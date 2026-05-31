// scripts/killEmbeddingScans.js
//
// Emergency CPU relief: finds and kills the runaway COLLSCAN ops on `articles`
// that scan the full `embedding` field (the PCA-training death-spiral query), so the
// primary can recover. Safe — these are read scans; killing them just errors those
// requests. Run scripts/ensurePCAModel.js right after to stop them recurring.
//
// Usage: node scripts/killEmbeddingScans.js [--dry]
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    const dry = process.argv.includes('--dry');
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000 });
    const admin = mongoose.connection.db.admin();
    const r = await admin.command({ currentOp: 1, active: true });

    const targets = (r.inprog || []).filter(o => {
        if (!/\.articles$/.test(o.ns || '')) return false;
        if (o.planSummary !== 'COLLSCAN') return false;
        const orig = JSON.stringify(o.cursor?.originatingCommand || o.originatingCommand || o.command || {});
        return /embedding/.test(orig);
    });

    console.log(`Found ${targets.length} embedding COLLSCAN op(s)${dry ? ' (dry run)' : ''}`);
    let killed = 0;
    for (const o of targets) {
        const id = o.opid;
        console.log(`  [${o.secs_running}s] opid=${id} ${o.op} ${o.ns}`);
        if (dry) continue;
        try { await admin.command({ killOp: 1, op: id }); killed++; }
        catch (e) { console.warn(`    killOp failed: ${e.message}`); }
    }
    if (!dry) console.log(`💀 Killed ${killed}/${targets.length}.`);
    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
