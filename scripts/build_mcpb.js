// ============================================================================
// KARP Graph Lite — MCPB Build Script
// Version: 1.0.0
// Author: SoulDriver (Adelaide, Australia)
// Usage: node scripts/build_mcpb.js
//
// Creates a .mcpb bundle (ZIP) with the correct structure:
//   karp-graph-lite.mcpb
//   ├── manifest.json
//   ├── server/
//   │   ├── index.js
//   │   ├── database.js
//   │   ├── embeddings.js
//   │   ├── search.js
//   │   └── auth.js
//   ├── ui/
//   │   └── index.html
//   ├── node_modules/   (production deps only)
//   ├── package.json
//   └── icon.png        (if exists)
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'dist', 'stage');
const OUTPUT = path.join(ROOT, 'dist', 'karp-graph-lite.mcpb');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function cleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

function fileSize(filepath) {
    const bytes = fs.statSync(filepath).size;
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${bytes}B`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

console.log('╔══════════════════════════════════════════════╗');
console.log('║  KARP Graph Lite — MCPB Bundle Builder       ║');
console.log('║  by SoulDriver (souldriver.com.au)           ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');

// Step 1: Verify
console.log('[1/6] Checking project...');
if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    console.error('      ✗ package.json not found!');
    process.exit(1);
}
console.log('      ✓ package.json found');

const requiredFiles = [
    'config/manifest.json',
    'server/index.js',
    'server/database.js',
    'server/embeddings.js',
    'server/search.js',
    'server/auth.js',
    'ui/index.html'
];

for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(ROOT, f))) {
        console.error(`      ✗ Missing: ${f}`);
        process.exit(1);
    }
    console.log(`      ✓ ${f}`);
}

// Step 2: Clean staging
console.log('[2/6] Preparing staging directory...');
cleanDir(STAGE);
console.log('      ✓ dist/stage cleaned');

// Step 3: Copy files
console.log('[3/6] Staging files...');

// manifest.json
fs.copyFileSync(
    path.join(ROOT, 'config', 'manifest.json'),
    path.join(STAGE, 'manifest.json')
);
console.log('      ✓ manifest.json');

// package.json
fs.copyFileSync(
    path.join(ROOT, 'package.json'),
    path.join(STAGE, 'package.json')
);
console.log('      ✓ package.json');

// server/
copyDir(path.join(ROOT, 'server'), path.join(STAGE, 'server'));
// Remove any .bak files from staging
const serverFiles = fs.readdirSync(path.join(STAGE, 'server'));
serverFiles.forEach(f => { if (f.endsWith('.bak')) fs.unlinkSync(path.join(STAGE, 'server', f)); });
console.log('      ✓ server/ (index.js, database.js, embeddings.js, search.js)');

// ui/
copyDir(path.join(ROOT, 'ui'), path.join(STAGE, 'ui'));
console.log('      ✓ ui/ (index.html)');

// icon.png (optional)
const iconPath = path.join(ROOT, 'assets', 'icon.png');
if (fs.existsSync(iconPath)) {
    fs.copyFileSync(iconPath, path.join(STAGE, 'icon.png'));
    console.log('      ✓ icon.png');
} else {
    console.log('      ⚠ icon.png not found (optional — add to assets/)');
}

// Step 4: Install production dependencies
console.log('[4/6] Installing production dependencies (strips dev deps)...');
execSync('npm install --omit=dev', { cwd: STAGE, stdio: 'inherit' });
console.log('      ✓ node_modules/ (production dependencies only)');

// Step 5: Create ZIP
console.log('[5/6] Creating .mcpb bundle...');

if (fs.existsSync(OUTPUT)) {
    fs.unlinkSync(OUTPUT);
}

const isWindows = process.platform === 'win32';

try {
    if (isWindows) {
        const zipPath = OUTPUT.replace(/\.mcpb$/, '.zip');
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        const psCmd = `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -Force`;
        execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });
        fs.renameSync(zipPath, OUTPUT);
    } else {
        execSync(`cd "${STAGE}" && zip -r "${OUTPUT}" .`, { stdio: 'inherit' });
    }
    console.log(`      ✓ Bundle created: ${OUTPUT}`);
} catch (e) {
    console.error(`      ✗ ZIP creation failed: ${e.message}`);
    console.log('');
    console.log('      Manual alternative:');
    console.log(`      1. Open: ${STAGE}`);
    console.log('      2. Select all files → right-click → Send to → Compressed folder');
    console.log(`      3. Rename to: karp-graph-lite.mcpb`);
    process.exit(1);
}

// Step 6: Summary
console.log('[6/6] Build complete!');
console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║  BUILD SUMMARY                               ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  Output:  ${path.basename(OUTPUT)}`);
console.log(`║  Size:    ${fileSize(OUTPUT)}`);
console.log(`║  Path:    ${OUTPUT}`);
console.log('╠══════════════════════════════════════════════╣');
console.log('║  TO INSTALL:                                 ║');
console.log('║  1. Open Claude Desktop                      ║');
console.log('║  2. Settings → Extensions → Install Extension║');
console.log('║  3. Select the .mcpb file                    ║');
console.log('║  4. Choose a data folder when prompted       ║');
console.log('║  5. Open localhost:3456 to see your graph    ║');
console.log('╚══════════════════════════════════════════════╝');

// Cleanup
console.log('');
console.log('Cleaning up staging directory...');
fs.rmSync(STAGE, { recursive: true, force: true });
console.log('Done! 🚀');
