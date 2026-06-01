#!/usr/bin/env node
/**
 * Benchmark: recency vs Atlas $vectorSearch candidate retrieval for the
 * personalized-light feed. Mirrors the two candidate queries in
 * routes/articles.js (computePersonalizedLight) so you can compare latency and
 * result overlap for a real user BEFORE flipping PERS_LIGHT_VECTOR=1 in prod.
 *
 * This replicates the candidate-retrieval stage only (not the full blended
 * scorer) — that's the part that actually changes between the two modes.
 *
 * Usage:
 *   node benchmark-personalized-light.js                  # auto-pick a user with signal
 *   node benchmark-personalized-light.js --user <supabaseId>
 *   node benchmark-personalized-light.js --limit 10 --lang english --runs 3
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');
const User = require('./models/User');

// ---- mirror the route's tuning constants -------------------------------
const VECTOR_INDEX = 'default';
const NUM_CANDIDATE_MULT = 2.5;
const VECTOR_MAX_TIME_MS = 1500;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOWS = [24 * HOUR, 48 * HOUR, 7 * DAY, 30 * DAY];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LIMIT = parseInt(arg('--limit', '10'), 10);
const RUNS = parseInt(arg('--runs', '3'), 10);
const USER_ARG = arg('--user', null);
const LANG_ARG = arg('--lang', null);
const candidateLimit = Math.min(LIMIT * 12, 400);
const numCandidates = Math.min(Math.round(candidateLimit * NUM_CANDIDATE_MULT), 2000);

const PROJECT = {
  title: 1, content: 1, contentFormat: 1, url: 1, category: 1, publishedAt: 1,
  image: 1, viewCount: 1, likes: 1, dislikes: 1, likedBy: 1, dislikedBy: 1,
  sourceId: 1, sourceName: 1, sourceIcon: 1, sourceGroupName: 1, language: 1,
};

const SOURCE_LOOKUP = {
  $lookup: {
    from: 'sources', localField: 'sourceId', foreignField: '_id', as: 'source',
    pipeline: [
      { $match: { status: { $ne: 'blocked' } } },
      { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
    ],
  },
};
const SOURCE_FIELDS = {
  $addFields: {
    sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
    sourceName: { $arrayElemAt: ['$source.name', 0] },
    sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
    sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
  },
};

function buildCtx(user) {
  return {
    embedding:
      Array.isArray(user.embedding_pca) && user.embedding_pca.length > 0
        ? user.embedding_pca
        : null,
    dislikedCategories: new Set(user.disliked_categories || []),
    dislikedIds: new Set((user.disliked_articles || []).map((id) => id.toString())),
    language: (user.language || 'English').toLowerCase(),
    hasSignal:
      (user.preferred_categories?.length || 0) +
        (user.liked_articles?.length || 0) +
        (user.saved_articles?.length || 0) +
        (user.following_sources?.length || 0) >
      0,
  };
}

// ---- recency candidate query (current prod behavior) -------------------
function recencyQuery(ctx, language, sinceMs) {
  const match = { language, publishedAt: { $gte: new Date(Date.now() - sinceMs) } };
  if (ctx.dislikedIds.size > 0) {
    match._id = {
      $nin: [...ctx.dislikedIds].slice(0, 500).map((id) => new mongoose.Types.ObjectId(id)),
    };
  }
  if (ctx.dislikedCategories.size > 0) match.category = { $nin: [...ctx.dislikedCategories] };
  return Article.aggregate([
    { $match: match },
    { $sort: { publishedAt: -1 } },
    { $limit: candidateLimit },
    SOURCE_LOOKUP,
    { $match: { 'source.0': { $exists: true } } },
    SOURCE_FIELDS,
    { $project: PROJECT },
  ]);
}

// ---- vector candidate query (hybrid path) ------------------------------
function vectorQuery(ctx, language, sinceMs) {
  const filter = { language, publishedAt: { $gte: new Date(Date.now() - sinceMs) } };
  if (ctx.dislikedCategories.size > 0) filter.category = { $nin: [...ctx.dislikedCategories] };
  const dislikedObjectIds =
    ctx.dislikedIds.size > 0
      ? [...ctx.dislikedIds].slice(0, 500).map((id) => new mongoose.Types.ObjectId(id))
      : [];
  return Article.aggregate(
    [
      {
        $vectorSearch: {
          index: VECTOR_INDEX, path: 'embedding_pca', queryVector: ctx.embedding,
          numCandidates, limit: candidateLimit, filter,
        },
      },
      { $addFields: { _atlasSimilarity: { $meta: 'vectorSearchScore' } } },
      ...(dislikedObjectIds.length > 0 ? [{ $match: { _id: { $nin: dislikedObjectIds } } }] : []),
      SOURCE_LOOKUP,
      { $match: { 'source.0': { $exists: true } } },
      SOURCE_FIELDS,
      { $project: { ...PROJECT, _atlasSimilarity: 1 } },
    ],
    { maxTimeMS: VECTOR_MAX_TIME_MS, allowDiskUse: false }
  );
}

async function runWindowed(queryFn, ctx, language) {
  let cands = [];
  let used = WINDOWS[0];
  for (const sinceMs of WINDOWS) {
    cands = await queryFn(ctx, language, sinceMs);
    used = sinceMs;
    if (cands.length >= LIMIT * 2) break;
  }
  return { cands, used };
}

async function timeIt(fn) {
  const t = Date.now();
  const out = await fn();
  return { ms: Date.now() - t, out };
}

function topIds(cands, n) {
  return cands.slice(0, n).map((a) => a._id.toString());
}

async function main() {
  console.log('🔗 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  let user;
  if (USER_ARG) {
    user = await User.findOne({ supabase_id: USER_ARG }).lean();
  } else {
    user = await User.findOne({
      'embedding_pca.127': { $exists: true }, // has a full 128-D embedding
      $or: [
        { liked_articles: { $exists: true, $ne: [] } },
        { following_sources: { $exists: true, $ne: [] } },
        { preferred_categories: { $exists: true, $ne: [] } },
      ],
    }).lean();
  }

  if (!user) {
    console.error('❌ No suitable user found. Pass --user <supabaseId>.');
    process.exit(1);
  }

  const ctx = buildCtx(user);
  const language = (LANG_ARG || ctx.language).toLowerCase();

  console.log(`\n👤 User: ${user.supabase_id} (${user.email || 'no-email'})`);
  console.log(`   embedding_pca dims: ${user.embedding_pca?.length || 0}`);
  console.log(`   hasSignal: ${ctx.hasSignal} | liked: ${user.liked_articles?.length || 0} | ` +
    `following: ${user.following_sources?.length || 0} | dislikedCats: ${ctx.dislikedCategories.size}`);
  console.log(`   language: ${language} | limit: ${LIMIT} | candidateLimit: ${candidateLimit} | numCandidates: ${numCandidates}\n`);

  if (!ctx.embedding) {
    console.error('❌ User has no embedding_pca — vector path would never trigger for them.');
    process.exit(1);
  }
  if (ctx.embedding.length !== 128) {
    console.warn(`⚠️  embedding is ${ctx.embedding.length}-D, default index expects 128. Vector search may error.\n`);
  }

  // Warm-up (first vector query pays index-load cost; ignore it in the average)
  try { await runWindowed(vectorQuery, ctx, language); } catch (_) {}
  await runWindowed(recencyQuery, ctx, language);

  const recencyTimes = [];
  const vectorTimes = [];
  let lastRecency = { cands: [], used: 0 };
  let lastVector = { cands: [], used: 0 };
  let vectorError = null;

  for (let i = 0; i < RUNS; i++) {
    const r = await timeIt(() => runWindowed(recencyQuery, ctx, language));
    recencyTimes.push(r.ms);
    lastRecency = r.out;

    try {
      const v = await timeIt(() => runWindowed(vectorQuery, ctx, language));
      vectorTimes.push(v.ms);
      lastVector = v.out;
    } catch (err) {
      vectorError = err.message;
      break;
    }
  }

  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : NaN);

  console.log('⏱  Latency (window-expansion loop, avg over ' + RUNS + ' runs, warm):');
  console.log(`   recency: ${avg(recencyTimes)}ms   ${JSON.stringify(recencyTimes)}`);
  if (vectorError) {
    console.log(`   vector : ERROR — ${vectorError}`);
    console.log('\n❌ Vector search failed. Common causes: index not READY, _id/category not an');
    console.log('   indexed filter field, or wrong embedding dims. Check the default index definition.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`   vector : ${avg(vectorTimes)}ms   ${JSON.stringify(vectorTimes)}`);

  console.log('\n📦 Pool sizes:');
  console.log(`   recency: ${lastRecency.cands.length} candidates (window ${Math.round(lastRecency.used / HOUR)}h)`);
  console.log(`   vector : ${lastVector.cands.length} candidates (window ${Math.round(lastVector.used / HOUR)}h)`);

  // Overlap of the top-LIMIT each mode would actually serve (pre-scorer).
  const rTop = new Set(topIds(lastRecency.cands, LIMIT));
  const vTop = new Set(topIds(lastVector.cands, LIMIT));
  const shared = [...vTop].filter((id) => rTop.has(id)).length;
  console.log(`\n🔁 Overlap of top-${LIMIT} (before scoring): ${shared}/${LIMIT} shared ` +
    `(${Math.round((shared / LIMIT) * 100)}%) — low overlap means vector surfaces different articles.`);

  const fmt = (a, i, extra = '') =>
    `   ${String(i + 1).padStart(2)}. [${a.category || '—'}] ${(a.title || '').slice(0, 70)}${extra}`;

  console.log(`\n📰 RECENCY top-${LIMIT} (by publishedAt):`);
  lastRecency.cands.slice(0, LIMIT).forEach((a, i) =>
    console.log(fmt(a, i, `  (${new Date(a.publishedAt).toISOString().slice(0, 10)})`)));

  console.log(`\n🧭 VECTOR top-${LIMIT} (by similarity):`);
  lastVector.cands.slice(0, LIMIT).forEach((a, i) =>
    console.log(fmt(a, i, `  sim=${(a._atlasSimilarity ?? 0).toFixed(3)} (${new Date(a.publishedAt).toISOString().slice(0, 10)})`)));

  await mongoose.disconnect();
  console.log('\n✅ Done.');
}

main().catch(async (err) => {
  console.error('💥 Benchmark failed:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
