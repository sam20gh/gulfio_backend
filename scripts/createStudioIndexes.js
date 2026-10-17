/**
 * Indexes for Gulfio Studio (routes/studio.js). Run once against prod:
 *
 *   node scripts/createStudioIndexes.js            # dry run: prints what it would build
 *   node scripts/createStudioIndexes.js --apply
 *
 * autoIndex is off in production, so nothing here is created by Mongoose on boot.
 *
 * articles.studio_cover — lets the overview facets, per-source stats and the
 * "rank by views/likes/comments within a window" queries run as covered index
 * scans instead of fetching full article documents (content + vectors), which on
 * cold (>7 day old) data is the difference between ~0.2s and 10–30s.
 * Expect roughly 50–70 MB for ~550k articles. Built with the default (hybrid)
 * build, which does not lock the collection, but it does use CPU — run off-peak.
 *
 * payouts — the unique {groupName, period} guard against double statements.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const SPECS = [
    {
        collection: 'articles',
        key: { publishedAt: -1, sourceId: 1, viewCount: 1, likes: 1, dislikes: 1, commentCount: 1, category: 1, language: 1, _id: 1 },
        options: { name: 'studio_cover' },
    },
    {
        collection: 'payouts',
        key: { groupName: 1, period: 1 },
        options: { name: 'groupName_1_period_1', unique: true },
    },
    {
        collection: 'payouts',
        key: { status: 1, periodStart: -1 },
        options: { name: 'status_1_periodStart_-1' },
    },
];

(async () => {
    // Index builds on ~550k articles outlast the default socket timeout; wait as long as it takes.
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, socketTimeoutMS: 0 });
    const db = mongoose.connection.db;

    for (const spec of SPECS) {
        const existing = await db.collection(spec.collection).indexes().catch(() => []);
        if (existing.some((i) => i.name === spec.options.name)) {
            console.log(`✓ ${spec.collection}.${spec.options.name} already exists`);
            continue;
        }
        if (!APPLY) {
            console.log(`• would create ${spec.collection}.${spec.options.name}`, JSON.stringify(spec.key));
            continue;
        }
        const started = Date.now();
        await db.collection(spec.collection).createIndex(spec.key, spec.options);
        console.log(`✅ created ${spec.collection}.${spec.options.name} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }

    if (!APPLY) console.log('\nDry run. Re-run with --apply to build.');
    await mongoose.disconnect();
})().catch((err) => {
    if (err.name === 'MongoNetworkTimeoutError') {
        // The build keeps running on Atlas after the client drops — re-run this script
        // in a few minutes; it reports "already exists" once the build has finished.
        console.error('Connection dropped; the build likely continues server-side. Re-run in a few minutes to confirm.');
    }
    console.error(err);
    process.exit(1);
});
