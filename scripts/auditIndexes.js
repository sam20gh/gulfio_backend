// scripts/auditIndexes.js
//
// Read-only audit of every collection's indexes: usage stats ($indexStats),
// sizes, multikey/array indexes, and redundant-prefix detection. Writes a report
// to scripts/index-audit-report.json and prints a summary.
//
// Usage: node scripts/auditIndexes.js
//
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function withRetry(label, fn, retries = 5) {
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

const fmtBytes = (b) => b == null ? '?' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB'
    : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? (b / 1e3).toFixed(1) + ' KB' : b + ' B';

async function run() {
    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
    });
    const db = mongoose.connection.db;
    console.log(`🗄️  Connected to DB: ${db.databaseName}\n`);

    const collections = (await withRetry('listCollections', () => db.listCollections().toArray()))
        .filter(c => c.type === 'collection' && !c.name.startsWith('system.'))
        .map(c => c.name)
        .sort();

    const report = { db: db.databaseName, generatedAt: new Date().toISOString(), collections: [] };
    let totalIndexes = 0;
    const deadIndexes = [];
    const arrayIndexes = [];
    const redundant = [];

    for (const name of collections) {
        const coll = db.collection(name);
        let stats, indexes, idxStats, count;
        try {
            count = await withRetry(`${name}.count`, () => coll.estimatedDocumentCount());
            stats = await withRetry(`${name}.collStats`, () => db.command({ collStats: name }));
            indexes = await withRetry(`${name}.indexes`, () => coll.indexes());
            idxStats = await withRetry(`${name}.$indexStats`, () =>
                coll.aggregate([{ $indexStats: {} }]).toArray());
        } catch (err) {
            console.warn(`⚠️  Skipping ${name}: ${err.message}`);
            continue;
        }

        const statsByName = Object.fromEntries(idxStats.map(s => [s.name, s]));
        const indexSizes = stats.indexSizes || {};
        totalIndexes += indexes.length;

        const collEntry = {
            name,
            docCount: count,
            dataSize: stats.size,
            storageSize: stats.storageSize,
            totalIndexSize: stats.totalIndexSize,
            indexCount: indexes.length,
            indexes: [],
        };

        for (const ix of indexes) {
            const s = statsByName[ix.name];
            const ops = s?.accesses?.ops != null ? Number(s.accesses.ops) : null;
            const since = s?.accesses?.since ? new Date(s.accesses.since).toISOString() : null;
            const size = indexSizes[ix.name];
            const keyFields = Object.keys(ix.key);
            const entry = {
                name: ix.name,
                key: ix.key,
                ops,
                since,
                size,
                unique: !!ix.unique,
                sparse: !!ix.sparse,
                ttl: ix.expireAfterSeconds != null ? ix.expireAfterSeconds : null,
                isId: ix.name === '_id_',
            };
            collEntry.indexes.push(entry);

            // Dead: 0 ops, not _id, not unique-constraint, not TTL
            if (ops === 0 && !entry.isId && !entry.unique && entry.ttl == null) {
                deadIndexes.push({ coll: name, name: ix.name, key: ix.key, size, since });
            }
            // Likely array/multikey index on embedding-style fields
            if (keyFields.some(f => /embedding/i.test(f))) {
                arrayIndexes.push({ coll: name, name: ix.name, key: ix.key, size, ops });
            }
        }

        // Redundant prefix detection: index A is a prefix of index B (same leading keys).
        const keysList = collEntry.indexes
            .filter(e => !e.isId)
            .map(e => ({ name: e.name, sig: Object.entries(e.key).map(([k, v]) => `${k}:${v}`) }));
        for (const a of keysList) {
            for (const b of keysList) {
                if (a.name === b.name || a.sig.length >= b.sig.length) continue;
                const isPrefix = a.sig.every((p, i) => b.sig[i] === p);
                if (isPrefix) redundant.push({ coll: name, prefix: a.name, supersededBy: b.name });
            }
        }

        report.collections.push(collEntry);
    }

    fs.writeFileSync(path.join(__dirname, 'index-audit-report.json'), JSON.stringify(report, null, 2));

    // ---- Summary ----
    console.log(`📊 ${collections.length} collections, ${totalIndexes} total indexes\n`);

    console.log('🐘 Largest index footprints:');
    report.collections
        .slice().sort((a, b) => (b.totalIndexSize || 0) - (a.totalIndexSize || 0)).slice(0, 10)
        .forEach(c => console.log(`   ${c.name}: ${c.indexCount} idx, indexes=${fmtBytes(c.totalIndexSize)}, data=${fmtBytes(c.dataSize)}, docs=${c.docCount}`));

    console.log(`\n🧨 Array/embedding btree indexes (candidates to DROP — use Atlas vector search instead): ${arrayIndexes.length}`);
    arrayIndexes.forEach(a => console.log(`   ${a.coll}.${a.name} ${JSON.stringify(a.key)} size=${fmtBytes(a.size)} ops=${a.ops}`));

    console.log(`\n💀 Dead indexes (0 ops since stats start — VERIFY 'since' is before the migration!): ${deadIndexes.length}`);
    deadIndexes.forEach(d => console.log(`   ${d.coll}.${d.name} ${JSON.stringify(d.key)} size=${fmtBytes(d.size)} since=${d.since}`));

    console.log(`\n♻️  Redundant prefix indexes (covered by a longer index): ${redundant.length}`);
    redundant.forEach(r => console.log(`   ${r.coll}: ${r.prefix} ⊂ ${r.supersededBy}`));

    console.log('\n📝 Full report: scripts/index-audit-report.json');
    await mongoose.disconnect();
}

run().catch(e => { console.error('❌', e); process.exit(1); });
