// scripts/ensurePCAModel.js
//
// Ensures a persisted PCA model exists in Mongo. Without it, EVERY backend instance
// and scraper run retrains PCA from the corpus — a full collscan loading thousands of
// 1536-dim embeddings — which saturates CPU under autoscaling (the "PCA death spiral").
//
// This runs ONE controlled training (if needed) and persists it, so all processes
// load it instantly afterwards. Safe: it will NOT overwrite a healthy existing model.
//
// Usage:
//   node scripts/ensurePCAModel.js           # create only if missing/broken
//   node scripts/ensurePCAModel.js --force   # force retrain + overwrite (invalidates basis)
//
require('dotenv').config();
const mongoose = require('mongoose');
const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');

// Small sample — a PCA basis for 128 components needs >=128 rows; a few hundred is plenty
// and the bounded collscan completes fast even on an overloaded cluster (unlike 3000+2000).
const SAMPLE = parseInt((process.argv.find(a => a.startsWith('--sample=')) || '').split('=')[1], 10) || 600;
const MAX_TIME_MS = 90000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withRetry(label, fn, retries = 8) {
    for (let attempt = 1; ; attempt++) {
        try { return await fn(); }
        catch (err) {
            if (attempt > retries) throw err;
            const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000);
            console.warn(`⚠️  ${label} retry ${attempt}/${retries}: ${err.name || err.message}`);
            await sleep(backoff);
        }
    }
}

async function run() {
    const force = process.argv.includes('--force');
    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000,
        socketTimeoutMS: 120000, retryWrites: true,
    });
    console.log('🗄️  Connected');

    const PCAModel = require('../models/PCAModel');
    const Article = require('../models/Article');
    const NAME = 'article_embedding_pca_v1';

    const existing = await PCAModel.findOne({ name: NAME }).lean();
    if (existing?.model && !force) {
        try {
            PCA.load(existing.model);
            console.log(`✅ Persisted PCA already exists and hydrates OK ` +
                `(${existing.components} components, ${existing.sampleCount} samples, trained ${existing.trainedAt}).`);
            console.log('   If collscans persist, stale/old-revision instances are still serving (check Cloud Run rollout).');
            await mongoose.disconnect();
            return;
        } catch (e) {
            console.warn(`⚠️ Persisted PCA exists but FAILS to hydrate: ${e.message} — will retrain.`);
        }
    }

    console.log(`ℹ️ Training a stable PCA basis from ${SAMPLE} article embeddings (one bounded scan)...`);
    const docs = await Article.find({ embedding: { $exists: true, $ne: null } })
        .limit(SAMPLE)
        .select('embedding')
        .maxTimeMS(MAX_TIME_MS)
        .lean();

    const valid = docs.map(d => d.embedding).filter(e => Array.isArray(e) && e.length === 1536);
    console.log(`📊 Got ${valid.length} valid 1536-D embeddings`);
    if (valid.length < 150) { console.error('❌ Not enough embeddings to train a 128-component PCA'); await mongoose.disconnect(); process.exit(1); }

    const pca = new PCA(new Matrix(valid), { center: true, scale: false });
    console.log(`✅ PCA trained — ${pca.getExplainedVariance().length} components`);

    // pca.toJSON() returns U/S as Matrix objects; Mongoose's Mixed type serializes those
    // into a shape PCA.load() can't parse. Plain-ify to nested arrays so it round-trips.
    const modelJSON = JSON.parse(JSON.stringify(pca.toJSON()));
    const components = pca.getExplainedVariance().length;
    await withRetry('persist PCA', () => PCAModel.updateOne(
        { name: NAME },
        { $set: { name: NAME, model: modelJSON, components, sampleCount: valid.length, trainedAt: new Date() } },
        { upsert: true }
    ));
    // Verify it landed and hydrates.
    const check = await withRetry('verify PCA', () => PCAModel.findOne({ name: NAME }).lean());
    PCA.load(check.model);
    console.log(`💾 Persisted + verified PCA "${NAME}" (${components} components). Cold starts will now LOAD this instead of scanning.`);

    await mongoose.disconnect();
    console.log('🔌 Disconnected');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
