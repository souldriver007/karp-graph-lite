// ============================================================================
// KARP Graph Lite — Authentication Module
// Version: 1.1.0
// Author: SoulDriver (Adelaide, Australia)
// Description: Simple passphrase-based session auth for the web UI.
//              Uses Node's built-in crypto.scrypt (no native dependencies).
//              MCP tools bypass auth entirely (stdio, not HTTP).
//              Supports persistent auth config via auth.json in data folder.
// License: MIT
// ============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SESSION_DURATION_SHORT = 24 * 60 * 60 * 1000;      // 24 hours
const SESSION_DURATION_LONG = 30 * 24 * 60 * 60 * 1000;  // 30 days

// Active sessions: token → { expires_at }
const sessions = new Map();

let passwordHash = null;
let passwordSalt = null;
let authEnabled = false;
let needsSetup = false;
let authFilePath = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg) {
    process.stderr.write(`${new Date().toISOString()} [AUTH:${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Password Hashing (scrypt — built into Node.js, no native deps)
// ---------------------------------------------------------------------------

function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
            if (err) reject(err);
            else resolve(derivedKey.toString('hex'));
        });
    });
}

// ---------------------------------------------------------------------------
// Persistent Auth Config (auth.json in data folder)
// ---------------------------------------------------------------------------

function loadAuthConfig() {
    if (!authFilePath) return null;
    try {
        if (fs.existsSync(authFilePath)) {
            const data = JSON.parse(fs.readFileSync(authFilePath, 'utf8'));
            return data;
        }
    } catch (err) {
        log('WARN', `Failed to read auth config: ${err.message}`);
    }
    return null;
}

function saveAuthConfig(config) {
    if (!authFilePath) return;
    try {
        fs.writeFileSync(authFilePath, JSON.stringify(config, null, 2), 'utf8');
        log('INFO', 'Auth config saved to disk');
    } catch (err) {
        log('ERROR', `Failed to save auth config: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Initialize
// Priority: 1) ENV var  2) Saved auth.json  3) Needs first-run setup
// ---------------------------------------------------------------------------

async function configure(dataPath, envPassword) {
    authFilePath = path.join(dataPath, 'auth.json');

    // Priority 1: Environment variable password
    if (envPassword && envPassword.trim() !== '') {
        authEnabled = true;
        needsSetup = false;
        passwordSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
        passwordHash = await hashPassword(envPassword.trim(), passwordSalt);
        // Persist so UI restarts work
        saveAuthConfig({ hash: passwordHash, salt: passwordSalt, mode: 'password' });
        log('INFO', 'Password protection enabled via environment variable');
        return;
    }

    // Priority 2: Saved auth config from disk
    const saved = loadAuthConfig();
    if (saved) {
        if (saved.mode === 'trust') {
            authEnabled = false;
            needsSetup = false;
            log('INFO', 'Network trust mode — web UI is open (user chose to trust localhost)');
            return;
        }
        if (saved.mode === 'password' && saved.hash && saved.salt) {
            authEnabled = true;
            needsSetup = false;
            passwordHash = saved.hash;
            passwordSalt = saved.salt;
            log('INFO', 'Password protection enabled from saved config');
            return;
        }
    }

    // Priority 3: No config found — needs first-run setup
    authEnabled = false;
    needsSetup = true;
    log('INFO', 'No auth configured — first-run setup required via web UI');
}

// ---------------------------------------------------------------------------
// First-Run Setup
// ---------------------------------------------------------------------------

async function setupPassword(password) {
    authEnabled = true;
    needsSetup = false;
    passwordSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    passwordHash = await hashPassword(password.trim(), passwordSalt);
    saveAuthConfig({ hash: passwordHash, salt: passwordSalt, mode: 'password' });
    log('INFO', 'Password set via first-run setup');
    return { success: true, mode: 'password' };
}

function setupTrust() {
    authEnabled = false;
    needsSetup = false;
    saveAuthConfig({ mode: 'trust', trusted_at: new Date().toISOString() });
    log('INFO', 'Trust mode enabled via first-run setup');
    return { success: true, mode: 'trust' };
}

async function changePassword(currentPassword, newPassword) {
    // If auth is currently enabled, verify old password first
    if (authEnabled) {
        const valid = await verifyPassword(currentPassword);
        if (!valid) {
            return { success: false, error: 'Current password is incorrect' };
        }
    }
    return await setupPassword(newPassword);
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function createSession(rememberDevice = false) {
    const token = generateToken();
    const duration = rememberDevice ? SESSION_DURATION_LONG : SESSION_DURATION_SHORT;
    const expiresAt = Date.now() + duration;

    sessions.set(token, { expires_at: expiresAt });

    // Clean expired sessions periodically
    if (sessions.size > 50) {
        cleanExpiredSessions();
    }

    return { token, maxAge: duration };
}

function validateSession(token) {
    if (!token) return false;

    const session = sessions.get(token);
    if (!session) return false;

    if (Date.now() > session.expires_at) {
        sessions.delete(token);
        return false;
    }

    return true;
}

function destroySession(token) {
    sessions.delete(token);
}

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (now > session.expires_at) {
            sessions.delete(token);
        }
    }
}

// ---------------------------------------------------------------------------
// Verify Password
// ---------------------------------------------------------------------------

async function verifyPassword(attempt) {
    if (!authEnabled) return true;

    const attemptHash = await hashPassword(attempt, passwordSalt);
    return attemptHash === passwordHash;
}

// ---------------------------------------------------------------------------
// Express Middleware
// ---------------------------------------------------------------------------

function authMiddleware(req, res, next) {
    // If first-run setup needed, only allow setup and status endpoints
    if (needsSetup) {
        if (req.path === '/api/auth/status' || req.path === '/api/auth/setup' || 
            req.path === '/api/auth/trust' || req.path === '/' || req.path === '/index.html') {
            return next();
        }
        return res.status(403).json({ error: 'First-run setup required', needs_setup: true });
    }

    // If auth not enabled (trust mode), pass through
    if (!authEnabled) return next();

    // Allow auth endpoints through
    if (req.path === '/api/auth/login' || req.path === '/api/auth/status') return next();

    // Allow the main page (serves login UI when not authenticated)
    if (req.path === '/' || req.path === '/index.html') return next();

    // Check session cookie
    const token = parseCookie(req.headers.cookie, 'kg_session');

    if (validateSession(token)) {
        return next();
    }

    res.status(401).json({ error: 'Authentication required', auth_required: true });
}

function parseCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
    return match ? match.split('=')[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Auth Routes (added to Express app)
// ---------------------------------------------------------------------------

function addAuthRoutes(app) {
    // Check auth status
    app.get('/api/auth/status', (req, res) => {
        const token = parseCookie(req.headers.cookie, 'kg_session');
        res.json({
            auth_enabled: authEnabled,
            needs_setup: needsSetup,
            authenticated: !authEnabled || validateSession(token)
        });
    });

    // First-run: set password
    app.post('/api/auth/setup', async (req, res) => {
        if (!needsSetup) {
            return res.status(400).json({ success: false, error: 'Setup already completed' });
        }

        const { password } = req.body || {};
        if (!password || password.trim().length < 4) {
            return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
        }

        const result = await setupPassword(password);
        
        // Auto-login after setup
        const { token, maxAge } = createSession(true);
        res.setHeader('Set-Cookie', `kg_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge / 1000)}`);
        
        res.json(result);
    });

    // First-run: trust network
    app.post('/api/auth/trust', (req, res) => {
        if (!needsSetup) {
            return res.status(400).json({ success: false, error: 'Setup already completed' });
        }

        const result = setupTrust();
        res.json(result);
    });

    // Login
    app.post('/api/auth/login', async (req, res) => {
        if (!authEnabled) {
            return res.json({ success: true, message: 'Auth not enabled' });
        }

        const { password, remember } = req.body || {};

        if (!password) {
            return res.status(400).json({ success: false, error: 'Password required' });
        }

        const valid = await verifyPassword(password);

        if (!valid) {
            log('WARN', 'Failed login attempt');
            return res.status(401).json({ success: false, error: 'Incorrect password' });
        }

        const { token, maxAge } = createSession(remember === true);

        res.setHeader('Set-Cookie', `kg_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge / 1000)}`);
        log('INFO', `Login successful (remember: ${remember === true})`);
        res.json({ success: true });
    });

    // Logout
    app.post('/api/auth/logout', (req, res) => {
        const token = parseCookie(req.headers.cookie, 'kg_session');
        if (token) destroySession(token);
        res.setHeader('Set-Cookie', 'kg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        res.json({ success: true });
    });

    // Change password (from settings)
    app.post('/api/auth/change-password', async (req, res) => {
        const { current_password, new_password } = req.body || {};

        if (!new_password || new_password.trim().length < 4) {
            return res.status(400).json({ success: false, error: 'New password must be at least 4 characters' });
        }

        const result = await changePassword(current_password || '', new_password);
        res.json(result);
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    configure,
    authMiddleware,
    addAuthRoutes,
    isEnabled: () => authEnabled,
    needsFirstRun: () => needsSetup
};
