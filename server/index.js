// ============================================================================
// KARP Graph Lite — MCP Server + Web UI
// Version: 1.0.0
// Author: SoulDriver (Adelaide, Australia)
// Description: MCP server (stdio) for Claude Desktop integration plus an
//              Express web server serving the local UI on localhost.
//              Zero external dependencies beyond Node.js.
// License: MIT
//
// The full KARP Research Engine uses enterprise-grade vector storage,
// multi-AI deliberation across four frontier models, and institutional-scale
// knowledge graph architecture. This is the free personal edition.
// Learn more: https://souldriver.com.au
// ============================================================================

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const express = require('express');

// Import modules
const database = require('./database');
const embeddings = require('./embeddings');
const search = require('./search');
const auth = require('./auth');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const VERSION = '1.0.0';
const SERVER_NAME = 'karp-graph-lite';
const DATA_PATH = process.env.DATA_PATH || path.join(require('os').homedir(), '.karp-graph-lite');
const UI_PORT = parseInt(process.env.UI_PORT || '3456', 10);
const UI_PASSWORD = process.env.UI_PASSWORD || '';

// Logging to stderr (stdout reserved for MCP protocol)
function log(level, msg) {
    process.stderr.write(`${new Date().toISOString()} [${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const TOOLS = [
    {
        name: 'remember',
        description: 'Store a memory, note, decision, todo, insight, dev_session, changelog, or any custom type in your knowledge graph. Returns the created node with its ID.',
        annotations: { title: 'Remember', readOnlyHint: false, destructiveHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Node type: memory, todo, decision, insight, dev_session, changelog, or any custom type' },
                summary: { type: 'string', description: 'Brief summary (required)' },
                detail: { type: 'string', description: 'Detailed content (optional)' },
                context: { type: 'string', description: 'Context or category (optional)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
                importance: { type: 'number', description: 'Importance 0-1 (default 0.5)' },
                metadata: { type: 'object', description: 'Additional structured fields (e.g. status, date, version)' },
                connect_to: { type: 'string', description: 'Optional: ID of existing node to connect to' },
                relationship: { type: 'string', description: 'Relationship name if connect_to is set (e.g. led_to, part_of)' }
            },
            required: ['type', 'summary']
        }
    },
    {
        name: 'recall',
        description: 'Semantic search across your entire knowledge graph. Finds nodes by meaning, not just keywords. Use this to find relevant memories, decisions, insights, or any stored knowledge.',
        annotations: { title: 'Recall', readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language search query' },
                limit: { type: 'integer', description: 'Max results (default 10)', default: 10 },
                type: { type: 'string', description: 'Filter by node type (optional)' }
            },
            required: ['query']
        }
    },
    {
        name: 'forget',
        description: 'Delete a node from the knowledge graph by ID. This is permanent.',
        annotations: { title: 'Forget', readOnlyHint: false, destructiveHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Node ID to delete' }
            },
            required: ['id']
        }
    },
    {
        name: 'update',
        description: 'Edit an existing node. Only provided fields are updated — everything else stays the same.',
        annotations: { title: 'Update', readOnlyHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Node ID to update' },
                summary: { type: 'string', description: 'New summary' },
                detail: { type: 'string', description: 'New detail' },
                context: { type: 'string', description: 'New context' },
                tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing)' },
                importance: { type: 'number', description: 'New importance 0-1' },
                metadata: { type: 'object', description: 'Metadata fields to update (merges with existing)' }
            },
            required: ['id']
        }
    },
    {
        name: 'connect',
        description: 'Create a named relationship between two nodes. Examples: "led_to", "contradicts", "part_of", "inspired_by", "blocks".',
        annotations: { title: 'Connect', readOnlyHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                source_id: { type: 'string', description: 'Source node ID' },
                target_id: { type: 'string', description: 'Target node ID' },
                relationship: { type: 'string', description: 'Relationship name (e.g. led_to, part_of, contradicts)' }
            },
            required: ['source_id', 'target_id', 'relationship']
        }
    },
    {
        name: 'search',
        description: 'Keyword/exact match search across node summaries and details. Faster than recall but less intelligent. Use recall for semantic search.',
        annotations: { title: 'Search', readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keyword search query' },
                limit: { type: 'integer', description: 'Max results (default 20)', default: 20 },
                type: { type: 'string', description: 'Filter by type (optional)' }
            },
            required: ['query']
        }
    },
    {
        name: 'list',
        description: 'Browse nodes by type, tags, or date. Returns summaries, not full content. Use recall or search for content-based lookup.',
        annotations: { title: 'List', readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Filter by node type' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Filter by any of these tags' },
                limit: { type: 'integer', description: 'Max results (default 20)', default: 20 },
                offset: { type: 'integer', description: 'Skip first N results (pagination)', default: 0 },
                sort: { type: 'string', enum: ['created', 'updated', 'importance'], description: 'Sort field (default: created)' },
                order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' }
            }
        }
    },
    {
        name: 'kg_status',
        description: 'Knowledge graph health: node counts by type, database size, embedding coverage, available types, pending proposals, snapshot count.',
        annotations: { title: 'KG Status', readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'propose_node_type',
        description: 'Propose a new custom node type. The user will review and approve it in the web UI before it becomes available. Describe the fields this type needs.',
        annotations: { title: 'Propose Type', readOnlyHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                type_name: { type: 'string', description: 'Internal name (lowercase, no spaces, e.g. recipe, case_brief)' },
                display_name: { type: 'string', description: 'Human-readable name (e.g. Recipe, Case Brief)' },
                description: { type: 'string', description: 'What this type is for' },
                icon: { type: 'string', description: 'Emoji icon (e.g. 🍳, ⚖️)' },
                fields: {
                    type: 'array',
                    description: 'Field definitions for this type',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            type: { type: 'string', enum: ['string', 'text', 'number', 'array', 'enum', 'boolean'] },
                            required: { type: 'boolean' },
                            description: { type: 'string' },
                            values: { type: 'array', items: { type: 'string' }, description: 'For enum type: allowed values' }
                        }
                    }
                }
            },
            required: ['type_name', 'display_name', 'description']
        }
    },
    {
        name: 'snapshot',
        description: 'Create a backup snapshot of the entire knowledge graph. Recommended before major changes.',
        annotations: { title: 'Snapshot', readOnlyHint: false },
        inputSchema: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Reason for snapshot (e.g. "before cleanup", "weekly backup")' }
            }
        }
    },
    {
        name: 're_embed',
        description: 'Rebuild all vector embeddings. Use after adding new node types, if search quality seems off, or after importing data. May take a few minutes for large graphs.',
        annotations: { title: 'Re-embed All', readOnlyHint: false },
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

// ---------------------------------------------------------------------------
// Tool Router
// ---------------------------------------------------------------------------

async function handleToolCall(name, args) {
    switch (name) {

        // --- remember ---
        case 'remember': {
            const node = database.createNode({
                type: args.type,
                summary: args.summary,
                detail: args.detail,
                context: args.context,
                tags: args.tags,
                importance: args.importance,
                metadata: args.metadata
            });

            // Auto-embed the new node
            try {
                await search.embedNode(node.id);
            } catch (err) {
                log('WARN', `Auto-embed failed for ${node.id}: ${err.message}`);
            }

            // Auto-connect if requested
            if (args.connect_to && args.relationship) {
                try {
                    database.createEdge(node.id, args.connect_to, args.relationship);
                    node.connected_to = { id: args.connect_to, relationship: args.relationship };
                } catch (err) {
                    node.connection_error = err.message;
                }
            }

            return node;
        }

        // --- recall (semantic search) ---
        case 'recall': {
            return await search.semanticSearch(args.query, {
                limit: args.limit,
                type: args.type
            });
        }

        // --- forget ---
        case 'forget': {
            return database.deleteNode(args.id);
        }

        // --- update ---
        case 'update': {
            const { id, ...updates } = args;
            const node = database.updateNode(id, updates);

            // Re-embed after update
            try {
                await search.embedNode(id);
            } catch (err) {
                log('WARN', `Re-embed after update failed for ${id}: ${err.message}`);
            }

            return node;
        }

        // --- connect ---
        case 'connect': {
            return database.createEdge(args.source_id, args.target_id, args.relationship);
        }

        // --- search (keyword) ---
        case 'search': {
            return search.keywordSearch(args.query, {
                limit: args.limit,
                type: args.type
            });
        }

        // --- list ---
        case 'list': {
            return database.listNodes({
                type: args.type,
                tags: args.tags,
                limit: args.limit,
                offset: args.offset,
                sort: args.sort,
                order: args.order
            });
        }

        // --- kg_status ---
        case 'kg_status': {
            const stats = database.getStats();
            const types = database.getTypeDefinitions();
            const pending = database.getPendingProposals();

            return {
                ...stats,
                available_types: types.map(t => ({
                    name: t.type_name,
                    display_name: t.display_name,
                    icon: t.icon,
                    is_base: !!t.is_base_type
                })),
                pending_proposals: pending.length > 0 ? pending.map(p => ({
                    id: p.id,
                    type_name: p.type_name,
                    display_name: p.display_name
                })) : 'none',
                ui_url: `http://localhost:${UI_PORT}`,
                powered_by: 'KARP Graph Lite by SoulDriver — souldriver.com.au'
            };
        }

        // --- propose_node_type ---
        case 'propose_node_type': {
            return database.proposeNodeType({
                type_name: args.type_name,
                display_name: args.display_name,
                description: args.description,
                fields: args.fields,
                icon: args.icon
            });
        }

        // --- snapshot ---
        case 'snapshot': {
            const snapshotPath = database.createSnapshot(args.reason || 'manual');
            return {
                status: 'created',
                path: snapshotPath,
                message: 'Snapshot created successfully.'
            };
        }

        // --- re_embed ---
        case 're_embed': {
            return await search.reEmbedAll((done, total) => {
                log('INFO', `Re-embedding: ${done}/${total}`);
            });
        }

        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// ---------------------------------------------------------------------------
// Express Web UI Server
// ---------------------------------------------------------------------------

function startWebUI() {
    const app = express();
    app.use(express.json());

    // Auth middleware — protects all /api/* routes except auth endpoints
    app.use(auth.authMiddleware);

    // Auth routes (login, logout, status)
    auth.addAuthRoutes(app);

    // Serve the single-file UI
    const uiPath = path.join(__dirname, '..', 'ui', 'index.html');
    app.get('/', (req, res) => {
        if (fs.existsSync(uiPath)) {
            res.sendFile(uiPath);
        } else {
            res.send('<h1>KARP Graph Lite</h1><p>UI file not found. Check ui/index.html</p>');
        }
    });

    // --- API Routes ---

    // Stats
    app.get('/api/stats', (req, res) => {
        try {
            res.json(database.getStats());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // List nodes
    app.get('/api/nodes', (req, res) => {
        try {
            const { type, tags, limit, offset, sort, order } = req.query;
            const result = database.listNodes({
                type,
                tags: tags ? tags.split(',') : undefined,
                limit: parseInt(limit) || 20,
                offset: parseInt(offset) || 0,
                sort,
                order
            });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get single node
    app.get('/api/nodes/:id', (req, res) => {
        try {
            const node = database.getNode(req.params.id);
            if (!node) return res.status(404).json({ error: 'Node not found' });
            res.json(node);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Update node
    app.patch('/api/nodes/:id', (req, res) => {
        try {
            const node = database.updateNode(req.params.id, req.body);
            // Re-embed async (don't block response)
            search.embedNode(req.params.id).catch(err =>
                log('WARN', `Re-embed after UI update failed: ${err.message}`)
            );
            res.json(node);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete node
    app.delete('/api/nodes/:id', (req, res) => {
        try {
            const result = database.deleteNode(req.params.id);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Search
    app.get('/api/search', async (req, res) => {
        try {
            const { q, type, limit, mode } = req.query;
            if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });

            if (mode === 'keyword') {
                res.json(search.keywordSearch(q, { limit: parseInt(limit) || 20, type }));
            } else {
                res.json(await search.semanticSearch(q, { limit: parseInt(limit) || 10, type }));
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Type definitions
    app.get('/api/types', (req, res) => {
        try {
            res.json(database.getTypeDefinitions());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Pending proposals
    app.get('/api/proposals', (req, res) => {
        try {
            res.json(database.getPendingProposals());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Approve proposal
    app.post('/api/proposals/:id/approve', async (req, res) => {
        try {
            const result = database.approveProposal(req.params.id);
            // Re-embed all after new type added
            search.embedMissing().catch(err =>
                log('WARN', `Post-approval embed failed: ${err.message}`)
            );
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Reject proposal
    app.post('/api/proposals/:id/reject', (req, res) => {
        try {
            res.json(database.rejectProposal(req.params.id));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Edges (connections)
    app.get('/api/edges', (req, res) => {
        try {
            const edges = database.queryAll(`
                SELECT e.*, s.type as source_type, s.summary as source_summary,
                       t.type as target_type, t.summary as target_summary
                FROM edges e
                JOIN nodes s ON e.source_id = s.id
                JOIN nodes t ON e.target_id = t.id
                ORDER BY e.created_at DESC
            `);
            res.json(edges);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete edge
    app.delete('/api/edges/:id', (req, res) => {
        try {
            res.json(database.deleteEdge(req.params.id));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Snapshots
    app.get('/api/snapshots', (req, res) => {
        try {
            res.json(database.listSnapshots());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/snapshots', (req, res) => {
        try {
            const snapshotPath = database.createSnapshot(req.body.reason || 'manual_ui');
            res.json({ status: 'created', path: snapshotPath });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Export
    app.get('/api/export', (req, res) => {
        try {
            const data = database.exportJSON();
            res.setHeader('Content-Disposition', 'attachment; filename=karp-graph-export.json');
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Graph data (for D3 visualization)
    app.get('/api/graph', (req, res) => {
        try {
            const nodes = database.queryAll('SELECT id, type, summary, importance, tags, created_at FROM nodes')
                .map(n => ({ ...n, tags: JSON.parse(n.tags || '[]') }));
            const edges = database.queryAll('SELECT id, source_id, target_id, relationship FROM edges');
            res.json({ nodes, edges });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Start server
    const server = app.listen(UI_PORT, '127.0.0.1', () => {
        log('INFO', `Web UI available at http://localhost:${UI_PORT}`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log('WARN', `Port ${UI_PORT} in use — UI may already be running`);
        } else {
            log('ERROR', `Web UI server error: ${err.message}`);
        }
    });

    return server;
}

// ---------------------------------------------------------------------------
// MCP Protocol Handler
// ---------------------------------------------------------------------------

async function handleMessage(message) {
    const { method, id, params = {} } = message;

    // --- Initialize ---
    if (method === 'initialize') {
        log('INFO', `Initializing ${SERVER_NAME} v${VERSION}`);
        log('INFO', `Data path: ${DATA_PATH}`);

        // Configure modules (both async — sql.js needs WASM init)
        await database.configure(DATA_PATH);
        await embeddings.configure(DATA_PATH);
        await auth.configure(UI_PASSWORD);

        // Start web UI
        startWebUI();

        // Embed any nodes missing vectors (background)
        search.embedMissing().then(result => {
            if (result.total > 0) {
                log('INFO', `Background embed: ${result.embedded}/${result.total} nodes`);
            }
        }).catch(err => log('WARN', `Background embed error: ${err.message}`));

        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME, version: VERSION }
            }
        };
    }

    // --- Initialized notification ---
    if (method === 'notifications/initialized') {
        log('INFO', 'Client connected — Claude Desktop is ready');
        return null;
    }

    // --- List tools ---
    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0',
            id,
            result: { tools: TOOLS }
        };
    }

    // --- Call tool ---
    if (method === 'tools/call') {
        const toolName = params.name || '';
        const toolArgs = params.arguments || {};

        try {
            const result = await handleToolCall(toolName, toolArgs);
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                }
            };
        } catch (err) {
            log('ERROR', `Tool error [${toolName}]: ${err.message}`);
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ error: err.message })
                    }],
                    isError: true
                }
            };
        }
    }

    // --- Ping ---
    if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
    }

    // --- Unknown ---
    log('WARN', `Unknown method: ${method}`);
    return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
    };
}

// ---------------------------------------------------------------------------
// Main — stdio loop
// ---------------------------------------------------------------------------

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
        const message = JSON.parse(trimmed);
        const response = await handleMessage(message);
        if (response !== null) {
            process.stdout.write(JSON.stringify(response) + '\n');
        }
    } catch (err) {
        log('ERROR', `Parse error: ${err.message}`);
    }
});

log('INFO', `${SERVER_NAME} v${VERSION} starting (stdio mode)`);
log('INFO', `Data: ${DATA_PATH} | UI: http://localhost:${UI_PORT}`);
