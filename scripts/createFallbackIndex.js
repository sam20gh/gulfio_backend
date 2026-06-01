require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000, socketTimeoutMS: 180000, retryWrites: true });
  const c = mongoose.connection.db.collection('articles');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  for (let a=1;;a++){
    try { await c.createIndex({ language:1, publishedAt:-1, viewCount:-1 }, { name:'language_1_publishedAt_-1_viewCount_-1', background:true }); break; }
    catch(e){ if(a>6) throw e; console.warn(`retry ${a}: ${e.codeName||e.message}`); await sleep(Math.min(1000*2**a,15000)); }
  }
  console.log('✅ created language_1_publishedAt_-1_viewCount_-1');
  await mongoose.disconnect();
})().catch(e=>{console.error('❌',e.message);process.exit(1)});
