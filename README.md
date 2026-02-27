# KARP Graph Lite

**A self-evolving personal knowledge graph for Claude Desktop.**

Built by [SoulDriver](https://souldriver.com.au) — Adelaide, Australia.

---

## What Is This?

KARP Graph Lite is an MCP (Model Context Protocol) extension that gives Claude Desktop persistent, structured memory with semantic search. It runs as a local Node.js server, stores everything in a portable SQLite database on the user's machine, and serves a web UI for browsing, editing, and visualizing the knowledge graph.

The user installs it as a `.mcpb` bundle through Claude Desktop's extension system. No config files, no API keys, no cloud services. Unpack, install, done.

**One sentence:** Claude gets a brain that remembers across conversations, and the user gets a visual dashboard to see and manage everything Claude remembers.

---

## Why Does This Exist?

Claude Desktop has a built-in memory system, but it's a black box. Users can't see what's stored, can't edit it, can't export it, can't structure it, and can't evolve it. Graph Lite fixes all of that:

| Claude's Built-in Memory | KARP Graph Lite |
|--------------------------|-----------------|
| Black box — user can't see what's stored | Transparent — full web UI, every node visible |
| Unstructured text blobs | Typed nodes: memory, todo, decision, insight, etc. |
| No editing or deletion | Full CRUD — create, read, update, delete |
| No export | Export to JSON, SQLite backup, snapshots |
| No connections between memories | Named relationships: `led_to`, `contradicts`, `part_of` |
| No search beyond keyword | Semantic search using vector embeddings |
| Fixed schema | Self-evolving — user adds custom types through conversation |
| Cloud-dependent | 100% local, works offline, user owns the file |

---

## Security

### Overview

KARP Graph Lite is a local-first tool. Your data never leaves your machine. There is no cloud sync, no telemetry, no analytics, no external API calls (except the one-time embedding model download on first run).

### Web UI Protection

The web UI runs on `localhost:3456` and is protected by a passphrase-based session authentication system:

- **Password set during installation** — Claude Desktop prompts for a passphrase when you install the extension. This is hashed using Node.js built-in `crypto.scrypt` (no external dependencies) and verified on every web UI visit.
- **Session cookies** — After successful login, a session cookie is set. Choose "Remember this device" for a 30-day session, or leave unchecked for a 24-hour session that expires when you close your browser.
- **Express middleware** — All `/api/*` routes are protected. Unauthenticated requests receive a `401` response.
- **MCP tools are unaffected** — Claude Desktop communicates via stdio (standard input/output), not HTTP. The passphrase only protects the web UI, not Claude's ability to use the knowledge graph tools.

### Network Safety

- The Express server binds to `127.0.0.1` (localhost only). It is not accessible from other devices on your network by default.
- **Shared/public networks**: If your machine's firewall allows inbound connections on port 3456, other devices on the same network could potentially access the UI. Always set a passphrase if you're on a shared or public network.
- The "Remember this device" checkbox should **only** be used on a trusted personal computer.

### Data at Rest

- `graph.db` is a **plain unencrypted SQLite file**. Anyone with access to the file can read its contents.
- Store your data folder in a location with appropriate file system permissions.
- **Do not store passwords, API keys, credit card numbers, or other secrets** in the knowledge graph. It is designed for notes, insights, decisions, and structured knowledge — not credential storage.
- Snapshots (backups) are also unencrypted SQLite copies in the `snapshots/` subfolder.

### Embedding Model

- The BGE-small-en-v1.5 model (~130MB) is downloaded once from Hugging Face on first run and cached in your data folder under `models/`.
- After the initial download, no further network requests are made by the extension.

### What We Don't Collect

- No usage analytics
- No crash reporting
- No telemetry
- No user data transmission
- No cloud accounts required

Your knowledge graph is yours. Period.

---

## Architecture

### Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Runtime | Node.js (Claude Desktop's built-in) | Zero installation required |
| MCP Server | Custom stdio handler | Direct protocol implementation, no framework overhead |
| Database | sql.js (SQLite compiled to WebAssembly) | Universal compatibility — no native module compilation. We originally used better-sqlite3 but it crashes in Claude Desktop's bundled Node.js due to ABI mismatch |
| Embeddings | @xenova/transformers + BGE-small-en-v1.5 | 384-dimension vectors, ONNX runtime, ~130MB model cached locally |
| Web UI | Express serving a single HTML file | Dashboard, browse, D3 graph visualization, type manager, settings |
| Auth | Node.js crypto.scrypt | Passphrase hashing with zero external dependencies |
| Package | .mcpb bundle (ZIP with manifest) | Claude Desktop's native extension format |

### File Structure

```
karp-graph-lite/
├── package.json              # Dependencies: sql.js, @xenova/transformers, express
├── config/
│   └── manifest.json         # MCP extension manifest — tools, user config, metadata
├── server/
│   ├── index.js              # MCP protocol handler + Express web server + tool router
│   ├── database.js           # sql.js wrapper — schema, CRUD, migrations, snapshots
│   ├── embeddings.js         # BGE-small via transformers.js — embed, similarity
│   ├── search.js             # Semantic search, keyword search, re-embed pipeline
│   └── auth.js               # Passphrase auth, session management, Express middleware
├── ui/
│   └── index.html            # Single-file web UI (CSS + JS inline, D3.js for graph)
├── assets/
│   └── icon.png              # SoulDriver extension icon
├── scripts/
│   └── build_mcpb.js         # Bundle builder — stages, installs prod deps, zips
└── dist/
    └── karp-graph-lite.mcpb  # Distributable bundle
```

### Data Storage (User's Machine)

```
[user-chosen-folder]/
├── graph.db                  # SQLite database (single file, portable)
├── snapshots/                # Auto and manual backups (SQLite copies)
└── models/                   # Cached BGE-small embedding model (~130MB)
```

The user chooses where this lives during installation. It's a single SQLite file. Copy it anywhere, back it up, share it. Zero lock-in. Data persists across extension reinstalls and updates.

---

## MCP Tools (What Claude Sees)

Claude Desktop registers these 11 tools when the extension loads:

### Knowledge Operations

| Tool | Purpose | Key Behavior |
|------|---------|-------------|
| `remember` | Store a new node | Accepts type, summary, detail, tags, importance, metadata. Auto-embeds for semantic search. Optional `connect_to` creates an edge in the same call. |
| `recall` | Semantic search | Embeds the query, compares against all stored vectors using cosine similarity. Returns ranked results with similarity scores. Finds by meaning, not keywords. |
| `forget` | Delete a node | Cascades: removes the node, its embedding, and all connected edges. Permanent. |
| `update` | Edit a node | Partial updates — only provided fields change. Metadata merges with existing. Auto re-embeds after update. |
| `connect` | Link two nodes | Named relationship (e.g. `led_to`, `contradicts`, `part_of`, `inspired_by`). Creates a directional edge. |
| `search` | Keyword search | LIKE-based search across summary, detail, context fields. Faster than recall but less intelligent. |
| `list` | Browse nodes | Filter by type, tags. Sort by created, updated, importance. Pagination via limit/offset. |

### Meta / Health Operations

| Tool | Purpose |
|------|---------|
| `kg_status` | Full health report: node counts by type, DB size, embedding coverage, available types, pending proposals, snapshot count |
| `propose_node_type` | Claude proposes a new custom type with field definitions. User approves in the web UI. Auto-snapshot before migration. |
| `snapshot` | Manual backup of the entire database. Auto-prunes to keep 20 most recent. |
| `re_embed` | Rebuild all vector embeddings. Used after adding new types or if search quality degrades. |

---

## Self-Evolving Schema

This is Graph Lite's defining feature. The knowledge graph ships with 6 base types, but users can add unlimited custom types through natural conversation with Claude.

### Base Types (Shipped)

| Type | Icon | Purpose |
|------|------|---------|
| `memory` | 💭 | Personal reflections, wisdom, notes, letters |
| `todo` | ✅ | Tasks with status tracking |
| `decision` | ⚖️ | Choices made and their rationale |
| `insight` | 💡 | Patterns noticed, learnings, observations |
| `dev_session` | 🔧 | Structured daily work logs |
| `changelog` | 📋 | Versioned release notes |

### Custom Type Creation Flow

```
1. User and Claude are chatting naturally
2. They realize a new type would be useful
   Example: "I keep tracking recipes, can we make that a proper type?"

3. Claude calls propose_node_type:
   → type_name: "recipe"
   → display_name: "Recipe"  
   → icon: "🍳"
   → fields: [name, ingredients[], method, cuisine, prep_time, rating]

4. Proposal appears in the web UI as a banner
   → User reviews fields and clicks [Approve] or [Reject]

5. On approval:
   a. Auto-snapshot taken (safety net)
   b. Type definition added to type_definitions table
   c. Migration logged in migrations table
   d. Claude immediately has the new type available
   e. UI updates with new filter option

6. Claude can now: remember type="recipe" summary="Nonna's carbonara" ...
```

### What This Means

Every user's knowledge graph becomes unique to their life and work:

- A **developer** has dev_session, changelog (base) + maybe `architecture_decision`, `bug_report`
- A **chef** has memory, insight (base) + `recipe`, `ingredient_note`, `menu_plan`
- A **lawyer** has decision, todo (base) + `case_brief`, `client_note`, `precedent`
- A **teacher** has insight, todo (base) + `lesson_plan`, `student_note`, `curriculum_map`
- A **researcher** has insight, decision (base) + `hypothesis`, `experiment`, `literature_note`

Same engine, infinite shapes. Schema evolution negotiated in natural language — no database knowledge required.

---

## Database Schema

All nodes share a single `nodes` table. Type-specific fields go in the JSON `metadata` column. This avoids table-per-type sprawl while keeping queries simple.

```sql
CREATE TABLE nodes (
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

CREATE TABLE edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE embeddings (
    node_id TEXT PRIMARY KEY,
    vector BLOB NOT NULL,
    model TEXT NOT NULL,
    embedded_at REAL NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE TABLE type_definitions (
    type_name TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    fields TEXT NOT NULL DEFAULT '[]',
    icon TEXT DEFAULT '📝',
    is_base_type INTEGER DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE pending_proposals (
    id TEXT PRIMARY KEY,
    type_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    fields TEXT NOT NULL DEFAULT '[]',
    icon TEXT DEFAULT '📝',
    proposed_at REAL NOT NULL,
    status TEXT DEFAULT 'pending'
);

CREATE TABLE migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_name TEXT NOT NULL,
    action TEXT NOT NULL,
    snapshot_path TEXT,
    fields_before TEXT,
    fields_after TEXT,
    created_at REAL NOT NULL
);
```

---

## Embedding Pipeline

- **Model:** BGE-small-en-v1.5 via `@xenova/transformers` (ONNX runtime), 384 dimensions
- **Text preparation:** Node fields concatenated as `[type] | summary | detail | context | Tags: ... | metadata...`, truncated to 2000 chars
- **Search:** Query embedded → cosine similarity against all stored vectors → ranked results
- **Auto-embed:** On `remember`, on `update`, on startup (background job for missing vectors), on `re_embed`

---

## Web UI

Served by Express on `localhost:3456` (configurable). Single HTML file with inline CSS and JavaScript. Protected by passphrase authentication.

| Page | Purpose |
|------|---------|
| **Dashboard** | Stats cards, nodes by type breakdown, recent activity, pending proposal banners |
| **Browse** | Search bar (semantic + keyword), type filter chips, node cards, detail modal |
| **Graph** | D3.js force-directed visualization. Nodes colored by type, sized by importance. Click, drag, zoom. |
| **Types** | Base and custom types, pending proposals with approve/reject, instructions for creating types |
| **Settings** | Database info, snapshot management, JSON export, security status, link to full KARP platform |

---

## Relationship to Full KARP Platform

KARP Graph Lite is a free consumer tool. The full KARP Research Engine is an enterprise platform:

| Aspect | Graph Lite | Full KARP |
|--------|-----------|-----------|
| Embeddings | BGE-small (384d), local | BGE-large (1024d), server-side |
| Vector Storage | sql.js (SQLite WASM) | Enterprise-grade vector storage |
| AI Models | Claude Desktop (single model) | 4 frontier models (Claude, GPT, Gemini, Grok) |
| Architecture | Single-user, local file | Multi-tenant, cloud, JWT auth, subscriptions |
| Use Case | Personal memory & notes | Institutional-grade research, 13-turn deliberation |
| Price | Free | Subscription tiers (PAYG to Enterprise) |

Graph Lite is the free personal edition of the KARP knowledge graph architecture — the same design principles, scaled for individual use.

---

## Product Family

1. **KARP Inspector Lite** — Semantic codebase search for Claude Desktop
2. **KARP Graph Lite** — Personal knowledge graph for Claude Desktop (this project)
3. **Full KARP Platform** — Multi-AI deliberation engine at [souldriver.com.au](https://souldriver.com.au)

---

## Key Engineering Decisions

### sql.js over better-sqlite3

better-sqlite3 is a native C++ module that crashes in Claude Desktop's bundled Node.js due to ABI mismatch. Replaced with sql.js (SQLite compiled to WebAssembly) for universal compatibility. Trade-off: manual save-to-disk via debounced writes every 2 seconds.

### Single `nodes` Table

Custom types store fields in the JSON `metadata` column rather than separate tables. Schema evolution is non-destructive — adding a type only requires an INSERT, not a CREATE TABLE.

### No File Processing

Graph Lite does NOT process documents. Claude Desktop reads files natively. The flow is: user gives Claude a document → Claude reads it → Claude calls `remember` to store insights. File processing is planned as a separate product.

### Passphrase Auth (Not OAuth/JWT)

Local tool needs local auth. Node's built-in `crypto.scrypt` handles hashing — zero external dependencies. Session cookies with configurable duration. No accounts, no cloud auth providers.

---

## Current Status

- **Version:** 1.0.1
- **Status:** Stable — shipped and tested on Claude Desktop (Chat + Code tabs)

---

## How to Build

```bash
cd Karp_Graph_Lite
npm install
npm run build    # Creates dist/karp-graph-lite.mcpb
```

## How to Install

1. Open Claude Desktop
2. Settings → Extensions → Install Extension
3. Select `dist/karp-graph-lite.mcpb`
4. Choose a data folder when prompted
5. Set a passphrase (recommended for shared networks)
6. Open `http://localhost:3456` to see your graph

## How to Test (Manual)

```bash
DATA_PATH=./test_data UI_PORT=3456 UI_PASSWORD=yourpassphrase node server/index.js
```

---

## License

MIT — SoulDriver (Adelaide, Australia)

**The full KARP Research Engine uses enterprise-grade vector storage, multi-AI deliberation across four frontier models, and a knowledge graph architecture built for institutional-scale research. Graph Lite is the free personal edition.**

[souldriver.com.au](https://souldriver.com.au)
