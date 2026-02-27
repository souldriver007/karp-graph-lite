// ============================================================================
// KARP Graph Lite — Search Module
// Version: 1.0.0
// Author: SoulDriver (Adelaide, Australia)
// Description: Semantic search (vector similarity) and keyword search across
//              the knowledge graph. Combines database queries with embeddings.
// License: MIT
// ============================================================================

const database = require('./database');
const embeddings = require('./embeddings');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg) {
    process.stderr.write(`${new Date().toISOString()} [SEARCH:${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Semantic Search (Vector Similarity)
// ---------------------------------------------------------------------------

async function semanticSearch(query, { limit = 10, type = null, minSimilarity = 0.3 } = {}) {
    // Embed the query
    const queryVector = await embeddings.embed(query);

    // Get all embeddings from DB
    const allEmbeddings = database.getAllEmbeddings();

    if (allEmbeddings.length === 0) {
        return {
            results: [],
            message: 'No embeddings found. The knowledge graph may be empty or embeddings need to be rebuilt (use re_embed).'
        };
    }

    // Calculate similarities
    let scored = allEmbeddings.map(emb => ({
        node_id: emb.node_id,
        similarity: embeddings.cosineSimilarity(queryVector, emb.vector)
    }));

    // Filter by minimum similarity
    scored = scored.filter(s => s.similarity >= minSimilarity);

    // Sort by similarity (descending)
    scored.sort((a, b) => b.similarity - a.similarity);

    // If type filter, we need to check node types
    if (type) {
        const db = database.getDb();
        const typeSet = new Set(
            db.prepare('SELECT id FROM nodes WHERE type = ?').all(type).map(r => r.id)
        );
        scored = scored.filter(s => typeSet.has(s.node_id));
    }

    // Take top N
    scored = scored.slice(0, limit);

    // Hydrate with full node data
    const results = scored.map(s => {
        const node = database.getNode(s.node_id);
        if (!node) return null;
        return {
            ...node,
            similarity: Math.round(s.similarity * 1000) / 1000
        };
    }).filter(Boolean);

    log('INFO', `Semantic search "${query}" → ${results.length} results (top similarity: ${results[0]?.similarity || 0})`);

    return { results, query, total_embeddings: allEmbeddings.length };
}

// ---------------------------------------------------------------------------
// Keyword Search
// ---------------------------------------------------------------------------

function keywordSearch(query, { limit = 20, type = null } = {}) {
    let results = database.searchKeyword(query, limit * 2); // Fetch extra for filtering

    if (type) {
        results = results.filter(r => r.type === type);
    }

    results = results.slice(0, limit);

    log('INFO', `Keyword search "${query}" → ${results.length} results`);
    return { results, query };
}

// ---------------------------------------------------------------------------
// Combined Search (semantic + keyword, deduplicated)
// ---------------------------------------------------------------------------

async function combinedSearch(query, { limit = 10, type = null } = {}) {
    const [semantic, keyword] = await Promise.all([
        semanticSearch(query, { limit, type }),
        Promise.resolve(keywordSearch(query, { limit, type }))
    ]);

    // Merge and deduplicate, preferring semantic results
    const seen = new Set();
    const merged = [];

    // Semantic results first (higher quality)
    for (const r of semantic.results) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            merged.push({ ...r, match_type: 'semantic' });
        }
    }

    // Then keyword results that weren't in semantic
    for (const r of keyword.results) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            merged.push({ ...r, match_type: 'keyword', similarity: 0 });
        }
    }

    return {
        results: merged.slice(0, limit),
        query,
        semantic_count: semantic.results.length,
        keyword_count: keyword.results.length
    };
}

// ---------------------------------------------------------------------------
// Embed Node (create/update embedding for a single node)
// ---------------------------------------------------------------------------

async function embedNode(nodeId) {
    const node = database.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const text = embeddings.prepareNodeText(node);
    const vector = await embeddings.embed(text);

    database.storeEmbedding(nodeId, vector, embeddings.MODEL_NAME);

    return { node_id: nodeId, embedded: true, text_length: text.length };
}

// ---------------------------------------------------------------------------
// Re-embed All (rebuild all vectors)
// ---------------------------------------------------------------------------

async function reEmbedAll(progressCallback) {
    const db = database.getDb();
    const nodes = db.prepare('SELECT id, type, summary, detail, context, tags, metadata FROM nodes').all();

    if (nodes.length === 0) {
        return { total: 0, embedded: 0, message: 'No nodes to embed.' };
    }

    log('INFO', `Re-embedding ${nodes.length} nodes...`);

    let embedded = 0;
    let errors = 0;

    for (const node of nodes) {
        try {
            const text = embeddings.prepareNodeText(node);
            const vector = await embeddings.embed(text);
            database.storeEmbedding(node.id, vector, embeddings.MODEL_NAME);
            embedded++;

            if (progressCallback && embedded % 10 === 0) {
                progressCallback(embedded, nodes.length);
            }
        } catch (err) {
            log('ERROR', `Failed to embed ${node.id}: ${err.message}`);
            errors++;
        }
    }

    log('INFO', `Re-embedding complete: ${embedded}/${nodes.length} succeeded, ${errors} errors`);

    return {
        total: nodes.length,
        embedded,
        errors,
        model: embeddings.MODEL_NAME,
        dimensions: embeddings.EMBEDDING_DIM
    };
}

// ---------------------------------------------------------------------------
// Embed Missing (only nodes without embeddings)
// ---------------------------------------------------------------------------

async function embedMissing() {
    const missing = database.getNodesWithoutEmbeddings();

    if (missing.length === 0) {
        return { total: 0, message: 'All nodes have embeddings.' };
    }

    log('INFO', `Embedding ${missing.length} nodes without vectors...`);

    let embedded = 0;
    for (const node of missing) {
        try {
            const text = embeddings.prepareNodeText(node);
            const vector = await embeddings.embed(text);
            database.storeEmbedding(node.id, vector, embeddings.MODEL_NAME);
            embedded++;
        } catch (err) {
            log('ERROR', `Failed to embed ${node.id}: ${err.message}`);
        }
    }

    return { total: missing.length, embedded, model: embeddings.MODEL_NAME };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    semanticSearch,
    keywordSearch,
    combinedSearch,
    embedNode,
    reEmbedAll,
    embedMissing
};
