/**
 * Re-index articles since March 16, 2026
 * Generates missing `embedding` (1536D) and `embedding_pca` (128D) for each article.
 *
 * Usage:
 *   MONGO_URI=... OPENAI_API_KEY=... node scripts/reindexSinceMarch16.js
 *
 * Optional env:
 *   SINCE_DATE   - override cutoff date (ISO string, default: 2026-03-16)
 *   BATCH_DELAY  - ms between batches (default: 200)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { convertToPCAEmbedding, initializePCAModel } = require('../utils/pcaEmbedding');

const SINCE_DATE = new Date(process.env.SINCE_DATE || '2026-03-16T00:00:00.000Z');
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY || '200', 10);
const BATCH_SIZE = 10;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI not set');
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Find articles since March 16 that are missing either embedding
    const articles = await Article.find({
        publishedAt: { $gte: SINCE_DATE },
        $or: [
            { embedding: { $exists: false } },
            { embedding: { $size: 0 } },
            { embedding_pca: { $exists: false } },
            { embedding_pca: { $size: 0 } },
        ]
    }).select('_id title content embedding embedding_pca publishedAt').lean();

    console.log(`📋 Found ${articles.length} articles to process since ${SINCE_DATE.toISOString()}`);

    // Warm up the PCA model once before looping — it reads ~3k articles from DB
    console.log('🔄 Warming up PCA model...');
    await initializePCAModel();
    console.log('✅ PCA model ready');

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (article) => {
            try {
                const needsEmbedding = !article.embedding || article.embedding.length === 0;
                const needsPCA = !article.embedding_pca || article.embedding_pca.length === 0;

                let embedding = article.embedding;

                if (needsEmbedding) {
                    const text = `${article.title}\n\n${article.content?.slice(0, 512) || ''}`;
                    embedding = await getDeepSeekEmbedding(text);
                }

                let pcaEmbedding = null;
                if (needsPCA && embedding && embedding.length === 1536) {
                    pcaEmbedding = await convertToPCAEmbedding(embedding);
                }

                const update = {};
                if (needsEmbedding && embedding) update.embedding = embedding;
                if (needsPCA && pcaEmbedding) update.embedding_pca = pcaEmbedding;

                if (Object.keys(update).length > 0) {
                    await Article.updateOne({ _id: article._id }, { $set: update });
                }

                succeeded++;
                const pct = Math.round(((i + batch.indexOf(article) + 1) / articles.length) * 100);
                console.log(`✅ [${pct}%] ${article.title?.slice(0, 60)}`);
            } catch (err) {
                failed++;
                console.error(`❌ Failed ${article._id}: ${err.message}`);
            }
        }));

        if (i + BATCH_SIZE < articles.length) {
            await sleep(BATCH_DELAY);
        }
    }

    console.log(`\n🏁 Done. Succeeded: ${succeeded}, Failed: ${failed}`);
    await mongoose.disconnect();
}

run().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
