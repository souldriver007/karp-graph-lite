// ============================================================================
// KARP Graph Lite — Database Layer (sql.js / WebAssembly SQLite)
// Version: 1.0.1
// Author: SoulDriver (Adelaide, Australia)
// Description: All SQLite operations — schema, CRUD, migrations, snapshots.
//              Uses sql.js (SQLite compiled to WASM) for universal compatibility
//              with any Node.js runtime including Claude Desktop's built-in Node.
//              Single file database, zero native dependencies, fully portable.
// License: MIT
// ============================================================================

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let db = null;
let SQL = null;
let DATA_PATH = '';
let DB_PATH = '';
let SNAPSHOTS_PATH = '';
let saveTimer = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg) {
    process.stderr.write(`${new Date().toISOString()} [DB:${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function configure(dataPath) {
    DATA_PATH = dataPath;
    DB_PATH = path.join(DATA_PATH, 'graph.db');
    SNAPSHOTS_PATH = path.join(DATA_PATH, 'snapshots');

    // Ensure directories exist
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.mkdirSync(SNAPSHOTS_PATH, { recursive: true });

    // Initialize sql.js WASM engine
    SQL = await initSqlJs();

    // Open or create database
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        log('INFO', `Database loaded: ${DB_PATH}`);
    } else {
        db = new SQL.Database();
        log('INFO', `Database created: ${DB_PATH}`);
    }

    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON;');

    // Initialize schema
    initSchema();

    // Save to disk
    saveToDisk();

    return db;
}

function saveToDisk() {
    if (!db) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
        log('ERROR', `Failed to save database: ${err.message}`);
    }
}

// Debounced save — writes at most every 2 seconds
function debouncedSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveToDisk();
        saveTimer = null;
    }, 2000);
}

// Immediate save for critical operations
function immediateSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveToDisk();
}

function initSchema() {
    db.run(`
        CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            summary TEXT NOT NULL,
            detail TEXT DEFAULT '',
            context TEXT DEFAULT '',
            tags TEXT DEFAULT '[]',
            importance REAL DEFAULT 0.5,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            metadata TEXT DEFAULT '{}'
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS edges (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            relationship TEXT NOT NULL,
            created_at REAL NOT NULL,
            FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS embeddings (
            node_id TEXT PRIMARY KEY,
            vector BLOB NOT NULL,
            model TEXT NOT NULL,
            embedded_at REAL NOT NULL,
            FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS type_definitions (
            type_name TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            description TEXT DEFAULT '',
            fields TEXT NOT NULL DEFAULT '[]',
            icon TEXT DEFAULT '📝',
            is_base_type INTEGER DEFAULT 0,
            created_at REAL NOT NULL
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type_name TEXT NOT NULL,
            action TEXT NOT NULL,
            snapshot_path TEXT,
            fields_before TEXT,
            fields_after TEXT,
            created_at REAL NOT NULL
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS pending_proposals (
            id TEXT PRIMARY KEY,
            type_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            description TEXT DEFAULT '',
            fields TEXT NOT NULL DEFAULT '[]',
            icon TEXT DEFAULT '📝',
            proposed_at REAL NOT NULL,
            status TEXT DEFAULT 'pending'
        );
    `);

    // Indexes (CREATE INDEX IF NOT EXISTS is safe to run repeatedly)
    db.run('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);');
    db.run('CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at);');
    db.run('CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes(updated_at);');
    db.run('CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);');

    // Seed base types
    seedBaseTypes();
}

function seedBaseTypes() {
    const baseTypes = [
        {
            type_name: 'memory',
            display_name: 'Memory',
            description: 'Personal reflections, wisdom, notes, letters',
            fields: JSON.stringify([
                { name: 'summary', type: 'string', required: true },
                { name: 'detail', type: 'text', required: false },
                { name: 'context', type: 'string', required: false }
            ]),
            icon: '💭'
        },
        {
            type_name: 'todo',
            display_name: 'Todo',
            description: 'Tasks with status tracking',
            fields: JSON.stringify([
                { name: 'summary', type: 'string', required: true },
                { name: 'status', type: 'enum', values: ['pending', 'in_progress', 'completed', 'cancelled'], required: false },
                { name: 'priority', type: 'enum', values: ['low', 'medium', 'high', 'critical'], required: false }
            ]),
            icon: '✅'
        },
        {
            type_name: 'decision',
            display_name: 'Decision',
            description: 'Choices made and their rationale',
            fields: JSON.stringify([
                { name: 'summary', type: 'string', required: true },
                { name: 'detail', type: 'text', required: false },
                { name: 'context', type: 'string', required: false },
                { name: 'rationale', type: 'text', required: false }
            ]),
            icon: '⚖️'
        },
        {
            type_name: 'insight',
            display_name: 'Insight',
            description: 'Patterns noticed, learnings, observations',
            fields: JSON.stringify([
                { name: 'summary', type: 'string', required: true },
                { name: 'detail', type: 'text', required: false }
            ]),
            icon: '💡'
        },
        {
            type_name: 'dev_session',
            display_name: 'Dev Session',
            description: 'Structured daily work logs',
            fields: JSON.stringify([
                { name: 'summary', type: 'string', required: true },
                { name: 'date', type: 'string', required: true },
                { name: 'duration_estimate', type: 'string', required: false },
                { name: 'topics_covered', type: 'array', required: false },
                { name: 'bugs_found', type: 'array', required: false },
                { name: 'bugs_fixed', type: 'array', required: false },
                { name: 'features_added', type: 'array', required: false },
                { name: 'decisions_made', type: 'array', required: false },
                { name: 'todos_created', type: 'array', required: false }
            ]),
            icon: '🔧'
        },
        {
            type_name: 'changelog',
            display_name: 'Changelog',
            description: 'Versioned release notes',
            fields: JSON.stringify([
                { name: 'summary', type: 'string', required: true },
                { name: 'version', type: 'string', required: true },
                { name: 'changes', type: 'array', required: false }
            ]),
            icon: '📋'
        }
    ];

    const now = Date.now() / 1000;
    for (const t of baseTypes) {
        db.run(
            `INSERT OR IGNORE INTO type_definitions (type_name, display_name, description, fields, icon, is_base_type, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
            [t.type_name, t.display_name, t.description, t.fields, t.icon, now]
        );
    }
}

// ---------------------------------------------------------------------------
// Query Helpers (sql.js uses different API than better-sqlite3)
// ---------------------------------------------------------------------------

function queryOne(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
    }
    stmt.free();
    return row;
}

function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    const columns = stmt.getColumnNames();
    while (stmt.step()) {
        const values = stmt.get();
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
        rows.push(row);
    }
    stmt.free();
    return rows;
}

function runSql(sql, params = []) {
    db.run(sql, params);
}

// ---------------------------------------------------------------------------
// Generate IDs
// ---------------------------------------------------------------------------

function generateId() {
    return 'kg_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

function createNode({ type, summary, detail, context, tags, importance, metadata }) {
    const id = generateId();
    const now = Date.now() / 1000;

    // Validate type exists
    const typeDef = queryOne('SELECT type_name FROM type_definitions WHERE type_name = ?', [type]);
    if (!typeDef) {
        throw new Error(`Unknown node type: "${type}". Use kg_status to see available types, or propose_node_type to create a new one.`);
    }

    runSql(
        `INSERT INTO nodes (id, type, summary, detail, context, tags, importance, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, type, summary || '', detail || '', context || '', JSON.stringify(tags || []), importance || 0.5, now, now, JSON.stringify(metadata || {})]
    );

    debouncedSave();
    log('INFO', `Created node ${id} (${type}): ${summary}`);
    return getNode(id);
}

function getNode(id) {
    const node = queryOne('SELECT * FROM nodes WHERE id = ?', [id]);
    if (!node) return null;

    // Parse JSON fields
    node.tags = JSON.parse(node.tags || '[]');
    node.metadata = JSON.parse(node.metadata || '{}');

    // Get connections
    node.connections = getNodeConnections(id);

    return node;
}

function updateNode(id, updates) {
    const existing = queryOne('SELECT * FROM nodes WHERE id = ?', [id]);
    if (!existing) throw new Error(`Node not found: ${id}`);

    const now = Date.now() / 1000;
    const sets = [];
    const values = [];

    if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary); }
    if (updates.detail !== undefined) { sets.push('detail = ?'); values.push(updates.detail); }
    if (updates.context !== undefined) { sets.push('context = ?'); values.push(updates.context); }
    if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
    if (updates.importance !== undefined) { sets.push('importance = ?'); values.push(updates.importance); }
    if (updates.metadata !== undefined) {
        const existingMeta = JSON.parse(existing.metadata || '{}');
        const merged = { ...existingMeta, ...updates.metadata };
        sets.push('metadata = ?');
        values.push(JSON.stringify(merged));
    }

    if (sets.length === 0) throw new Error('No fields to update');

    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);

    runSql(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`, values);
    debouncedSave();
    log('INFO', `Updated node ${id}`);

    return getNode(id);
}

function deleteNode(id) {
    const existing = queryOne('SELECT id, type, summary FROM nodes WHERE id = ?', [id]);
    if (!existing) throw new Error(`Node not found: ${id}`);

    // Manual cascade since sql.js foreign key cascade can be unreliable
    runSql('DELETE FROM embeddings WHERE node_id = ?', [id]);
    runSql('DELETE FROM edges WHERE source_id = ? OR target_id = ?', [id, id]);
    runSql('DELETE FROM nodes WHERE id = ?', [id]);

    debouncedSave();
    log('INFO', `Deleted node ${id} (${existing.type}): ${existing.summary}`);

    return { deleted: true, id, type: existing.type, summary: existing.summary };
}

// ---------------------------------------------------------------------------
// List & Search (keyword)
// ---------------------------------------------------------------------------

function listNodes({ type, tags, limit, offset, sort, order } = {}) {
    let sql = 'SELECT id, type, summary, tags, importance, created_at, updated_at FROM nodes WHERE 1=1';
    const params = [];

    if (type) {
        sql += ' AND type = ?';
        params.push(type);
    }

    if (tags && tags.length > 0) {
        const tagClauses = tags.map(() => "tags LIKE ?");
        sql += ` AND (${tagClauses.join(' OR ')})`;
        tags.forEach(t => params.push(`%"${t}"%`));
    }

    const sortField = sort === 'importance' ? 'importance' : sort === 'updated' ? 'updated_at' : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortField} ${sortOrder}`;

    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit || 20, offset || 0);

    const rows = queryAll(sql, params);
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
}

function searchKeyword(query, limit = 20) {
    const pattern = `%${query}%`;
    const rows = queryAll(
        `SELECT id, type, summary, detail, tags, importance, created_at, updated_at FROM nodes WHERE summary LIKE ? OR detail LIKE ? OR context LIKE ? ORDER BY updated_at DESC LIMIT ?`,
        [pattern, pattern, pattern, limit]
    );
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
}

// ---------------------------------------------------------------------------
// Connections (Edges)
// ---------------------------------------------------------------------------

function createEdge(sourceId, targetId, relationship) {
    const source = queryOne('SELECT id FROM nodes WHERE id = ?', [sourceId]);
    const target = queryOne('SELECT id FROM nodes WHERE id = ?', [targetId]);
    if (!source) throw new Error(`Source node not found: ${sourceId}`);
    if (!target) throw new Error(`Target node not found: ${targetId}`);

    const id = generateId();
    const now = Date.now() / 1000;

    runSql(
        `INSERT INTO edges (id, source_id, target_id, relationship, created_at) VALUES (?, ?, ?, ?, ?)`,
        [id, sourceId, targetId, relationship, now]
    );

    debouncedSave();
    log('INFO', `Connected ${sourceId} --[${relationship}]--> ${targetId}`);
    return { id, source_id: sourceId, target_id: targetId, relationship };
}

function getNodeConnections(nodeId) {
    const outgoing = queryAll(
        `SELECT e.id, e.relationship, e.target_id, n.type, n.summary FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?`,
        [nodeId]
    );
    const incoming = queryAll(
        `SELECT e.id, e.relationship, e.source_id, n.type, n.summary FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`,
        [nodeId]
    );
    return { outgoing, incoming };
}

function deleteEdge(edgeId) {
    const existing = queryOne('SELECT id FROM edges WHERE id = ?', [edgeId]);
    if (!existing) throw new Error(`Edge not found: ${edgeId}`);
    runSql('DELETE FROM edges WHERE id = ?', [edgeId]);
    debouncedSave();
    return { deleted: true, id: edgeId };
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

function storeEmbedding(nodeId, vector, model) {
    const now = Date.now() / 1000;
    const vectorBlob = Buffer.from(new Float32Array(vector).buffer);

    runSql(
        `INSERT OR REPLACE INTO embeddings (node_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)`,
        [nodeId, vectorBlob, model, now]
    );
    debouncedSave();
}

function getEmbedding(nodeId) {
    const row = queryOne('SELECT * FROM embeddings WHERE node_id = ?', [nodeId]);
    if (!row) return null;

    const buf = row.vector;
    row.vector = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    return row;
}

function getAllEmbeddings() {
    const rows = queryAll('SELECT node_id, vector FROM embeddings');
    return rows.map(r => {
        const buf = r.vector;
        // sql.js returns Uint8Array for BLOBs
        const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        return {
            node_id: r.node_id,
            vector: Array.from(floats)
        };
    });
}

function getNodesWithoutEmbeddings() {
    return queryAll(
        `SELECT n.id, n.type, n.summary, n.detail, n.context, n.tags, n.metadata FROM nodes n LEFT JOIN embeddings e ON n.id = e.node_id WHERE e.node_id IS NULL`
    );
}

// ---------------------------------------------------------------------------
// Type Definitions (Self-Evolving Schema)
// ---------------------------------------------------------------------------

function getTypeDefinitions() {
    const rows = queryAll('SELECT * FROM type_definitions ORDER BY is_base_type DESC, type_name ASC');
    return rows.map(r => ({ ...r, fields: JSON.parse(r.fields || '[]') }));
}

function getTypeDefinition(typeName) {
    const row = queryOne('SELECT * FROM type_definitions WHERE type_name = ?', [typeName]);
    if (!row) return null;
    row.fields = JSON.parse(row.fields || '[]');
    return row;
}

function proposeNodeType({ type_name, display_name, description, fields, icon }) {
    const id = generateId();
    const now = Date.now() / 1000;

    const existing = queryOne('SELECT type_name FROM type_definitions WHERE type_name = ?', [type_name]);
    if (existing) throw new Error(`Type already exists: "${type_name}"`);

    const pending = queryOne('SELECT id FROM pending_proposals WHERE type_name = ? AND status = ?', [type_name, 'pending']);
    if (pending) throw new Error(`A proposal for type "${type_name}" is already pending approval`);

    runSql(
        `INSERT INTO pending_proposals (id, type_name, display_name, description, fields, icon, proposed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [id, type_name, display_name, description || '', JSON.stringify(fields || []), icon || '📝', now]
    );

    debouncedSave();
    log('INFO', `Proposed new type: ${type_name} (${display_name})`);
    return {
        proposal_id: id,
        type_name,
        display_name,
        status: 'pending',
        message: `Type "${display_name}" proposed. Open the Graph Lite UI to review and approve it.`
    };
}

function approveProposal(proposalId) {
    const proposal = queryOne('SELECT * FROM pending_proposals WHERE id = ? AND status = ?', [proposalId, 'pending']);
    if (!proposal) throw new Error(`Pending proposal not found: ${proposalId}`);

    const now = Date.now() / 1000;

    // Take snapshot before schema change
    const snapshotPath = createSnapshot('pre_type_addition');

    // Add type definition
    runSql(
        `INSERT INTO type_definitions (type_name, display_name, description, fields, icon, is_base_type, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [proposal.type_name, proposal.display_name, proposal.description, proposal.fields, proposal.icon, now]
    );

    // Log migration
    runSql(
        `INSERT INTO migrations (type_name, action, snapshot_path, fields_before, fields_after, created_at) VALUES (?, 'created', ?, NULL, ?, ?)`,
        [proposal.type_name, snapshotPath, proposal.fields, now]
    );

    // Mark proposal as approved
    runSql('UPDATE pending_proposals SET status = ? WHERE id = ?', ['approved', proposalId]);

    immediateSave();
    log('INFO', `Approved type: ${proposal.type_name}`);
    return {
        type_name: proposal.type_name,
        display_name: proposal.display_name,
        status: 'approved',
        snapshot: snapshotPath
    };
}

function rejectProposal(proposalId) {
    const proposal = queryOne('SELECT * FROM pending_proposals WHERE id = ? AND status = ?', [proposalId, 'pending']);
    if (!proposal) throw new Error(`Pending proposal not found: ${proposalId}`);

    runSql('UPDATE pending_proposals SET status = ? WHERE id = ?', ['rejected', proposalId]);
    debouncedSave();
    return { type_name: proposal.type_name, status: 'rejected' };
}

function getPendingProposals() {
    const rows = queryAll('SELECT * FROM pending_proposals WHERE status = ? ORDER BY proposed_at DESC', ['pending']);
    return rows.map(r => ({ ...r, fields: JSON.parse(r.fields || '[]') }));
}

// ---------------------------------------------------------------------------
// Snapshots (Backup)
// ---------------------------------------------------------------------------

function createSnapshot(reason) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `graph_${timestamp}_${reason || 'manual'}.db`;
    const snapshotPath = path.join(SNAPSHOTS_PATH, filename);

    // Export full database and write to file
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(snapshotPath, buffer);

    log('INFO', `Snapshot created: ${filename}`);

    // Prune old snapshots (keep last 20)
    pruneSnapshots(20);

    return snapshotPath;
}

function listSnapshots() {
    if (!fs.existsSync(SNAPSHOTS_PATH)) return [];

    return fs.readdirSync(SNAPSHOTS_PATH)
        .filter(f => f.endsWith('.db'))
        .map(f => {
            const stats = fs.statSync(path.join(SNAPSHOTS_PATH, f));
            return {
                filename: f,
                path: path.join(SNAPSHOTS_PATH, f),
                size_bytes: stats.size,
                created: stats.mtime.toISOString()
            };
        })
        .sort((a, b) => b.created.localeCompare(a.created));
}

function pruneSnapshots(keep = 20) {
    const snapshots = listSnapshots();
    if (snapshots.length <= keep) return;

    const toDelete = snapshots.slice(keep);
    for (const snap of toDelete) {
        fs.unlinkSync(snap.path);
        log('INFO', `Pruned snapshot: ${snap.filename}`);
    }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function getStats() {
    const totalNodes = queryOne('SELECT COUNT(*) as count FROM nodes').count;
    const totalEdges = queryOne('SELECT COUNT(*) as count FROM edges').count;
    const totalEmbeddings = queryOne('SELECT COUNT(*) as count FROM embeddings').count;

    const nodesByType = queryAll('SELECT type, COUNT(*) as count FROM nodes GROUP BY type ORDER BY count DESC');

    const typeDefs = queryOne('SELECT COUNT(*) as count FROM type_definitions').count;
    const pendingProposals = queryOne("SELECT COUNT(*) as count FROM pending_proposals WHERE status = 'pending'").count;

    const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    const snapshotCount = listSnapshots().length;

    const embeddingCoverage = totalNodes > 0 ? Math.round((totalEmbeddings / totalNodes) * 100) : 0;

    return {
        total_nodes: totalNodes,
        total_edges: totalEdges,
        total_embeddings: totalEmbeddings,
        embedding_coverage: `${embeddingCoverage}%`,
        nodes_by_type: nodesByType,
        type_definitions: typeDefs,
        pending_proposals: pendingProposals,
        db_size_bytes: dbSize,
        db_size: formatBytes(dbSize),
        snapshot_count: snapshotCount,
        db_path: DB_PATH
    };
}

function formatBytes(bytes) {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportJSON() {
    const nodes = queryAll('SELECT * FROM nodes').map(r => ({
        ...r,
        tags: JSON.parse(r.tags || '[]'),
        metadata: JSON.parse(r.metadata || '{}')
    }));
    const edges = queryAll('SELECT * FROM edges');
    const types = getTypeDefinitions();

    return { exported_at: new Date().toISOString(), nodes, edges, type_definitions: types };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    configure,
    generateId,
    // Node CRUD
    createNode,
    getNode,
    updateNode,
    deleteNode,
    // List & Search
    listNodes,
    searchKeyword,
    // Edges
    createEdge,
    getNodeConnections,
    deleteEdge,
    // Embeddings
    storeEmbedding,
    getEmbedding,
    getAllEmbeddings,
    getNodesWithoutEmbeddings,
    // Types
    getTypeDefinitions,
    getTypeDefinition,
    proposeNodeType,
    approveProposal,
    rejectProposal,
    getPendingProposals,
    // Snapshots
    createSnapshot,
    listSnapshots,
    // Stats
    getStats,
    // Export
    exportJSON,
    // Direct DB access (for search module and web API)
    getDb: () => db,
    queryAll,
    queryOne,
    // Save
    saveToDisk,
    immediateSave
};
