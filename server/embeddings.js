// ============================================================================
// KARP Graph Lite — Embeddings Layer (transformers.js)
// Version: 1.0.0
// Author: SoulDriver (Adelaide, Australia)
// Description: Semantic embedding using BGE-small-en-v1.5 via transformers.js.
//              Same model as Inspector Lite — ONNX runtime, no Python needed.
//              Downloads model on first run (~130MB), cached locally after.
// License: MIT
// ============================================================================

const path = require('path');

let pipeline = null;
let extractor = null;
let isReady = false;
let modelPath = '';

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const EMBEDDING_DIM = 384;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg) {
    process.stderr.write(`${new Date().toISOString()} [EMBED:${level}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

async function configure(dataPath) {
    modelPath = path.join(dataPath, 'models');

    // Dynamic import for ES module
    const { pipeline: pipelineFn } = await import('@xenova/transformers');
    pipeline = pipelineFn;

    log('INFO', `Embedding model: ${MODEL_NAME} (${EMBEDDING_DIM}d)`);
    log('INFO', `Model cache: ${modelPath}`);
}

async function ensureReady() {
    if (isReady && extractor) return;

    log('INFO', 'Loading embedding model (first run downloads ~130MB)...');

    extractor = await pipeline('feature-extraction', MODEL_NAME, {
        cache_dir: modelPath,
        quantized: true
    });

    isReady = true;
    log('INFO', 'Embedding model loaded and ready');
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

async function embed(text) {
    await ensureReady();

    // BGE-small works best with instruction prefix for retrieval
    const input = `Represent this sentence for retrieval: ${text}`;

    const output = await extractor(input, { pooling: 'cls', normalize: true });
    return Array.from(output.data);
}

async function embedBatch(texts, batchSize = 16) {
    await ensureReady();

    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const inputs = batch.map(t => `Represent this sentence for retrieval: ${t}`);

        // Process one at a time (transformers.js doesn't batch well in Node)
        for (const input of inputs) {
            const output = await extractor(input, { pooling: 'cls', normalize: true });
            results.push(Array.from(output.data));
        }

        if (texts.length > batchSize) {
            log('INFO', `Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// Text Preparation
// ---------------------------------------------------------------------------

function prepareNodeText(node) {
    // Combine relevant fields for embedding
    const parts = [];

    if (node.type) parts.push(`[${node.type}]`);
    if (node.summary) parts.push(node.summary);
    if (node.detail) parts.push(node.detail);
    if (node.context) parts.push(node.context);

    // Include tags
    const tags = typeof node.tags === 'string' ? JSON.parse(node.tags || '[]') : (node.tags || []);
    if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);

    // Include metadata keys that have string values
    const meta = typeof node.metadata === 'string' ? JSON.parse(node.metadata || '{}') : (node.metadata || {});
    for (const [key, value] of Object.entries(meta)) {
        if (typeof value === 'string' && value.length > 0) {
            parts.push(`${key}: ${value}`);
        } else if (Array.isArray(value) && value.length > 0) {
            parts.push(`${key}: ${value.join(', ')}`);
        }
    }

    return parts.join(' | ').substring(0, 2000); // Truncate for model context window
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    configure,
    ensureReady,
    embed,
    embedBatch,
    prepareNodeText,
    cosineSimilarity,
    MODEL_NAME,
    EMBEDDING_DIM,
    isReady: () => isReady
};
