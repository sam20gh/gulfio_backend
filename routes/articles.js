/**
 * 📄 Article API Routes
 * Personalized and generic article feeds with page-aware recency blending.
 */

const express = require('express');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const User = require('../models/User');
const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const { redis } = require('../utils/redis');
const { getFaissIndexStatus, searchFaissIndex } = require('../recommendation/faissIndex');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const cacheWarmer = require('../services/cacheWarmer');

const articleRouter = express.Router();

/** ---- Utilities ---- **/

// Engagement score: tune weights here if needed
const viewsWeight = 1.0;
const likesWeight = 3.0;
const dislikesWeight = -2.0;
const recencyWeight = 4.0;

function basicRecencyScore(publishedAt) {
  const now = Date.now();
  const t = new Date(publishedAt || Date.now()).getTime();
  const hours = (now - t) / (1000 * 60 * 60);
  if (hours <= 24) return 1.0;
  if (hours <= 48) return 0.8;
  if (hours <= 72) return 0.6;
  if (hours <= 168) return 0.4; // 7 days
  return Math.max(0, 1 - hours / (24 * 30)); // taper over ~30 days
}

function calculateEngagementScore(article) {
  const recencyScore = basicRecencyScore(article.publishedAt);
  return (
    (article.viewCount || 0) * viewsWeight +
    (article.likes || 0) * likesWeight +
    (article.dislikes || 0) * dislikesWeight +
    recencyScore * recencyWeight
  );
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

/** Clear all article caches (used after reacts) */
async function clearArticlesCache() {
  try {
    // Clear all article-related caches
    const articleKeys = await redis.keys('articles_*');
    const servedKeys = await redis.keys('served_personalized_*');
    const allKeys = [...articleKeys, ...servedKeys];

    if (allKeys.length > 0) {
      await redis.del(allKeys);
      console.log('🧹 Cleared article caches:', allKeys.length, 'keys');
      console.log('🧹 Article keys cleared:', articleKeys.length);
      console.log('🧹 Served keys cleared:', servedKeys.length);
    } else {
      console.log('🧹 No article caches to clear');
    }
  } catch (error) {
    console.error('⚠️ Error clearing article caches:', error.message);
    // Don't throw - cache clearing failure shouldn't break the like/dislike
  }
}

/** Recompute the user's profile embedding after an interaction */
async function updateUserProfileEmbedding(userMongoId) {
  try {
    // Project-specific: you already have this logic in your codebase
    // Call into your existing function to rebuild user embedding and store
    // For illustration only:
    const user = await User.findById(userMongoId).lean();
    if (!user) return;
    // ... compute new embedding (e.g., from recent likes/dislikes/text) ...
    // await User.updateOne({ _id: userMongoId }, { $set: { embedding_pca: newEmbeddingPCA }});
  } catch (e) {
    console.warn('Embedding refresh failed (non-fatal):', e.message);
  }
}

/** Deterministic LCG for stable pseudo-randomness */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (1103515245 * s + 12345) >>> 0) / 4294967296);
}

/** Simple hash function for seed generation */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash);
}

/** ---- Routes ---- **/

// GET: Quick performance test endpoint
articleRouter.get('/perf-test', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();
  try {
    const userId = req.mongoUser.supabase_id;

    // Test 1: Simple article count
    const simpleCount = await Article.countDocuments({ language: 'english' });
    const t1 = Date.now() - startTime;

    // Test 2: User lookup
    const user = await User.findOne({ supabase_id: userId }).lean();
    const t2 = Date.now() - startTime;

    // Test 3: Redis test
    let redisOk = false;
    try {
      await redis.set('test_key', 'test_value', 'EX', 10);
      await redis.get('test_key');
      redisOk = true;
    } catch (e) {
      console.error('Redis test failed:', e.message);
    }
    const t3 = Date.now() - startTime;

    // Test 4: Basic article fetch
    const sampleArticles = await Article.find({ language: 'english' })
      .sort({ publishedAt: -1 })
      .limit(5)
      .lean();
    const t4 = Date.now() - startTime;

    res.json({
      totalTime: Date.now() - startTime,
      tests: {
        articleCount: { time: t1, result: simpleCount },
        userLookup: { time: t2, hasUser: !!user, hasEmbedding: !!(user?.embedding_pca) },
        redis: { time: t3, working: redisOk },
        sampleFetch: { time: t4, count: sampleArticles.length }
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Performance test failed',
      message: error.message,
      totalTime: Date.now() - startTime
    });
  }
});

// GET: Fast personalized fallback (simplified algorithm)
// GET: Ultra-fast personalized articles with source population (for first page)
articleRouter.get('/personalized-light', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();
  try {
    const userId = req.mongoUser.supabase_id;
    const language = req.query.language || 'english';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    console.log(`🚀 Light personalized for user ${userId}, limit ${limit}, lang: ${language}`);

    // Mark user as active for cache warming (temporarily disabled)
    // cacheWarmer.markUserActive(userId);

    // Check warm cache first
    const cacheKey = `articles_warm_${userId}_${language}`;
    let cached;
    try {
      cached = await redis.get(cacheKey);
      if (cached && !req.query.noCache) {
        const result = JSON.parse(cached);
        console.log(`🚀 Light cache hit in ${Date.now() - startTime}ms - ${result.length} articles`);
        return res.json(result);
      }
    } catch (err) {
      console.error('⚠️ Redis get error:', err.message);
    }

    // Fast query with source population - crucial for preventing "Unknown Source"
    const articles = await Article.find({
      language,
      publishedAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } // Last 48 hours
    })
      .populate('sourceId', 'name icon groupName') // Populate source data immediately
      .sort({ publishedAt: -1, viewCount: -1 })
      .limit(limit)
      .lean();

    // Transform articles with pre-populated source data
    const response = articles.map(article => ({
      ...article,
      fetchId: new mongoose.Types.ObjectId().toString(),
      isLight: true,
      // Extract source info from populated data
      sourceName: article.sourceId?.name || 'Unknown Source',
      sourceIcon: article.sourceId?.icon || null,
      sourceGroupName: article.sourceId?.groupName || null
    }));

    // Cache for 5 minutes only (fresh content)
    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    console.log(`🚀 Light personalized complete in ${Date.now() - startTime}ms - ${response.length} articles`);
    res.json(response);

  } catch (error) {
    console.error('❌ Light personalized error:', error);
    res.status(500).json({ error: 'Light personalized error', message: error.message });
  }
});

articleRouter.get('/personalized-fast', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
    const language = req.query.language || 'english';
    const userId = req.mongoUser.supabase_id;

    console.log(`⚡ Fast personalized for user ${userId}, page ${page}, limit ${limit}`);

    // Simple cache key
    const cacheKey = `articles_fast_${userId}_page_${page}_limit_${limit}_lang_${language}`;

    // Cache check
    let cached;
    try {
      cached = await redis.get(cacheKey);
      if (!req.query.noCache && cached) {
        console.log(`⚡ Fast cache hit in ${Date.now() - startTime}ms`);
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      console.error('⚠️ Redis get error:', err.message);
    }

    // Get user preferences quickly
    const user = await User.findOne({ supabase_id: userId }, 'liked_articles disliked_articles').lean();
    const skip = (page - 1) * limit;

    // Fast query: recent articles, exclude dislikes
    const excludeIds = user?.disliked_articles || [];
    const articles = await Article.find({
      language,
      _id: { $nin: excludeIds },
      publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
    })
      .sort({ publishedAt: -1, viewCount: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Simple enhancement
    const enhancedArticles = articles.map(article => ({
      ...article,
      fetchId: new mongoose.Types.ObjectId().toString(),
      isFast: true,
      engagementScore: calculateEngagementScore(article)
    }));

    // Cache for 10 minutes
    try {
      await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 600);
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    console.log(`⚡ Fast personalized complete in ${Date.now() - startTime}ms - ${enhancedArticles.length} articles`);
    res.json(enhancedArticles);

  } catch (error) {
    console.error('❌ Fast personalized error:', error);
    res.status(500).json({ error: 'Fast personalized error', message: error.message });
  }
});

// Performance configuration constants
const VECTOR_INDEX = "articles_pca_index";
const NUM_CANDIDATE_MULT = 4;
const LIMIT_MULT = 2;
const DIVERSITY_RATIO = 0.15;
const TRENDING_RATIO = 0.10;
const VECTOR_PROBE_TTL_MS = 5 * 60 * 1000;
const VECTOR_MAX_TIME_MS = 2000;
const ROUTE_BUDGET_MS = 4500;
const ENABLE_SERVER_TIMING = true;

// Module-scoped vector readiness cache
let _vectorProbe = { ok: false, checkedAt: 0, dims: null };

// Vector readiness probe
async function isVectorSearchReady() {
  const now = Date.now();
  if (now - _vectorProbe.checkedAt < VECTOR_PROBE_TTL_MS) {
    return _vectorProbe.ok;
  }

  try {
    const indexes = await Article.collection.listSearchIndexes({ name: VECTOR_INDEX }).toArray();
    const vectorIndex = indexes.find(idx => idx.name === VECTOR_INDEX);
    const ok = vectorIndex && (vectorIndex.status === 'READY' || vectorIndex.queryable);
    const dims = vectorIndex?.latestDefinition?.mappings?.fields?.embedding_pca?.dimensions || null;

    _vectorProbe = { ok, checkedAt: now, dims };
    return ok;
  } catch (error) {
    console.error('🔍 Vector readiness probe failed:', error.message);
    _vectorProbe = { ok: false, checkedAt: now, dims: null };
    return false;
  }
}

// Quick vector probe
async function quickVectorProbe(queryVector, cutoffDate, language, excludeIds) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: "embedding_pca",
          queryVector: queryVector,
          numCandidates: 32,
          limit: 1,
          filter: {
            language: language,
            publishedAt: { $gte: cutoffDate },
            _id: { $nin: excludeIds }
          }
        }
      }
    ];

    const results = await Article.aggregate(pipeline, { maxTimeMS: 400, allowDiskUse: true });
    return { ok: true };
  } catch (error) {
    if (error.message.includes('index') || error.message.includes('cluster')) {
      return { ok: false };
    }
    return { ok: true }; // Other errors don't mean vector search is unavailable
  }
}

// GET: Personalized article recommendations (MongoDB Atlas $vectorSearch + recency mix)
articleRouter.get('/personalized', auth, ensureMongoUser, async (req, res) => {
  // Set a longer timeout for this complex endpoint
  req.setTimeout(60000); // 60 seconds for complex AI processing

  // 📏 End-to-end timing: Request received
  const requestStartTime = Date.now();
  const startTime = Date.now();
  const deadlineMs = ROUTE_BUDGET_MS;
  const timings = {};
  const mark = (k) => timings[k] = Date.now() - startTime;

  try {
    const userId = req.mongoUser.supabase_id;

    // Mark user as active for cache warming (temporarily disabled)
    // cacheWarmer.markUserActive(userId);

    console.log('🔥 PERSONALIZED ENDPOINT START:', new Date().toISOString());
    console.log(`📏 E2E: Request received at ${requestStartTime}ms`);

    // Override res.json to measure JSON serialization time
    const originalJson = res.json;
    res.json = function (data) {
      const jsonStartTime = Date.now();
      console.log(`📏 E2E: Starting JSON serialization at ${jsonStartTime - requestStartTime}ms`);

      const result = originalJson.call(this, data);

      const jsonEndTime = Date.now();
      const totalE2ETime = jsonEndTime - requestStartTime;
      const jsonSerializationTime = jsonEndTime - jsonStartTime;

      console.log(`📏 E2E: JSON serialization took ${jsonSerializationTime}ms`);
      console.log(`📏 E2E: TOTAL REQUEST-TO-JSON time: ${totalE2ETime}ms`);
      console.log(`📏 E2E: Response sent at ${jsonEndTime}ms`);

      return result;
    };

    // Input validation and clamping
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
    const language = req.query.language || 'english';
    const resetServed = req.query.resetServed === '1';

    // Day-based keys for non-repetition
    const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const servedKey = `served_personalized_${userId}_${language}_${dayKey}`;
    const noveltySeed = simpleHash(`${userId}:${page}:${dayKey}`);

    console.log(`🎯 Fetching personalized articles for user ${userId}, page ${page}, limit ${limit}, language ${language}`);
    console.log(`⏱️ Processing time so far: ${Date.now() - startTime}ms`);

    // Reset served articles if requested
    if (resetServed) {
      try {
        await redis.del(servedKey);
        console.log('🔄 Reset served articles for today');
      } catch (err) {
        console.error('⚠️ Failed to reset served articles:', err.message);
      }
    }

    // Enhanced cache key with day and novelty seed
    const cacheKey = `articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}_${dayKey}_${noveltySeed}`;

    // Cache check
    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }
    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached personalized articles');
      console.log(`⚡ Cache hit in ${Date.now() - startTime}ms`);
      mark('cache_check');
      mark('total');
      if (ENABLE_SERVER_TIMING) {
        res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
        res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
      }
      console.log(`📏 E2E: About to return cached result at ${Date.now() - requestStartTime}ms`);
      return res.json(JSON.parse(cached));
    }

    mark('cache_check');

    console.log(`⏱️ Cache check complete: ${Date.now() - startTime}ms`);

    // Get already served articles
    let servedIds = [];
    try {
      servedIds = await redis.smembers(servedKey);
      console.log(`📚 Served set size: ${servedIds.length}`);
    } catch (err) {
      console.error('⚠️ Redis served set error (safe to ignore):', err.message);
    }

    // User embedding
    const user = await User.findOne({ supabase_id: userId }).lean();
    let userEmbedding = user?.embedding_pca;

    mark('user_load');

    console.log(`⏱️ User data loaded: ${Date.now() - startTime}ms`);

    // Progressive time windows based on page
    const getTimeWindow = (page) => {
      if (page === 1) return { hours: 72, label: 'last 72h' };
      if (page === 2) return { hours: 168, label: 'last 7d' };
      if (page === 3) return { hours: 336, label: 'last 14d' };
      return { hours: 720, label: 'last 30d' };
    };

    const timeWindow = getTimeWindow(page);
    console.log(`⏰ Time window: ${timeWindow.label}, noveltySeed: ${noveltySeed}`);

    // Vector readiness and probe
    const vectorReady = await isVectorSearchReady();
    const canUseVectorSearch = userEmbedding && Array.isArray(userEmbedding) && userEmbedding.length > 0 && vectorReady;
    console.log(`🔍 Vector search available: ${canUseVectorSearch}`);

    console.log(`🔍 Vector search ready: ${vectorReady}, dims: ${_vectorProbe.dims}, user embedding: ${userEmbedding ? 'exists' : 'missing'}`);

    // Time window constraint for probes
    const cutoffTime = new Date(Date.now() - timeWindow.hours * 60 * 60 * 1000);
    const excludeIds = [
      ...servedIds.map(id => new mongoose.Types.ObjectId(id)),
      ...(user?.disliked_articles || [])
    ];

    let quickProbeOk = true;
    if (canUseVectorSearch) {
      const probeResult = await quickVectorProbe(userEmbedding, cutoffTime, language, excludeIds);
      quickProbeOk = probeResult.ok;
      console.log(`🔍 Quick vector probe: ${quickProbeOk ? 'OK' : 'FAILED'}`);
    }

    mark('vector_probe');
    console.log(`⏱️ Vector probe complete: ${Date.now() - startTime}ms`);

    // Fast fallback path for various conditions
    const isSlowRequest = (Date.now() - startTime) > deadlineMs;
    const shouldUseFastFallback = !canUseVectorSearch || !quickProbeOk || (isSlowRequest && page === 1);

    // Fallback path (no embedding OR slow request OR vector unavailable)
    if (shouldUseFastFallback) {
      if (isSlowRequest) {
        console.warn('⚡ Using FAST FALLBACK due to budget exceeded');
      } else if (!canUseVectorSearch) {
        console.warn('⚠️ Falling back to engagement-based sorting');
        console.warn(`Vector ready: ${vectorReady}, embedding: ${userEmbedding ? 'exists' : 'missing'}`);
      } else {
        console.warn('⚡ Using FAST FALLBACK due to probe failure');
      }

      // Fast inline fallback (replicating /personalized-fast logic)
      const fallbackArticles = await Article.find({
        language,
        _id: { $nin: excludeIds },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
      })
        .sort({ publishedAt: -1, viewCount: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const fastResponse = fallbackArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFast: true,
        isFallback: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article)
      }));

      // Track served articles
      if (fastResponse.length > 0) {
        try {
          const articleIds = fastResponse.map(a => a._id.toString());
          await redis.sadd(servedKey, ...articleIds);
          await redis.expire(servedKey, 86400);
        } catch (err) {
          console.error('⚠️ Failed to track served articles:', err.message);
        }
      }

      mark('total');
      console.log(`⚡ FAST FALLBACK complete: ${fastResponse.length} articles, timings.total: ${timings.total}ms`);

      try {
        await redis.set(cacheKey, JSON.stringify(fastResponse), 'EX', 600); // Shorter cache for fallback
      } catch (err) {
        console.error('⚠️ Redis set error (safe to ignore):', err.message);
      }

      if (ENABLE_SERVER_TIMING) {
        res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
        res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
      }

      return res.json(fastResponse);
    }

    /** ---------- Personalized path (MongoDB Atlas $vectorSearch) ---------- */
    console.log('🔍 Using MongoDB Atlas $vectorSearch for personalized recommendations');

    // Build larger candidate pool for pagination
    const candidatePoolSize = limit * 3 * page;
    const searchLimit = candidatePoolSize * LIMIT_MULT;
    const numCandidates = candidatePoolSize * NUM_CANDIDATE_MULT;

    console.log(`🎯 Vector search params: numCandidates=${numCandidates}, limit=${searchLimit}, excludeIds=${excludeIds.length}`);

    // MongoDB Atlas $vectorSearch aggregation
    const performVectorSearch = async (cutoffDate, isWideningSearch = false) => {
      try {
        const pipeline = [
          {
            $vectorSearch: {
              index: VECTOR_INDEX,
              path: "embedding_pca",
              queryVector: userEmbedding,
              numCandidates: numCandidates,
              limit: searchLimit,
              filter: {
                language: language,
                publishedAt: { $gte: cutoffDate },
                _id: { $nin: excludeIds }
              }
            }
          },
          { $addFields: { similarity: { $meta: "vectorSearchScore" } } },
          // Add source population to prevent "Unknown Source"
          {
            $lookup: {
              from: 'sources',
              localField: 'sourceId',
              foreignField: '_id',
              as: 'sourceData'
            }
          },
          {
            $addFields: {
              sourceName: { $arrayElemAt: ['$sourceData.name', 0] },
              sourceIcon: { $arrayElemAt: ['$sourceData.icon', 0] },
              sourceGroupName: { $arrayElemAt: ['$sourceData.groupName', 0] }
            }
          },
          {
            $project: {
              _id: 1,
              title: 1,
              summary: 1,
              image: 1,
              sourceId: 1,
              source: 1,
              sourceName: 1,
              sourceIcon: 1,
              sourceGroupName: 1,
              publishedAt: 1,
              viewCount: 1,
              category: 1,
              likes: 1,
              dislikes: 1,
              likedBy: 1,
              dislikedBy: 1,
              similarity: 1
            }
          }
        ];

        const results = await Article.aggregate(pipeline, {
          maxTimeMS: VECTOR_MAX_TIME_MS,
          allowDiskUse: true
        });
        console.log(`📊 Vector search returned ${results.length} results (cutoff: ${cutoffDate.toISOString().slice(0, 10)})`);
        return results;
      } catch (error) {
        console.error('❌ Vector search error:', error.message);
        if (error.message.includes('index') || error.message.includes('cluster')) {
          console.warn('⚠️ Vector search unavailable, falling back to engagement-based sorting');
          return null; // Trigger fallback
        }
        throw error;
      }
    };

    // Perform initial vector search
    let candidateArticles = await performVectorSearch(cutoffTime);
    mark('vector_search');

    // If vector search failed, fall back to engagement-based approach
    if (candidateArticles === null) {
      console.warn('🔄 Vector search failed, using engagement-based fallback with time window');

      const fallbackArticles = await Article.find({
        language,
        publishedAt: { $gte: cutoffTime },
        _id: { $nin: excludeIds }
      })
        .sort({ publishedAt: -1, viewCount: -1 })
        .limit(candidatePoolSize * 2)
        .lean();

      candidateArticles = fallbackArticles.map(article => ({
        ...article,
        similarity: 0, // No similarity score available
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFallback: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article)
      }));
    }

    // If insufficient candidates, progressively widen time window
    const minCandidatesNeeded = candidatePoolSize + limit; // Buffer for pagination
    if (candidateArticles.length < minCandidatesNeeded && timeWindow.hours < 720) {
      const widerRanges = [
        { hours: 168, label: 'last 7d' },
        { hours: 336, label: 'last 14d' },
        { hours: 720, label: 'last 30d' }
      ];

      for (const range of widerRanges) {
        if (range.hours <= timeWindow.hours) continue;

        const widerCutoff = new Date(Date.now() - range.hours * 60 * 60 * 1000);

        // Additional vector search with wider time window
        let additionalCandidates;
        if (candidateArticles.some(a => !a.isFallback)) {
          // Use vector search for additional candidates
          const widerResults = await performVectorSearch(widerCutoff, true);
          if (widerResults) {
            // Filter out already found articles
            const existingIds = new Set(candidateArticles.map(a => a._id.toString()));
            additionalCandidates = widerResults.filter(a =>
              !existingIds.has(a._id.toString()) &&
              a.publishedAt < cutoffTime
            );
          } else {
            additionalCandidates = [];
          }
        } else {
          // Fallback path - use regular query
          const widerArticles = await Article.find({
            language,
            publishedAt: { $gte: widerCutoff, $lt: cutoffTime },
            _id: { $nin: [...excludeIds, ...candidateArticles.map(a => a._id)] }
          })
            .sort({ publishedAt: -1, viewCount: -1 })
            .limit(minCandidatesNeeded - candidateArticles.length)
            .lean();

          additionalCandidates = widerArticles.map(article => ({
            ...article,
            similarity: 0,
            isFallback: true
          }));
        }

        candidateArticles = [...candidateArticles, ...additionalCandidates];
        console.log(`📅 Widened time window to ${range.label}, total candidates: ${candidateArticles.length}`);

        if (candidateArticles.length >= minCandidatesNeeded) break;
      }
    }

    console.log(`📄 Found ${candidateArticles.length} candidate articles within time window: ${timeWindow.label}`);

    mark('widen');

    // Budget check - if we're over the deadline, return fast fallback
    if (Date.now() - startTime > deadlineMs) {
      console.warn(`⚡ Budget exceeded after vector search, returning fast fallback`);

      const fastFallbackArticles = await Article.find({
        language,
        _id: { $nin: excludeIds },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      })
        .sort({ publishedAt: -1, viewCount: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

      const fastResponse = fastFallbackArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFast: true,
        isOverBudget: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article)
      }));

      if (fastResponse.length > 0) {
        try {
          const articleIds = fastResponse.map(a => a._id.toString());
          await redis.sadd(servedKey, ...articleIds);
          await redis.expire(servedKey, 86400);
        } catch (err) {
          console.error('⚠️ Failed to track served articles:', err.message);
        }
      }

      mark('total');
      console.log(`⚡ OVER-BUDGET FALLBACK complete: ${fastResponse.length} articles, timings.total: ${timings.total}ms`);

      try {
        await redis.set(cacheKey, JSON.stringify(fastResponse), 'EX', 600);
      } catch (err) {
        console.error('⚠️ Redis set error (safe to ignore):', err.message);
      }

      if (ENABLE_SERVER_TIMING) {
        res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
        res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
      }

      return res.json(fastResponse);
    }

    // Page-aware recency weighting
    const w_recency =
      page === 1 ? 0.75 :
        page === 2 ? 0.65 :
          page === 3 ? 0.55 :
            0.45;

    // Recency-first similarity scoring
    const scoredArticles = candidateArticles.map(article => {
      const similarity = article.similarity || 0; // From $meta: "vectorSearchScore" or 0 for fallback
      const engagementScore = calculateEngagementScore(article);
      const recencyScore = basicRecencyScore(article.publishedAt);
      const baseScore = (similarity * 0.6) + (engagementScore * 0.4);
      const finalScore = w_recency * recencyScore + (1 - w_recency) * baseScore;

      return {
        ...article,
        fetchId: article.fetchId || new mongoose.Types.ObjectId().toString(),
        similarity,
        engagementScore,
        recencyScore,
        finalScore,
        timeWindow: timeWindow.label,
        noveltySeed
      };
    });

    // Sort by final score for all candidates
    scoredArticles.sort((a, b) => b.finalScore - a.finalScore);

    mark('scoring');

    // Build final pool with diversity and trending before pagination
    const candidatePool = [...scoredArticles];
    console.log(`📊 Base scored articles: ${candidatePool.length}, w_recency: ${w_recency.toFixed(2)}`);

    // Diversity injection: add older-but-relevant articles to candidate pool
    const diversityPoolSize = Math.ceil(candidatePoolSize * DIVERSITY_RATIO);
    if (diversityPoolSize > 0 && candidatePool.length < candidatePoolSize) {
      console.log(`🎲 Adding up to ${diversityPoolSize} diversity articles to pool`);

      // Use older high-similarity articles for diversity (not yet in pool)
      const usedIds = new Set(candidatePool.map(a => a._id.toString()));
      const diversityCandidates = scoredArticles
        .filter(a => !usedIds.has(a._id.toString()) && a.similarity > 0.3)
        .slice(0, diversityPoolSize * 2);

      // Deterministic shuffle using LCG
      const rng = lcg(noveltySeed);
      const shuffledDiversity = diversityCandidates
        .map(article => ({ article, sort: rng() }))
        .sort((a, b) => a.sort - b.sort)
        .map(item => ({ ...item.article, isDiverse: true }))
        .slice(0, diversityPoolSize);

      candidatePool.push(...shuffledDiversity);
      console.log(`🎯 Diversity added to pool: ${shuffledDiversity.length}`);
    }

    mark('diversity');

    // Trending injection: add to candidate pool
    const trendingPoolSize = Math.ceil(candidatePoolSize * TRENDING_RATIO);
    if (trendingPoolSize > 0 && candidatePool.length < candidatePoolSize) {
      console.log(`📈 Adding up to ${trendingPoolSize} trending articles to pool`);

      const usedIds = new Set(candidatePool.map(a => a._id.toString()));
      const trendingArticles = await Article.find({
        language,
        viewCount: { $exists: true, $gt: 0 },
        publishedAt: { $gte: cutoffTime },
        _id: { $nin: [...excludeIds, ...Array.from(usedIds).map(id => new mongoose.Types.ObjectId(id))] }
      })
        .sort({ viewCount: -1, publishedAt: -1 })
        .limit(trendingPoolSize * 2)
        .lean();

      const trendingEnhanced = trendingArticles.slice(0, trendingPoolSize).map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isTrending: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article),
        finalScore: calculateEngagementScore(article) * 0.7 // Lower score for trending
      }));

      candidatePool.push(...trendingEnhanced);
      console.log(`📈 Trending added to pool: ${trendingEnhanced.length}`);
    }

    mark('trending');

    // Source diversification shuffle
    console.log(`🔀 Applying source diversification to ${candidatePool.length} articles`);

    // Get Source data to map sourceId to groupName
    const uniqueSourceIds = [...new Set(candidatePool.map(a => a.sourceId).filter(Boolean))];
    const Source = require('../models/Source'); // Make sure this path is correct
    const sources = await Source.find({ _id: { $in: uniqueSourceIds } }, 'groupName').lean();
    const sourceIdToGroupName = {};
    sources.forEach(source => {
      sourceIdToGroupName[source._id.toString()] = source.groupName || 'default-group';
    });

    console.log(`📊 Found ${sources.length} sources with groupNames: ${Object.values(sourceIdToGroupName).join(', ')}`);

    // Group articles by source.groupName
    const sourceGroups = {};
    candidatePool.forEach(article => {
      const sourceKey = sourceIdToGroupName[article.sourceId?.toString()] || article.source || 'unknown-group';
      if (!sourceGroups[sourceKey]) {
        sourceGroups[sourceKey] = [];
      }
      sourceGroups[sourceKey].push(article);
    });

    // Sort each source group by finalScore (maintain ranking priority)
    Object.keys(sourceGroups).forEach(source => {
      sourceGroups[source].sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
    });

    // Round-robin interleaving with ranking priority
    const interleaved = [];
    const sourceKeys = Object.keys(sourceGroups);
    let maxGroupSize = Math.max(...sourceKeys.map(key => sourceGroups[key].length));

    console.log(`🔀 Interleaving ${sourceKeys.length} source groups (${sourceKeys.join(', ')}), max group size: ${maxGroupSize}`);

    // Interleave round-robin: take highest scoring from each group in turns
    for (let round = 0; round < maxGroupSize; round++) {
      for (const sourceKey of sourceKeys) {
        if (sourceGroups[sourceKey][round]) {
          interleaved.push(sourceGroups[sourceKey][round]);
        }
      }
    }

    console.log(`🎯 Source diversification complete: ${interleaved.length} articles interleaved across ${sourceKeys.length} groups`);

    mark('interleave');

    // Apply pagination AFTER scoring, diversity, and source shuffling
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    let finalArticles = interleaved.slice(startIndex, endIndex);

    mark('paginate');

    // Track served articles
    if (finalArticles.length > 0) {
      try {
        const articleIds = finalArticles.map(a => a._id.toString());
        await redis.sadd(servedKey, ...articleIds);
        await redis.expire(servedKey, 86400);
      } catch (err) {
        console.error('⚠️ Failed to track served articles:', err.message);
      }
    }

    console.log(`🎯 Final composition: ${finalArticles.length} articles, cacheKey: ${cacheKey.slice(-20)}...`);
    mark('cache_set');

    mark('total');
    console.log(`⚡ TOTAL PROCESSING TIME: ${timings.total}ms`);
    console.log(`📊 Vector ready: ${vectorReady}, dims: ${_vectorProbe.dims}, timings:`, timings);

    if (ENABLE_SERVER_TIMING) {
      res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
      res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
    }

    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 3600);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    console.log(`📏 E2E: About to send final response at ${Date.now() - requestStartTime}ms`);
    res.json(finalArticles);
  } catch (error) {
    const processingTime = Date.now() - startTime;
    const e2eTime = Date.now() - requestStartTime;
    console.error('❌ Error fetching personalized articles:', error);
    console.error(`⏱️ Failed after ${processingTime}ms (E2E: ${e2eTime}ms)`);

    // Return a meaningful error response
    if (processingTime > 50000) {
      res.status(504).json({ error: 'Request timeout - processing took too long', message: error.message });
    } else {
      res.status(500).json({ error: 'Error fetching personalized articles', message: error.message });
    }
  }
});

// GET: Articles by category (public - works for both authenticated and non-authenticated users)
articleRouter.get('/category', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const language = req.query.language || 'english';
    const category = req.query.category;

    if (!category) {
      return res.status(400).json({ error: 'Category parameter is required' });
    }

    console.log(`🏷️ Fetching category articles for category: "${category}", page: ${page}, limit: ${limit}`);
    console.log(`🔍 Raw query params:`, req.query);

    const startTime = Date.now();
    const skip = (page - 1) * limit;

    // Build cache key
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `articles_category_public_${category}_page_${page}_limit_${limit}_lang_${language}_${today}`;

    // Check cache first
    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }
    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached category articles');
      return res.json(JSON.parse(cached));
    }

    // Build base query with category filter
    const filter = {
      language,
      category
    };

    console.log(`🔍 MongoDB query filter:`, filter);
    console.log(`🔍 Searching for articles in category: "${category}"`);

    // Check how many articles exist in this category total
    const totalInCategory = await Article.countDocuments({ language, category });
    console.log(`📊 Total articles in category "${category}": ${totalInCategory}`);

    // Fetch articles from the specified category
    const raw = await Article.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit * 2) // Get more to allow for better ranking
      .lean();

    console.log(`📊 Found ${raw.length} articles in category`);

    if (raw.length === 0) {
      console.log(`⚠️ No articles found in category: "${category}"`);
      return res.json([]);
    }

    // Apply basic ranking (no personalization for public endpoint)
    const enhancedArticles = raw
      .map((article) => {
        const engagement = calculateEngagementScore(article);
        const recency = basicRecencyScore(article.publishedAt);

        // Weight more toward recency for public endpoint
        const finalScore = 0.7 * recency + 0.3 * engagement;

        return {
          ...article,
          fetchId: new mongoose.Types.ObjectId().toString(),
          engagementScore: engagement,
          finalScore,
        };
      })
      .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
      .slice(0, limit); // Take only the requested limit

    // Cache the results
    try {
      await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 300); // 5 minutes
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Category articles fetched in ${duration}ms - ${enhancedArticles.length} articles`);

    res.json(enhancedArticles);
  } catch (error) {
    console.error('❌ Error fetching category articles:', error);
    res.status(500).json({ error: 'Error fetching category articles', message: error.message });
  }
});

// GET: Personalized articles by category (similar to personalized but filtered by category)
articleRouter.get('/personalized-category', auth, ensureMongoUser, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const language = req.query.language || 'english';
    const category = req.query.category;
    const userId = req.mongoUserId;

    if (!category) {
      return res.status(400).json({ error: 'Category parameter is required' });
    }

    console.log(`🏷️ Fetching personalized articles for user ${userId}, category: "${category}", page: ${page}, limit: ${limit}`);
    console.log(`🔍 Raw query params:`, req.query);

    const startTime = Date.now();
    const skip = (page - 1) * limit;

    // Build cache key including category
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `articles_personalized_category_${userId}_${category}_page_${page}_limit_${limit}_lang_${language}_${today}`;

    // Check cache first
    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }
    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached personalized category articles');
      return res.json(JSON.parse(cached));
    }

    // Get user preferences
    const user = await User.findById(userId).lean();
    const likedArticles = user?.liked_articles || [];
    const dislikedArticles = user?.disliked_articles || [];

    // Build base query with category filter
    const filter = {
      language,
      category,
      _id: { $nin: [...likedArticles, ...dislikedArticles] } // Exclude already interacted articles
    };

    console.log(`🔍 MongoDB query filter:`, filter);
    console.log(`🔍 Searching for articles in category: "${category}"`);

    // First, let's check how many articles exist in this category total
    const totalInCategory = await Article.countDocuments({ language, category });
    console.log(`📊 Total articles in category "${category}": ${totalInCategory}`);

    // Fetch articles from the specified category
    const raw = await Article.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit * 2) // Get more to allow for better ranking
      .lean();

    console.log(`📊 Found ${raw.length} articles after applying user exclusions`);

    if (raw.length === 0) {
      console.log(`⚠️ No articles found in category: "${category}" after applying user exclusions`);

      // Try without user exclusions to see if that's the issue
      const rawWithoutExclusions = await Article.find({ language, category })
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(5)
        .lean();

      console.log(`🔍 Articles in "${category}" without user exclusions: ${rawWithoutExclusions.length}`);

      return res.json([]);
    }

    // Apply personalized ranking based on user preferences
    const freshRatio = page === 1 ? 0.75 : page === 2 ? 0.60 : page === 3 ? 0.50 : 0.40;

    const enhancedArticles = raw
      .map((article) => {
        const engagement = calculateEngagementScore(article);
        const recency = basicRecencyScore(article.publishedAt);

        // Simple preference bonus if user has liked similar sources or recent articles
        let preferenceBonus = 0;
        if (likedArticles.length > 0) {
          // Small bonus for articles from sources user has liked before
          preferenceBonus = 0.1;
        }

        const baseScore = engagement + preferenceBonus;
        const finalScore = freshRatio * recency + (1 - freshRatio) * baseScore;

        return {
          ...article,
          fetchId: new mongoose.Types.ObjectId().toString(),
          engagementScore: engagement,
          finalScore,
        };
      })
      .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))
      .slice(0, limit); // Take only the requested limit

    // Cache the results
    try {
      await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 300); // 5 minutes
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Personalized category articles fetched in ${duration}ms - ${enhancedArticles.length} articles`);

    res.json(enhancedArticles);
  } catch (error) {
    console.error('❌ Error fetching personalized category articles:', error);
    res.status(500).json({ error: 'Error fetching personalized category articles', message: error.message });
  }
});

// GET: Generic (guest) feed with recency-aware sort
articleRouter.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const language = req.query.language || 'english';
    const category = req.query.category;

    const cacheKey = `articles_page_${page}_limit_${limit}_lang_${language}_cat_${category || 'all'}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }
    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;

    // Build query filter
    const filter = { language };
    if (category) {
      filter.category = category;
      console.log('🏷️ Filtering articles by category:', category);
    }

    // Fetch newest first
    const raw = await Article.find(filter)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Re-rank by page-aware recency+engagement for better first page feel
    const freshRatio =
      page === 1 ? 0.70 :
        page === 2 ? 0.55 :
          page === 3 ? 0.45 :
            0.35;

    const enhancedArticles = raw
      .map((a) => {
        const engagement = calculateEngagementScore(a);
        const recency = basicRecencyScore(a.publishedAt);
        const baseScore = engagement; // no similarity for guests
        const finalScore = freshRatio * recency + (1 - freshRatio) * baseScore;
        return {
          ...a,
          fetchId: new mongoose.Types.ObjectId().toString(),
          engagementScore: engagement,
          finalScore,
        };
      })
      .sort((x, y) => (y.finalScore ?? 0) - (x.finalScore ?? 0));

    try {
      await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(enhancedArticles);
  } catch (error) {
    console.error('❌ Error fetching articles:', error);
    res.status(500).json({ error: 'Error fetching articles', message: error.message });
  }
});

// React (like/dislike)
articleRouter.post('/:id/react', auth, ensureMongoUser, async (req, res) => {
  try {
    const { action } = req.body;
    const userId = req.mongoUser.supabase_id;
    const articleId = req.params.id;
    const mongoUser = req.mongoUser;

    if (!mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ message: 'Invalid article ID' });
    }
    if (!['like', 'dislike'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }

    // 1) Update article reaction arrays
    await Article.updateOne(
      { _id: articleId },
      { $pull: { likedBy: userId, dislikedBy: userId } }
    );

    const pushOp = action === 'like'
      ? { $push: { likedBy: userId } }
      : { $push: { dislikedBy: userId } };

    await Article.updateOne({ _id: articleId }, pushOp);

    // 2) Update user lists
    const articleObjectId = new mongoose.Types.ObjectId(articleId);
    await User.updateOne(
      { _id: mongoUser._id },
      { $pull: { liked_articles: articleObjectId, disliked_articles: articleObjectId } }
    );

    if (action === 'like') {
      await User.updateOne({ _id: mongoUser._id }, { $addToSet: { liked_articles: articleObjectId } });
    } else {
      await User.updateOne({ _id: mongoUser._id }, { $addToSet: { disliked_articles: articleObjectId } });
    }

    // 3) Recompute embedding
    await updateUserProfileEmbedding(mongoUser._id);

    // 4) Return updated counts
    const updatedArticle = await Article.findById(articleId, 'likedBy dislikedBy');
    const likes = updatedArticle?.likedBy?.length || 0;
    const dislikes = updatedArticle?.dislikedBy?.length || 0;

    updatedArticle.likes = likes;
    updatedArticle.dislikes = dislikes;
    await updatedArticle.save();

    res.json({ userReact: action, likes, dislikes });

    await clearArticlesCache();
  } catch (error) {
    console.error('Error in POST /:id/react:', error);
    res.status(500).json({ message: 'Error reacting to article', error: error.message });
  }
});

// Related-by-embedding (small helper endpoint you already have)
articleRouter.get('/related-embedding/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const target = await Article.findById(id);
    if (!target?.embedding) return res.status(404).json({ error: 'No embedding found' });

    const allArticles = await Article.find({ _id: { $ne: id }, embedding: { $exists: true } });

    const cosineSimilarity = (a, b) => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
    };

    const related = allArticles
      .map(a => ({ ...a.toObject(), similarity: cosineSimilarity(target.embedding, a.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    res.json(related);
  } catch (err) {
    console.error('Error finding related articles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Feature (unchanged, minus minor cleanups)
articleRouter.get('/feature', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const language = req.query.language || 'english';

    const cacheKey = `articles_feature_page_${page}_limit_${limit}_lang_${language}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({ category: 'feature', language })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalFeatureArticles = await Article.countDocuments({ category: 'feature', language });

    const response = {
      articles,
      totalPages: Math.ceil(totalFeatureArticles / limit),
      currentPage: page,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching feature articles:', error);
    res.status(500).json({ error: 'Error fetching feature articles', message: error.message });
  }
});

// Headline (unchanged)
articleRouter.get('/headline', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const language = req.query.language || 'english';

    const cacheKey = `articles_headline_page_${page}_limit_${limit}_lang_${language}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({ category: 'headline', language })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalHeadlineArticles = await Article.countDocuments({ category: 'headline', language });

    const response = {
      articles,
      totalPages: Math.ceil(totalHeadlineArticles / limit),
      currentPage: page,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching headline articles:', error);
    res.status(500).json({ error: 'Error fetching headline articles', message: error.message });
  }
});

// Create (embedding)
articleRouter.post('/', auth, async (req, res) => {
  try {
    const { title, content, url, sourceId, category, publishedAt, image } = req.body;
    if (!title || !content || !url || !sourceId || !category || !image) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const embeddingInput = `${title}\n\n${content?.slice(0, 512) || ''}`;
    let embedding = [];
    try {
      embedding = await getDeepSeekEmbedding(embeddingInput);
    } catch (embeddingError) {
      console.warn('DeepSeek embedding error (article will save without embedding):', embeddingError.message);
    }

    const newArticle = new Article({
      title, content, url, sourceId, category, publishedAt, image, embedding,
    });
    const savedArticle = await newArticle.save();
    res.status(201).json(savedArticle);
  } catch (error) {
    res.status(400).json({ message: 'Error creating article', error: error.message });
  }
});

// Update
articleRouter.put('/:id', auth, async (req, res) => {
  try {
    const updatedArticle = await Article.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updatedArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }
    res.json(updatedArticle);
  } catch (error) {
    res.status(400).json({ message: 'Error updating article', error: error.message });
  }
});

// GET related articles based on similarity
articleRouter.get('/related/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 5, 20); // Max 20 related articles

    console.log(`🔍 Fetching related articles for: ${id}, limit: ${limit}`);

    // Get the base article
    const baseArticle = await Article.findById(id).lean();
    if (!baseArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }

    console.log(`📰 Base article: "${baseArticle.title?.slice(0, 50)}..." Category: ${baseArticle.category}`);

    let relatedArticles = [];

    // Method 1: Try embedding-based similarity if embeddings exist
    if (baseArticle.embedding_pca && baseArticle.embedding_pca.length > 0) {
      console.log('🔍 Using PCA embedding-based similarity');

      // Find articles with PCA embeddings in the same category
      const candidateArticles = await Article.find({
        _id: { $ne: id },
        embedding_pca: { $exists: true, $not: { $size: 0 } },
        category: baseArticle.category
      })
        .select('title content category sourceId publishedAt image url viewCount likes dislikes embedding_pca')
        .limit(50) // Get more candidates for better similarity scoring
        .lean();

      console.log(`📊 Found ${candidateArticles.length} candidate articles with PCA embeddings`);

      // Calculate cosine similarity with PCA embeddings
      const similarities = candidateArticles.map(article => {
        const similarity = cosineSimilarity(baseArticle.embedding_pca, article.embedding_pca);
        return { ...article, similarity };
      });

      // Sort by similarity and take top results
      relatedArticles = similarities
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      console.log(`🔍 Top similarities: ${relatedArticles.slice(0, 3).map(a => a.similarity.toFixed(3)).join(', ')}`);
    }

    // Method 2: If no embedding results or not enough, fall back to category/source similarity
    if (relatedArticles.length < limit) {
      console.log('🔍 Using category/source-based similarity as fallback');

      const remaining = limit - relatedArticles.length;
      const excludeIds = relatedArticles.map(a => a._id.toString()).concat([id]);

      // First try same category, different source
      let categoryArticles = await Article.find({
        _id: { $nin: excludeIds },
        category: baseArticle.category,
        sourceId: { $ne: baseArticle.sourceId }
      })
        .select('title content category sourceId publishedAt image url viewCount likes dislikes')
        .sort({ publishedAt: -1 })
        .limit(remaining)
        .lean();

      relatedArticles = relatedArticles.concat(categoryArticles.map(a => ({ ...a, similarity: 0.7 })));

      // If still not enough, try same source
      if (relatedArticles.length < limit) {
        const stillRemaining = limit - relatedArticles.length;
        const newExcludeIds = relatedArticles.map(a => a._id.toString()).concat([id]);

        const sourceArticles = await Article.find({
          _id: { $nin: newExcludeIds },
          sourceId: baseArticle.sourceId
        })
          .select('title content category sourceId publishedAt image url viewCount likes dislikes')
          .sort({ publishedAt: -1 })
          .limit(stillRemaining)
          .lean();

        relatedArticles = relatedArticles.concat(sourceArticles.map(a => ({ ...a, similarity: 0.5 })));
      }
    }

    // Clean up the results - return complete article objects
    const finalResults = relatedArticles.slice(0, limit).map(article => ({
      ...article,
      similarity: article.similarity || 0
    }));

    console.log(`✅ Returning ${finalResults.length} related articles with complete data`);
    res.json(finalResults);

  } catch (error) {
    console.error('Error fetching related articles:', error);
    res.status(500).json({ message: 'Error fetching related articles', error: error.message });
  }
});

// GET one - Must be last to avoid conflicts with specific routes
articleRouter.get('/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });
    res.json(article);
  } catch (err) {
    console.error('GET /:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = articleRouter;

/*
=== MongoDB Atlas Search Index Configuration ===

Create this Atlas Search index named "articles_pca_index" on the articles collection:

{
  "mappings": {
    "dynamic": false,
    "fields": {
      "embedding_pca": {
        "type": "vector",
        "similarity": "cosine",
        "dimensions": 128
      },
      "language": { "type": "keyword" },
      "publishedAt": { "type": "date" }
    }
  }
}

Note: Replace 128 with your actual PCA dimensions if different.

=== MongoDB Secondary Indexes ===

Run these commands in MongoDB shell or compass:

db.articles.createIndex({ language: 1, publishedAt: -1 })
db.articles.createIndex({ viewCount: -1, publishedAt: -1, language: 1 })
db.articles.createIndex({ "source": 1, publishedAt: -1 })

=== Test Plan ===

Unit Tests:
- Test vector search with valid embedding_pca
- Test fallback when embedding_pca is missing
- Test progressive time window widening
- Test diversity and trending injection
- Test source diversification
- Test pagination correctness
- Test Redis served set management

Integration Tests:
- Test with real MongoDB Atlas cluster
- Test vector search index availability
- Test performance under load
- Test cache hit/miss scenarios

Smoke Tests:
- GET /articles/personalized?page=1&limit=20&language=english
- GET /articles/personalized?page=2&limit=10&language=arabic
- GET /articles/personalized?resetServed=1
- GET /articles/personalized?noCache=1

=== Operations Notes ===

Redis Keys & TTLs:
- served_personalized_${userId}_${language}_${dayKey} (86400s TTL)
- articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}_${dayKey}_${noveltySeed} (3600s TTL)

Monitoring:
- Track vector search response times
- Monitor fallback usage rates  
- Alert on vector search errors
- Monitor Redis memory usage
- Track cache hit rates

Performance Knobs:
- VECTOR_INDEX: Atlas Search index name
- NUM_CANDIDATE_MULT: Controls numCandidates (4x pool size)
- LIMIT_MULT: Controls search limit (2x pool size)
- DIVERSITY_RATIO: Diversity injection percentage (0.15 = 15%)
- TRENDING_RATIO: Trending injection percentage (0.10 = 10%)
*/

// Cache Warmer Admin Endpoints (temporarily disabled)
/*
articleRouter.get('/cache-warmer/stats', (req, res) => {
  try {
    const stats = cacheWarmer.getStats();
    res.json({
      status: 'success',
      cacheWarmer: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Cache warmer stats error:', error);
    res.status(500).json({ error: 'Failed to get cache warmer stats' });
  }
});

articleRouter.post('/cache-warmer/force-warm/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await cacheWarmer.forceWarmUser(userId);
    res.json({
      status: 'success',
      message: `Cache warming forced for user ${userId}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Force warm error:', error);
    res.status(500).json({ error: 'Failed to force warm user cache' });
  }
});
*/

module.exports = articleRouter;
