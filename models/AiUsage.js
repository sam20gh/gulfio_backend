const mongoose = require('mongoose');

/**
 * AiUsage — per-call telemetry for AI endpoints (brief, factcheck, future RAG).
 *
 * Captured fire-and-forget after each successful or failed AI call so we can:
 *   - bill publishers per-key (v2)
 *   - monitor model spend and latency
 *   - debug cache hit ratios
 *   - rate-limit abusive callers post-hoc
 *
 * Index on (apiKeyId | userId, createdAt) supports usage-window queries.
 */
const aiUsageSchema = new mongoose.Schema({
    endpoint: { type: String, required: true, index: true }, // 'brief' | 'factcheck'
    engine: { type: String, default: 'llm_only' },          // 'llm_only' | 'gulfio_rag' (v2)
    model: { type: String },
    userId: { type: String, index: true },                  // supabase sub
    apiKeyId: { type: String, index: true },                // v2: publisher API key ref
    articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
    contentHash: { type: String },                          // when content sent in body (publishers)
    language: { type: String },
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    cacheHit: { type: Boolean, default: false },
    status: { type: String, default: 'ok' },                // 'ok' | 'error' | 'rate_limited'
    errorMessage: { type: String },
    createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

aiUsageSchema.index({ userId: 1, createdAt: -1 });
aiUsageSchema.index({ apiKeyId: 1, createdAt: -1 });
aiUsageSchema.index({ endpoint: 1, createdAt: -1 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
