// scripts/measurePersonalized.js — measure the /personalized hot paths. Read-only.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000 });
    const Article = require('../models/Article');
    const lang = 'english';
    const VECTOR_INDEX = 'article_embeddings_pca';

    const time = async (label, fn) => {
        const t = Date.now();
        try { const r = await fn(); console.log(`⏱️  ${label}: ${Date.now() - t}ms → ${r}`); }
        catch (e) { console.log(`❌ ${label}: ${Date.now() - t}ms ERROR ${e.codeName || e.message}`); }
    };

    // grab a real 128-d query vector + ~200 exclude ids to mimic a logged-in user
    const seed = await Article.findOne({ embedding_pca: { $exists: true, $not: { $size: 0 } } }).select('embedding_pca').lean();
    const qv = seed?.embedding_pca;
    console.log(`query vector dims: ${qv?.length}`);
    const someIds = (await Article.find({}).select('_id').limit(200).lean()).map(d => d._id);
    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 1) Does Atlas $vectorSearch even work right now?
    await time('vectorSearch probe', async () => {
        const r = await Article.aggregate([
            { $vectorSearch: { index: VECTOR_INDEX, path: 'embedding_pca', queryVector: qv, numCandidates: 50, limit: 10,
                filter: { language: lang, publishedAt: { $gte: cutoff7d } } } },
            { $project: { _id: 1 } }
        ], { maxTimeMS: 5000 });
        return `${r.length} hits`;
    });

    // 2) Fast-fallback query WITH the two-field sort (index I dropped) + big $nin.
    const fbExplain = await Article.find({ language: lang, _id: { $nin: someIds }, publishedAt: { $gte: cutoff7d } })
        .sort({ publishedAt: -1, viewCount: -1 }).limit(30).explain('executionStats');
    const ex = fbExplain.executionStats || {};
    console.log(`\n📋 FAST FALLBACK find({lang,_id:$nin200,publishedAt:$gte7d}).sort({publishedAt:-1,viewCount:-1}).limit(30)`);
    console.log(`   plan: ${JSON.stringify(fbExplain.queryPlanner?.winningPlan).match(/"stage":"(\w+)"/g)?.join(' > ')}`);
    console.log(`   executionTimeMillis: ${ex.executionTimeMillis}, docsExamined: ${ex.totalDocsExamined}, keysExamined: ${ex.totalKeysExamined}, returned: ${ex.nReturned}, hasSortStage: ${/SORT/.test(JSON.stringify(fbExplain.queryPlanner?.winningPlan))}`);

    await time('fast-fallback fetch .lean()', async () => {
        const r = await Article.find({ language: lang, _id: { $nin: someIds }, publishedAt: { $gte: cutoff7d } })
            .select('title summary image sourceId source publishedAt viewCount category likes dislikes likedBy dislikedBy')
            .sort({ publishedAt: -1, viewCount: -1 }).limit(30).lean();
        return `${r.length} docs`;
    });

    // 3) Same fallback but sort by publishedAt ONLY (what the kept index supports).
    const fb2 = await Article.find({ language: lang, _id: { $nin: someIds }, publishedAt: { $gte: cutoff7d } })
        .sort({ publishedAt: -1 }).limit(30).explain('executionStats');
    const ex2 = fb2.executionStats || {};
    console.log(`\n📋 FALLBACK with sort {publishedAt:-1} ONLY → execTime: ${ex2.executionTimeMillis}ms, docsExamined: ${ex2.totalDocsExamined}, hasSortStage: ${/SORT/.test(JSON.stringify(fb2.queryPlanner?.winningPlan))}`);

    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
