// scripts/dropVecFullIndex.js
//
// Drops the `vec_full` Atlas Vector Search index (1536D, articles.embedding).
//
// ⚠️ RUN THIS ONLY AFTER the backend is redeployed with the aiAgentService change
// that repoints the AI agent to the 128D `default` index. Dropping first breaks
// AI chat retrieval until the deploy lands.
//
// Rebuilding vec_full over ~411k articles is slow, so this is effectively one-way.
//
//   node scripts/dropVecFullIndex.js --confirm
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    if (!process.argv.includes('--confirm')) {
        console.log('Refusing to run without --confirm. Deploy the backend first.');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });
    const coll = mongoose.connection.db.collection('articles');

    const before = await coll.listSearchIndexes().toArray();
    console.log('Search indexes before:', before.map(i => `${i.name}(${i.type || 'search'})`).join(', '));

    if (!before.some(i => i.name === 'vec_full')) {
        console.log('vec_full not present — nothing to do.');
    } else {
        await coll.dropSearchIndex('vec_full');
        console.log('🗑️  Dropped vec_full.');
    }

    const after = await coll.listSearchIndexes().toArray();
    console.log('Search indexes after:', after.map(i => `${i.name}(${i.type || 'search'})`).join(', '));
    await mongoose.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
