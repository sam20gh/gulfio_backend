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
const redis = require('../utils/redis');
const { getDeepSeekEmbedding } = require('../utils/deepseek');

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

// Utility function to limit articles per source group (max 2 per group)
function limitArticlesPerSourceGroup(articles, maxPerGroup = 2) {
  const sourceGroupCounts = {};
  return articles.filter(article => {
    const sourceGroup = article.sourceGroupName || article.sourceId?.groupName || article.sourceId?.toString() || article.source || 'unknown-group';

    if (!sourceGroupCounts[sourceGroup]) {
      sourceGroupCounts[sourceGroup] = 0;
    }

    if (sourceGroupCounts[sourceGroup] < maxPerGroup) {
      sourceGroupCounts[sourceGroup]++;
      return true;
    }

    return false;
  });
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

    // Also specifically target the main articles endpoint cache that QuickStartContent uses
    const pageKeys = await redis.keys('articles_page_*');

    const allKeys = [...articleKeys, ...servedKeys, ...pageKeys];

    console.log('🔍 Cache clear debug - Article keys found:', articleKeys.slice(0, 5), articleKeys.length > 5 ? `... and ${articleKeys.length - 5} more` : '');
    console.log('🔍 Cache clear debug - Page keys found:', pageKeys.slice(0, 3), pageKeys.length > 3 ? `... and ${pageKeys.length - 3} more` : '');
    console.log('🔍 Cache clear debug - Served keys found:', servedKeys.slice(0, 3), servedKeys.length > 3 ? `... and ${servedKeys.length - 3} more` : '');

    if (allKeys.length > 0) {
      await redis.del(allKeys);
      console.log('🧹 Cleared article caches:', allKeys.length, 'keys');
      console.log('🧹 Article keys cleared:', articleKeys.length);
      console.log('🧹 Page keys cleared:', pageKeys.length);
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
    const { updateUserProfileEmbedding: updateEmbedding } = require('../utils/userEmbedding');
    await updateEmbedding(userMongoId);
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

// articleRouter.get('/personalized-light', auth, ensureMongoUser, async (req, res) => {
//   const startTime = Date.now();

//   try {
//     const userId = req.mongoUser.supabase_id;
//     const language = req.query.language || 'english';
//     const limit = Math.min(parseInt(req.query.limit) || 20, 50);
//     const forceRefresh = req.query.noCache === 'true';

//     console.log(`🚀 OPTIMIZED Light personalized for user ${userId}, limit ${limit}, lang: ${language}, forceRefresh: ${forceRefresh}`);

//     // Check cache first with ultra-aggressive cache key (every 30 minutes)
//     const thirtyMinSlot = Math.floor(Date.now() / (30 * 60 * 1000)); // 30-minute cache slots
//     const cacheKey = `articles_ultrafast_${language}_${limit}_${thirtyMinSlot}`;

//     let cached;
//     if (!forceRefresh) {
//       try {
//         cached = await redis.get(cacheKey);
//         if (cached) {
//           const result = JSON.parse(cached);
//           console.log(`⚡ OPTIMIZED cache hit in ${Date.now() - startTime}ms - ${result.length} articles`);
//           return res.json(result);
//         }
//       } catch (err) {
//         console.error('⚠️ Redis get error:', err.message);
//       }
//     }

//     console.log(`🔍 OPTIMIZED: Starting aggregation query for ${language} language`);
//     const queryStart = Date.now();

//     // OPTIMIZATION 1: Use aggregation pipeline instead of populate()
//     // OPTIMIZATION 2: Reduce time window to 24 hours for good content variety
//     // OPTIMIZATION 3: Skip $lookup for ultra-fast performance (sources handled client-side)

//     const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

//     const articles = await Article.aggregate([
//       {
//         // Stage 1: Match with optimized filter (use compound index)
//         $match: {
//           language: language,
//           publishedAt: { $gte: twentyFourHoursAgo }
//         }
//       },
//       {
//         // Stage 2: Sort BEFORE limiting for better performance
//         $sort: { publishedAt: -1 }
//       },
//       {
//         // Stage 3: Early limit for maximum speed - skip source lookup entirely
//         $limit: limit
//       },
//       {
//         // Stage 4: Add performance markers without source lookup
//         $addFields: {
//           isLight: { $literal: true },
//           fetchedAt: { $literal: new Date() },
//           isRefreshed: { $literal: forceRefresh },
//           fetchId: { $literal: new mongoose.Types.ObjectId().toString() }
//         }
//       },
//       {
//         // Stage 5: Project only essential fields for maximum speed
//         $project: {
//           title: 1,
//           content: 1,
//           url: 1,
//           category: 1,
//           publishedAt: 1,
//           image: 1,
//           viewCount: 1,
//           likes: 1,
//           dislikes: 1,
//           likedBy: 1,
//           dislikedBy: 1,
//           sourceId: 1, // Let client handle source resolution for speed
//           isLight: 1,
//           fetchedAt: 1,
//           isRefreshed: 1,
//           fetchId: 1
//         }
//       }
//     ]);

//     console.log(`⚡ ULTRA-FAST DB query completed in ${Date.now() - queryStart}ms - found ${articles.length} articles`);

//     // OPTIMIZATION 4: Skip source grouping for ultra-speed - return articles directly
//     const totalTime = Date.now() - startTime;
//     console.log(`🚀 ULTRA-FAST Light personalized complete in ${totalTime}ms - ${articles.length} articles (no source grouping)`);

//     // OPTIMIZATION 5: Shorter cache for fresher content at ultra-speed
//     try {
//       await redis.set(cacheKey, JSON.stringify(articles), 'EX', 900); // 15 min cache for speed
//     } catch (err) {
//       console.error('⚠️ Redis set error:', err.message);
//     }

//     // Add performance headers for monitoring
//     res.setHeader('X-Performance-Time', totalTime);
//     res.setHeader('X-DB-Query-Time', Date.now() - queryStart);
//     res.setHeader('X-Optimization-Applied', 'ultra-fast-no-lookup');

//     res.json(articles);

//   } catch (error) {
//     const errorTime = Date.now() - startTime;
//     console.error(`❌ OPTIMIZED Light personalized error in ${errorTime}ms:`, error);

//     // Fallback to basic query if aggregation fails
//     console.log('🔄 Falling back to basic query...');
//     try {
//       const fallbackArticles = await Article.find({
//         language: req.query.language || 'english',
//         publishedAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } // 6 hours
//       })
//         .select('title content url category publishedAt image sourceId viewCount likes dislikes')
//         .sort({ publishedAt: -1 })
//         .limit(limit)
//         .lean();

//       console.log(`🔄 Fallback completed with ${fallbackArticles.length} articles`);
//       res.json(fallbackArticles);
//     } catch (fallbackError) {
//       console.error('❌ Fallback also failed:', fallbackError);
//       res.status(500).json({ error: 'Optimized light personalized error', message: error.message });
//     }
//   }
// });
articleRouter.get('/personalized-light', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();

  try {
    const userId = req.mongoUser.supabase_id;
    const language = req.query.language || 'english';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const forceRefresh = req.query.noCache === 'true';

    console.log(`🚀 OPTIMIZED Light personalized for user ${userId}, limit ${limit}, lang: ${language}, forceRefresh: ${forceRefresh}`);

    // Fetch user's preferred categories/sources for semi-personalization
    const user = await User.findOne({ supabase_id: userId }).select('preferred_categories preferred_sources').lean();
    const preferredCategories = user?.preferred_categories || [];
    const preferredSources = user?.preferred_sources || []; // Assuming this field exists or add it to User model

    // Enhanced cache key: now user-specific with preferences hash for invalidation
    const prefsHash = simpleHash(JSON.stringify({ cats: preferredCategories, srcs: preferredSources }));
    const thirtyMinSlot = Math.floor(Date.now() / (30 * 60 * 1000)); // 30-minute cache slots
    const cacheKey = `articles_ultrafast_${userId}_${language}_${limit}_${prefsHash}_${thirtyMinSlot}`;

    let cached;
    if (!forceRefresh) {
      try {
        cached = await redis.get(cacheKey);
        if (cached) {
          const result = JSON.parse(cached);
          console.log(`⚡ OPTIMIZED cache hit in ${Date.now() - startTime}ms - ${result.length} articles`);
          return res.json(result);
        }
      } catch (err) {
        console.error('⚠️ Redis get error:', err.message);
      }
    }

    console.log(`🔍 OPTIMIZED: Starting aggregation query for ${language} language with prefs: cats=${preferredCategories.length}, srcs=${preferredSources.length}`);
    const queryStart = Date.now();

    // OPTIMIZATION 1: Use aggregation pipeline instead of populate()
    // OPTIMIZATION 2: Reduce time window to 24 hours for good content variety
    // OPTIMIZATION 3: Skip $lookup for ultra-fast performance (sources handled client-side)
    // NEW: Semi-personalization via preferred categories/sources in match stage

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const matchFilter = {
      language: language,
      publishedAt: { $gte: twentyFourHoursAgo }
    };

    // Add personalization filters if preferences exist
    if (preferredCategories.length > 0) {
      matchFilter.category = { $in: preferredCategories.slice(0, 5) }; // Limit to top 5 for speed
    }
    if (preferredSources.length > 0) {
      matchFilter.sourceId = { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) }; // Assuming source IDs are ObjectIds
    }

    // Get more articles initially to allow for source group filtering and randomization
    const initialLimit = Math.min(limit * 3, 150); // Get 3x more articles but cap at 150

    const articles = await Article.aggregate([
      {
        // Stage 1: Match with optimized filter (use compound index)
        $match: matchFilter
      },
      {
        // Stage 2: Sort BEFORE limiting for better performance
        $sort: { publishedAt: -1 }
      },
      {
        // Stage 3: Get more articles for source group filtering
        $limit: initialLimit
      },
      {
        // Stage 4: Lookup source to get groupName for filtering
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } }, // Only get non-blocked sources
            { $project: { groupName: 1, name: 1, status: 1 } } // Only get needed fields
          ]
        }
      },
      {
        // Stage 4.5: Filter out articles from blocked sources
        $match: { 'source.0': { $exists: true } }
      },
      {
        // Stage 5: Add source group name for filtering
        $addFields: {
          sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          isLight: { $literal: true },
          fetchedAt: { $literal: new Date() },
          isRefreshed: { $literal: forceRefresh },
          fetchId: { $literal: new mongoose.Types.ObjectId().toString() },
          isPersonalized: { $literal: preferredCategories.length > 0 || preferredSources.length > 0 }
        }
      },
      {
        // Stage 6: Project essential fields (keep sourceGroupName for filtering but don't expose sourceName to avoid conflicts)
        $project: {
          title: 1,
          content: 1,
          url: 1,
          category: 1,
          publishedAt: 1,
          image: 1,
          viewCount: 1,
          likes: 1,
          dislikes: 1,
          likedBy: 1,
          dislikedBy: 1,
          sourceId: 1,
          sourceGroupName: 1, // Keep for internal filtering
          isLight: 1,
          fetchedAt: 1,
          isRefreshed: 1,
          fetchId: 1,
          isPersonalized: 1
        }
      }
    ]);

    console.log(`⚡ DB query completed in ${Date.now() - queryStart}ms - found ${articles.length} initial articles`);

    // Apply source group filtering and randomization
    const filteringStart = Date.now();

    // Step 1: Apply source group filtering (max 3 per group)
    const sourceGroupCounts = {};
    const filteredArticles = [];

    for (const article of articles) {
      const groupName = article.sourceGroupName || article.sourceId?.toString() || 'unknown';
      const currentCount = sourceGroupCounts[groupName] || 0;

      if (currentCount < 3) { // Max 3 per source group
        sourceGroupCounts[groupName] = currentCount + 1;
        // Remove sourceGroupName before sending to client to avoid conflicts with frontend source resolution
        const { sourceGroupName, ...cleanArticle } = article;
        filteredArticles.push(cleanArticle);

        // Stop if we have enough articles
        if (filteredArticles.length >= limit) break;
      }
    }

    // Step 2: Randomize while preserving recency bias
    // Use a deterministic seed based on user ID and day for consistent randomization
    const seed = simpleHash(userId + Math.floor(Date.now() / (24 * 60 * 60 * 1000))); // Daily seed
    const rng = lcg(seed);

    // Apply gentle randomization: shuffle articles within time-based buckets
    const bucketSize = Math.max(3, Math.floor(filteredArticles.length / 5)); // 5 buckets
    const randomizedArticles = [];

    for (let i = 0; i < filteredArticles.length; i += bucketSize) {
      const bucket = filteredArticles.slice(i, i + bucketSize);

      // Fisher-Yates shuffle with deterministic RNG for this bucket
      for (let j = bucket.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [bucket[j], bucket[k]] = [bucket[k], bucket[j]];
      }

      randomizedArticles.push(...bucket);
    }

    // Take only the requested limit
    const finalArticles = randomizedArticles.slice(0, limit);

    console.log(`🔀 Filtering and randomization completed in ${Date.now() - filteringStart}ms`);
    console.log(`📊 Source group distribution:`, sourceGroupCounts);
    console.log(`🎯 Final result: ${finalArticles.length} articles from ${Object.keys(sourceGroupCounts).length} source groups`);

    const totalTime = Date.now() - startTime;
    console.log(`🚀 Light personalized complete in ${totalTime}ms - ${finalArticles.length} articles with source group filtering`);

    // Cache the final result
    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 900); // 15 min cache for speed
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    // Add performance headers for monitoring
    res.setHeader('X-Performance-Time', totalTime);
    res.setHeader('X-DB-Query-Time', Date.now() - queryStart);
    res.setHeader('X-Filtering-Time', Date.now() - filteringStart);
    res.setHeader('X-Optimization-Applied', 'source-group-filtering-randomization');
    res.setHeader('X-Personalized', preferredCategories.length > 0 || preferredSources.length > 0 ? 'semi' : 'none');
    res.setHeader('X-Source-Groups', Object.keys(sourceGroupCounts).length);

    res.json(finalArticles);

  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ OPTIMIZED Light personalized error in ${errorTime}ms:`, error);

    // Fallback to basic query if aggregation fails (without personalization for speed)
    console.log('🔄 Falling back to basic query...');
    try {
      const fallbackArticles = await Article.find({
        language: req.query.language || 'english',
        publishedAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } // 6 hours
      })
        .select('title content url category publishedAt image sourceId viewCount likes dislikes')
        .sort({ publishedAt: -1 })
        .limit(limit)
        .lean();

      console.log(`🔄 Fallback completed with ${fallbackArticles.length} articles`);
      res.json(fallbackArticles);
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      res.status(500).json({ error: 'Optimized light personalized error', message: error.message });
    }
  }
});

// articleRouter.get('/personalized-fast', auth, ensureMongoUser, async (req, res) => {
//   const startTime = Date.now();
//   try {
//     const page = Math.max(1, parseInt(req.query.page) || 1);
//     const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
//     const language = req.query.language || 'english';
//     const userId = req.mongoUser.supabase_id;
//     const forceRefresh = req.query.noCache === 'true';

//     console.log(`⚡ ULTRA-FAST personalized-fast for user ${userId}, page ${page}, limit ${limit}, forceRefresh: ${forceRefresh}`);

//     // Ultra-aggressive cache key with 15-minute slots for consistency with personalized-light
//     const fifteenMinSlot = Math.floor(Date.now() / (15 * 60 * 1000)); // 15-minute cache slots
//     const cacheKey = `articles_ultrafast_page_${language}_${page}_${limit}_${fifteenMinSlot}`;

//     // Cache check
//     let cached;
//     if (!forceRefresh) {
//       try {
//         cached = await redis.get(cacheKey);
//         if (cached) {
//           console.log(`⚡ ULTRA-FAST cache hit in ${Date.now() - startTime}ms`);
//           return res.json(JSON.parse(cached));
//         }
//       } catch (err) {
//         console.error('⚠️ Redis get error:', err.message);
//       }
//     }

//     console.log(`🔍 ULTRA-FAST: Starting aggregation query for page ${page}, ${language} language`);
//     const queryStart = Date.now();

//     // OPTIMIZATION 1: Use same ultra-fast aggregation as personalized-light
//     // OPTIMIZATION 2: Use 24-hour window for good content variety
//     // OPTIMIZATION 3: Skip $lookup for ultra-fast performance (sources handled client-side)

//     const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
//     const skip = (page - 1) * limit;

//     const articles = await Article.aggregate([
//       {
//         // Stage 1: Match with optimized filter (use compound index)
//         $match: {
//           language: language,
//           publishedAt: { $gte: twentyFourHoursAgo }
//         }
//       },
//       {
//         // Stage 2: Sort BEFORE limiting for better performance
//         $sort: { publishedAt: -1 }
//       },
//       {
//         // Stage 3: Skip for pagination
//         $skip: skip
//       },
//       {
//         // Stage 4: Limit for this page
//         $limit: limit
//       },
//       {
//         // Stage 5: Add performance markers without source lookup
//         $addFields: {
//           isFast: { $literal: true },
//           fetchedAt: { $literal: new Date() },
//           isRefreshed: { $literal: forceRefresh },
//           fetchId: { $literal: new mongoose.Types.ObjectId().toString() },
//           page: { $literal: page }
//         }
//       },
//       {
//         // Stage 6: Project only essential fields for maximum speed
//         $project: {
//           title: 1,
//           content: 1,
//           url: 1,
//           category: 1,
//           publishedAt: 1,
//           image: 1,
//           viewCount: 1,
//           likes: 1,
//           dislikes: 1,
//           likedBy: 1,
//           dislikedBy: 1,
//           sourceId: 1, // Let client handle source resolution for speed
//           isFast: 1,
//           fetchedAt: 1,
//           isRefreshed: 1,
//           fetchId: 1,
//           page: 1
//         }
//       }
//     ]);

//     console.log(`⚡ ULTRA-FAST DB query completed in ${Date.now() - queryStart}ms - found ${articles.length} articles for page ${page}`);

//     // OPTIMIZATION 4: Skip source grouping for ultra-speed - return articles directly
//     const totalTime = Date.now() - startTime;
//     console.log(`🚀 ULTRA-FAST personalized-fast complete in ${totalTime}ms - ${articles.length} articles (page ${page}, no source grouping for speed)`);

//     // OPTIMIZATION 5: 15-minute cache for consistency with personalized-light
//     try {
//       await redis.set(cacheKey, JSON.stringify(articles), 'EX', 900); // 15 min cache
//     } catch (err) {
//       console.error('⚠️ Redis set error:', err.message);
//     }

//     // Add performance headers for monitoring
//     res.setHeader('X-Performance-Time', totalTime);
//     res.setHeader('X-DB-Query-Time', Date.now() - queryStart);
//     res.setHeader('X-Optimization-Applied', 'ultra-fast-no-lookup-pagination');
//     res.setHeader('X-Page', page);

//     res.json(articles);

//   } catch (error) {
//     const errorTime = Date.now() - startTime;
//     console.error(`❌ ULTRA-FAST personalized-fast error in ${errorTime}ms:`, error);

//     // Fallback to basic query if aggregation fails
//     console.log(`🔄 Fallback query for page ${page}...`);
//     try {
//       const skip = (page - 1) * limit;
//       const fallbackArticles = await Article.find({
//         language: language,
//         publishedAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } // 6 hours
//       })
//         .select('title content url category publishedAt image sourceId viewCount likes dislikes')
//         .sort({ publishedAt: -1 })
//         .skip(skip)
//         .limit(limit)
//         .lean();

//       console.log(`🔄 Fallback completed with ${fallbackArticles.length} articles for page ${page}`);
//       res.json(fallbackArticles);
//     } catch (fallbackError) {
//       console.error('❌ Fallback also failed:', fallbackError);
//       res.status(500).json({ error: 'Ultra-fast personalized-fast error', message: error.message });
//     }
//   }
// });

// Performance configuration constants
articleRouter.get('/personalized-fast', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();

  try {
    const userId = req.mongoUser.supabase_id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
    const language = req.query.language || 'english';
    const forceRefresh = req.query.noCache === 'true';

    console.log(`⚡ ULTRA-FAST personalized-fast for user ${userId}, page ${page}, limit ${limit}, lang: ${language}, forceRefresh: ${forceRefresh}`);

    // Fetch user's preferred categories/sources for semi-personalization
    const user = await User.findOne({ supabase_id: userId }).select('preferred_categories preferred_sources').lean();
    const preferredCategories = user?.preferred_categories || [];
    const preferredSources = user?.preferred_sources || []; // Assuming this field exists or add it to User model

    // Enhanced cache key: now user-specific with preferences hash for invalidation
    const prefsHash = simpleHash(JSON.stringify({ cats: preferredCategories, srcs: preferredSources }));
    const fifteenMinSlot = Math.floor(Date.now() / (15 * 60 * 1000)); // 15-minute cache slots
    const cacheKey = `articles_ultrafast_page_${userId}_${language}_${page}_${limit}_${prefsHash}_${fifteenMinSlot}`;

    // Cache check
    let cached;
    if (!forceRefresh) {
      try {
        cached = await redis.get(cacheKey);
        if (cached) {
          console.log(`⚡ ULTRA-FAST cache hit in ${Date.now() - startTime}ms`);
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        console.error('⚠️ Redis get error:', err.message);
      }
    }

    console.log(`🔍 ULTRA-FAST: Starting aggregation query for page ${page}, ${language} language with prefs: cats=${preferredCategories.length}, srcs=${preferredSources.length}`);
    const queryStart = Date.now();

    // OPTIMIZATION 1: Use aggregation pipeline for speed
    // OPTIMIZATION 2: Use 24-hour window for content variety
    // OPTIMIZATION 3: Skip $lookup for ultra-fast performance (sources handled client-side)
    // NEW: Semi-personalization via preferred categories/sources in match stage

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const skip = (page - 1) * limit;
    const matchFilter = {
      language: language,
      publishedAt: { $gte: twentyFourHoursAgo }
    };

    // Add personalization filters if preferences exist
    if (preferredCategories.length > 0) {
      matchFilter.category = { $in: preferredCategories.slice(0, 5) }; // Limit to top 5 for speed
    }
    if (preferredSources.length > 0) {
      matchFilter.sourceId = { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) }; // Assuming source IDs are ObjectIds
    }

    // Get more articles initially to allow for source group filtering and randomization
    const initialLimit = Math.min(limit * 3, 150); // Get 3x more articles but cap at 150
    const initialSkip = Math.max(0, skip - Math.floor(initialLimit / 3)); // Adjust skip for larger initial fetch

    const articles = await Article.aggregate([
      {
        // Stage 1: Match with optimized filter (use compound index)
        $match: matchFilter
      },
      {
        // Stage 2: Sort BEFORE skipping/limiting for better performance
        $sort: { publishedAt: -1 }
      },
      {
        // Stage 3: Skip for pagination (adjusted for larger fetch)
        $skip: initialSkip
      },
      {
        // Stage 4: Get more articles for source group filtering
        $limit: initialLimit
      },
      {
        // Stage 5: Lookup source to get groupName for filtering
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } }, // Only get non-blocked sources
            { $project: { groupName: 1, name: 1, status: 1 } } // Only get needed fields
          ]
        }
      },
      {
        // Stage 5.5: Filter out articles from blocked sources
        $match: { 'source.0': { $exists: true } }
      },
      {
        // Stage 6: Add source group name and performance markers
        $addFields: {
          sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          isFast: { $literal: true },
          fetchedAt: { $literal: new Date() },
          isRefreshed: { $literal: forceRefresh },
          fetchId: { $literal: new mongoose.Types.ObjectId().toString() },
          page: { $literal: page },
          isPersonalized: { $literal: preferredCategories.length > 0 || preferredSources.length > 0 }
        }
      },
      {
        // Stage 7: Project essential fields (keep sourceGroupName for filtering but don't expose sourceName to avoid conflicts)
        $project: {
          title: 1,
          content: 1,
          url: 1,
          category: 1,
          publishedAt: 1,
          image: 1,
          viewCount: 1,
          likes: 1,
          dislikes: 1,
          likedBy: 1,
          dislikedBy: 1,
          sourceId: 1,
          sourceGroupName: 1, // Keep for internal filtering
          isFast: 1,
          fetchedAt: 1,
          isRefreshed: 1,
          fetchId: 1,
          page: 1,
          isPersonalized: 1
        }
      }
    ]);

    console.log(`⚡ DB query completed in ${Date.now() - queryStart}ms - found ${articles.length} initial articles for page ${page}`);

    // Apply source group filtering and randomization
    const filteringStart = Date.now();

    // Step 1: Apply source group filtering (max 3 per group)
    const sourceGroupCounts = {};
    const filteredArticles = [];

    for (const article of articles) {
      const groupName = article.sourceGroupName || article.sourceId?.toString() || 'unknown';
      const currentCount = sourceGroupCounts[groupName] || 0;

      if (currentCount < 3) { // Max 3 per source group
        sourceGroupCounts[groupName] = currentCount + 1;
        // Remove sourceGroupName before sending to client to avoid conflicts with frontend source resolution
        const { sourceGroupName, ...cleanArticle } = article;
        filteredArticles.push(cleanArticle);

        // Stop if we have enough articles
        if (filteredArticles.length >= limit) break;
      }
    }

    // Step 2: Randomize while preserving recency bias
    // Use a deterministic seed based on user ID, page, and day for consistent randomization
    const seed = simpleHash(userId + page.toString() + Math.floor(Date.now() / (24 * 60 * 60 * 1000))); // Daily seed with page
    const rng = lcg(seed);

    // Apply gentle randomization: shuffle articles within time-based buckets
    const bucketSize = Math.max(3, Math.floor(filteredArticles.length / 5)); // 5 buckets
    const randomizedArticles = [];

    for (let i = 0; i < filteredArticles.length; i += bucketSize) {
      const bucket = filteredArticles.slice(i, i + bucketSize);

      // Fisher-Yates shuffle with deterministic RNG for this bucket
      for (let j = bucket.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [bucket[j], bucket[k]] = [bucket[k], bucket[j]];
      }

      randomizedArticles.push(...bucket);
    }

    // Take only the requested limit
    const finalArticles = randomizedArticles.slice(0, limit);

    console.log(`🔀 Filtering and randomization completed in ${Date.now() - filteringStart}ms`);
    console.log(`📊 Source group distribution for page ${page}:`, sourceGroupCounts);
    console.log(`🎯 Final result: ${finalArticles.length} articles from ${Object.keys(sourceGroupCounts).length} source groups`);

    const totalTime = Date.now() - startTime;
    console.log(`🚀 personalized-fast complete in ${totalTime}ms - ${finalArticles.length} articles (page ${page}, with source group filtering)`);

    // Cache the final result
    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 900); // 15 min cache
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    // Add performance headers for monitoring
    res.setHeader('X-Performance-Time', totalTime);
    res.setHeader('X-DB-Query-Time', Date.now() - queryStart);
    res.setHeader('X-Filtering-Time', Date.now() - filteringStart);
    res.setHeader('X-Optimization-Applied', 'source-group-filtering-randomization-pagination');
    res.setHeader('X-Page', page);
    res.setHeader('X-Personalized', preferredCategories.length > 0 || preferredSources.length > 0 ? 'semi' : 'none');
    res.setHeader('X-Source-Groups', Object.keys(sourceGroupCounts).length);

    res.json(finalArticles);

  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ ULTRA-FAST personalized-fast error in ${errorTime}ms:`, error);

    // Fallback to basic query if aggregation fails (without personalization for speed)
    console.log(`🔄 Fallback query for page ${page}...`);
    try {
      const skip = (page - 1) * limit;
      const fallbackArticles = await Article.find({
        language: req.query.language || 'english',
        publishedAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } // 6 hours
      })
        .select('title content url category publishedAt image sourceId viewCount likes dislikes')
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      console.log(`🔄 Fallback completed with ${fallbackArticles.length} articles for page ${page}`);
      res.json(fallbackArticles);
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      res.status(500).json({ error: 'Ultra-fast personalized-fast error', message: error.message });
    }
  }
});


// Performance configuration constants
const VECTOR_INDEX = "articles_pca_index";
const NUM_CANDIDATE_MULT = 2.5; // Reduced from 4 for faster vector search
const LIMIT_MULT = 1.5; // Reduced from 2 for smaller candidate pools
const DIVERSITY_RATIO = 0.15;
const TRENDING_RATIO = 0.10;
const VECTOR_PROBE_TTL_MS = 10 * 60 * 1000; // Extended to 10min for stable clusters
const VECTOR_MAX_TIME_MS = 1500; // Tightened from 2000ms
const ROUTE_BUDGET_MS = 3000; // Tightened from 4500ms
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
    await redis.set('vector_search_status', 'unavailable', 'EX', 300); // Cache failure for 5min
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
          numCandidates: 50, // Reduced for faster probe
          limit: 1,
          filter: {
            language: language,
            publishedAt: { $gte: cutoffDate },
            _id: { $nin: excludeIds }
          }
        }
      }
    ];

    await Article.aggregate(pipeline, { maxTimeMS: 300 }); // Tighter timeout
    return { ok: true };
  } catch (error) {
    console.error('🔍 Quick vector probe error:', error.message);
    if (error.message.includes('index') || error.message.includes('cluster')) {
      await redis.set('vector_search_status', 'unavailable', 'EX', 300); // Cache failure
      return { ok: false };
    }
    return { ok: true }; // Non-critical errors don't disable vector search
  }
}

articleRouter.get('/personalized', auth, ensureMongoUser, async (req, res) => {
  req.setTimeout(30000); // Reduced from 60s; still ample for complex queries
  const requestStartTime = Date.now();
  const startTime = Date.now();
  const timings = {};
  const mark = (k) => timings[k] = Date.now() - startTime;

  try {
    const userId = req.mongoUser.supabase_id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
    const language = req.query.language || 'english';
    const resetServed = req.query.resetServed === '1';

    console.log(`🔥 PERSONALIZED ENDPOINT START for user ${userId}, page ${page}, limit ${limit}, lang: ${language}`);

    // Enhanced cache key with user preferences
    const userPrefs = await User.findOne({ supabase_id: userId }).select('preferred_categories preferred_sources').lean();
    const prefsHash = simpleHash(JSON.stringify({
      cats: userPrefs?.preferred_categories || [],
      srcs: userPrefs?.preferred_sources || []
    }));
    const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const noveltySeed = simpleHash(`${userId}:${page}:${dayKey}`);
    const cacheKey = `articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}_${prefsHash}_${dayKey}_${noveltySeed}`;

    // Cache check
    let cached;
    if (!req.query.noCache) {
      try {
        cached = await redis.get(cacheKey);
        if (cached) {
          console.log(`⚡ Cache hit in ${Date.now() - startTime}ms`);
          mark('cache_check');
          mark('total');
          if (ENABLE_SERVER_TIMING) {
            res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
            res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
          }
          return res.json(JSON.parse(cached));
        }
      } catch (err) {
        console.error('⚠️ Redis get error:', err.message);
      }
    }
    mark('cache_check');

    // Reset served articles if requested
    const servedKey = `served_personalized_${userId}_${language}_${dayKey}`;
    if (resetServed) {
      try {
        await redis.del(servedKey);
        console.log('🔄 Reset served articles for today');
      } catch (err) {
        console.error('⚠️ Failed to reset served articles:', err.message);
      }
    }

    // Get served and disliked articles
    let servedIds = [];
    try {
      servedIds = await redis.smembers(servedKey);
    } catch (err) {
      console.error('⚠️ Redis served set error:', err.message);
    }
    const user = await User.findOne({ supabase_id: userId }).select('embedding_pca preferred_categories preferred_sources disliked_articles').lean();
    const excludeIds = [
      ...servedIds.map(id => new mongoose.Types.ObjectId(id)),
      ...(user?.disliked_articles || []).map(id => new mongoose.Types.ObjectId(id))
    ];

    // User embedding and preferences
    let userEmbedding = user?.embedding_pca;
    const preferredCategories = user?.preferred_categories || [];
    const preferredSources = user?.preferred_sources || [];
    mark('user_load');

    // Progressive time windows
    const getTimeWindow = (page) => {
      if (page === 1) return { hours: 72, label: 'last 72h' };
      if (page === 2) return { hours: 168, label: 'last 7d' };
      if (page === 3) return { hours: 336, label: 'last 14d' };
      return { hours: 720, label: 'last 30d' };
    };
    const timeWindow = getTimeWindow(page);
    const cutoffTime = new Date(Date.now() - timeWindow.hours * 60 * 60 * 1000);

    // Vector search readiness
    const vectorReady = await redis.get('vector_search_status') !== 'unavailable' && await isVectorSearchReady();
    const canUseVectorSearch = userEmbedding && Array.isArray(userEmbedding) && userEmbedding.length === 128 && vectorReady;
    let quickProbeOk = true;
    if (canUseVectorSearch) {
      quickProbeOk = (await quickVectorProbe(userEmbedding, cutoffTime, language, excludeIds)).ok;
    }
    mark('vector_probe');

    // Fast fallback for cold start or vector unavailability
    const isSlowRequest = (Date.now() - startTime) > ROUTE_BUDGET_MS;
    const shouldUseFastFallback = !canUseVectorSearch || !quickProbeOk || (isSlowRequest && page === 1);

    if (shouldUseFastFallback) {
      console.warn(`⚡ Fast fallback triggered: canUseVectorSearch=${canUseVectorSearch}, quickProbeOk=${quickProbeOk}, isSlowRequest=${isSlowRequest}`);
      const fallbackMatch = {
        language,
        _id: { $nin: excludeIds },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      };
      if (preferredCategories.length > 0) {
        fallbackMatch.category = { $in: preferredCategories.slice(0, 5) };
      }
      if (preferredSources.length > 0) {
        fallbackMatch.sourceId = { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) };
      }

      const fallbackArticles = await Article.find(fallbackMatch)
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes likedBy dislikedBy')
        .sort({ publishedAt: -1, viewCount: -1 })
        .limit(limit * 3) // Reduced multiplier for faster fallback
        .lean();

      const enhancedFallbackArticles = fallbackArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFast: true,
        isFallback: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article),
        isPersonalized: preferredCategories.length > 0 || preferredSources.length > 0
      }));

      // Source group limiting
      const startIndex = (page - 1) * limit;
      let skipped = 0;
      let limitedFastResponse = [];
      const sourceGroupCounts = {};
      const uniqueSourceIds = [...new Set(enhancedFallbackArticles.map(a => a.sourceId).filter(Boolean))];
      const sources = await Source.find({ _id: { $in: uniqueSourceIds } }, 'groupName').lean();
      const sourceIdToGroupName = {};
      sources.forEach(source => {
        sourceIdToGroupName[source._id.toString()] = source.groupName || 'default-group';
      });

      for (let i = 0; i < enhancedFallbackArticles.length && limitedFastResponse.length < limit; i++) {
        const article = enhancedFallbackArticles[i];
        const sourceGroup = sourceIdToGroupName[article.sourceId?.toString()] || article.source || 'unknown-group';
        if (skipped < startIndex) {
          skipped++;
          continue;
        }
        const currentCount = sourceGroupCounts[sourceGroup] || 0;
        if (currentCount < 2) {
          limitedFastResponse.push(article);
          sourceGroupCounts[sourceGroup] = currentCount + 1;
        }
      }

      if (limitedFastResponse.length > 0) {
        try {
          const articleIds = limitedFastResponse.map(a => a._id.toString());
          await redis.sadd(servedKey, ...articleIds);
          await redis.expire(servedKey, 86400);
        } catch (err) {
          console.error('⚠️ Failed to track served articles:', err.message);
        }
      }

      mark('total');
      try {
        await redis.set(cacheKey, JSON.stringify(limitedFastResponse), 'EX', 600);
      } catch (err) {
        console.error('⚠️ Redis set error:', err.message);
      }

      if (ENABLE_SERVER_TIMING) {
        res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
        res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
      }
      res.setHeader('X-Personalized', preferredCategories.length > 0 || preferredSources.length > 0 ? 'semi' : 'none');
      return res.json(limitedFastResponse);
    }

    // Vector search pipeline
    const candidatePoolSize = limit * 2 * page; // Reduced multiplier
    const searchLimit = candidatePoolSize * LIMIT_MULT;
    const numCandidates = candidatePoolSize * NUM_CANDIDATE_MULT;

    const performVectorSearch = async (cutoffDate, isWideningSearch = false) => {
      const pipeline = [
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: "embedding_pca",
            queryVector: userEmbedding,
            numCandidates,
            limit: searchLimit,
            filter: {
              language,
              publishedAt: { $gte: cutoffDate },
              _id: { $nin: excludeIds },
              ...(preferredCategories.length > 0 && !isWideningSearch ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
              ...(preferredSources.length > 0 && !isWideningSearch ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
            }
          }
        },
        { $addFields: { similarity: { $meta: "vectorSearchScore" } } },
        {
          $project: {
            _id: 1,
            title: 1,
            summary: 1,
            image: 1,
            sourceId: 1,
            source: 1,
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

      return await Article.aggregate(pipeline, { maxTimeMS: VECTOR_MAX_TIME_MS, allowDiskUse: false }); // Disable allowDiskUse for speed
    };

    let candidateArticles = await performVectorSearch(cutoffTime);
    mark('vector_search');

    // Fallback if vector search fails
    if (!candidateArticles || candidateArticles.length === 0) {
      console.warn('🔄 Vector search failed, using engagement-based fallback');
      const fallbackMatch = {
        language,
        publishedAt: { $gte: cutoffTime },
        _id: { $nin: excludeIds },
        ...(preferredCategories.length > 0 ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
        ...(preferredSources.length > 0 ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
      };

      const fallbackArticles = await Article.find(fallbackMatch)
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes likedBy dislikedBy')
        .sort({ publishedAt: -1, viewCount: -1 })
        .limit(candidatePoolSize)
        .lean();

      candidateArticles = fallbackArticles.map(article => ({
        ...article,
        similarity: 0,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFallback: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article)
      }));
    }

    // Widen time window if needed
    const minCandidatesNeeded = candidatePoolSize + limit;
    if (candidateArticles.length < minCandidatesNeeded && timeWindow.hours < 720) {
      const widerRanges = [
        { hours: 168, label: 'last 7d' },
        { hours: 336, label: 'last 14d' },
        { hours: 720, label: 'last 30d' }
      ];

      for (const range of widerRanges) {
        if (range.hours <= timeWindow.hours) continue;
        const widerCutoff = new Date(Date.now() - range.hours * 60 * 60 * 1000);
        const widerResults = await performVectorSearch(widerCutoff, true);
        if (widerResults && widerResults.length > 0) {
          const existingIds = new Set(candidateArticles.map(a => a._id.toString()));
          const additionalCandidates = widerResults
            .filter(a => !existingIds.has(a._id.toString()) && a.publishedAt < cutoffTime)
            .map(a => ({ ...a, isWider: true }));
          candidateArticles = [...candidateArticles, ...additionalCandidates];
        }
        if (candidateArticles.length >= minCandidatesNeeded) break;
      }
    }
    mark('widen');

    // Budget check
    if (Date.now() - startTime > ROUTE_BUDGET_MS) {
      console.warn(`⚡ Budget exceeded, using fast fallback`);
      const fallbackMatch = {
        language,
        _id: { $nin: excludeIds },
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        ...(preferredCategories.length > 0 ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
        ...(preferredSources.length > 0 ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
      };

      const fastFallbackArticles = await Article.find(fallbackMatch)
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes likedBy dislikedBy')
        .sort({ publishedAt: -1, viewCount: -1 })
        .limit(limit * 3)
        .lean();

      const enhancedFastResponse = fastFallbackArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFast: true,
        isOverBudget: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article),
        isPersonalized: preferredCategories.length > 0 || preferredSources.length > 0
      }));

      const startIndex = (page - 1) * limit;
      let skipped = 0;
      let limitedFastResponse = [];
      const sourceGroupCounts = {};
      const uniqueSourceIds = [...new Set(enhancedFastResponse.map(a => a.sourceId).filter(Boolean))];
      const sources = await Source.find({ _id: { $in: uniqueSourceIds } }, 'groupName').lean();
      const sourceIdToGroupName = {};
      sources.forEach(source => {
        sourceIdToGroupName[source._id.toString()] = source.groupName || 'default-group';
      });

      for (let i = 0; i < enhancedFastResponse.length && limitedFastResponse.length < limit; i++) {
        const article = enhancedFastResponse[i];
        const sourceGroup = sourceIdToGroupName[article.sourceId?.toString()] || article.source || 'unknown-group';
        if (skipped < startIndex) {
          skipped++;
          continue;
        }
        const currentCount = sourceGroupCounts[sourceGroup] || 0;
        if (currentCount < 2) {
          limitedFastResponse.push(article);
          sourceGroupCounts[sourceGroup] = currentCount + 1;
        }
      }

      if (limitedFastResponse.length > 0) {
        try {
          const articleIds = limitedFastResponse.map(a => a._id.toString());
          await redis.sadd(servedKey, ...articleIds);
          await redis.expire(servedKey, 86400);
        } catch (err) {
          console.error('⚠️ Failed to track served articles:', err.message);
        }
      }

      mark('total');
      try {
        await redis.set(cacheKey, JSON.stringify(limitedFastResponse), 'EX', 600);
      } catch (err) {
        console.error('⚠️ Redis set error:', err.message);
      }

      if (ENABLE_SERVER_TIMING) {
        res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
        res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
      }
      res.setHeader('X-Personalized', preferredCategories.length > 0 || preferredSources.length > 0 ? 'semi' : 'none');
      return res.json(limitedFastResponse);
    }

    // Enhanced scoring with preference boosts
    const w_recency = page === 1 ? 0.75 : page === 2 ? 0.65 : page === 3 ? 0.55 : 0.45;
    const scoredArticles = candidateArticles.map(article => {
      const similarity = article.similarity || 0;
      const engagementScore = calculateEngagementScore(article);
      const recencyScore = basicRecencyScore(article.publishedAt);
      let preferenceBoost = 0;
      if (preferredCategories.includes(article.category)) {
        preferenceBoost += 0.15;
      }
      if (preferredSources.includes(article.sourceId?.toString())) {
        preferenceBoost += 0.10;
      }
      const baseScore = (similarity * 0.6) + (engagementScore * 0.4) + preferenceBoost;
      const finalScore = w_recency * recencyScore + (1 - w_recency) * baseScore;

      return {
        ...article,
        fetchId: article.fetchId || new mongoose.Types.ObjectId().toString(),
        similarity,
        engagementScore,
        recencyScore,
        finalScore,
        timeWindow: timeWindow.label,
        noveltySeed,
        isPersonalized: true
      };
    });

    scoredArticles.sort((a, b) => b.finalScore - a.finalScore);
    mark('scoring');

    // Diversity injection
    const candidatePool = [...scoredArticles];
    const diversityPoolSize = Math.ceil(candidatePoolSize * DIVERSITY_RATIO);
    if (diversityPoolSize > 0 && candidatePool.length < candidatePoolSize) {
      const usedIds = new Set(candidatePool.map(a => a._id.toString()));
      const diversityCandidates = scoredArticles
        .filter(a => !usedIds.has(a._id.toString()) && a.similarity > 0.3)
        .slice(0, diversityPoolSize * 2);

      const rng = lcg(noveltySeed);
      const shuffledDiversity = diversityCandidates
        .map(article => ({ article, sort: rng() }))
        .sort((a, b) => a.sort - b.sort)
        .map(item => ({ ...item.article, isDiverse: true }))
        .slice(0, diversityPoolSize);

      candidatePool.push(...shuffledDiversity);
    }
    mark('diversity');

    // Trending injection
    const trendingPoolSize = Math.ceil(candidatePoolSize * TRENDING_RATIO);
    if (trendingPoolSize > 0 && candidatePool.length < candidatePoolSize) {
      const usedIds = new Set(candidatePool.map(a => a._id.toString()));
      const trendingArticles = await Article.find({
        language,
        viewCount: { $exists: true, $gt: 0 },
        publishedAt: { $gte: cutoffTime },
        _id: { $nin: [...excludeIds, ...Array.from(usedIds).map(id => new mongoose.Types.ObjectId(id))] },
        ...(preferredCategories.length > 0 ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
        ...(preferredSources.length > 0 ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
      })
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes likedBy dislikedBy')
        .sort({ viewCount: -1, publishedAt: -1 })
        .limit(trendingPoolSize)
        .lean();

      const trendingEnhanced = trendingArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isTrending: true,
        timeWindow: timeWindow.label,
        noveltySeed,
        engagementScore: calculateEngagementScore(article),
        finalScore: calculateEngagementScore(article) * 0.7,
        isPersonalized: true
      }));

      candidatePool.push(...trendingEnhanced);
    }
    mark('trending');

    // Source diversification
    const uniqueSourceIds = [...new Set(candidatePool.map(a => a.sourceId).filter(Boolean))];
    const sources = await Source.find({ _id: { $in: uniqueSourceIds } }, 'groupName').lean();
    const sourceIdToGroupName = {};
    sources.forEach(source => {
      sourceIdToGroupName[source._id.toString()] = source.groupName || 'default-group';
    });

    const sourceGroups = {};
    candidatePool.forEach(article => {
      const sourceKey = sourceIdToGroupName[article.sourceId?.toString()] || article.source || 'unknown-group';
      if (!sourceGroups[sourceKey]) {
        sourceGroups[sourceKey] = [];
      }
      sourceGroups[sourceKey].push(article);
    });

    Object.keys(sourceGroups).forEach(source => {
      sourceGroups[source].sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
    });

    const interleaved = [];
    const sourceKeys = Object.keys(sourceGroups);
    const maxGroupSize = Math.max(...sourceKeys.map(key => sourceGroups[key].length));

    for (let round = 0; round < maxGroupSize; round++) {
      for (const sourceKey of sourceKeys) {
        if (sourceGroups[sourceKey][round]) {
          interleaved.push(sourceGroups[sourceKey][round]);
        }
      }
    }
    mark('interleave');

    // Pagination and source group limiting
    const startIndex = (page - 1) * limit;
    let skipped = 0;
    let finalArticles = [];
    const sourceGroupCounts = {};

    for (let i = 0; i < interleaved.length && finalArticles.length < limit; i++) {
      const article = interleaved[i];
      const sourceGroup = sourceIdToGroupName[article.sourceId?.toString()] || article.source || 'unknown-group';
      if (skipped < startIndex) {
        skipped++;
        continue;
      }
      const currentCount = sourceGroupCounts[sourceGroup] || 0;
      if (currentCount < 2) {
        finalArticles.push(article);
        sourceGroupCounts[sourceGroup] = currentCount + 1;
      }
    }
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

    // Cache results
    mark('total');
    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', page === 1 ? 1800 : 3600); // Shorter TTL for page 1
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    if (ENABLE_SERVER_TIMING) {
      res.setHeader('Server-Timing', Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(', '));
      res.setHeader('X-Gulfio-Timings', JSON.stringify(timings));
    }
    res.setHeader('X-Personalized', 'full');

    res.json(finalArticles);
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ Error fetching personalized articles after ${processingTime}ms:`, error);
    res.status(processingTime > 25000 ? 504 : 500).json({
      error: processingTime > 25000 ? 'Request timeout' : 'Error fetching personalized articles',
      message: error.message
    });
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

    // Fetch articles from the specified category with source filtering
    const raw = await Article.aggregate([
      { $match: filter },
      { $sort: { publishedAt: -1 } },
      { $skip: skip },
      { $limit: limit * 2 }, // Get more to allow for better ranking
      {
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } }, // Only get non-blocked sources
            { $project: { name: 1, icon: 1, groupName: 1, status: 1 } }
          ]
        }
      },
      { $match: { 'source.0': { $exists: true } } }, // Only keep articles with valid (non-blocked) sources
      {
        $addFields: {
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
          sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] }
        }
      },
      { $unset: 'source' } // Remove the source array to clean up the response
    ]);

    console.log(`📊 Found ${raw.length} articles in category (filtered by non-blocked sources)`);

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
    const raw = await Article.aggregate([
      { $match: filter },
      { $sort: { publishedAt: -1 } },
      { $skip: skip },
      { $limit: limit * 2 }, // Get more to allow for better ranking
      {
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } },
            { $project: { name: 1, icon: 1, groupName: 1 } }
          ]
        }
      },
      { $match: { 'source.0': { $exists: true } } }, // Only articles from non-blocked sources
      {
        $addFields: {
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          sourceIcon: { $arrayElemAt: ['$source.icon', 0] }
        }
      },
      { $unset: 'source' }
    ]);

    console.log(`📊 Found ${raw.length} articles after applying user exclusions`);

    if (raw.length === 0) {
      console.log(`⚠️ No articles found in category: "${category}" after applying user exclusions`);

      // Try without user exclusions to see if that's the issue
      const rawWithoutExclusions = await Article.aggregate([
        { $match: { language, category } },
        { $sort: { publishedAt: -1 } },
        { $skip: skip },
        { $limit: 5 },
        {
          $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'source',
            pipeline: [{ $match: { status: { $ne: 'blocked' } } }]
          }
        },
        { $match: { 'source.0': { $exists: true } } }
      ]);

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

// GET: Generic (guest) feed with recency-aware sort and source group limiting
// Also supports JWT-based publisher filtering for authenticated users
articleRouter.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const language = req.query.language || 'english';
    const category = req.query.category;
    const search = req.query.search;

    // Detect authentication method
    const hasJWT = req.headers.authorization && req.headers.authorization.startsWith('Bearer ');
    const hasAPIKey = req.headers['x-api-key'];

    console.log(`🌍 ARTICLES ROUTE: page ${page}, limit ${limit}, language ${language}, category ${category || 'all'}, search: "${search || 'none'}"`);
    console.log(`🔐 Auth method: ${hasJWT ? 'JWT' : hasAPIKey ? 'API-KEY' : 'NONE'}`);

    let userPublisherGroups = null;
    let isAuthenticated = false;

    // Handle JWT authentication for publisher filtering
    if (hasJWT) {
      try {
        const token = req.headers.authorization.split(' ')[1];
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (!error && user) {
          // Get user's publisher groups from MongoDB
          const mongoUser = await User.findOne({ supabase_id: user.id }).lean();
          if (mongoUser && mongoUser.type === 'publisher' && mongoUser.publisher_group) {
            userPublisherGroups = mongoUser.publisher_group;
            isAuthenticated = true;
            console.log(`🔐 Publisher user detected: ${mongoUser.email}, groups: ${userPublisherGroups}`);
          } else {
            console.log(`🔐 Regular user or admin: ${mongoUser?.email || 'unknown'}, type: ${mongoUser?.type || 'none'}`);
            isAuthenticated = true; // Still authenticated, just not a publisher
          }
        }
      } catch (jwtError) {
        console.error('⚠️ JWT authentication failed:', jwtError.message);
        // Continue as unauthenticated user
      }
    }

    const cacheKey = `articles_page_${page}_limit_${limit}_lang_${language}_cat_${category || 'all'}_search_${search || 'none'}_pub_${userPublisherGroups ? (Array.isArray(userPublisherGroups) ? userPublisherGroups.join(',') : userPublisherGroups) : 'none'}`;

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

    // Build query filter
    const filter = { language };
    if (category) {
      filter.category = category;
      console.log('🏷️ Filtering articles by category:', category);
    }

    // Add search functionality
    if (search && search.trim()) {
      const searchTerm = search.trim();
      console.log(`🔍 Searching for articles with term: "${searchTerm}"`);

      // Use MongoDB regex search for title and content
      filter.$or = [
        { title: { $regex: searchTerm, $options: 'i' } },
        { content: { $regex: searchTerm, $options: 'i' } }
      ];
    }

    // Add publisher filtering if user is a publisher
    if (userPublisherGroups && (Array.isArray(userPublisherGroups) ? userPublisherGroups.length > 0 : userPublisherGroups)) {
      const publisherGroupsArray = Array.isArray(userPublisherGroups) ? userPublisherGroups : [userPublisherGroups];
      console.log(`🔒 Applying publisher filter for groups: ${publisherGroupsArray}`);

      // Get source IDs that match the user's publisher groups
      const Source = require('../models/Source');
      const allowedSources = await Source.find({
        $or: publisherGroupsArray.map(group => ({
          groupName: { $regex: new RegExp('^' + group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
        }))
      }).select('_id').lean();

      const allowedSourceIds = allowedSources.map(s => s._id);

      console.log(`🔒 Found ${allowedSources.length} allowed sources for publisher groups`);

      if (allowedSourceIds.length > 0) {
        filter.sourceId = { $in: allowedSourceIds };
      } else {
        // No matching sources found, return empty result
        console.log(`🔒 No sources found for publisher groups: ${publisherGroupsArray}`);
        return res.json([]);
      }
    }

    // Fetch more articles to allow for source group filtering and pagination
    // Publishers need more articles since they have higher per-source limits
    const fetchMultiplier = userPublisherGroups ? 8 : 5;
    const fetchLimit = limit * fetchMultiplier;

    const raw = await Article.find(filter)
      .populate({
        path: 'sourceId',
        select: 'name icon groupName status',
        match: { status: { $ne: 'blocked' } } // Only populate non-blocked sources
      })
      .sort({ publishedAt: -1 })
      .limit(fetchLimit) // Get more articles for source filtering and pagination
      .lean();

    // Filter out articles from blocked sources (where sourceId population returned null)
    const filteredArticles = raw.filter(article => article.sourceId !== null);
    console.log(`📊 Found ${raw.length} raw articles, ${filteredArticles.length} after filtering blocked sources${userPublisherGroups ? ' (publisher filtered)' : ''}`);

    // Re-rank by page-aware recency+engagement for better first page feel
    const freshRatio =
      page === 1 ? 0.70 :
        page === 2 ? 0.55 :
          page === 3 ? 0.45 :
            0.35;

    const enhancedArticles = filteredArticles
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
          // Extract source info from populated data
          sourceName: a.sourceId?.name || 'Unknown Source',
          sourceIcon: a.sourceId?.icon || null,
          sourceGroupName: a.sourceId?.groupName || null
        };
      })
      .sort((x, y) => (y.finalScore ?? 0) - (x.finalScore ?? 0));

    // Apply pagination with source group limiting (general users only - publishers skip this)
    const startIndex = (page - 1) * limit;
    let processedArticles = [];
    const sourceGroupCounts = {};

    if (userPublisherGroups) {
      // Publishers: Skip source group limiting entirely since they're already filtered to their allowed sources
      console.log(`🔀 PUBLISHER MODE: Skipping source group limits, using all ${enhancedArticles.length} articles`);
      processedArticles = enhancedArticles;

      // Count source groups for logging
      enhancedArticles.forEach(article => {
        const sourceGroup = article.sourceGroupName || article.sourceId?.toString() || article.source || 'unknown-group';
        sourceGroupCounts[sourceGroup] = (sourceGroupCounts[sourceGroup] || 0) + 1;
      });
    } else {
      // General users: Apply source group limiting (max 2 per source group)
      const maxPerSourceGroup = 2;
      console.log(`🔀 GENERAL MODE: Applying source group limiting: page ${page}, startIndex ${startIndex}, target limit ${limit}, maxPerGroup ${maxPerSourceGroup}`);

      for (let i = 0; i < enhancedArticles.length; i++) {
        const article = enhancedArticles[i];
        const sourceGroup = article.sourceGroupName || article.sourceId?.toString() || article.source || 'unknown-group';

        // Check if adding this article would exceed the source group limit
        const currentCount = sourceGroupCounts[sourceGroup] || 0;
        if (currentCount < maxPerSourceGroup) {
          processedArticles.push(article);
          sourceGroupCounts[sourceGroup] = currentCount + 1;
        }
      }
    }

    // Now apply proper pagination to the filtered list
    const finalArticles = processedArticles.slice(startIndex, startIndex + limit); console.log(`🔀 Step 1: ${userPublisherGroups ? 'Skipped source group limits (publisher)' : 'Applied source group limits'} to ${enhancedArticles.length} articles, got ${processedArticles.length} filtered articles`);
    console.log(`🔀 Step 2: Applied pagination (${startIndex}-${startIndex + limit}) to get ${finalArticles.length} final articles`);

    console.log(`🔀 PUBLIC: Selected ${finalArticles.length} articles from ${processedArticles.length} candidates ${userPublisherGroups ? '(publisher - no source limits)' : '(general - source limited)'}`);
    console.log(`📊 Total source group distribution:`, Object.entries(sourceGroupCounts).map(([group, count]) => `${group}:${count}`).join(', '));

    // Calculate distribution for this page only
    const pageSourceCounts = {};
    finalArticles.forEach(article => {
      const sourceGroup = article.sourceGroupName || article.sourceId?.toString() || article.source || 'unknown-group';
      pageSourceCounts[sourceGroup] = (pageSourceCounts[sourceGroup] || 0) + 1;
    });
    console.log(`📊 Page ${page} source distribution:`, Object.entries(pageSourceCounts).map(([group, count]) => `${group}:${count}`).join(', '));

    // Create pagination metadata
    const totalPages = Math.ceil(processedArticles.length / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    const responseData = {
      articles: finalArticles,
      pagination: {
        page,
        limit,
        total: processedArticles.length,
        pages: totalPages,
        hasNext: hasNextPage,
        hasPrev: hasPrevPage
      }
    };

    try {
      await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(responseData);
  } catch (error) {
    console.error('❌ Error fetching articles:', error);
    res.status(500).json({ error: 'Error fetching articles', message: error.message });
  }
});

// React (like/dislike) - Optimized for performance
articleRouter.post('/:id/react', auth, ensureMongoUser, async (req, res) => {
  // Set a timeout for this specific route to prevent hanging
  req.setTimeout(10000); // 10 second timeout

  try {
    const startTime = Date.now();
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

    const articleObjectId = new mongoose.Types.ObjectId(articleId);

    // Use MongoDB transactions for atomic updates or fallback to sequential operations
    let updatedArticle;

    try {
      // Use bulkWrite for better performance - combine pull and push in single operation
      const articleUpdate = await Article.bulkWrite([
        {
          updateOne: {
            filter: { _id: articleId },
            update: { $pull: { likedBy: userId, dislikedBy: userId } }
          }
        },
        {
          updateOne: {
            filter: { _id: articleId },
            update: action === 'like'
              ? { $push: { likedBy: userId } }
              : { $push: { dislikedBy: userId } }
          }
        }
      ]);

      const userUpdate = await User.bulkWrite([
        {
          updateOne: {
            filter: { _id: mongoUser._id },
            update: { $pull: { liked_articles: articleObjectId, disliked_articles: articleObjectId } }
          }
        },
        {
          updateOne: {
            filter: { _id: mongoUser._id },
            update: action === 'like'
              ? { $addToSet: { liked_articles: articleObjectId } }
              : { $addToSet: { disliked_articles: articleObjectId } }
          }
        }
      ]);

      // Get the updated article with current reaction counts
      updatedArticle = await Article.findById(articleId, 'likedBy dislikedBy likes dislikes').lean();

    } catch (bulkError) {
      console.error('Bulk write failed, falling back to individual operations:', bulkError);

      // Fallback to individual operations if bulk write fails
      await Article.updateOne(
        { _id: articleId },
        { $pull: { likedBy: userId, dislikedBy: userId } }
      );

      await Article.updateOne(
        { _id: articleId },
        action === 'like'
          ? { $push: { likedBy: userId } }
          : { $push: { dislikedBy: userId } }
      );

      await User.updateOne(
        { _id: mongoUser._id },
        { $pull: { liked_articles: articleObjectId, disliked_articles: articleObjectId } }
      );

      await User.updateOne(
        { _id: mongoUser._id },
        action === 'like'
          ? { $addToSet: { liked_articles: articleObjectId } }
          : { $addToSet: { disliked_articles: articleObjectId } }
      );

      updatedArticle = await Article.findById(articleId, 'likedBy dislikedBy likes dislikes').lean();
    }

    if (!updatedArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }

    // Calculate current counts from arrays
    const likes = updatedArticle.likedBy?.length || 0;
    const dislikes = updatedArticle.dislikedBy?.length || 0;

    const processingTime = Date.now() - startTime;
    console.log(`✅ Like/dislike processed in ${processingTime}ms for user ${userId} on article ${articleId}`);

    // Update the cached counts in the article document IMMEDIATELY (not fire-and-forget)
    try {
      await Article.updateOne(
        { _id: articleId },
        { $set: { likes, dislikes } }
      );
      console.log(`✅ Article counts updated in database: likes=${likes}, dislikes=${dislikes}`);
    } catch (updateError) {
      console.error('⚠️ Failed to update article counts in database:', updateError);
      // Don't fail the request, but log the error
    }

    // Respond immediately with the reaction data
    res.json({
      userReact: action,
      likes,
      dislikes,
      processingTime // Include timing for debugging
    });

    // Perform expensive operations asynchronously after responding
    setImmediate(async () => {
      try {
        // Clear cache asynchronously
        await clearArticlesCache();

        // Recompute user embedding asynchronously (this is expensive)
        await updateUserProfileEmbedding(mongoUser._id);
      } catch (asyncError) {
        console.error('Error in async post-response operations:', asyncError);
        // Don't affect the user response - these operations can be retried later
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ Error in POST /:id/react after ${processingTime}ms:`, error);
    console.error('❌ Request details:', {
      articleId: req.params.id,
      action: req.body.action,
      userId: req.mongoUser?.supabase_id,
      errorMessage: error.message,
      errorStack: error.stack?.split('\n').slice(0, 3).join('\n') // First 3 lines of stack trace
    });

    // Don't leak internal error details in production
    res.status(500).json({
      message: 'Error reacting to article',
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
      processingTime
    });
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
    const articles = await Article.aggregate([
      { $match: { category: 'feature', language } },
      { $sort: { publishedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } },
            { $project: { name: 1, icon: 1, groupName: 1 } }
          ]
        }
      },
      { $match: { 'source.0': { $exists: true } } }, // Only articles from non-blocked sources
      {
        $addFields: {
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          sourceIcon: { $arrayElemAt: ['$source.icon', 0] }
        }
      },
      { $unset: 'source' }
    ]);

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

// Breaking (unchanged)
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
    const articles = await Article.aggregate([
      { $match: { category: 'breaking', language } },
      { $sort: { publishedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } },
            { $project: { name: 1, icon: 1, groupName: 1 } }
          ]
        }
      },
      { $match: { 'source.0': { $exists: true } } }, // Only articles from non-blocked sources
      {
        $addFields: {
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          sourceIcon: { $arrayElemAt: ['$source.icon', 0] }
        }
      },
      { $unset: 'source' }
    ]);

    const totalHeadlineArticles = await Article.countDocuments({ category: 'breaking', language });

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

// Test endpoint to verify router is working
articleRouter.get('/test-route', (req, res) => {
  res.json({ message: 'Articles router is working!', timestamp: new Date().toISOString() });
});

// Cache clear endpoint - MUST be before the generic /:id route
articleRouter.post('/cache/clear', async (req, res) => {
  try {
    console.log('🧹 Manual cache clear requested');
    await clearArticlesCache();
    res.json({
      success: true,
      message: 'Article caches cleared successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Manual cache clear failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache',
      message: error.message
    });
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
