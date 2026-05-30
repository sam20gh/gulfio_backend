// scripts/deleteOldArticles.js
//
// Deletes all articles older than 9 months (based on publishedAt).
//
// Usage:
//   node scripts/deleteOldArticles.js            # DRY RUN — only reports how many would be deleted
//   node scripts/deleteOldArticles.js --confirm  # Actually deletes the articles
//
// Optional:
//   --months=12   # Override the age threshold (default 9 months)
//   --batch=500   # Documents deleted per batch (default 500)
//   --retries=5   # Retry attempts per batch on transient network errors (default 5)
//
require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Retry a DB operation on transient network/timeout errors with exponential backoff.
async function withRetry(label, fn, retries) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const transient =
                err.name === 'MongoNetworkTimeoutError' ||
                err.name === 'MongoNetworkError' ||
                err.code === 50 || // ExceededTimeLimit (maxTimeMS hit)
                err.hasErrorLabel?.('RetryableWriteError') ||
                err.errorLabelSet?.has?.('RetryableWriteError');
            if (!transient || attempt > retries) throw err;
            const backoff = Math.min(1000 * 2 ** (attempt - 1), 15000);
            console.warn(`⚠️  ${label} failed (attempt ${attempt}/${retries}): ${err.name}. Retrying in ${backoff}ms...`);
            await sleep(backoff);
        }
    }
}

// Cache clearing is optional — skip gracefully if unavailable.
let clearArticlesCache;
try {
    ({ clearArticlesCache } = require('../utils/cache'));
} catch (_) {
    clearArticlesCache = null;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const confirm = args.includes('--confirm');
    const monthsArg = args.find(a => a.startsWith('--months='));
    const months = monthsArg ? parseInt(monthsArg.split('=')[1], 10) : 9;
    if (!Number.isFinite(months) || months <= 0) {
        throw new Error(`Invalid --months value: ${monthsArg}`);
    }
    const batchArg = args.find(a => a.startsWith('--batch='));
    const batch = batchArg ? parseInt(batchArg.split('=')[1], 10) : 100;
    if (!Number.isFinite(batch) || batch <= 0) {
        throw new Error(`Invalid --batch value: ${batchArg}`);
    }
    const retriesArg = args.find(a => a.startsWith('--retries='));
    const retries = retriesArg ? parseInt(retriesArg.split('=')[1], 10) : 5;
    if (!Number.isFinite(retries) || retries < 0) {
        throw new Error(`Invalid --retries value: ${retriesArg}`);
    }
    return { confirm, months, batch, retries };
}

async function run() {
    const { confirm, months, batch, retries } = parseArgs();

    // Compute the cutoff date: now minus `months` months.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        socketTimeoutMS: 120000,            // allow long-running batch deletes
        connectTimeoutMS: 30000,            // fail fast if initial connect can't be made
        serverSelectionTimeoutMS: 30000,    // wait up to 30s for a reachable server
        retryWrites: true,                  // let the driver auto-retry one write
        maxPoolSize: 5,
    });
    console.log('🗄️  Connected to MongoDB');
    console.log(`📅 Cutoff date: ${cutoff.toISOString()} (articles published before this are "older than ${months} months")`);

    try {
        const filter = { publishedAt: { $lt: cutoff } };

        const matchCount = await withRetry('countDocuments', () => Article.countDocuments(filter), retries);
        console.log(`🔎 Found ${matchCount} article(s) older than ${months} months`);

        if (matchCount === 0) {
            console.log('✅ Nothing to delete.');
            return;
        }

        if (!confirm) {
            console.log('🧪 DRY RUN — no articles were deleted.');
            console.log('   Re-run with --confirm to actually delete them:');
            console.log(`   node scripts/deleteOldArticles.js --confirm${months !== 9 ? ` --months=${months}` : ''}`);
            return;
        }

        // Delete in batches to avoid socket timeouts on very large deletions.
        // Each batch is retried independently so a transient network drop
        // doesn't lose progress — already-deleted docs simply won't match again.
        let totalDeleted = 0;
        while (true) {
            const docs = await withRetry('find batch', () =>
                Article.find(filter).select('_id').limit(batch).maxTimeMS(60000).lean(), retries);
            if (docs.length === 0) break;

            const ids = docs.map(d => d._id);
            const { deletedCount } = await withRetry('deleteMany batch', () =>
                Article.deleteMany(
                    { _id: { $in: ids } },
                    { maxTimeMS: 60000, writeConcern: { w: 1, j: false } }
                ), retries);
            totalDeleted += deletedCount;
            console.log(`🗑️  Deleted ${totalDeleted}/${matchCount}...`);
            await sleep(250); // brief pause to ease load on a strained server
        }
        console.log(`✅ Deleted ${totalDeleted} article(s) older than ${months} months`);

        if (typeof clearArticlesCache === 'function') {
            await clearArticlesCache();
            console.log('♻️  Articles cache cleared');
        }
    } catch (err) {
        console.error('❌ Error during deletion:', err);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

run();
