// scripts/measureFeed.js — measure the real feed queries (explain + wall-clock). Read-only.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000 });
    const Article = require('../models/Article');
    const lang = 'english';

    async function timeIt(label, fn) {
        const t = Date.now();
        try { const r = await fn(); console.log(`⏱️  ${label}: ${Date.now() - t}ms  → ${r}`); }
        catch (e) { console.log(`❌ ${label}: ${Date.now() - t}ms ERROR ${e.codeName || e.message}`); }
    }

    // 1) Public feed query (GET /): find by language, sort publishedAt desc, limit 31.
    const feedExplain = await Article.find({ language: lang })
        .sort({ publishedAt: -1 }).limit(31)
        .explain('executionStats');
    const exec = feedExplain.executionStats || {};
    const win = feedExplain.queryPlanner?.winningPlan || {};
    const stage = JSON.stringify(win).match(/"stage":"(\w+)"/g)?.join(' > ');
    console.log(`\n📋 FEED find({language}).sort({publishedAt:-1}).limit(31)`);
    console.log(`   plan: ${stage}`);
    console.log(`   index: ${JSON.stringify(win.inputStage?.indexName || win.inputStage?.inputStage?.indexName || '(none/COLLSCAN)')}`);
    console.log(`   executionTimeMillis: ${exec.executionTimeMillis}, docsExamined: ${exec.totalDocsExamined}, keysExamined: ${exec.totalKeysExamined}, returned: ${exec.nReturned}`);

    // 2) Wall-clock the actual fetch with the full projection used by the route.
    await timeIt('feed fetch (.select content...).lean()', async () => {
        const r = await Article.find({ language: lang })
            .select('title content contentFormat url category publishedAt image viewCount likes dislikes likedBy dislikedBy sourceId language')
            .sort({ publishedAt: -1 }).limit(31).lean();
        const bytes = Buffer.byteLength(JSON.stringify(r));
        return `${r.length} docs, ${(bytes / 1e6).toFixed(2)} MB payload`;
    });

    // 3) Category distinct (what populates categories, if done server-side anywhere).
    await timeIt('distinct(category){language}', async () => {
        const c = await Article.distinct('category', { language: lang }).maxTimeMS(20000);
        return `${c.length} categories: ${c.slice(0, 12).join(', ')}`;
    });

    // 4) estimatedDocumentCount (used for pagination).
    await timeIt('estimatedDocumentCount', async () => await Article.estimatedDocumentCount());

    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
