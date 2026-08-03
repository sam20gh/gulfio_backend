/**
 * Migrate articles.embedding from a BSON array of doubles to a BSON Binary float32
 * vector (subtype 9).
 *
 * Why: the array form costs ~13 bytes per dimension (8-byte double + stringified index
 * key + type byte), so one 1536-D embedding is ~20 KB. As a Binary float32 vector it is
 * ~6.1 KB. Measured on this corpus the `embedding` field is 79% of the whole database,
 * so this reclaims roughly 5 GB with no loss of behaviour:
 *   - the embedding API returns float32-precision values, so the conversion is exact;
 *   - Atlas Vector Search reads binData float32 natively, so `vec_full` needs no
 *     definition change and reindexes incrementally as documents are written.
 *
 * Safety properties:
 *   - Idempotent. Documents already stored as Binary are skipped, so re-running is free.
 *   - Resumable. Pages by _id ascending (uses the _id index, no collscan) and writes a
 *     checkpoint file after every batch. Re-run with --resume to continue where it died.
 *   - Bounded. Reads one page at a time; never loads the corpus into memory.
 *   - Retries transient network errors with backoff — the connection from a laptop to
 *     Atlas is unreliable for sustained bulk writes, so prefer running this in the same
 *     region as the cluster (e.g. as a Cloud Run job).
 *
 * Usage:
 *   node scripts/migrateEmbeddingsToBinaryVector.js --dry-run
 *   node scripts/migrateEmbeddingsToBinaryVector.js
 *   node scripts/migrateEmbeddingsToBinaryVector.js --resume
 *   node scripts/migrateEmbeddingsToBinaryVector.js --batch=250 --sleep=50
 *
 * Note: dataSize drops immediately, but storageSize only returns to the OS after a
 * compact or a rolling resync — WiredTiger keeps the freed blocks for reuse.
 */

require('dotenv').config();
// The driver is only present nested under mongoose in this repo, so go through
// mongoose.mongo rather than requiring 'mongodb' directly.
const { MongoClient, Binary, ObjectId } = require('mongoose').mongo;
const { makeCheckpointStore } = require('../utils/migrationState');

const CHECKPOINT_KEY = 'embedding-binary-vector';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const getOpt = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
};

const DRY_RUN = hasFlag('dry-run');
const RESUME = hasFlag('resume');
const BATCH_SIZE = parseInt(getOpt('batch', '250'), 10);
const SLEEP_MS = parseInt(getOpt('sleep', '25'), 10);
const MAX_DOCS = parseInt(getOpt('max', '0'), 10) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run an operation, retrying transient Atlas/network errors with backoff. */
async function withRetry(label, fn, attempts = 5) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt === attempts) break;
            const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1));
            console.warn(`  ⚠️  ${label} failed (attempt ${attempt}/${attempts}): ${err.message} — retrying in ${backoff}ms`);
            await sleep(backoff);
        }
    }
    throw lastErr;
}

(async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');

    const client = new MongoClient(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 300000,
    });
    await client.connect();
    const db = client.db();
    const articles = db.collection('articles');

    // Checkpoint lives in Mongo, not on disk — Cloud Run containers are ephemeral.
    const store = makeCheckpointStore(db, CHECKPOINT_KEY);
    const saveCheckpoint = (state) => (DRY_RUN ? Promise.resolve() : store.save(state));

    console.log(`\n${DRY_RUN ? '🔍 DRY RUN — no writes' : '🚀 Migrating'} articles.embedding → BSON Binary float32`);
    console.log(`   batch=${BATCH_SIZE} sleep=${SLEEP_MS}ms\n`);

    let checkpoint = null;
    if (RESUME) {
        checkpoint = await store.load();
        if (checkpoint) {
            console.log(`▶️  Resuming: _id > ${checkpoint.lastId} (${checkpoint.converted} already converted)`);
        } else {
            console.log('ℹ️  --resume given but no saved checkpoint found — starting from the beginning');
        }
    }
    let lastId = checkpoint ? new ObjectId(checkpoint.lastId) : null;

    let scanned = checkpoint ? checkpoint.scanned : 0;
    let converted = checkpoint ? checkpoint.converted : 0;
    let alreadyBinary = 0;
    let skippedEmpty = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;
    const startedAt = Date.now();

    while (scanned < MAX_DOCS) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const page = await withRetry('read page', () =>
            articles
                .find(query, { projection: { embedding: 1 } })
                .sort({ _id: 1 })
                .limit(Math.min(BATCH_SIZE, MAX_DOCS - scanned))
                .toArray()
        );

        if (page.length === 0) break;

        const ops = [];
        for (const doc of page) {
            const value = doc.embedding;
            if (Array.isArray(value)) {
                if (value.length === 0) {
                    skippedEmpty++;                     // never embedded; leave as-is
                } else {
                    // ~13 bytes/dim as an array vs 4 bytes/dim + 2-byte header as Binary
                    bytesBefore += value.length * 13;
                    bytesAfter += value.length * 4 + 2;
                    ops.push({
                        updateOne: {
                            filter: { _id: doc._id },
                            update: { $set: { embedding: Binary.fromFloat32Array(new Float32Array(value)) } },
                        },
                    });
                }
            } else if (value) {
                alreadyBinary++;                        // idempotent re-run
            } else {
                skippedEmpty++;                         // field absent / null
            }
        }

        if (ops.length > 0 && !DRY_RUN) {
            await withRetry('bulkWrite', () => articles.bulkWrite(ops, { ordered: false }));
        }

        converted += ops.length;
        scanned += page.length;
        lastId = page[page.length - 1]._id;
        await saveCheckpoint({ lastId: lastId.toString(), scanned, converted });

        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = scanned / Math.max(elapsed, 0.001);
        process.stdout.write(
            `\r   scanned ${scanned}  converted ${converted}  binary ${alreadyBinary}  empty ${skippedEmpty}  ` +
            `${rate.toFixed(0)}/s  saved ~${((bytesBefore - bytesAfter) / 1024 ** 3).toFixed(2)} GB   `
        );

        // Small pause so a long run doesn't pin cluster CPU while the app is serving.
        if (SLEEP_MS > 0) await sleep(SLEEP_MS);
    }

    console.log('\n\n=== DONE ===');
    console.log(`scanned         : ${scanned}`);
    console.log(`converted       : ${converted}${DRY_RUN ? ' (would convert)' : ''}`);
    console.log(`already binary  : ${alreadyBinary}`);
    console.log(`no embedding    : ${skippedEmpty}`);
    console.log(`estimated saving: ~${((bytesBefore - bytesAfter) / 1024 ** 3).toFixed(2)} GB of BSON`);
    console.log(`elapsed         : ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);

    if (!DRY_RUN) {
        await store.clear();
        console.log('checkpoint cleared');
    }
    console.log('\nNote: storageSize reclaims only after a compact or rolling resync.\n');

    await client.close();
})().catch((err) => {
    console.error('\n❌ Migration failed:', err.message);
    console.error('   Re-run with --resume to continue from the last checkpoint.');
    process.exit(1);
});
