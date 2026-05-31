// scripts/currentOp.js — snapshot of active ops sorted by running time. Read-only.
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000 });
    const admin = mongoose.connection.db.admin();
    const r = await admin.command({ currentOp: 1, active: true });
    const ops = (r.inprog || [])
        .filter(o => o.op !== 'none' && (o.secs_running || 0) >= 0)
        .sort((a, b) => (b.secs_running || 0) - (a.secs_running || 0));
    console.log(`active ops: ${ops.length}\n`);
    // Focus on real query work on articles (skip hello/monitor chatter).
    const interesting = ops.filter(o => /articles|reels|users/.test(o.ns || '') && o.op !== 'none');
    for (const o of interesting.slice(0, 20)) {
        const orig = o.cursor?.originatingCommand || o.originatingCommand;
        const cmd = JSON.stringify(orig || o.command || o.query || {}).slice(0, 400);
        console.log(`[${String(o.secs_running ?? 0).padStart(5)}s] ${o.op} ${o.ns} planSummary=${o.planSummary || '-'}`);
        console.log(`        orig=${cmd}\n`);
    }
    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
