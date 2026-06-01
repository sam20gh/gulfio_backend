require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000, socketTimeoutMS: 60000 });
  const Article = require('../models/Article');
  const lang='english';
  const ids=(await Article.find({}).select('_id').limit(200).lean()).map(d=>d._id);
  const c7=new Date(Date.now()-7*864e5);
  const plan=e=>JSON.stringify(e.queryPlanner?.winningPlan).match(/"stage":"(\w+)"/g)?.join(' > ');
  for (const [label,sort] of [['two-field {publishedAt:-1,viewCount:-1}',{publishedAt:-1,viewCount:-1}],['publishedAt only',{publishedAt:-1}]]){
    const e=await Article.find({language:lang,_id:{$nin:ids},publishedAt:{$gte:c7}}).sort(sort).limit(30).explain('executionStats');
    const x=e.executionStats||{};
    console.log(`\n${label}\n  plan: ${plan(e)}\n  execTime: ${x.executionTimeMillis}ms docsExamined: ${x.totalDocsExamined} returned: ${x.nReturned} blockingSORT: ${/"stage":"SORT"/.test(JSON.stringify(e.queryPlanner?.winningPlan))}`);
  }
  const n=await Article.countDocuments({language:lang,publishedAt:{$gte:c7}}).maxTimeMS(20000);
  console.log(`\nenglish articles in last 7d (blocking-sort working set): ${n}`);
  await mongoose.disconnect();
})().catch(e=>{console.error('❌',e.message);process.exit(1)});
