require('dotenv').config();
const mongoose = require('mongoose');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(label, fn, n=6){ for(let a=1;;a++){ try{ return await fn(); }catch(e){ if(a>n) throw e; console.warn(`retry ${a} ${label}: ${e.codeName||e.message}`); await sleep(Math.min(1000*2**a,15000)); } } }
(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000, socketTimeoutMS: 120000, retryWrites: true });
  const c = mongoose.connection.db.collection('articles');
  const ix = await retry('indexes', () => c.indexes());
  const cur = ix.find(i => i.name === 'publishedAt_-1');
  console.log('current publishedAt_-1:', cur ? `expireAfterSeconds=${cur.expireAfterSeconds}` : '(missing)');
  if (cur && cur.expireAfterSeconds != null) {
    await retry('dropIndex', () => c.dropIndex('publishedAt_-1'));
    console.log('🗑️  dropped TTL index');
  }
  // recreate as a plain (non-TTL) sort index
  await retry('createIndex', () => c.createIndex({ publishedAt: -1 }, { name: 'publishedAt_-1', background: true }));
  const after = (await retry('indexes2', () => c.indexes())).find(i => i.name === 'publishedAt_-1');
  console.log('✅ publishedAt_-1 now:', after ? `expireAfterSeconds=${after.expireAfterSeconds ?? '(none — TTL removed)'}` : '(missing!)');
  await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
