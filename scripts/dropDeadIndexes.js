// scripts/dropDeadIndexes.js
//
// Drops dead / design-wrong indexes identified by scripts/auditIndexes.js.
// Curated, explicit list (not heuristic) — safe to review in version control.
//
// SAFETY:
//   - Never touches _id, unique, or TTL indexes.
//   - DRY RUN by default; pass --confirm to actually drop.
//   - Drops are fast metadata ops in WiredTiger (no collection scan).
//   - Creates replacement indexes BEFORE dropping the originals they replace.
//
// NOTE: Some of these (reels.embedding_1/embedding_pca_1, articles.category_1) are
// schema-defined and will be RECREATED on next app boot unless the schema is also
// edited (done in models/Reel.js & models/Article.js) or autoIndex is disabled.
//
// Usage:
//   node scripts/dropDeadIndexes.js            # dry run — list actions
//   node scripts/dropDeadIndexes.js --confirm  # execute
//
require('dotenv').config();
const mongoose = require('mongoose');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withRetry(label, fn, retries = 6) {
    for (let attempt = 1; ; attempt++) {
        try { return await fn(); }
        catch (err) {
            const transient = /Network|Pool|timed out|ETIMEDOUT|ECONNRESET/i.test(err.name + ' ' + err.message)
                || err.code === 50 || err.errorLabelSet?.has?.('RetryableWriteError');
            if (!transient || attempt > retries) throw err;
            const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000);
            console.warn(`⚠️  ${label} retry ${attempt}/${retries}: ${err.name}`);
            await sleep(backoff);
        }
    }
}

// Indexes to create FIRST (replacements), then the originals get dropped below.
const CREATE = [
    { coll: 'videos', name: 'source_1', key: { source: 1 }, reason: 'replaces multikey source_1_embedding_1' },
];

// Indexes to drop, by collection. Each is dead (0 ops on a high-traffic coll) and/or
// wrong by design (huge string/array btree, wrong field, _id-prefixed, reversed dup).
const DROP = {
    articles: [
        'category_1_content_1_language_1_publishedAt_-1', // 1.22 GB — indexes full body text
        'embedding_pca_partial',                          // 809 MB — multikey over float arrays
        'category_1_language_1_title_1_publishedAt_-1',   // 40 MB — indexes title in middle
        '_id_1_language_1_publishedAt_1',                 // _id prefix is pointless
        '_id_1_language_1_publishedAt_-1',                // _id prefix is pointless
        'language_1_publishedAt_-1_sourceId_1',           // dead; covered by used language_1_publishedAt*
        'language_1_sourceId_1_publishedAt_-1',           // dead
        'language_1_publishedAt_-1_viewCount_-1',         // dead
        'category_1_publishedAt_-1',                      // dead
        'category_1_language_1_publishedAt_-1',           // dead (used twin: language_1_category_1_publishedAt_-1)
        'sourceId_1_publishedAt_-1',                      // dead (sourceId_1 kept separately)
        'language_1_viewCount_-1_publishedAt_-1',         // dead
        'language_sourceGroupName_publishedAt',           // dead (from create-performance-indexes.js)
        'viewCount_-1_publishedAt_-1',                    // dead
        'source_1_publishedAt_-1',                        // wrong field (`source`); schema uses sourceId
        'sourceGroupName_publishedAt',                    // dead
        'category_1',                                     // dead single (also removed from schema)
        'likeCount_-1',                                   // wrong field (`likeCount`); schema uses `likes`
    ],
    reels: [
        'embedding_1',           // 30.5 MB — multikey 1536-dim (also removed from schema)
        'embedding_pca_1',       // multikey (also removed from schema)
        'embedding_pca_partial', // multikey partial
    ],
    videos: [
        'source_1_embedding_1',  // 28 MB — multikey; replaced by source_1 above
    ],
};

const PROTECTED = (ix) => ix.name === '_id_' || ix.unique || ix.expireAfterSeconds != null;

async function run() {
    const confirm = process.argv.includes('--confirm');
    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000, retryWrites: true,
    });
    const db = mongoose.connection.db;
    console.log(`🗄️  DB: ${db.databaseName} — ${confirm ? '🔴 EXECUTE' : '🧪 DRY RUN'}\n`);

    // 1) Create replacement indexes first.
    for (const c of CREATE) {
        const coll = db.collection(c.coll);
        const existing = await withRetry(`${c.coll}.indexes`, () => coll.indexes());
        if (existing.some(ix => ix.name === c.name)) {
            console.log(`✓  ${c.coll}.${c.name} already exists (${c.reason})`);
            continue;
        }
        if (!confirm) { console.log(`＋ would CREATE ${c.coll}.${c.name} ${JSON.stringify(c.key)} — ${c.reason}`); continue; }
        await withRetry(`create ${c.coll}.${c.name}`, () => coll.createIndex(c.key, { name: c.name }));
        console.log(`＋ created ${c.coll}.${c.name}`);
    }

    // 2) Drop dead indexes.
    let dropped = 0, skipped = 0;
    for (const [collName, names] of Object.entries(DROP)) {
        const coll = db.collection(collName);
        const existing = await withRetry(`${collName}.indexes`, () => coll.indexes());
        const byName = Object.fromEntries(existing.map(ix => [ix.name, ix]));
        for (const name of names) {
            const ix = byName[name];
            if (!ix) { console.log(`–  ${collName}.${name} not found (already dropped)`); continue; }
            if (PROTECTED(ix)) { console.log(`🛡️  SKIP protected ${collName}.${name}`); skipped++; continue; }
            if (!confirm) { console.log(`🗑️  would DROP ${collName}.${name} ${JSON.stringify(ix.key)}`); continue; }
            await withRetry(`drop ${collName}.${name}`, () => coll.dropIndex(name));
            console.log(`🗑️  dropped ${collName}.${name}`);
            dropped++;
        }
    }

    console.log(confirm
        ? `\n✅ Done. Dropped ${dropped}, skipped ${skipped}.`
        : `\n🧪 Dry run complete. Re-run with --confirm to execute.`);
    await mongoose.disconnect();
}

run().catch(e => { console.error('❌', e); process.exit(1); });
