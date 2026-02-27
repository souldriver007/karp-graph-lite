// ============================================================================
// KARP Graph Lite — Authentication Module
// Version: 1.0.0
// Author: SoulDriver (Adelaide, Australia)
// Description: Simple passphrase-based session auth for the web UI.
//              Uses Node's built-in crypto.scrypt (no native dependencies).
//              MCP tools bypass auth entirely (stdio, not HTTP).
// License: MIT
// ============================================================================

const crypto = require('crypto');

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const SESSION_DURATION_SHORT = 24 * 60 * 60 * 1000;      // 24 hours
const SESSION_DURATION_LONG = 30 * 24 * 60 * 60 * 1000;  // 30 days

// Active sessions: token → { expires_at }
const sessions = new Map();

let passwordHash = null;
let passwordSalt = null;
let authEnabled = false;

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
// Initialize
// ---------------------------------------------------------------------------

async function configure(password) {
    if (!password || password.trim() === '') {
        authEnabled = false;
        log('INFO', 'No password set — web UI is open (localhost only)');
        return;
    }

    authEnabled = true;
    passwordSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
    passwordHash = await hashPassword(password.trim(), passwordSalt);
    log('INFO', 'Password protection enabled for web UI');
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
    // If auth not enabled, pass through
    if (!authEnabled) return next();

    // Allow login endpoint through
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
            authenticated: !authEnabled || validateSession(token)
        });
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
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    configure,
    authMiddleware,
    addAuthRoutes,
    isEnabled: () => authEnabled
};
