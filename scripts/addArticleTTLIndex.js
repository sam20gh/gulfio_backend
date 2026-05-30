// scripts/addArticleTTLIndex.js
//
// Adds (or updates) a TTL index on the `articles` collection so that articles are
// automatically deleted ~9 months after their `publishedAt` date. Atlas performs the
// deletion server-side in the background, so this works even over a flaky client
// connection — unlike a large client-driven deleteMany loop.
//
// This is a fast metadata operation (collMod), not a bulk write.
//
// Usage:
//   node scripts/addArticleTTLIndex.js              # apply 9-month TTL
//   node scripts/addArticleTTLIndex.js --days=300   # override the age threshold
//
require('dotenv').config();
const mongoose = require('mongoose');

const COLLECTION = 'articles';
const KEY = { publishedAt: -1 }; // matches the existing index in models/Article.js

function parseDays() {
    const arg = process.argv.slice(2).find(a => a.startsWith('--days='));
    if (!arg) return 274; // ~9 months
    const days = parseInt(arg.split('=')[1], 10);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid --days value: ${arg}`);
    return days;
}

async function run() {
    const days = parseDays();
    const expireAfterSeconds = days * 24 * 60 * 60;

    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
    });
    console.log('🗄️  Connected to MongoDB');

    const db = mongoose.connection.db;
    const coll = db.collection(COLLECTION);

    try {
        // Show existing indexes for context.
        const before = await coll.indexes();
        const existing = before.find(ix => JSON.stringify(ix.key) === JSON.stringify(KEY));
        console.log(`🔎 Existing publishedAt index: ${existing ? existing.name : '(none)'}` +
            (existing && existing.expireAfterSeconds != null
                ? ` (TTL ${existing.expireAfterSeconds}s)` : ' (no TTL)'));

        if (existing) {
            // Convert / update the existing index to TTL via collMod (fast, metadata only).
            const res = await db.command({
                collMod: COLLECTION,
                index: { keyPattern: KEY, expireAfterSeconds },
            });
            console.log(`✅ collMod applied. expireAfterSeconds: ${res.expireAfterSeconds_old ?? '(none)'} → ${res.expireAfterSeconds_new ?? expireAfterSeconds}`);
        } else {
            // No index on publishedAt yet — create the TTL index directly.
            await coll.createIndex(KEY, { expireAfterSeconds });
            console.log('✅ Created new TTL index on publishedAt');
        }

        const after = await coll.indexes();
        const ttl = after.find(ix => JSON.stringify(ix.key) === JSON.stringify(KEY));
        console.log(`🎯 publishedAt index now: ${ttl.name}, expireAfterSeconds=${ttl.expireAfterSeconds}` +
            ` (~${Math.round(ttl.expireAfterSeconds / 86400)} days)`);
        console.log('🧹 Atlas will delete the existing backlog of old articles in the background over the next minutes/hours.');
    } catch (err) {
        console.error('❌ Error applying TTL index:', err);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

run();
