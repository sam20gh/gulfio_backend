/**
 * Retrain the canonical 1536D → 128D PCA basis and re-project every stored
 * embedding_pca into it.
 *
 * THE BUG THIS FIXES
 * ------------------
 * `scraper-job/utils/pcaEmbedding.js` used to train its own PCA basis in-process on
 * every cold start, from whatever ~5000 articles it happened to sample. The backend
 * meanwhile loads the persisted `article_embedding_pca_v1` basis and uses it to build
 * each user's embedding_pca. So the personalized feed's $vectorSearch was comparing a
 * query vector in one basis against article vectors in a different one. Measured on the
 * live corpus, re-projecting stored embeddings through the persisted basis gave a median
 * |cos| of ~0.07–0.20 against the stored embedding_pca (a match would be ~1.0), uniformly
 * across every article age. Reels were written by the same scraper path, so they drifted
 * too — and users blend reel vectors into their own (routes/user.js), mixing bases again.
 *
 * scraper-job now loads the persisted model (it was ported from backend/utils, and both
 * copies are byte-identical). This script establishes the basis everything shares.
 *
 * WHAT IT DOES
 *   1. Retrains PCA on a large sample and overwrites the persisted model.
 *   2. Re-projects every article's embedding_pca from its stored 1536-D embedding.
 *   3. Re-projects every reel's embedding_pca.
 *   4. Regenerates every user's embedding_pca from their liked/saved article vectors.
 *
 * ORDER MATTERS
 *   Run scripts/migrateEmbeddingsToBinaryVector.js FIRST. This script reads the 1536-D
 *   embedding of every article; in array form that is ~7.7 GB over the wire, in binary
 *   float32 form it is ~2.3 GB. Migrating first makes this pass ~3x cheaper.
 *
 *   Afterwards, redeploy backend and scraper-job. Both cache the PCA basis in memory per
 *   process, so running instances keep serving the OLD basis until they restart.
 *
 * Steps 2-4 are idempotent and resumable; re-running is safe.
 *
 * Usage:
 *   node --max-old-space-size=4096 scripts/retrainAndReprojectPCA.js --dry-run
 *   node --max-old-space-size=4096 scripts/retrainAndReprojectPCA.js
 *   node --max-old-space-size=4096 scripts/retrainAndReprojectPCA.js --skip-retrain --resume
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { ObjectId } = mongoose.mongo;
const { makeCheckpointStore } = require('../utils/migrationState');

const CHECKPOINT_KEY = 'pca-reprojection';

const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(`--${n}`);
const getOpt = (n, d) => {
    const hit = args.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split('=')[1] : d;
};

const DRY_RUN = hasFlag('dry-run');
const RESUME = hasFlag('resume');
const SKIP_RETRAIN = hasFlag('skip-retrain');
const ARTICLE_SAMPLES = parseInt(getOpt('samples', '20000'), 10);
const REEL_SAMPLES = parseInt(getOpt('reel-samples', '2000'), 10);
const BATCH_SIZE = parseInt(getOpt('batch', '500'), 10);
const SLEEP_MS = parseInt(getOpt('sleep', '25'), 10);
/** Cap documents scanned per collection. For validating a slice; omit for a full run. */
const MAX_DOCS = parseInt(getOpt('max', '0'), 10) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, attempts = 5) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try { return await fn(); } catch (err) {
            lastErr = err;
            if (i === attempts) break;
            const backoff = Math.min(30000, 1000 * 2 ** (i - 1));
            console.warn(`  ⚠️  ${label} failed (${i}/${attempts}): ${err.message} — retry in ${backoff}ms`);
            await sleep(backoff);
        }
    }
    throw lastErr;
}

// Checkpoint lives in Mongo, not on disk — Cloud Run containers are ephemeral, so a
// task timeout or retry would otherwise restart a 405k-document scan from zero.
let checkpointStore = null;
async function readCheckpoint() {
    if (!RESUME) return {};
    const saved = await checkpointStore.load();
    if (saved) console.log(`▶️  Resuming from saved checkpoint: ${JSON.stringify(saved)}`);
    else console.log('ℹ️  --resume given but no saved checkpoint found — starting from the beginning');
    return saved || {};
}
async function writeCheckpoint(state) {
    if (!DRY_RUN) await checkpointStore.save(state);
}

/**
 * Re-project one collection's embedding_pca in _id order, resumable.
 * Reads the 1536-D source vector and writes the 128-D projection.
 */
async function reproject({ collection, label, project, checkpoint, checkpointKey }) {
    const { fromVector, isValidEmbedding } = require('../utils/vector');

    let lastId = checkpoint[checkpointKey] ? new ObjectId(checkpoint[checkpointKey]) : null;
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    const startedAt = Date.now();

    console.log(`\n=== re-projecting ${label} ===`);

    while (scanned < MAX_DOCS) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const page = await withRetry(`read ${label}`, () =>
            collection.find(query, { projection: { embedding: 1 } })
                .sort({ _id: 1 }).limit(Math.min(BATCH_SIZE, MAX_DOCS - scanned)).toArray()
        );
        if (page.length === 0) break;

        const ops = [];
        for (const doc of page) {
            if (!isValidEmbedding(doc.embedding)) { skipped++; continue; }
            const pca = project(fromVector(doc.embedding));
            if (!pca) { skipped++; continue; }
            ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { embedding_pca: pca } } } });
        }

        if (ops.length && !DRY_RUN) {
            await withRetry(`write ${label}`, () => collection.bulkWrite(ops, { ordered: false }));
        }

        updated += ops.length;
        scanned += page.length;
        lastId = page[page.length - 1]._id;
        checkpoint[checkpointKey] = lastId.toString();
        await writeCheckpoint(checkpoint);

        const rate = scanned / Math.max((Date.now() - startedAt) / 1000, 0.001);
        process.stdout.write(`\r   scanned ${scanned}  reprojected ${updated}  skipped ${skipped}  ${rate.toFixed(0)}/s   `);
        if (SLEEP_MS > 0) await sleep(SLEEP_MS);
    }

    console.log(`\n   ${label}: ${updated} reprojected, ${skipped} skipped (no usable embedding)`);
    return { updated, skipped };
}

(async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 600000,
    });

    const { retrainAndPersistPCA, initializePCAModel, convertToPCAEmbedding } = require('../utils/pcaEmbedding');
    const db = mongoose.connection.db;
    checkpointStore = makeCheckpointStore(db, CHECKPOINT_KEY);
    const checkpoint = await readCheckpoint();

    console.log(`\n${DRY_RUN ? '🔍 DRY RUN — no writes' : '🚀 Retrain + re-projection'}`);

    // ---- 1. Retrain the canonical basis -------------------------------------
    // A resumed run must NEVER retrain: the documents already re-projected are in the
    // current basis, and training a new one would silently invalidate them. This makes
    // the job safe to retry (Cloud Run retries re-run the same command).
    const resumedMidRun = Object.keys(checkpoint).length > 0;

    if (SKIP_RETRAIN || resumedMidRun) {
        const why = SKIP_RETRAIN ? '--skip-retrain' : 'resuming an in-progress re-projection';
        console.log(`\n=== step 1: retrain SKIPPED (${why}) — loading persisted basis ===`);
        const ok = await initializePCAModel();
        if (!ok) throw new Error('No persisted PCA model to load');
    } else if (DRY_RUN) {
        console.log(`\n=== step 1: would retrain on ${ARTICLE_SAMPLES} articles + ${REEL_SAMPLES} reels ===`);
        await initializePCAModel();
    } else {
        console.log(`\n=== step 1: retraining on ${ARTICLE_SAMPLES} articles + ${REEL_SAMPLES} reels ===`);
        console.log('    (this overwrites article_embedding_pca_v1 — every embedding_pca below is rebuilt against it)');
        const res = await retrainAndPersistPCA({ articleSamples: ARTICLE_SAMPLES, reelSamples: REEL_SAMPLES });
        if (!res.success) throw new Error(`Retrain failed: ${res.error}`);
        console.log(`    ✅ persisted: ${res.components} components from ${res.sampleCount} samples`);
    }

    // Single in-memory basis for the whole run — convertToPCAEmbedding is async and
    // logs per call, so project through the loaded PCA directly instead.
    const { PCA } = require('ml-pca');
    const { Matrix } = require('ml-matrix');
    const persisted = await db.collection('pcamodels').findOne({ name: 'article_embedding_pca_v1' });
    const pca = PCA.load(persisted.model);
    const project = (values) => {
        try {
            return Array.from(pca.predict(new Matrix([values]), { nComponents: 128 }).getRow(0));
        } catch {
            return null;
        }
    };

    // ---- 2 & 3. Articles and reels ------------------------------------------
    const articleStats = await reproject({
        collection: db.collection('articles'), label: 'articles',
        project, checkpoint, checkpointKey: 'articlesLastId',
    });
    const reelStats = await reproject({
        collection: db.collection('reels'), label: 'reels',
        project, checkpoint, checkpointKey: 'reelsLastId',
    });

    // ---- 4. Users ------------------------------------------------------------
    // User vectors are the mean of the article vectors they engaged with, so they must
    // be rebuilt from the NEW article embedding_pca values written above.
    console.log('\n=== re-projecting users ===');
    const users = await db.collection('users')
        .find({}, { projection: { liked_articles: 1, saved_articles: 1, email: 1, supabase_id: 1 } })
        .toArray();
    let userUpdated = 0;
    let userSkipped = 0;

    for (const user of users) {
        const ids = [...(user.liked_articles || []), ...(user.saved_articles || [])]
            .map((id) => { try { return new ObjectId(id); } catch { return null; } })
            .filter(Boolean);
        if (ids.length === 0) { userSkipped++; continue; }

        const arts = await db.collection('articles')
            .find({ _id: { $in: ids }, 'embedding_pca.0': { $exists: true } }, { projection: { embedding_pca: 1 } })
            .toArray();
        if (arts.length === 0) { userSkipped++; continue; }

        const mean = new Array(128).fill(0);
        for (const a of arts) for (let i = 0; i < 128; i++) mean[i] += a.embedding_pca[i];
        for (let i = 0; i < 128; i++) mean[i] /= arts.length;

        if (!DRY_RUN) {
            await db.collection('users').updateOne({ _id: user._id }, { $set: { embedding_pca: mean } });
        }
        userUpdated++;
    }
    console.log(`   users: ${userUpdated} rebuilt, ${userSkipped} skipped (no engagement history)`);

    // ---- summary -------------------------------------------------------------
    console.log('\n=== DONE ===');
    console.log(`articles reprojected: ${articleStats.updated}`);
    console.log(`reels reprojected   : ${reelStats.updated}`);
    console.log(`users rebuilt       : ${userUpdated}`);
    if (!DRY_RUN) {
        await checkpointStore.clear();
        console.log('checkpoint cleared');
    }
    console.log('\n⚠️  Redeploy backend AND scraper-job now — both cache the PCA basis in');
    console.log('    memory per process and will serve the old one until they restart.\n');

    await mongoose.disconnect();
})().catch((err) => {
    console.error('\n❌ Failed:', err.message);
    console.error('   Re-run with --skip-retrain --resume to continue without retraining again.');
    process.exit(1);
});
