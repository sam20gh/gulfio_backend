/**
 * Persisted PCA Model (P3-3).
 *
 * The 1536D → 128D PCA used to be trained from scratch on every cold
 * boot, against whatever articles/reels happened to be in the DB at
 * that moment. If the content distribution shifts and the process
 * restarts, every embedding ever produced silently lives in a slightly
 * different 128-D basis — broken vector search, drifted user
 * embeddings, no clear signal.
 *
 * Persist the trained model so boots are deterministic. Retrain
 * happens only on a manual trigger.
 *
 * Document shape:
 *   { name: 'article_embedding_pca_v1', model: <ml-pca toJSON()>, ... }
 * Size: ~2-4 MB (well under Mongo's 16MB doc limit).
 */
const mongoose = require('mongoose');

const PCAModelSchema = new mongoose.Schema({
    name: { type: String, unique: true, required: true },
    // ml-pca toJSON() output; opaque to us — we just hand it back to PCA.load()
    model: { type: mongoose.Schema.Types.Mixed, required: true },
    components: { type: Number },
    sampleCount: { type: Number },
    trainedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PCAModel', PCAModelSchema);
