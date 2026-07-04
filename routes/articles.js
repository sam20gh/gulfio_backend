/**
 * 📄 Article API Routes
 * Personalized and generic article feeds with page-aware recency blending.
 */

const express = require('express');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const User = require('../models/User');
const UserActivity = require('../models/UserActivity');
const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const redis = require('../utils/redis');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { searchArticles, findInContent } = require('../utils/atlasSearch');
const { enrichArticlesWithSources, getSourceMap } = require('../utils/sourceCache');
const PointsService = require('../services/pointsService'); // 🎮 Gamification
const NotificationService = require('../utils/notificationService'); // Phase 3.3: Notifications
const {
  EXPERIMENT_ID,
  getTreatmentForUser,
  getEffectivePersW,
} = require('../utils/experiments'); // P3-1: A/B framework

const articleRouter = express.Router();

/** ---- Utilities ---- **/

// Engagement score: tune weights here if needed
const viewsWeight = 1.0;
const likesWeight = 3.0;
const dislikesWeight = -2.0;
const recencyWeight = 4.0;

/**
 * Time constant for the recency decay. exp(-hours/τ).
 *
 *   τ=72  →  24h: 0.72   48h: 0.51   72h: 0.37   7d: 0.10   30d: 4e-5
 *
 * Picked to match the brand voice ("Bold · Fast · Energetic"): fresher
 * content scores meaningfully higher than 24h-old, and 7-day content is
 * a faint signal rather than the 0.4 the old piecewise function gave it.
 *
 * Single tunable knob — adjust here to re-weight freshness without
 * touching PERS_W or any caller.
 */
const RECENCY_TAU_HOURS = 72;

/**
 * Recency score in [0, 1] using continuous exponential decay.
 *
 * Replaces a piecewise step function that had visible cliffs at 24/48/72h
 * (an article scored 1.0 at 23h and 0.8 at 25h). Smooth decay means a
 * 2-hour-old breaking story now beats a 22-hour-old one on the recency
 * term alone — useful for breaking news.
 */
function basicRecencyScore(publishedAt) {
  const now = Date.now();
  const t = new Date(publishedAt || Date.now()).getTime();
  const hours = Math.max(0, (now - t) / (1000 * 60 * 60));
  return Math.exp(-hours / RECENCY_TAU_HOURS);
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

/**
 * Per-user cache index. When a personalized endpoint SETs a key, it also
 * SADDs the key into `user_cache_keys:{userId}` so we can purge that user's
 * keys without a global SCAN. Set itself carries a 1h TTL so stale members
 * don't accumulate if a clear is missed.
 */
const USER_CACHE_INDEX_TTL = 60 * 60; // 1 hour

function userCacheIndexKey(userId) {
  return `user_cache_keys:${userId}`;
}

async function trackUserCacheKey(userId, cacheKey) {
  if (!userId || !cacheKey) return;
  try {
    await redis.sadd(userCacheIndexKey(userId), cacheKey);
    await redis.expire(userCacheIndexKey(userId), USER_CACHE_INDEX_TTL);
  } catch (err) {
    // Non-fatal: cache tracking failure just falls back to TTL-based expiry.
    console.warn('⚠️ trackUserCacheKey error:', err.message);
  }
}

/**
 * Clear the cache entries belonging to a single user.
 *
 * Safe to call on every like/dislike: O(N) over THIS user's keys, not the
 * full keyspace. Combined with `stateHash` (which already rotates the cache
 * key on every action), this is belt-and-suspenders — the new request will
 * generate a fresh key regardless.
 */
async function clearUserArticleCaches(userId) {
  if (!userId) return;
  try {
    const idxKey = userCacheIndexKey(userId);
    const keys = await redis.smembers(idxKey);
    if (keys && keys.length > 0) {
      await redis.del(...keys, idxKey);
      console.log(`🧹 Cleared ${keys.length} cache keys for user ${userId}`);
    } else {
      // No tracked keys; nothing to do.
    }
  } catch (error) {
    console.error('⚠️ Error clearing user article caches:', error.message);
    // Don't throw - cache clearing failure shouldn't break the like/dislike.
  }
}

/**
 * Clear ALL article caches across every user.
 *
 * Uses `KEYS *` so it's expensive — reserve for admin actions that
 * legitimately affect every user's feed: breaking news (mark/unmark),
 * find-replace migrations, manual /cache/clear. Do NOT call from the
 * per-user like/dislike hot path — use `clearUserArticleCaches(userId)`
 * there instead.
 */
async function clearArticlesCache() {
  try {
    const articleKeys = await redis.keys('articles_*');
    const servedKeys = await redis.keys('served_personalized_*');
    const pageKeys = await redis.keys('articles_page_*');

    const allKeys = [...articleKeys, ...servedKeys, ...pageKeys];

    if (allKeys.length > 0) {
      await redis.del(...allKeys);
      console.log(
        `🧹 [GLOBAL] Cleared ${allKeys.length} article cache keys ` +
        `(articles: ${articleKeys.length}, page: ${pageKeys.length}, served: ${servedKeys.length})`
      );
    } else {
      console.log('🧹 [GLOBAL] No article caches to clear');
    }
  } catch (error) {
    console.error('⚠️ Error clearing global article caches:', error.message);
    // Don't throw - cache clearing failure shouldn't break the caller.
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

/**
 * Incremental EMA embedding update for an article like/dislike.
 *
 * Mirrors the cheap path used by reels (routes/user.js): blend the user's
 * 128D PCA embedding toward (or away from) the article's embedding by a
 * small alpha. ~5ms of math, no OpenAI call, no full re-aggregation. The
 * daily cron (jobs/update-user-embeddings.js) still recomputes the full
 * embedding from scratch and catches up on views/saves/comments.
 *
 * Side effect: on dislike, also $addToSet the article's category into
 * disliked_categories — preserves the behavior previously achieved by the
 * heavy full re-aggregation, without scanning all disliked articles.
 *
 * Debounced via Redis: at most one incremental update per user per 2s,
 * so rapid-tap scrolling doesn't thrash the vector.
 *
 * @param {string} supabaseId
 * @param {mongoose.Types.ObjectId|string} articleId
 * @param {'like'|'dislike'} action
 */
async function applyIncrementalEmbeddingUpdate(supabaseId, articleId, action) {
  if (!supabaseId || !articleId) return;
  if (action !== 'like' && action !== 'dislike') return;

  try {
    // Debounce: skip if we updated within the last 2 seconds for this user.
    // NX returns 'OK' on first set; null if the key already exists.
    const debounceKey = `emb_debounce:${supabaseId}`;
    const acquired = await redis.set(debounceKey, '1', 'EX', 2, 'NX');
    if (acquired !== 'OK') {
      return;
    }

    const [article, user] = await Promise.all([
      Article.findById(articleId).select('embedding_pca category').lean(),
      User.findOne({ supabase_id: supabaseId })
        .select('embedding_pca disliked_articles')
        .lean(),
    ]);

    if (!article?.embedding_pca || article.embedding_pca.length !== 128) {
      // Article has no usable embedding yet (older article or scrape miss).
      // For dislikes we can still update the category set below.
    }

    // EMA blend — like pulls toward, dislike pushes away.
    if (
      article?.embedding_pca?.length === 128 &&
      user?.embedding_pca?.length === 128
    ) {
      const alpha = action === 'like' ? 0.12 : -0.15;
      const w = 1 - Math.abs(alpha);
      const newEmbedding = user.embedding_pca.map(
        (v, i) => v * w + article.embedding_pca[i] * alpha
      );
      await User.updateOne(
        { supabase_id: supabaseId },
        { $set: { embedding_pca: newEmbedding, updatedAt: new Date() } }
      );
      console.log(
        `🧠 EMA embedding update for ${supabaseId.substring(0, 8)} ` +
        `(${action}, α=${alpha})`
      );
    } else if (
      action === 'like' &&
      article?.embedding_pca?.length === 128 &&
      (!user?.embedding_pca || user.embedding_pca.length !== 128)
    ) {
      // Cold-start: user has no embedding yet (brand new account).
      // Seed it with the article's vector so the very next request
      // gets a vector-weighted feed instead of waiting for tonight's
      // cron. Only on like (not dislike) — seeding with a negative
      // signal would mean the user's vector starts as "the opposite
      // of an article they didn't like", which is meaningless.
      await User.updateOne(
        { supabase_id: supabaseId },
        { $set: { embedding_pca: article.embedding_pca, updatedAt: new Date() } }
      );
      console.log(
        `🌱 Cold-start embedding seed for ${supabaseId.substring(0, 8)} ` +
        `from first like`
      );
    }
    // else: dislike on user with no embedding — daily cron will bootstrap.

    // Dislike marks the whole category as disliked — but only after the
    // user has disliked several articles in it. The old single-tap version
    // was a feed death spiral: one thumbs-down on one sports article added
    // 'sports' to disliked_categories forever (hard $nin in every candidate
    // query, nothing ever removes entries). One real account accumulated
    // 19 of 20 categories this way and its feed collapsed to two sources.
    if (action === 'dislike' && article?.category) {
      const CATEGORY_DISLIKE_THRESHOLD = 3;
      const dislikedIds = (user?.disliked_articles || []).slice(-500);
      // Deleted articles drop out of the count — conservative by design.
      let inCategory = await Article.countDocuments({
        _id: { $in: dislikedIds },
        category: article.category,
      });
      // The current dislike may not be in disliked_articles yet (the /react
      // array update and this incremental hook race); count it if missing.
      if (!dislikedIds.some((id) => id.toString() === articleId.toString())) {
        inCategory += 1;
      }
      if (inCategory >= CATEGORY_DISLIKE_THRESHOLD) {
        await User.updateOne(
          { supabase_id: supabaseId },
          { $addToSet: { disliked_categories: article.category } }
        );
        console.log(
          `🚫 Category '${article.category}' banned for ` +
          `${supabaseId.substring(0, 8)} after ${inCategory} dislikes`
        );
      }
    }
  } catch (err) {
    // Non-fatal: a missed EMA just means the daily cron handles it.
    console.warn(
      `⚠️ Incremental embedding update failed for ${supabaseId}: ${err.message}`
    );
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

/** ---- Served-article cursor (P0-2 follow-up) ---- **/
/**
 * Exclude articles a user has been served recently from their personalized
 * candidate pool, so deep pagination doesn't repeat the same content as
 * the underlying pool shrinks (the page-based slice problem: pages 1, 2,
 * 3 used to be [0:20], [20:40], [40:60] of the same scored list — pool
 * size 25 meant page 2 returned 5, page 3 returned 0).
 *
 * Implementation: per-user Redis SET keyed by supabase_id. SADD every
 * article ID we surface. EXPIRE sliding 6h on every write — active users
 * never see repeats; idle users returning the next morning see
 * everything again.
 *
 * Applied to: /personalized-light, /personalized-fast, /personalized-category.
 * NOT applied to: /following (users explicitly subscribed; they want
 * everything those sources publish even if they've already seen it).
 */
const SERVED_EXCLUSION_TTL_SEC = 6 * 60 * 60; // 6h sliding
const SERVED_MAX_EXCLUDE = 1000; // ceiling on how many IDs we send to $nin

function servedKey(userId) {
  return `served_pers_v1:${userId}`;
}

async function getServedIds(userId) {
  if (!userId) return new Set();
  try {
    const members = await redis.smembers(servedKey(userId));
    return new Set(members || []);
  } catch (err) {
    // Non-fatal: just means no exclusion this request.
    console.warn('⚠️ getServedIds error:', err.message);
    return new Set();
  }
}

async function recordServedIds(userId, articleIds) {
  if (!userId || !articleIds?.length) return;
  try {
    const ids = articleIds
      .map((a) => (a && a._id ? a._id.toString() : a?.toString()))
      .filter(Boolean);
    if (ids.length === 0) return;
    await redis.sadd(servedKey(userId), ...ids);
    // Sliding TTL: each write resets the expiry. Active users keep
    // their served set "warm" for as long as they're scrolling; idle
    // users let it expire after 6h of no activity.
    await redis.expire(servedKey(userId), SERVED_EXCLUSION_TTL_SEC);
  } catch (err) {
    // Non-fatal: a missed record just means the next page may overlap
    // slightly. Client-side dedup catches it.
    console.warn('⚠️ recordServedIds error:', err.message);
  }
}

/** ---- Personalization v2 helpers ---- **/

// Scoring weights — tuned for Gulf news feed (bold/fast hero accent feed)
const PERS_W = {
  recency: 4.0,
  engagement: 1.0,
  categoryAffinity: 3.0,
  followingBoost: 2.5,
  preferredSourceBoost: 1.5,
  vector: 6.0,
  dislikedCategoryPenalty: -8.0,
  // Explicit "show less from this source" (not-interested panel chip).
  // Softer than a category ban: the source still appears when it has
  // genuinely strong content, just far less often.
  mutedSourcePenalty: -6.0,
  // Viewed articles are demoted (not excluded) so the feed never starves.
  // They sink below fresh content but reappear if no better candidates exist.
  viewedPenalty: -3.0,
};

/**
 * Threshold in seconds at which a read is considered "full" for the
 * read-time-weighted viewed penalty (P1-6). A read at this duration or
 * longer applies the full viewedPenalty; shorter reads apply
 * proportionally less.
 */
const FULL_READ_SECONDS = 60;

/**
 * Per-(category, language) engagement statistics (mean + stddev of raw
 * engagement signal) so we can score by z-score rather than absolute
 * volume. Without this, a viral Football article (raw eng ~200) drowns
 * out a typical Business article (raw eng ~20) even when a Business
 * reader has explicit Business preference — the engagement term keeps
 * dragging Football to the top.
 *
 * Returns Map<category, {mean, stddev}>. Empty Map if data unavailable;
 * scorer falls back to the legacy tanh(rawEng/80) in that case.
 *
 * Cached in Redis on a 15-minute slot, refreshed on miss. Computed from
 * articles published in the last 7 days for the given language.
 */
async function getCategoryEngagementStats(language) {
  const lang = (language || 'english').toLowerCase();
  const fifteenMinSlot = Math.floor(Date.now() / (15 * 60 * 1000));
  const cacheKey = `cat_eng_stats_v1_${lang}_${fifteenMinSlot}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const obj = JSON.parse(cached);
      return new Map(Object.entries(obj));
    }
  } catch (err) {
    console.warn('⚠️ getCategoryEngagementStats GET error:', err.message);
  }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await Article.aggregate([
      {
        $match: {
          language: lang,
          publishedAt: { $gte: sevenDaysAgo },
          category: { $exists: true, $ne: null },
        },
      },
      {
        $project: {
          category: 1,
          rawEng: {
            $add: [
              { $multiply: [{ $ifNull: ['$viewCount', 0] }, viewsWeight] },
              { $multiply: [{ $ifNull: ['$likes', 0] }, likesWeight] },
              { $multiply: [{ $ifNull: ['$dislikes', 0] }, dislikesWeight] },
            ],
          },
        },
      },
      {
        $group: {
          _id: '$category',
          mean: { $avg: '$rawEng' },
          stddev: { $stdDevPop: '$rawEng' },
          n: { $sum: 1 },
        },
      },
      // Reject categories with too few samples — their stats are noise
      { $match: { n: { $gte: 5 } } },
    ]);

    const stats = {};
    for (const r of rows) {
      stats[r._id] = { mean: r.mean || 0, stddev: r.stddev || 0 };
    }

    try {
      await redis.set(cacheKey, JSON.stringify(stats), 'EX', 900); // 15 min
    } catch (err) {
      console.warn('⚠️ getCategoryEngagementStats SET error:', err.message);
    }

    return new Map(Object.entries(stats));
  } catch (err) {
    console.warn('⚠️ getCategoryEngagementStats compute error:', err.message);
    return new Map();
  }
}

/**
 * Per-user context cache (P2-1).
 *
 * loadUserPersonalizationContext used to run on every personalized request:
 * one Mongo findOne + one UserActivity aggregation. With three handlers
 * each loading ctx (personalized-light, fast, category), an active user
 * scrolling + tapping a chip would trigger 3+ ctx loads in 5 seconds.
 *
 * Cache the entire ctx in Redis for CTX_CACHE_TTL seconds. Sets and Maps
 * don't JSON-serialize, so we round-trip them as arrays and rebuild on
 * read.
 *
 * Invalidation: tracked via trackUserCacheKey so the existing
 * clearUserArticleCaches(userId) call in the /react hot path purges it
 * along with the article caches. Other state mutations (follow, save,
 * language change) rely on the 5-min TTL — acceptable lag.
 */
const CTX_CACHE_TTL = 5 * 60; // 5 min

function ctxCacheKey(userId) {
  return `user_ctx_v1_${userId}`;
}

function serializeCtx(ctx) {
  if (!ctx) return null;
  return {
    userId: ctx.userId,
    treatment: ctx.treatment,
    preferredCategories: Array.from(ctx.preferredCategories),
    preferredSourceIds: Array.from(ctx.preferredSourceIds),
    dislikedCategories: Array.from(ctx.dislikedCategories),
    mutedSourceIds: Array.from(ctx.mutedSourceIds || []),
    likedIds: Array.from(ctx.likedIds),
    likedIdsOrdered: ctx.likedIdsOrdered,
    dislikedIds: Array.from(ctx.dislikedIds),
    savedIds: Array.from(ctx.savedIds),
    viewedIds: Array.from(ctx.viewedIds),
    viewReadFractions: Array.from(ctx.viewReadFractions.entries()),
    followingSourceGroups: Array.from(ctx.followingSourceGroups),
    embedding: ctx.embedding,
    language: ctx.language,
    hasSignal: ctx.hasSignal,
  };
}

function deserializeCtx(plain) {
  if (!plain) return null;
  return {
    userId: plain.userId,
    treatment: plain.treatment || 'control',
    preferredCategories: new Set(plain.preferredCategories || []),
    preferredSourceIds: new Set(plain.preferredSourceIds || []),
    dislikedCategories: new Set(plain.dislikedCategories || []),
    mutedSourceIds: new Set(plain.mutedSourceIds || []),
    likedIds: new Set(plain.likedIds || []),
    likedIdsOrdered: plain.likedIdsOrdered || [],
    dislikedIds: new Set(plain.dislikedIds || []),
    savedIds: new Set(plain.savedIds || []),
    viewedIds: new Set(plain.viewedIds || []),
    viewReadFractions: new Map(plain.viewReadFractions || []),
    followingSourceGroups: new Set(plain.followingSourceGroups || []),
    embedding: plain.embedding || null,
    language: plain.language,
    hasSignal: !!plain.hasSignal,
  };
}

/**
 * Load all personalization signals for a user in one Mongo query.
 * Returns null if user not found. Sets are used for O(1) exclusion/lookup.
 *
 * Cached in Redis for 5 min (P2-1). Pass `forceFresh: true` to bypass.
 */
async function loadUserPersonalizationContext(userId, { forceFresh = false } = {}) {
  if (!userId) return null;

  const cacheKey = ctxCacheKey(userId);

  if (!forceFresh) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return deserializeCtx(JSON.parse(cached));
      }
    } catch (err) {
      // Non-fatal: fall through and compute fresh.
      console.warn(`⚠️ ctx cache GET error for ${userId}: ${err.message}`);
    }
  }

  const ctx = await computeUserPersonalizationContext(userId);
  if (ctx) {
    try {
      await redis.set(cacheKey, JSON.stringify(serializeCtx(ctx)), 'EX', CTX_CACHE_TTL);
      await trackUserCacheKey(userId, cacheKey);
    } catch (err) {
      console.warn(`⚠️ ctx cache SET error for ${userId}: ${err.message}`);
    }
  }
  return ctx;
}

/** Inner: the actual Mongo work, unwrapped. */
async function computeUserPersonalizationContext(userId) {
  const user = await User.findOne({ supabase_id: userId })
    .select(
      'preferred_categories preferred_sources disliked_categories ' +
      'implicit_preferred_categories muted_categories muted_sources ' +
      'liked_articles disliked_articles saved_articles viewed_articles ' +
      'following_sources embedding_pca language'
    )
    .lean();
  if (!user) return null;

  const toIdStringSet = (arr) =>
    new Set((arr || []).map((id) => (id && id.toString ? id.toString() : id)).filter(Boolean));

  // Merge explicit + implicit preferred categories (P1-3).
  // Explicit are user-declared; implicit are derived nightly from
  // 30d weighted action history. Scorer treats both equally.
  const preferredCategories = new Set([
    ...(user.preferred_categories || []),
    ...(user.implicit_preferred_categories || []),
  ]);
  const preferredSourceIds = new Set(
    (user.preferred_sources || []).map((id) => (id && id.toString ? id.toString() : id))
  );

  // Source the viewed signal from BOTH the legacy User.viewed_articles
  // (rarely populated by current routes) AND the live UserActivity log
  // — that's where today's /article/:id/view and read_time events go.
  // Also accumulate read-time durations so the penalty can scale by how
  // deeply each article was consumed (P1-6).
  const viewedIds = toIdStringSet(user.viewed_articles);
  const viewReadFractions = new Map();
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activityRows = await UserActivity.aggregate([
      {
        $match: {
          userId,
          articleId: { $exists: true, $ne: null },
          eventType: { $in: ['view', 'read_time'] },
          timestamp: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: '$articleId',
          totalReadTime: {
            $sum: {
              $cond: [{ $eq: ['$eventType', 'read_time'] }, { $ifNull: ['$duration', 0] }, 0],
            },
          },
          hasView: {
            $max: { $cond: [{ $eq: ['$eventType', 'view'] }, 1, 0] },
          },
        },
      },
      { $limit: 500 },
    ]);
    for (const row of activityRows) {
      const idStr = row._id.toString();
      viewedIds.add(idStr);
      // Fraction maps total_read_time -> [0, 1] capped at FULL_READ_SECONDS.
      // No read_time event but a 'view' event recorded -> default 0.5
      // (they tapped through, but we don't know how long they stayed).
      let fraction;
      if (row.totalReadTime > 0) {
        fraction = Math.min(1, row.totalReadTime / FULL_READ_SECONDS);
      } else if (row.hasView) {
        fraction = 0.5;
      } else {
        continue;
      }
      viewReadFractions.set(idStr, fraction);
    }
  } catch (err) {
    // Non-fatal: missing read-time data just means the viewed penalty
    // falls back to its flat -1.0 (default for "viewed but no fraction").
    console.warn(`⚠️ Failed to load view/read activity for ${userId}: ${err.message}`);
  }

  // Preserve liked order as best as we can — Mongo array order is the
  // order they were pushed (newest at end), so reversing gives us
  // most-recent-first for the Cohere pseudo-query (P1-5).
  const likedIdsOrdered = (user.liked_articles || [])
    .slice(-20) // last 20 likes (most recent)
    .reverse()
    .map((id) => (id && id.toString ? id.toString() : id))
    .filter(Boolean);

  return {
    userId,
    // P3-1: stable A/B treatment ID. The scorer reads effective PERS_W
    // through this; /react and /view log it onto UserActivity.
    treatment: getTreatmentForUser(userId),
    preferredCategories,
    preferredSourceIds,
    // Derived bans (≥3 dislikes, nightly cron) + explicit mutes from the
    // not-interested panel share the exclusion machinery.
    dislikedCategories: new Set([
      ...(user.disliked_categories || []),
      ...(user.muted_categories || []),
    ]),
    // Explicit "show less from this source" — scorer demotes, never excludes.
    mutedSourceIds: toIdStringSet(user.muted_sources),
    likedIds: toIdStringSet(user.liked_articles),
    likedIdsOrdered,
    dislikedIds: toIdStringSet(user.disliked_articles),
    savedIds: toIdStringSet(user.saved_articles),
    viewedIds,
    viewReadFractions,
    followingSourceGroups: new Set(user.following_sources || []),
    embedding:
      Array.isArray(user.embedding_pca) && user.embedding_pca.length > 0
        ? user.embedding_pca
        : null,
    language: (user.language || 'English').toLowerCase(),
    hasSignal:
      preferredCategories.size +
        (user.liked_articles?.length || 0) +
        (user.saved_articles?.length || 0) +
        (user.following_sources?.length || 0) +
        preferredSourceIds.size >
      0,
  };
}

/**
 * Score candidate articles using the user's personalization context.
 * Returns an array sorted by descending score (mutates each item with `_score`).
 *
 * page argument shifts the blend: page 1 favors recency (feels fresh),
 * deeper pages favor relevance (give them what they like).
 */
function scorePersonalizedCandidates(candidates, ctx, { page = 1 } = {}) {
  if (!candidates?.length) return [];

  const recencyMult = page === 1 ? 1.2 : page === 2 ? 1.0 : 0.8;
  const relMult = page === 1 ? 0.8 : page === 2 ? 1.0 : 1.2;
  const hasEmbedding = !!ctx?.embedding;

  // P3-1: pull effective weights from the user's treatment. Falls
  // through to PERS_W defaults when no overrides exist (today: always).
  const W = getEffectivePersW(ctx?.treatment || 'control', PERS_W);

  const categoryStats = ctx.categoryStats; // Map<category, {mean, stddev}> | undefined

  // P2-2 telemetry: aggregate stats so we can decide whether to skip the
  // embedding projection for heavy-category users. Logged at the bottom.
  let totalAbsScore = 0;
  let totalAbsVector = 0;
  let withEmbeddingCount = 0;

  for (const a of candidates) {
    const recency = basicRecencyScore(a.publishedAt);

    // Engagement: if we have per-category stats (P1-2), score by z-score
    // (deviation from category average) so a viral Football article doesn't
    // outrank a typical Business article for a Business reader. Otherwise
    // fall back to the legacy tanh(rawEng/80) absolute-volume form.
    const rawEng =
      (a.viewCount || 0) * viewsWeight +
      (a.likes || 0) * likesWeight +
      (a.dislikes || 0) * dislikesWeight;
    const stats = categoryStats && a.category ? categoryStats.get(a.category) : null;
    let engagement;
    if (stats && stats.stddev > 0) {
      const z = (rawEng - stats.mean) / stats.stddev;
      // tanh(z/2) maps z=2 (~95th pct) to 0.76, z=0 to 0, z=-2 to -0.76.
      // Engagement can now actively penalize below-average articles, which
      // is the intended behavior — "below typical for its category" is a
      // real signal, not just absence of signal.
      engagement = Math.tanh(z / 2);
    } else {
      engagement = Math.tanh(rawEng / 80);
    }

    let categoryScore = 0;
    if (a.category) {
      if (ctx.preferredCategories.has(a.category)) categoryScore += 1;
      if (ctx.dislikedCategories.has(a.category)) {
        // Penalty is heavy and applied directly (not multiplied by relMult)
        // so it dominates regardless of page bias.
        a._dislikedCat = true;
      }
    }

    const sourceIdStr = a.sourceId ? a.sourceId.toString() : null;
    const idStr = a._id ? a._id.toString() : null;
    const followingScore = a.sourceGroupName && ctx.followingSourceGroups.has(a.sourceGroupName) ? 1 : 0;
    const preferredSourceScore = sourceIdStr && ctx.preferredSourceIds.has(sourceIdStr) ? 1 : 0;
    const alreadyViewed = idStr ? ctx.viewedIds.has(idStr) : false;

    let vectorScore = 0;
    if (typeof a._atlasSimilarity === 'number') {
      // Hybrid retrieval path: the candidate came from Atlas $vectorSearch, so
      // we already have a cosine score. Atlas normalizes cosine to [0,1] as
      // (1 + cos)/2 — convert back to raw cosine and clamp so W.vector keeps
      // the exact same meaning as the JS cosine path below.
      vectorScore = Math.max(0, 2 * a._atlasSimilarity - 1);
      withEmbeddingCount++;
    } else if (
      hasEmbedding &&
      Array.isArray(a.embedding_pca) &&
      a.embedding_pca.length === ctx.embedding.length
    ) {
      // Clamp to [0,1] — negative similarity shouldn't actively penalize, just contribute nothing
      vectorScore = Math.max(0, cosineSimilarity(ctx.embedding, a.embedding_pca));
      withEmbeddingCount++;
    }

    const vectorContribution = relMult * W.vector * vectorScore;
    const positiveScore =
      recencyMult * W.recency * recency +
      W.engagement * engagement +
      relMult * W.categoryAffinity * categoryScore +
      relMult * W.followingBoost * followingScore +
      relMult * W.preferredSourceBoost * preferredSourceScore +
      vectorContribution;

    // P3-5: scale the positive component by source quality. Default 1.0
    // (neutral) so articles from sources with no aggregate data yet
    // aren't penalized. Sources where dislikes dominate likes get
    // quality < 1, which proportionally demotes their positive signal —
    // they don't disappear, they just compete for fewer top slots.
    //
    // Penalties (dislikedCategory, viewedPenalty) are NOT scaled by
    // quality. Multiplying a negative number by 0.7 makes it less
    // negative, which would soften penalties for low-quality sources —
    // the opposite of what we want.
    const sourceQuality = typeof a.sourceQualityScore === 'number'
      ? a.sourceQualityScore
      : 1.0;
    let score = positiveScore * sourceQuality;

    if (a._dislikedCat) score += W.dislikedCategoryPenalty;
    if (sourceIdStr && ctx.mutedSourceIds?.has(sourceIdStr)) {
      score += W.mutedSourcePenalty;
    }
    if (alreadyViewed) {
      // P1-6: scale by how deeply this article was previously consumed.
      // Full read (≥FULL_READ_SECONDS) gets the full -3.0 penalty;
      // a glance gets proportionally less; legacy "view" with no
      // read-time event falls back to the default 1/3 of full.
      const fraction = ctx.viewReadFractions?.get(idStr) ?? (1 / 3);
      score += W.viewedPenalty * fraction;
    }

    a._score = score;

    if (hasEmbedding) {
      // Track absolute contribution so a vector that pushes some scores up
      // and others down still shows its real influence on the ranking.
      totalAbsScore += Math.abs(score);
      totalAbsVector += Math.abs(vectorContribution);
    }
  }

  // P2-2 telemetry: log mean vector contribution as a % of total absolute
  // ranking signal. After a week of these logs we can decide whether to
  // skip the embedding projection for users where this is consistently
  // below 5%.
  if (hasEmbedding && withEmbeddingCount > 0 && totalAbsScore > 0) {
    const vectorPct = Math.round((totalAbsVector / totalAbsScore) * 100);
    if (process.env.PERS_LOG_VECTOR_PCT === '1' || vectorPct < 3) {
      console.log(
        `📐 vector contribution for ${ctx.userId?.substring?.(0, 8) || '?'}: ` +
        `${vectorPct}% (${withEmbeddingCount}/${candidates.length} candidates had embedding)`
      );
    }
  }

  return candidates.sort((x, y) => y._score - x._score);
}

/**
 * Cohere rerank (P1-5).
 *
 * Feature-flagged via COHERE_RERANK_ENABLED=1. When on:
 *   - Build a pseudo-query from the user's last 20 liked article titles
 *     (cached per-user for 30 min — liked list changes rarely).
 *   - Send the top-N candidates after local scoring/interleave to Cohere
 *     rerank-multilingual-v3.0 (handles Arabic + Farsi as well as English).
 *   - Use the returned order as the final ranking; on any failure
 *     (no API key, timeout, HTTP error, no eligible query) fall back to
 *     the local order — Cohere is additive, never required.
 *
 * Runs only for users with >=3 liked articles. Below that we can't build
 * a meaningful pseudo-query.
 *
 * Cost notes: ~$2/1M docs. With 80 docs per request and a busy day at
 * 10k personalized-light requests, that's ~800k docs/day ≈ $1.60/day.
 * SWR (P0-2) means most calls are background regen, so latency cost is
 * off the user's response path.
 */
const COHERE_RERANK_TOP_N = 80;
const COHERE_RERANK_TIMEOUT_MS = 6000;
const COHERE_QUERY_CACHE_TTL = 30 * 60; // 30 min
const COHERE_MIN_LIKES = 3;

function cohereEnabled() {
  return !!process.env.COHERE_API_KEY && process.env.COHERE_RERANK_ENABLED === '1';
}

/**
 * P2-2 conditional embedding projection.
 *
 * When a user has lots of explicit signal (many preferred categories,
 * many followed source groups), the vector term contributes only
 * marginally to the final ranking — category and following boosts
 * already dominate. We can skip pulling `embedding_pca` from Mongo (128
 * floats × ~240 candidates ≈ 31KB) and save the network/Mongo bandwidth.
 *
 * Feature-flagged: off by default. Turn on after a week of
 * `📐 vector contribution` telemetry (PERS_LOG_VECTOR_PCT=1) confirms
 * which user profiles see <5% vector contribution.
 */
function shouldSkipEmbedding(ctx) {
  if (process.env.PERS_SKIP_VECTOR_FOR_HEAVY_PREFS !== '1') return false;
  if (!ctx) return false;
  const prefCats = ctx.preferredCategories?.size || 0;
  const followSrc = ctx.followingSourceGroups?.size || 0;
  // Users with 4+ category prefs AND 3+ followed source groups have
  // enough non-vector signal that the embedding projection rarely shifts
  // the top-K. Tune thresholds based on logged telemetry.
  return prefCats >= 4 && followSrc >= 3;
}

async function getCohereQueryForUser(userId, likedIdsOrdered) {
  if (!likedIdsOrdered || likedIdsOrdered.length < COHERE_MIN_LIKES) return null;
  // Cache key based on the prefix of liked IDs — if the user likes a new
  // article, the prefix shifts and the cache rotates naturally.
  const sample = likedIdsOrdered.slice(0, 10).join('|');
  const cacheKey = `cohere_q_${userId}_${simpleHash(sample)}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
  } catch (err) {
    // Non-fatal: just rebuild below.
  }

  try {
    const ids = likedIdsOrdered.map((id) => new mongoose.Types.ObjectId(id));
    const articles = await Article.find({ _id: { $in: ids } })
      .select('title')
      .lean();
    if (!articles.length) return null;
    // Order by the input array (the find() result order isn't guaranteed)
    const byId = new Map(articles.map((a) => [a._id.toString(), a]));
    const titles = likedIdsOrdered
      .map((id) => byId.get(id)?.title)
      .filter(Boolean)
      .slice(0, 20)
      .map((t) => t.replace(/\s+/g, ' ').trim());
    if (titles.length === 0) return null;
    const query = titles.join(' / ');
    try {
      await redis.set(cacheKey, query, 'EX', COHERE_QUERY_CACHE_TTL);
    } catch (err) {
      // Non-fatal
    }
    return query;
  } catch (err) {
    console.warn(`⚠️ getCohereQueryForUser failed for ${userId}: ${err.message}`);
    return null;
  }
}

async function rerankWithCohere(query, articles) {
  if (!articles?.length || !query) return null;

  const axios = require('axios');
  const documents = articles.map((a) => {
    const content = a.content
      ? a.content.replace(/<[^>]*>/g, '').slice(0, 800)
      : '';
    return `${a.title || ''}\n${content}`.slice(0, 1024);
  });

  try {
    const response = await axios.post(
      'https://api.cohere.ai/v1/rerank',
      {
        // Multilingual handles Arabic + Farsi + English in one model.
        model: 'rerank-multilingual-v3.0',
        query,
        documents,
        top_n: documents.length,
        return_documents: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: COHERE_RERANK_TIMEOUT_MS,
      }
    );

    const results = response?.data?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    // Map Cohere's reordered indices back to our articles, attaching the
    // relevance score for telemetry. Cohere's `results` is already sorted
    // by relevance descending.
    return results.map((r) => ({
      ...articles[r.index],
      _rerankScore: r.relevance_score,
    }));
  } catch (err) {
    console.warn(
      `⚠️ Cohere rerank failed (${err.response?.status || err.code || 'err'}): ${err.message}`
    );
    return null;
  }
}

/**
 * ε-greedy exploration injection (P1-4).
 *
 * With probability EXPLORATION_RATE, swap a visible mid-page slot of the
 * page-1 feed with a recent article from a category the user has NOT
 * recently engaged with. Helps break out of filter bubbles — the greedy
 * scorer otherwise reinforces existing affinities indefinitely.
 *
 * Criteria for an exploration candidate:
 *   - Recent (recency >= 0.5, i.e. ~last 50h with τ=72)
 *   - Category is NOT in user's explicit OR implicit preferred categories
 *   - Article is NOT already in the visible page
 *   - Article is NOT already in viewedIds
 *
 * No-op if no eligible candidate exists in the pool, or if user has no
 * personalization signal (cold-start users are already exploring by
 * default — pure recency feed).
 *
 * @param {Array} page - the page-sliced output array (mutated in place)
 * @param {Array} fullPool - the full scored+interleaved pool
 * @param {Object} ctx - personalization context
 * @returns {boolean} true if a swap happened
 */
const EXPLORATION_RATE = 0.12;
const EXPLORATION_MIN_SLOT = 2;
const EXPLORATION_MAX_SLOT = 7;

function maybeInjectExploration(page, fullPool, ctx) {
  if (!ctx?.hasSignal) return false;
  if (!page || page.length <= EXPLORATION_MIN_SLOT) return false;
  if (Math.random() >= EXPLORATION_RATE) return false;

  const pageIds = new Set(
    page.map((a) => (a._id ? a._id.toString() : null)).filter(Boolean)
  );

  // Build eligibility filter — prefer articles from categories the user
  // genuinely hasn't explored, not just ones missing from preferred.
  const preferred = ctx.preferredCategories || new Set();
  const viewed = ctx.viewedIds || new Set();

  const eligible = [];
  for (const a of fullPool) {
    if (!a.category) continue;
    if (preferred.has(a.category)) continue;
    const idStr = a._id ? a._id.toString() : null;
    if (!idStr) continue;
    if (pageIds.has(idStr)) continue;
    if (viewed.has(idStr)) continue;
    const recency = basicRecencyScore(a.publishedAt);
    if (recency < 0.5) continue;
    eligible.push(a);
  }

  if (eligible.length === 0) return false;

  // Pick uniformly at random — true exploration. We're explicitly not
  // sorting by score here; the point is to surface what the greedy ranker
  // would never pick.
  const picked = eligible[Math.floor(Math.random() * eligible.length)];

  // Pick a slot in the visible mid-page range. Clamp to actual length so
  // we don't crash on a short page.
  const maxSlot = Math.min(EXPLORATION_MAX_SLOT, page.length - 1);
  const slot =
    EXPLORATION_MIN_SLOT +
    Math.floor(Math.random() * (maxSlot - EXPLORATION_MIN_SLOT + 1));

  page[slot] = { ...picked, _explorationInjected: true };
  return true;
}

/**
 * Interleave articles by source group so consecutive items don't come from
 * the same source, without throwing away total count.
 *
 * `minGap` is the minimum number of other articles that must separate two
 * articles from the same group. `perGroupCap` is a soft ceiling per group —
 * generous, just prevents one source from dominating the whole feed.
 *
 * Preserves the incoming relevance order as much as possible: high-scored
 * articles still appear early; only those that would bunch with a recent
 * same-group article are deferred to a second pass.
 *
 * Complexity: **O(n)** total. Each candidate is processed at most twice
 * (once in pass 1, possibly once in pass 2). All inner ops are O(1):
 * Map.get / Map.set, single arithmetic on out.length and the cached
 * lastIdx. Measured ~28μs for n=240, ~200μs at n=25k — i.e. negligible
 * relative to any other step in the pipeline. A heap-based variant was
 * considered (P2-4 in the roadmap) and rejected: heap ops are
 * O(log k) > O(1), and the heap doesn't reduce candidate count — it
 * would be slower at every realistic n.
 */
function interleaveBySourceGroup(scored, { minGap = 2, perGroupCap = 8, fill = false } = {}) {
  if (!scored?.length) return scored;

  const groupCount = new Map();
  const lastIdx = new Map();
  const out = [];
  const deferred = [];
  const overflow = [];

  const groupOf = (a) =>
    a.sourceGroupName || (a.sourceId ? a.sourceId.toString() : 'unknown');

  // Pass 1: greedy placement with gap enforcement
  for (const a of scored) {
    const g = groupOf(a);
    if ((groupCount.get(g) || 0) >= perGroupCap) {
      if (fill) overflow.push(a);
      continue;
    }

    const last = lastIdx.get(g);
    if (last !== undefined && out.length - 1 - last < minGap) {
      deferred.push(a);
      continue;
    }

    out.push(a);
    groupCount.set(g, (groupCount.get(g) || 0) + 1);
    lastIdx.set(g, out.length - 1);
  }

  // Pass 2: append deferred articles where the gap now allows
  for (const a of deferred) {
    const g = groupOf(a);
    if ((groupCount.get(g) || 0) >= perGroupCap) {
      if (fill) overflow.push(a);
      continue;
    }

    const last = lastIdx.get(g);
    if (last === undefined || out.length - 1 - last >= minGap) {
      out.push(a);
      groupCount.set(g, (groupCount.get(g) || 0) + 1);
      lastIdx.set(g, out.length - 1);
    } else if (fill) {
      overflow.push(a);
    }
  }

  // fill mode: keep total count intact by appending cap/gap rejects at the
  // tail. Sparse pools (low-volume languages, small fallback queries) would
  // otherwise return a visibly short page; clustered items at the bottom
  // beat missing items.
  if (fill && overflow.length > 0) {
    out.push(...overflow);
  }

  return out;
}

/**
 * Greedy Maximal Marginal Relevance over the top of the scored pool.
 *
 * Source interleaving can't see *topical* redundancy: five sources covering
 * the same story pass the source-gap check, and a same-source scraper burst
 * has near-identical scores (recency dominates for brand-new articles, and
 * same-source style means similar embedding_pca vectors). MMR penalizes each
 * candidate by its max cosine similarity to anything already picked, so both
 * failure modes lose top slots to genuinely different content.
 *
 * Incremental form: each remaining candidate caches its max similarity to
 * the picked set and only updates against the last pick — O(topN² · dims)
 * ≈ 60·60·128 ≈ 460k mults, well under a millisecond in-process. Runs before
 * interleaveBySourceGroup (MMR shapes the order, interleave enforces hard
 * source gaps) and mostly inside SWR background regen, so the user-facing
 * path is unaffected.
 *
 * Candidates without embedding_pca are never penalized (maxSim stays 0) —
 * they rank purely by _score, same as before.
 */
const MMR_TOP_N = 60;
const MMR_LAMBDA = 1.75;

function applyMMRDiversity(scored, { topN = MMR_TOP_N, lambda = MMR_LAMBDA } = {}) {
  if (!scored || scored.length < 3) return scored;
  const n = Math.min(topN, scored.length);
  const head = scored.slice(0, n);

  let vecCount = 0;
  for (const a of head) {
    if (Array.isArray(a.embedding_pca) && a.embedding_pca.length > 0) vecCount++;
  }
  // Too few vectors to measure redundancy — keep the score order.
  if (vecCount < 3) return scored;

  const remaining = head.map((a) => ({ a, maxSim: 0 }));
  const picked = [];

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const val = remaining[i].a._score - lambda * remaining[i].maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    picked.push(chosen.a);

    const cv = chosen.a.embedding_pca;
    if (Array.isArray(cv) && cv.length > 0) {
      for (const r of remaining) {
        const rv = r.a.embedding_pca;
        if (Array.isArray(rv) && rv.length === cv.length) {
          const s = cosineSimilarity(rv, cv);
          if (s > r.maxSim) r.maxSim = s;
        }
      }
    }
  }

  return picked.concat(scored.slice(n));
}

/**
 * Hash that changes whenever the user's view/like/follow state changes.
 * Embedded in the cache key so refresh after activity returns fresh content.
 */
function userStateHash(ctx) {
  if (!ctx) return 0;
  return simpleHash(
    `${ctx.viewedIds.size}|${ctx.likedIds.size}|${ctx.dislikedIds.size}|` +
      `${ctx.savedIds.size}|${ctx.preferredCategories.size}|` +
      `${ctx.followingSourceGroups.size}|${ctx.embedding ? ctx.embedding.length : 0}|` +
      `${ctx.dislikedCategories.size}|${ctx.mutedSourceIds?.size || 0}`
  );
}

/** Strip internal/heavy fields before sending to client. */
function sanitizeForResponse(articles, extra = {}) {
  return articles.map((a) => {
    const { _score, _dislikedCat, _atlasSimilarity, embedding_pca, sourceGroupName, ...rest } = a;
    return { ...rest, ...extra };
  });
}

/**
 * Compute personalized-light articles for a user. Extracted so we can call it
 * synchronously on cold miss and from the SWR background regen path with the
 * same logic.
 *
 * @returns {Promise<{articles: object[], usedWindowMs: number, candidateCount: number, dbTime: number, includeEmbedding: boolean, retrieval: 'hybrid'|'recency'}>}
 */
async function computePersonalizedLight({ ctx, language, limit, forceRefresh }) {
  const buildMatch = (sinceMs, { skipCategoryExclusion = false } = {}) => {
    const match = {
      language,
      publishedAt: { $gte: new Date(Date.now() - sinceMs) },
    };
    if (ctx) {
      // Combined exclusion: hard-disliked articles + recently-served
      // articles (P0-2 follow-up). The latter rotates back in after the
      // 6h sliding TTL.
      const excluded = [];
      if (ctx.dislikedIds.size > 0) {
        excluded.push(...[...ctx.dislikedIds].slice(0, 500));
      }
      if (ctx.servedIds?.size > 0) {
        excluded.push(...[...ctx.servedIds].slice(0, SERVED_MAX_EXCLUDE));
      }
      if (excluded.length > 0) {
        match._id = {
          $nin: excluded.map((id) => new mongoose.Types.ObjectId(id)),
        };
      }
      if (!skipCategoryExclusion && ctx.dislikedCategories.size > 0) {
        match.category = { $nin: [...ctx.dislikedCategories] };
      }
    }
    return match;
  };

  const candidateLimit = Math.min(limit * 12, 400);
  const includeEmbedding = !!ctx?.embedding && !shouldSkipEmbedding(ctx);

  const runCandidateQuery = (sinceMs, opts) =>
    Article.aggregate([
      { $match: buildMatch(sinceMs, opts) },
      { $sort: { publishedAt: -1 } },
      { $limit: candidateLimit },
      {
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } },
            { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
          ],
        },
      },
      { $match: { 'source.0': { $exists: true } } },
      {
        $addFields: {
          sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
          sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
        },
      },
      {
        $project: {
          title: 1,
          content: 1,
          contentFormat: 1,
          url: 1,
          category: 1,
          publishedAt: 1,
          image: 1,
          viewCount: 1,
          likes: 1,
          dislikes: 1,
          commentCount: 1,
          likedBy: 1,
          dislikedBy: 1,
          sourceId: 1,
          sourceName: 1,
          sourceIcon: 1,
          sourceGroupName: 1,
          language: 1,
          // Always projected (not just when includeEmbedding): the MMR
          // diversity pass needs candidate-to-candidate similarity even for
          // users whose own embedding is skipped. 400 × 128 floats is a
          // trivial intra-cluster payload; sanitizeForResponse strips it.
          embedding_pca: 1,
        },
      },
    ]);

  // Hybrid retrieval: same candidate shape as runCandidateQuery, but the pool
  // is sourced from Atlas $vectorSearch (default index, embedding_pca) ranked
  // by similarity to the user's embedding instead of pure recency. The blended
  // scorer still runs on top — only the candidate *source* changes. We attach
  // _atlasSimilarity (Atlas cosine score) so the scorer can skip recomputing
  // cosine and we can drop embedding_pca from the projection (smaller payload).
  const runVectorCandidateQuery = (sinceMs) => {
    const numCandidates = Math.min(Math.round(candidateLimit * NUM_CANDIDATE_MULT), 2000);
    const filter = {
      language,
      publishedAt: { $gte: new Date(Date.now() - sinceMs) },
    };
    // category is an indexed filter field on the default index — cheapest place to drop dislikes
    if (ctx?.dislikedCategories?.size > 0) {
      filter.category = { $nin: [...ctx.dislikedCategories] };
    }
    // _id is NOT an indexed filter field on `default`, so disliked articles are
    // excluded in a post-search $match rather than inside the vector filter.
    const dislikedObjectIds =
      ctx?.dislikedIds?.size > 0
        ? [...ctx.dislikedIds].slice(0, 500).map((id) => new mongoose.Types.ObjectId(id))
        : [];

    return Article.aggregate(
      [
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: 'embedding_pca',
            queryVector: ctx.embedding,
            numCandidates,
            limit: candidateLimit,
            filter,
          },
        },
        { $addFields: { _atlasSimilarity: { $meta: 'vectorSearchScore' } } },
        ...(dislikedObjectIds.length > 0
          ? [{ $match: { _id: { $nin: dislikedObjectIds } } }]
          : []),
        {
          $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'source',
            pipeline: [
              { $match: { status: { $ne: 'blocked' } } },
              { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
            ],
          },
        },
        { $match: { 'source.0': { $exists: true } } },
        {
          $addFields: {
            sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
            sourceName: { $arrayElemAt: ['$source.name', 0] },
            sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
            sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
          },
        },
        {
          $project: {
            title: 1,
            content: 1,
            contentFormat: 1,
            url: 1,
            category: 1,
            publishedAt: 1,
            image: 1,
            viewCount: 1,
            likes: 1,
            dislikes: 1,
            commentCount: 1,
            likedBy: 1,
            dislikedBy: 1,
            sourceId: 1,
            sourceName: 1,
            sourceIcon: 1,
            sourceGroupName: 1,
            language: 1,
            _atlasSimilarity: 1,
            // For the MMR diversity pass (candidate-to-candidate cosine);
            // _atlasSimilarity only covers candidate-to-user.
            embedding_pca: 1,
          },
        },
      ],
      { maxTimeMS: VECTOR_MAX_TIME_MS, allowDiskUse: false }
    );
  };

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const windows = [24 * HOUR, 48 * HOUR, 7 * DAY, 30 * DAY];

  // Run the expanding-window loop against whichever retrieval fn is chosen,
  // widening the publishedAt window until we have a workable pool.
  const runWindowed = async (queryFn) => {
    let cands = [];
    let used = windows[0];
    for (const sinceMs of windows) {
      cands = await queryFn(sinceMs);
      used = sinceMs;
      if (cands.length >= limit * 2) break;
    }
    return { cands, used };
  };

  // Vector retrieval is opt-in (PERS_LIGHT_VECTOR=1) and only for users with a
  // usable embedding + signal. Guests / no-signal users always use recency.
  const vectorEligible =
    process.env.PERS_LIGHT_VECTOR === '1' && includeEmbedding && !!ctx?.hasSignal;

  const queryStart = Date.now();
  let candidates = [];
  let usedWindowMs = windows[0];
  let retrieval = 'recency';

  if (vectorEligible && (await isVectorSearchReady())) {
    // Union retrieval: run recency and vector candidates in parallel and
    // merge. The old either/or made the pool source pre-decide the feed's
    // character — vector-only starved breaking news the user's embedding
    // didn't predict; recency-only let scraper bursts from irrelevant
    // sources crowd out slightly-older articles the user would actually
    // read. With the union, both compete in one blended scoring pass.
    // Vector failure degrades to plain recency, never to an error.
    const [recencyRes, vectorRes] = await Promise.all([
      runWindowed(runCandidateQuery),
      runWindowed(runVectorCandidateQuery).catch((err) => {
        console.error(
          '⚠️ personalized-light vector retrieval failed, using recency only:',
          err.message
        );
        return null;
      }),
    ]);

    candidates = recencyRes.cands;
    usedWindowMs = recencyRes.used;
    if (vectorRes && vectorRes.cands.length > 0) {
      const byId = new Map();
      for (const a of recencyRes.cands) byId.set(a._id.toString(), a);
      // Vector copy wins on overlap: it carries _atlasSimilarity, which the
      // scorer prefers over recomputing cosine in JS.
      for (const a of vectorRes.cands) byId.set(a._id.toString(), a);
      candidates = [...byId.values()];
      usedWindowMs = Math.max(recencyRes.used, vectorRes.used);
      retrieval = 'hybrid';
    }
  } else {
    const { cands, used } = await runWindowed(runCandidateQuery);
    candidates = cands;
    usedWindowMs = used;
  }

  // Starvation guard: when the disliked-category $nin has gutted the pool
  // (too few articles OR everything from a couple of sources), re-run the
  // widest window WITHOUT the category exclusion and merge. The scorer's
  // dislikedCategoryPenalty (-8) still sinks those articles below every
  // eligible one — the feed degrades gracefully instead of collapsing.
  // Real incident: an account with 19/20 categories banned saw a feed of
  // exactly two sources that dead-ended after ~26 items.
  if (ctx?.dislikedCategories?.size > 0) {
    const groups = new Set(
      candidates.map((a) => a.sourceGroupName || (a.sourceId ? a.sourceId.toString() : 'unknown'))
    );
    if (candidates.length < limit * 2 || groups.size < 4) {
      try {
        const rescue = await runCandidateQuery(windows[windows.length - 1], {
          skipCategoryExclusion: true,
        });
        const byId = new Map();
        for (const a of rescue) byId.set(a._id.toString(), a);
        // Keep the original copies on overlap — they may carry _atlasSimilarity.
        for (const a of candidates) byId.set(a._id.toString(), a);
        candidates = [...byId.values()];
        console.log(
          `🛟 pers-light starvation guard: pool had ${groups.size} source groups, ` +
          `now ${candidates.length} candidates after rescue (user has ` +
          `${ctx.dislikedCategories.size} disliked categories)`
        );
      } catch (err) {
        console.warn('⚠️ starvation guard query failed:', err.message);
      }
    }
  }
  const dbTime = Date.now() - queryStart;

  let scored;
  if (ctx?.hasSignal) {
    scored = scorePersonalizedCandidates(candidates, ctx, { page: 1 });
  } else {
    for (const a of candidates) {
      a._score =
        PERS_W.recency * basicRecencyScore(a.publishedAt) +
        PERS_W.engagement *
          Math.tanh(
            ((a.viewCount || 0) * viewsWeight +
              (a.likes || 0) * likesWeight +
              (a.dislikes || 0) * dislikesWeight) /
              80
          );
      // A user can have disliked categories without hasSignal (dislikes
      // don't count toward it) — the starvation-guard rescue articles
      // must still sink below eligible ones.
      if (a.category && ctx?.dislikedCategories?.has(a.category)) {
        a._score += PERS_W.dislikedCategoryPenalty;
      }
    }
    scored = candidates.sort((x, y) => y._score - x._score);
  }

  // Topical diversity (MMR) on the head of the pool — demotes same-story
  // and same-source-burst redundancy that source interleaving can't see.
  scored = applyMMRDiversity(scored);

  // First-impression page: much tighter than the pages-2+ interleave.
  // The old { minGap: 2, perGroupCap: 8 } let one source legally take 8 of
  // 20 visible slots (positions 0,3,6,...) whenever a scraper cron dumped a
  // batch — recency dominates scoring for brand-new articles, so a burst
  // packs the top of the scored list. Cap scales with limit (3 at the
  // default 20). fill:true keeps sparse pools (low-volume languages) from
  // returning a short page: rejects go to the tail, past the slice cut
  // whenever the pool is rich.
  const perGroupCap = Math.max(2, Math.ceil(limit * 0.15));
  let interleaved = interleaveBySourceGroup(scored, { minGap: 3, perGroupCap, fill: true });

  // P1-5: optional Cohere rerank on the top-N pool. Reorders the top
  // candidates based on semantic similarity to the user's pseudo-query
  // (their last 20 liked titles). Strictly additive — any failure falls
  // back to the local order.
  let rerankApplied = false;
  if (cohereEnabled() && ctx?.hasSignal && ctx?.userId) {
    const topN = interleaved.slice(0, Math.min(COHERE_RERANK_TOP_N, interleaved.length));
    if (topN.length >= 10) {
      const query = await getCohereQueryForUser(ctx.userId, ctx.likedIdsOrdered);
      if (query) {
        const rerankStart = Date.now();
        const reranked = await rerankWithCohere(query, topN);
        if (reranked && reranked.length > 0) {
          interleaved = [...reranked, ...interleaved.slice(topN.length)];
          rerankApplied = true;
          console.log(
            `🎯 Cohere rerank applied to ${topN.length} candidates in ${Date.now() - rerankStart}ms`
          );
        }
      }
    }
  }

  const diversified = interleaved.slice(0, limit);

  // P1-4: maybe inject a random low-similarity exploration article into a
  // mid-page slot. Fires probabilistically (~12% of requests) for users
  // with signal — breaks filter bubbles without dominating the feed.
  const explorationInjected = maybeInjectExploration(diversified, interleaved, ctx);

  const articles = sanitizeForResponse(diversified, {
    isLight: true,
    fetchedAt: new Date(),
    isRefreshed: forceRefresh,
    isPersonalized: !!ctx?.hasSignal,
  });

  return {
    articles,
    usedWindowMs,
    candidateCount: candidates.length,
    dbTime,
    includeEmbedding,
    explorationInjected,
    rerankApplied,
    retrieval,
  };
}

/**
 * Two-tier cache + stale-while-revalidate for personalized-light.
 *
 * The fresh key carries stateHash + 10-min slot — it auto-rotates on
 * activity. The stale key has neither — it's a "latest known result" that
 * survives slot rotations and user actions. When the fresh key misses but
 * stale is warm, we return stale instantly and regenerate in the
 * background. A NX-lock prevents two simultaneous misses from both
 * regenerating.
 */
const SWR_STALE_TTL = 60 * 60; // 1h - stale tier survives across slots/actions
const SWR_FRESH_TTL = 600;     // 10min - fresh tier (current behaviour)
const SWR_LOCK_TTL = 30;       // 30s - max compute time

function lightStaleKey(userId, language, limit) {
  return `articles_pers_v2_stale_${userId}_${language}_${limit}`;
}

function lightLockKey(userId, language, limit) {
  return `articles_pers_v2_lock_${userId}_${language}_${limit}`;
}

/**
 * Acquire a distributed lock; returns true if we got it.
 * Spawn a background regeneration that writes to fresh + stale keys.
 */
function spawnBackgroundRegen({ freshKey, staleKey, lockKey, userId, params }) {
  setImmediate(async () => {
    const lockStart = Date.now();
    try {
      const acquired = await redis.set(lockKey, '1', 'EX', SWR_LOCK_TTL, 'NX');
      if (acquired !== 'OK') {
        // Another instance is already regenerating; nothing to do.
        return;
      }
      try {
        const { articles } = await computePersonalizedLight(params);
        await redis.set(freshKey, JSON.stringify(articles), 'EX', SWR_FRESH_TTL);
        await trackUserCacheKey(userId, freshKey);
        await redis.set(staleKey, JSON.stringify(articles), 'EX', SWR_STALE_TTL);
        await trackUserCacheKey(userId, staleKey);
        console.log(
          `♻️  pers-v2 light SWR regen done for ${userId} in ${Date.now() - lockStart}ms`
        );
      } finally {
        await redis.del(lockKey);
      }
    } catch (err) {
      // Non-fatal: stale already served, regen failure just means next
      // request also misses fresh. Log and move on.
      console.warn(`⚠️ SWR background regen failed for ${userId}:`, err.message);
    }
  });
}

/**
 * OPTIMIZED COUNT CACHING
 * Pre-warm common article counts in background to avoid expensive countDocuments() calls
 */
const COMMON_LANGUAGES = ['english', 'arabic'];
const COUNT_CACHE_TTL = 900; // 15 minutes

async function warmArticleCountCache() {
  console.log('🔥 Warming article count cache...');
  try {
    for (const lang of COMMON_LANGUAGES) {
      const filter = { language: lang };
      const filterKey = JSON.stringify(filter);
      const countCacheKey = `articles_count_${simpleHash(filterKey)}`;

      // Check if cache exists and is recent
      const existingCache = await redis.get(countCacheKey);
      if (!existingCache) {
        const count = await Article.countDocuments(filter);
        await redis.set(countCacheKey, count.toString(), 'EX', COUNT_CACHE_TTL);
        console.log(`📊 Cached count for ${lang}: ${count}`);
      }
    }
    console.log('✅ Article count cache warmed');
  } catch (error) {
    console.error('⚠️ Error warming count cache:', error.message);
  }
}

/**
 * P2-3: pre-warmed "recent articles" cache. The frontend uses this as
 * a fast fallback when personalized takes too long (cold Cloud Run,
 * stale-tier miss). One Mongo query per language every 5 minutes;
 * served from Redis in <5ms.
 */
const RECENT_CACHE_TTL = 300; // 5 min
const RECENT_LIMIT = 30;
// Fetch a wider pool than we serve so interleaveBySourceGroup has material
// to diversify with. A scraper cron that just dumped 25 articles from one
// source would otherwise fill the entire recent list with that source,
// back-to-back — and /recent is what the app's soft-race serves as page 1
// on cold starts, so it must not cluster.
const RECENT_CANDIDATES = 90;
const RECENT_INTERLEAVE_OPTS = { minGap: 3, perGroupCap: 3, fill: true };

function recentCacheKey(language) {
  return `articles_recent_v1_${language}`;
}

async function warmRecentArticlesCache() {
  try {
    for (const lang of COMMON_LANGUAGES) {
      const recent = await Article.aggregate([
        {
          $match: {
            language: lang,
            publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
        { $sort: { publishedAt: -1 } },
        { $limit: RECENT_CANDIDATES },
        {
          $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'source',
            pipeline: [
              { $match: { status: { $ne: 'blocked' } } },
              { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
            ],
          },
        },
        { $match: { 'source.0': { $exists: true } } },
        {
          $addFields: {
            sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
            sourceName: { $arrayElemAt: ['$source.name', 0] },
            sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
            sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
          },
        },
        {
          $project: {
            title: 1,
            content: 1,
            contentFormat: 1,
            url: 1,
            category: 1,
            publishedAt: 1,
            image: 1,
            viewCount: 1,
            likes: 1,
            dislikes: 1,
            commentCount: 1,
            sourceId: 1,
            sourceName: 1,
            sourceIcon: 1,
            sourceGroupName: 1,
            language: 1,
          },
        },
      ]);
      // Diversify at warm time — the request path stays a pure Redis read.
      const diversified = interleaveBySourceGroup(recent, RECENT_INTERLEAVE_OPTS)
        .slice(0, RECENT_LIMIT);
      await redis.set(recentCacheKey(lang), JSON.stringify(diversified), 'EX', RECENT_CACHE_TTL);
    }
    // Don't log on every refresh — too chatty.
  } catch (err) {
    console.error('⚠️ warmRecentArticlesCache failed:', err.message);
  }
}

// Warm cache on startup (after 30 seconds to let DB connect)
setTimeout(warmArticleCountCache, 30000);
setTimeout(warmRecentArticlesCache, 30000);

// Refresh cache every 15 minutes
setInterval(warmArticleCountCache, COUNT_CACHE_TTL * 1000);
// Refresh recent cache slightly before TTL so reads never miss
setInterval(warmRecentArticlesCache, (RECENT_CACHE_TTL - 30) * 1000);

// Import Source model for following feed
const Source = require('../models/Source');

/** ---- Routes ---- **/

/**
 * GET /api/articles/recent (P2-3)
 *
 * Pre-warmed list of recent articles in the requested language. Served
 * entirely from Redis (<5ms). Used by the frontend as an optimistic
 * fallback when the personalized fetch takes too long — paint
 * something usable in under a second, swap to personalized when it
 * arrives.
 *
 * Public, no JWT required. Safe to call from cold-start guest
 * sessions.
 */
articleRouter.get('/recent', async (req, res) => {
  try {
    const language = (req.query.language || 'english').toLowerCase();
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), RECENT_LIMIT);

    try {
      const cached = await redis.get(recentCacheKey(language));
      if (cached) {
        const articles = JSON.parse(cached).slice(0, limit);
        res.setHeader('X-Cache', 'hit');
        return res.json(articles);
      }
    } catch (err) {
      // Fall through to direct query
    }

    // Cache miss (cold boot before warmer ran, or unsupported language).
    // Compute inline once; the interval will keep it warm afterward.
    const recent = await Article.aggregate([
      {
        $match: {
          language,
          publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      },
      { $sort: { publishedAt: -1 } },
      { $limit: RECENT_CANDIDATES },
      {
        $lookup: {
          from: 'sources',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'source',
          pipeline: [
            { $match: { status: { $ne: 'blocked' } } },
            { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
          ],
        },
      },
      { $match: { 'source.0': { $exists: true } } },
      {
        $addFields: {
          sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
          sourceName: { $arrayElemAt: ['$source.name', 0] },
          sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
          sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
        },
      },
      {
        $project: {
          title: 1,
          content: 1,
          contentFormat: 1,
          url: 1,
          category: 1,
          publishedAt: 1,
          image: 1,
          viewCount: 1,
          likes: 1,
          dislikes: 1,
          commentCount: 1,
          sourceId: 1,
          sourceName: 1,
          sourceIcon: 1,
          sourceGroupName: 1,
          language: 1,
        },
      },
    ]);
    // Same warm-time diversification as warmRecentArticlesCache — cache the
    // full diversified list, serve the requested slice.
    const diversified = interleaveBySourceGroup(recent, RECENT_INTERLEAVE_OPTS)
      .slice(0, RECENT_LIMIT);
    try {
      await redis.set(recentCacheKey(language), JSON.stringify(diversified), 'EX', RECENT_CACHE_TTL);
    } catch (err) {
      // Non-fatal
    }
    res.setHeader('X-Cache', 'miss');
    return res.json(diversified.slice(0, limit));
  } catch (error) {
    console.error('❌ /articles/recent error:', error);
    return res.status(500).json({ error: 'recent error', message: error.message });
  }
});


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
//         .select('title content url category publishedAt image sourceId viewCount likes dislikes commentCount')
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
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    const userId = req.mongoUser.supabase_id;
    const forceRefresh = req.query.noCache === 'true';
    const userLanguagePref = req.mongoUser.language || 'English';
    const language = (req.query.language || userLanguagePref).toLowerCase();

    const ctx = await loadUserPersonalizationContext(userId);
    if (ctx) {
      ctx.language = language;
      ctx.categoryStats = await getCategoryEngagementStats(language);
      ctx.servedIds = await getServedIds(userId);
    }

    // Fresh tier: rotates on user activity (stateHash) and every 10 min.
    // Stale tier: same content, but no stateHash/slot — survives across
    // rotations so we can serve last-known-result on cold miss and
    // regenerate in the background.
    const stateHash = userStateHash(ctx);
    const tenMinSlot = Math.floor(Date.now() / (10 * 60 * 1000));
    const freshKey = `articles_pers_v2_${userId}_${language}_${limit}_${stateHash}_${tenMinSlot}`;
    const staleKey = lightStaleKey(userId, language, limit);
    const lockKey = lightLockKey(userId, language, limit);

    if (!forceRefresh) {
      try {
        const cached = await redis.get(freshKey);
        if (cached) {
          console.log(`⚡ pers-v2 light fresh cache hit in ${Date.now() - startTime}ms`);
          const parsed = JSON.parse(cached);
          res.setHeader('X-Cache', 'fresh');
          // Fire-and-forget: record served IDs so the next page excludes
          // them (P0-2 follow-up). Won't block the response.
          recordServedIds(userId, parsed).catch(() => {});
          return res.json(parsed);
        }
      } catch (err) {
        console.error('⚠️ Redis get error (fresh):', err.message);
      }

      // SWR: serve last-known-result instantly, regenerate in background.
      try {
        const stale = await redis.get(staleKey);
        if (stale) {
          spawnBackgroundRegen({
            freshKey,
            staleKey,
            lockKey,
            userId,
            params: { ctx, language, limit, forceRefresh: false },
          });
          console.log(
            `📦 pers-v2 light SWR stale-hit in ${Date.now() - startTime}ms ` +
            `(regen scheduled)`
          );
          const parsed = JSON.parse(stale);
          res.setHeader('X-Cache', 'stale');
          recordServedIds(userId, parsed).catch(() => {});
          return res.json(parsed);
        }
      } catch (err) {
        console.error('⚠️ Redis get error (stale):', err.message);
      }
    }

    // Cold miss (or forceRefresh): synchronous compute.
    const {
      articles: finalArticles,
      usedWindowMs,
      candidateCount,
      dbTime,
      includeEmbedding,
      explorationInjected,
      rerankApplied,
      retrieval,
    } = await computePersonalizedLight({ ctx, language, limit, forceRefresh });

    try {
      await redis.set(freshKey, JSON.stringify(finalArticles), 'EX', SWR_FRESH_TTL);
      await trackUserCacheKey(userId, freshKey);
      await redis.set(staleKey, JSON.stringify(finalArticles), 'EX', SWR_STALE_TTL);
      await trackUserCacheKey(userId, staleKey);
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    const totalTime = Date.now() - startTime;
    const usedWindowHours = Math.round(usedWindowMs / (60 * 60 * 1000));
    console.log(
      `🚀 pers-v2 light: ${finalArticles.length} articles in ${totalTime}ms ` +
      `(db ${dbTime}ms, candidates ${candidateCount}, window ${usedWindowHours}h, ` +
      `lang=${language}, signal=${!!ctx?.hasSignal}, embed=${includeEmbedding}, ` +
      `explore=${explorationInjected ? 'yes' : 'no'}, ` +
      `rerank=${rerankApplied ? 'yes' : 'no'}, retrieval=${retrieval})`
    );

    res.setHeader('X-Cache', 'miss');
    res.setHeader('X-Performance-Time', totalTime);
    res.setHeader('X-DB-Query-Time', dbTime);
    res.setHeader('X-Personalized', ctx?.hasSignal ? (includeEmbedding ? 'vector' : 'signal') : 'none');
    res.setHeader('X-Candidates', candidateCount);
    res.setHeader('X-Window-Hours', usedWindowHours);
    res.setHeader('X-Explore', explorationInjected ? '1' : '0');
    res.setHeader('X-Rerank', rerankApplied ? '1' : '0');
    res.setHeader('X-Retrieval', retrieval);
    res.setHeader('X-Treatment', ctx?.treatment || 'control');
    res.setHeader('X-Experiment', EXPERIMENT_ID);

    // P0-2 follow-up: record served IDs so pages 2+ exclude them.
    // Fire-and-forget — won't block the response.
    recordServedIds(userId, finalArticles).catch(() => {});

    res.json(finalArticles);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ pers-v2 light error in ${errorTime}ms:`, error);

    // Fallback to basic recency query so users still see content.
    // Widen progressively for low-volume languages (e.g. Farsi).
    try {
      const language = (req.query.language || 'english').toLowerCase();
      const HOUR = 60 * 60 * 1000;
      const DAY = 24 * HOUR;
      const windows = [24 * HOUR, 7 * DAY, 30 * DAY];
      let fallbackArticles = [];
      for (const sinceMs of windows) {
        fallbackArticles = await Article.find({
          language,
          publishedAt: { $gte: new Date(Date.now() - sinceMs) },
        })
          .select(
            'title content contentFormat url category publishedAt image sourceId viewCount likes dislikes commentCount language'
          )
          .sort({ publishedAt: -1 })
          .limit(limit * 3)
          .lean();
        if (fallbackArticles.length >= Math.min(limit, 5)) break;
      }
      // Recency sort clusters scraper bursts back-to-back; interleave by
      // source (sourceId fallback — no group lookup on this path) before
      // slicing down to the requested page size.
      fallbackArticles = interleaveBySourceGroup(fallbackArticles, {
        minGap: 3,
        perGroupCap: 3,
        fill: true,
      }).slice(0, limit);
      return res.json(fallbackArticles);
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      return res
        .status(500)
        .json({ error: 'personalized-light error', message: error.message });
    }
  }
});

/**
 * GET: Following feed - Articles from sources the user follows
 * Returns articles only from sourceGroups that the user has followed
 */
articleRouter.get('/following', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();

  try {
    const userId = req.mongoUser.supabase_id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
    const forceRefresh = req.query.noCache === 'true';

    // Use user's language preference from database if not specified in query
    const userLanguagePref = req.mongoUser.language || 'English';
    const defaultLang = userLanguagePref.toLowerCase();
    const language = req.query.language || defaultLang;

    console.log(`📰 Following feed for user ${userId}, page ${page}, limit ${limit}, lang: ${language}`);

    // Step 1: Get user's followed source groups
    const user = await User.findOne({ supabase_id: userId })
      .select('following_sources')
      .lean();

    const followedGroups = user?.following_sources || [];

    if (followedGroups.length === 0) {
      console.log(`📭 User ${userId} is not following any sources`);
      return res.json({
        articles: [],
        page,
        hasMore: false,
        message: 'Not following any sources yet',
        followedGroupsCount: 0
      });
    }

    console.log(`🔍 User following ${followedGroups.length} source groups:`, followedGroups);

    // Step 2: Find all Source _ids that belong to followed groups
    const Source = require('../models/Source');
    const followedSources = await Source.find({
      groupName: { $in: followedGroups },
      status: { $ne: 'blocked' }
    }).select('_id groupName').lean();

    const followedSourceIds = followedSources.map(s => s._id);

    if (followedSourceIds.length === 0) {
      console.log(`📭 No active sources found for followed groups`);
      return res.json({
        articles: [],
        page,
        hasMore: false,
        message: 'No active sources in followed groups',
        followedGroupsCount: followedGroups.length
      });
    }

    console.log(`🔍 Found ${followedSourceIds.length} source IDs for followed groups`);

    // Step 3: Check cache (v2 key bump — old `articles_following_*` entries
    // may have a 24h-only window and would serve stale empty results)
    const cacheKey = `articles_following_v2_${userId}_${language}_${page}_${limit}_${Math.floor(Date.now() / (15 * 60 * 1000))}`;

    let cached;
    if (!forceRefresh) {
      try {
        cached = await redis.get(cacheKey);
        if (cached) {
          const result = JSON.parse(cached);
          console.log(`⚡ Following feed cache hit in ${Date.now() - startTime}ms`);
          return res.json(result);
        }
      } catch (err) {
        console.error('⚠️ Redis get error:', err.message);
      }
    }

    // Step 4: Query articles from followed sources with progressive window
    // widening. Dense followers (mainstream English sources) succeed at 24h;
    // sparse followers (a couple of Farsi/niche sources) widen to 7d / 30d
    // so the feed isn't empty. Each widening pass is cheap because the
    // $match is narrowly scoped by followedSourceIds.
    const queryStart = Date.now();
    const skip = (page - 1) * limit;
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const windows = [
      { ms: 24 * HOUR, label: '24h' },
      { ms: 72 * HOUR, label: '3d' },
      { ms: 7 * DAY, label: '7d' },
      { ms: 30 * DAY, label: '30d' },
    ];

    const runFollowingQuery = (sinceMs) => Article.aggregate([
      {
        $match: {
          sourceId: { $in: followedSourceIds },
          language: language,
          publishedAt: { $gte: new Date(Date.now() - sinceMs) }
        }
      },
      {
        $sort: { publishedAt: -1 }
      },
      {
        $skip: skip
      },
      {
        $limit: limit + 1 // Get one extra to check if there are more
      },
      {
        $project: {
          title: 1,
          content: 1,
          contentFormat: 1,
          url: 1,
          category: 1,
          publishedAt: 1,
          image: 1,
          viewCount: 1,
          likes: 1,
          dislikes: 1,
          commentCount: 1,
          likedBy: 1,
          dislikedBy: 1,
          sourceId: 1,
          language: 1 // needed for RTL rendering on Arabic/Farsi
        }
      }
    ]);

    let articles = [];
    let usedWindow = windows[0];
    for (const w of windows) {
      articles = await runFollowingQuery(w.ms);
      usedWindow = w;
      // Got a full page? stop — wider windows would just re-fetch the same
      // most-recent articles followed by older ones the user doesn't need.
      if (articles.length >= limit + 1) break;
      // Deep pagination edge case: if we're past page 1 and even 7d returns
      // nothing, there genuinely isn't more — don't waste a 30d query.
      if (page > 1 && articles.length === 0 && w.ms >= 7 * DAY) break;
    }
    const usedWindowMs = usedWindow.ms;

    const usedWindowHours = Math.round(usedWindowMs / HOUR);
    console.log(`⚡ Following feed DB query completed in ${Date.now() - queryStart}ms - found ${articles.length} articles (window ${usedWindowHours}h, lang=${language})`);

    // Check if there are more articles
    const hasMore = articles.length > limit;
    const articlesForResponse = hasMore ? articles.slice(0, limit) : articles;

    // Step 5: Enrich with source info
    const enrichedArticles = await enrichArticlesWithSources(articlesForResponse);

    // Add following feed marker
    const finalArticles = enrichedArticles.map(article => ({
      ...article,
      isFollowing: true,
      fetchedAt: new Date(),
      page
    }));

    const result = {
      articles: finalArticles,
      page,
      hasMore,
      followedGroupsCount: followedGroups.length,
      followedSourcesCount: followedSourceIds.length
    };

    // Step 6: Cache the result
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 300); // 5 min cache for following feed
      await trackUserCacheKey(userId, cacheKey);
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    const totalTime = Date.now() - startTime;
    console.log(`📰 Following feed complete in ${totalTime}ms - ${finalArticles.length} articles from ${followedGroups.length} groups`);

    // Add performance headers
    res.setHeader('X-Performance-Time', totalTime);
    res.setHeader('X-DB-Query-Time', Date.now() - queryStart);
    res.setHeader('X-Following-Groups', followedGroups.length);
    res.setHeader('X-Following-Sources', followedSourceIds.length);
    res.setHeader('X-Window-Hours', usedWindowHours);

    res.json(result);

  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ Following feed error in ${errorTime}ms:`, error);
    res.status(500).json({ error: 'Following feed error', message: error.message });
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
//         .select('title content url category publishedAt image sourceId viewCount likes dislikes commentCount')
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
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);

  try {
    const userId = req.mongoUser.supabase_id;
    const forceRefresh = req.query.noCache === 'true';
    const userLanguagePref = req.mongoUser.language || 'English';
    const language = (req.query.language || userLanguagePref).toLowerCase();

    const ctx = await loadUserPersonalizationContext(userId);
    if (ctx) {
      ctx.language = language;
      ctx.categoryStats = await getCategoryEngagementStats(language);
      ctx.servedIds = await getServedIds(userId);
    }

    const stateHash = userStateHash(ctx);
    const tenMinSlot = Math.floor(Date.now() / (10 * 60 * 1000));
    const cacheKey = `articles_pers_v2_page_${userId}_${language}_${page}_${limit}_${stateHash}_${tenMinSlot}`;

    if (!forceRefresh) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          console.log(`⚡ pers-v2 fast cache hit in ${Date.now() - startTime}ms (page ${page})`);
          const parsed = JSON.parse(cached);
          recordServedIds(userId, parsed).catch(() => {});
          return res.json(parsed);
        }
      } catch (err) {
        console.error('⚠️ Redis get error:', err.message);
      }
    }

    // Build candidate filter: hard-exclude explicit dislikes + the
    // recently-served set (P0-2 follow-up). Viewed articles are still
    // only demoted in scoring, not excluded, so the feed doesn't
    // collapse for users with long view histories.
    const buildMatch = (sinceMs, { skipCategoryExclusion = false } = {}) => {
      const match = {
        language,
        publishedAt: { $gte: new Date(Date.now() - sinceMs) },
      };
      if (ctx) {
        const excluded = [];
        if (ctx.dislikedIds.size > 0) {
          excluded.push(...[...ctx.dislikedIds].slice(0, 500));
        }
        if (ctx.servedIds?.size > 0) {
          excluded.push(...[...ctx.servedIds].slice(0, SERVED_MAX_EXCLUDE));
        }
        if (excluded.length > 0) {
          match._id = {
            $nin: excluded.map((id) => new mongoose.Types.ObjectId(id)),
          };
        }
        if (!skipCategoryExclusion && ctx.dislikedCategories.size > 0) {
          match.category = { $nin: [...ctx.dislikedCategories] };
        }
      }
      return match;
    };

    // For pagination we need a wide enough candidate window to safely skip into.
    // Cap so deep pagination doesn't blow up memory.
    const candidateLimit = Math.min(page * limit + 200, 500);
    const includeEmbedding = !!ctx?.embedding && !shouldSkipEmbedding(ctx);

    const runCandidateQuery = (sinceMs, opts) =>
      Article.aggregate([
        { $match: buildMatch(sinceMs, opts) },
        { $sort: { publishedAt: -1 } },
        { $limit: candidateLimit },
        {
          $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'source',
            pipeline: [
              { $match: { status: { $ne: 'blocked' } } },
              { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
            ],
          },
        },
        { $match: { 'source.0': { $exists: true } } },
        {
          $addFields: {
            sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
            sourceName: { $arrayElemAt: ['$source.name', 0] },
            sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
            sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
          },
        },
        {
          $project: {
            title: 1,
            content: 1,
            contentFormat: 1,
            url: 1,
            category: 1,
            publishedAt: 1,
            image: 1,
            viewCount: 1,
            likes: 1,
            dislikes: 1,
            commentCount: 1,
            likedBy: 1,
            dislikedBy: 1,
            sourceId: 1,
            sourceName: 1,
            sourceIcon: 1,
            sourceGroupName: 1,
            language: 1,
            ...(includeEmbedding ? { embedding_pca: 1 } : {}),
          },
        },
      ]);

    const queryStart = Date.now();
    // Progressively widen until we have enough candidates to fill the requested page.
    // Sparse languages (e.g. Farsi) can have very few articles in 72h.
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const startWindow = page === 1 ? 24 * HOUR : 48 * HOUR;
    const windows = [startWindow, 72 * HOUR, 7 * DAY, 30 * DAY];
    const minCandidates = limit + (page - 1) * limit;
    let candidates = [];
    let usedWindowMs = windows[0];
    for (const sinceMs of windows) {
      candidates = await runCandidateQuery(sinceMs);
      usedWindowMs = sinceMs;
      if (candidates.length >= minCandidates) break;
    }

    // Starvation guard — same rationale as personalized-light: if the
    // disliked-category exclusion leaves a tiny or single-source pool,
    // pull unfiltered candidates from the widest window and let the
    // scoring penalty sink them instead of dead-ending pagination.
    if (ctx?.dislikedCategories?.size > 0) {
      const groups = new Set(
        candidates.map((a) => a.sourceGroupName || (a.sourceId ? a.sourceId.toString() : 'unknown'))
      );
      if (candidates.length < limit * 2 || groups.size < 4) {
        try {
          const rescue = await runCandidateQuery(windows[windows.length - 1], {
            skipCategoryExclusion: true,
          });
          const byId = new Map();
          for (const a of rescue) byId.set(a._id.toString(), a);
          for (const a of candidates) byId.set(a._id.toString(), a);
          candidates = [...byId.values()];
          console.log(
            `🛟 pers-fast starvation guard: page ${page}, pool had ${groups.size} ` +
            `source groups, now ${candidates.length} candidates after rescue`
          );
        } catch (err) {
          console.warn('⚠️ pers-fast starvation guard failed:', err.message);
        }
      }
    }
    const dbTime = Date.now() - queryStart;

    let scored;
    if (ctx?.hasSignal) {
      scored = scorePersonalizedCandidates(candidates, ctx, { page });
    } else {
      for (const a of candidates) {
        a._score =
          PERS_W.recency * basicRecencyScore(a.publishedAt) +
          PERS_W.engagement *
            Math.tanh(
              ((a.viewCount || 0) * viewsWeight +
                (a.likes || 0) * likesWeight +
                (a.dislikes || 0) * dislikesWeight) /
                80
            );
        // Disliked categories can exist without hasSignal (dislikes don't
        // count toward it); starvation-guard rescue articles must still
        // sink below eligible ones.
        if (a.category && ctx?.dislikedCategories?.has(a.category)) {
          a._score += PERS_W.dislikedCategoryPenalty;
        }
      }
      scored = candidates.sort((x, y) => y._score - x._score);
    }

    // P0-2 follow-up: candidates already EXCLUDE everything in the
    // user's served set (last 6h). So every personalized-fast call
    // returns slice(0, limit) of the fresh pool — there is no
    // page-based offset anymore. The `page` query param still steers
    // scoring biases (page-aware recency/relevance multipliers and the
    // starting time window) and the cache key, but the slice itself is
    // always from the top of the fresh pool.
    //
    // This is what makes deep pagination work for active scrollers:
    // every page is "give me 20 more I haven't seen", not "give me
    // items 60-80 of a fixed list that may have only 25 entries".
    const interleaved = interleaveBySourceGroup(scored, { minGap: 2, perGroupCap: 8 });
    const pageSlice = interleaved.slice(0, limit);

    const finalArticles = sanitizeForResponse(pageSlice, {
      isFast: true,
      fetchedAt: new Date(),
      isRefreshed: forceRefresh,
      page,
      isPersonalized: !!ctx?.hasSignal,
    });

    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 600);
      await trackUserCacheKey(userId, cacheKey);
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    const totalTime = Date.now() - startTime;
    const usedWindowHours = Math.round(usedWindowMs / (60 * 60 * 1000));
    console.log(
      `🚀 pers-v2 fast: page ${page}, ${finalArticles.length} articles in ${totalTime}ms (db ${dbTime}ms, candidates ${candidates.length}, window ${usedWindowHours}h, lang=${language}, signal=${!!ctx?.hasSignal}, embed=${includeEmbedding})`
    );

    res.setHeader('X-Performance-Time', totalTime);
    res.setHeader('X-DB-Query-Time', dbTime);
    res.setHeader('X-Page', page);
    res.setHeader('X-Personalized', ctx?.hasSignal ? (includeEmbedding ? 'vector' : 'signal') : 'none');
    res.setHeader('X-Candidates', candidates.length);
    res.setHeader('X-Window-Hours', usedWindowHours);

    recordServedIds(userId, finalArticles).catch(() => {});
    res.json(finalArticles);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ pers-v2 fast error in ${errorTime}ms (page ${page}):`, error);

    try {
      const language = (req.query.language || 'english').toLowerCase();
      const skip = (page - 1) * limit;
      const HOUR = 60 * 60 * 1000;
      const DAY = 24 * HOUR;
      const windows = [24 * HOUR, 72 * HOUR, 7 * DAY, 30 * DAY];
      const minNeeded = skip + Math.min(limit, 5);
      let fallbackArticles = [];
      for (const sinceMs of windows) {
        fallbackArticles = await Article.find({
          language,
          publishedAt: { $gte: new Date(Date.now() - sinceMs) },
        })
          .select(
            'title content contentFormat url category publishedAt image sourceId viewCount likes dislikes commentCount language'
          )
          .sort({ publishedAt: -1 })
          .skip(skip)
          .limit(limit * 3)
          .lean();
        if (fallbackArticles.length >= Math.min(limit, 5) || skip + fallbackArticles.length >= minNeeded) break;
      }
      // Same anti-clustering pass as the personalized-light fallback.
      fallbackArticles = interleaveBySourceGroup(fallbackArticles, {
        minGap: 3,
        perGroupCap: 3,
        fill: true,
      }).slice(0, limit);
      return res.json(fallbackArticles);
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      return res
        .status(500)
        .json({ error: 'personalized-fast error', message: error.message });
    }
  }
});


// Performance configuration constants
const VECTOR_INDEX = "default";
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

  // Hard off-switch — use during migrations/outages when Atlas Search is down.
  // Avoids the listSearchIndexes() call entirely (it can hang ~9s when the Search
  // Index Management service is unreachable).
  if (process.env.DISABLE_VECTOR_SEARCH === 'true') {
    _vectorProbe = { ok: false, checkedAt: now, dims: null };
    return false;
  }

  if (now - _vectorProbe.checkedAt < VECTOR_PROBE_TTL_MS) {
    return _vectorProbe.ok;
  }

  try {
    // Bound the admin call: when Atlas Search is unhealthy, listSearchIndexes() can
    // hang ~9s before erroring. Fail fast so a cold instance's first request isn't 9s.
    const indexes = await Promise.race([
      Article.collection.listSearchIndexes({ name: VECTOR_INDEX }).toArray(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('listSearchIndexes timeout')), 2000)),
    ]);
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
    // A probe that times out or can't reach the search service means vector search is
    // NOT usable right now — treat it as unavailable so we fall back fast instead of
    // attempting the (also-timing-out) full vector search. Previously timeouts were
    // treated as "non-critical" and let the request proceed into multi-second hangs.
    const msg = error.message || '';
    const unusable = /index|cluster|time limit|MaxTimeMSExpired|timed out|timeout|Search Index/i.test(msg);
    if (unusable) {
      await redis.set('vector_search_status', 'unavailable', 'EX', 300); // Cache failure
      return { ok: false };
    }
    return { ok: true }; // Truly non-critical errors don't disable vector search
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
    const resetServed = req.query.resetServed === '1';

    // Use user's language preference from database if not specified in query
    // Map 'Arabic' -> 'arabic', 'English' -> 'english' for consistency
    const userLanguagePref = req.mongoUser.language || 'English';
    const defaultLang = userLanguagePref.toLowerCase(); // 'Arabic' -> 'arabic', 'English' -> 'english'
    const language = req.query.language || defaultLang;

    console.log(`🔥 PERSONALIZED ENDPOINT START for user ${userId}, page ${page}, limit ${limit}, lang: ${language} (user pref: ${userLanguagePref})`);

    // Enhanced cache key with user preferences
    // Page 1 uses an hour-key so it refreshes every hour rather than being stale all day
    const userPrefs = await User.findOne({ supabase_id: userId }).select('preferred_categories preferred_sources').lean();
    const prefsHash = simpleHash(JSON.stringify({
      cats: userPrefs?.preferred_categories || [],
      srcs: userPrefs?.preferred_sources || []
    }));
    const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const hourKey = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, ''); // e.g. 2026022614
    const noveltySeed = simpleHash(`${userId}:${page}:${dayKey}`);
    const cacheKey = page === 1
      ? `articles_personalized_${userId}_p1_${language}_${prefsHash}_${hourKey}`
      : `articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}_${prefsHash}_${dayKey}_${noveltySeed}`;

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
    const user = await User.findOne({ supabase_id: userId })
      .select('embedding_pca preferred_categories preferred_sources disliked_articles viewed_articles liked_articles disliked_categories')
      .lean();

    // Exclude: served today + explicitly disliked + recently viewed (last 200 to cap payload)
    const recentlyViewedIds = (user?.viewed_articles || []).slice(-200).map(id => new mongoose.Types.ObjectId(id));
    const excludeIds = [
      ...servedIds.map(id => new mongoose.Types.ObjectId(id)),
      ...(user?.disliked_articles || []).map(id => new mongoose.Types.ObjectId(id)),
      ...recentlyViewedIds,
    ];

    // User embedding and preferences
    let userEmbedding = user?.embedding_pca;
    const preferredCategories = user?.preferred_categories || [];
    const preferredSources = user?.preferred_sources || [];
    const dislikedCategories = user?.disliked_categories || [];
    mark('user_load');

    // --- Recency centroid blend ---
    // Blend the stored lifetime embedding with a centroid of the user's most recently liked
    // articles so that interest drift is corrected without waiting for a full embedding rebuild.
    if (userEmbedding && Array.isArray(userEmbedding) && userEmbedding.length === 128) {
      try {
        const recentLikedIds = (user?.liked_articles || []).slice(-15);
        if (recentLikedIds.length >= 3) {
          const recentLikedArticles = await Article.find(
            { _id: { $in: recentLikedIds } },
            { embedding_pca: 1 }
          ).lean();

          const validEmbeddings = recentLikedArticles
            .filter(a => Array.isArray(a.embedding_pca) && a.embedding_pca.length === 128)
            .map(a => a.embedding_pca);

          if (validEmbeddings.length >= 3) {
            // Compute centroid of recent liked articles
            const recentCentroid = new Array(128).fill(0);
            validEmbeddings.forEach(emb => {
              emb.forEach((v, i) => { recentCentroid[i] += v / validEmbeddings.length; });
            });

            // Blend: 65% lifetime embedding + 35% recent centroid
            const blended = userEmbedding.map((v, i) => 0.65 * v + 0.35 * recentCentroid[i]);

            // Normalise to unit vector so cosine similarity stays valid
            const mag = Math.sqrt(blended.reduce((s, v) => s + v * v, 0));
            if (mag > 0) {
              userEmbedding = blended.map(v => v / mag);
              console.log(`🧠 Recency centroid blended from ${validEmbeddings.length} recent likes`);
            }
          }
        }
      } catch (blendErr) {
        console.warn('⚠️ Recency centroid blend failed (non-fatal):', blendErr.message);
        // Fall through with original embedding
      }
    }
    mark('recency_blend');

    // --- Read-time category boost weights ---
    // Build dynamic per-category preference boosts from UserActivity read_time events.
    // Users who spend more total time reading a category get a proportionally higher boost,
    // replacing the flat +0.15 with a signal-proportional value.
    const categoryTimeBoosts = {};
    try {
      const readTimeStats = await UserActivity.aggregate([
        {
          $match: {
            userId,
            eventType: 'read_time',
            duration: { $gt: 60 }, // only meaningful reads (> 1 min)
            timestamp: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }, // last 90 days
          }
        },
        {
          $lookup: {
            from: 'articles',
            localField: 'articleId',
            foreignField: '_id',
            as: 'article',
            pipeline: [{ $project: { category: 1 } }]
          }
        },
        { $unwind: { path: '$article', preserveNullAndEmpty: false } },
        {
          $group: {
            _id: '$article.category',
            totalTime: { $sum: '$duration' },
            count: { $sum: 1 }
          }
        },
        { $sort: { totalTime: -1 } },
        { $limit: 8 }
      ]);

      if (readTimeStats.length > 0) {
        const maxTime = readTimeStats[0].totalTime || 1;
        readTimeStats.forEach(stat => {
          if (stat._id) {
            // Scale so the top category gets +0.25 boost, others proportionally less
            categoryTimeBoosts[stat._id] = (stat.totalTime / maxTime) * 0.25;
          }
        });
        console.log(`📚 Read-time boosts computed for ${readTimeStats.length} categories`);
      }
    } catch (rtErr) {
      console.warn('⚠️ Read-time boost computation failed (non-fatal):', rtErr.message);
    }
    mark('readtime_boost');

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
      if (dislikedCategories.length > 0) {
        fallbackMatch.category = { $nin: dislikedCategories };
      }
      if (preferredCategories.length > 0) {
        fallbackMatch.category = { $in: preferredCategories.slice(0, 5) };
      }
      if (preferredSources.length > 0) {
        fallbackMatch.sourceId = { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) };
      }

      const fallbackArticles = await Article.find(fallbackMatch)
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes commentCount likedBy dislikedBy')
        .sort({ publishedAt: -1 }) // single-field sort uses language_1_publishedAt_1 (no blocking sort); viewCount factored into in-memory engagement re-ranking
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
              // Respect disliked categories at the index level — cheapest place to filter
              ...(dislikedCategories.length > 0 ? { category: { $nin: dislikedCategories } } : {}),
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
            content: 1,
            contentFormat: 1, // ✅ Include contentFormat for markdown rendering
            language: 1, // ✅ Include language for RTL support
            image: 1,
            sourceId: 1,
            source: 1,
            publishedAt: 1,
            viewCount: 1,
            category: 1,
            likes: 1,
            dislikes: 1,
            commentCount: 1,
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
        ...(dislikedCategories.length > 0 ? { category: { $nin: dislikedCategories } } : {}),
        ...(preferredCategories.length > 0 ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
        ...(preferredSources.length > 0 ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
      };

      const fallbackArticles = await Article.find(fallbackMatch)
        .select('title summary content contentFormat language image sourceId source publishedAt viewCount category likes dislikes commentCount likedBy dislikedBy')
        .sort({ publishedAt: -1 }) // single-field sort uses language_1_publishedAt_1 (no blocking sort); viewCount factored into in-memory engagement re-ranking
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
        ...(dislikedCategories.length > 0 ? { category: { $nin: dislikedCategories } } : {}),
        ...(preferredCategories.length > 0 ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
        ...(preferredSources.length > 0 ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
      };

      const fastFallbackArticles = await Article.find(fallbackMatch)
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes commentCount likedBy dislikedBy')
        .sort({ publishedAt: -1 }) // single-field sort uses language_1_publishedAt_1 (no blocking sort); viewCount factored into in-memory engagement re-ranking
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
    // Rebalanced: similarity drives page 1 (was 75% recency, now 45%) so personalisation
    // is actually visible on the first scroll rather than being swamped by raw recency.
    const w_recency = page === 1 ? 0.45 : page === 2 ? 0.35 : page === 3 ? 0.25 : 0.20;
    const scoredArticles = candidateArticles
      // Hard-filter disliked categories that may have slipped through (e.g. in widen results)
      .filter(article => !dislikedCategories.includes(article.category))
      .map(article => {
        const similarity = article.similarity || 0;
        const engagementScore = calculateEngagementScore(article);
        const recencyScore = basicRecencyScore(article.publishedAt);

        // Start with read-time derived boost (proportional to actual deep reading time)
        // Falls back to flat boost if read-time data isn't available for this category
        let preferenceBoost = categoryTimeBoosts[article.category] ?? (preferredCategories.includes(article.category) ? 0.15 : 0);

        // Source preference adds a smaller fixed boost on top
        if (preferredSources.includes(article.sourceId?.toString())) {
          preferenceBoost += 0.10;
        }

        // baseScore: similarity leads (55%), engagement secondary (20%), preference on top
        const baseScore = (similarity * 0.55) + (engagementScore * 0.20) + preferenceBoost;
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

    // Trending injection — sorted by view VELOCITY (views/hour) not raw viewCount,
    // so a fast-rising article from 3 hours ago beats a stale high-count article.
    const trendingPoolSize = Math.ceil(candidatePoolSize * TRENDING_RATIO);
    if (trendingPoolSize > 0 && candidatePool.length < candidatePoolSize) {
      const usedIds = new Set(candidatePool.map(a => a._id.toString()));
      // Fetch a larger pool so we can re-rank by velocity in JS (avoids a heavy aggregation)
      const trendingCandidates = await Article.find({
        language,
        viewCount: { $exists: true, $gt: 0 },
        publishedAt: { $gte: cutoffTime },
        _id: { $nin: [...excludeIds, ...Array.from(usedIds).map(id => new mongoose.Types.ObjectId(id))] },
        ...(dislikedCategories.length > 0 ? { category: { $nin: dislikedCategories } } : {}),
        ...(preferredCategories.length > 0 ? { category: { $in: preferredCategories.slice(0, 5) } } : {}),
        ...(preferredSources.length > 0 ? { sourceId: { $in: preferredSources.map(id => new mongoose.Types.ObjectId(id)) } } : {})
      })
        .select('title summary image sourceId source publishedAt viewCount category likes dislikes commentCount likedBy dislikedBy')
        .sort({ publishedAt: -1 }) // Fetch newest first; we rerank by velocity below
        .limit(trendingPoolSize * 5) // Extra headroom so velocity reranking is meaningful
        .lean();

      // Rerank by views-per-hour (velocity) — an article 2h old with 500 views ranks above
      // a 3-day-old article with 2000 views.
      const withVelocity = trendingCandidates.map(article => {
        const ageHours = Math.max(0.5, (Date.now() - new Date(article.publishedAt).getTime()) / 3.6e6);
        const velocity = (article.viewCount || 0) / ageHours;
        return { ...article, velocity };
      });
      withVelocity.sort((a, b) => b.velocity - a.velocity);
      const trendingArticles = withVelocity.slice(0, trendingPoolSize);

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

// GET: Personalized articles by category
// Uses the same context/scorer/interleaver as /personalized-light so the
// category browse benefits from embeddings, following boost, source
// preference, and disliked-category penalty — not just recency+engagement.
articleRouter.get('/personalized-category', auth, ensureMongoUser, async (req, res) => {
  const startTime = Date.now();
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
    const category = req.query.category;
    const forceRefresh = req.query.noCache === 'true';

    if (!category) {
      return res.status(400).json({ error: 'Category parameter is required' });
    }

    const supabaseId = req.mongoUser.supabase_id;
    const mongoId = req.mongoUser._id;
    const userLanguagePref = req.mongoUser.language || 'English';
    const language = (req.query.language || userLanguagePref).toLowerCase();

    const ctx = await loadUserPersonalizationContext(supabaseId);
    if (ctx) {
      ctx.language = language;
      ctx.categoryStats = await getCategoryEngagementStats(language);
      ctx.servedIds = await getServedIds(supabaseId);
    }

    // Refuse to serve a category the user has explicitly disliked — they
    // shouldn't be tapping it anyway, but if they do, return empty so the
    // chip click doesn't reintroduce the rejected content.
    if (ctx?.dislikedCategories?.has(category)) {
      console.log(`🏷️ User ${supabaseId} has disliked category "${category}"; returning empty`);
      return res.json([]);
    }

    const stateHash = userStateHash(ctx);
    const tenMinSlot = Math.floor(Date.now() / (10 * 60 * 1000));
    const cacheKey =
      `articles_pers_cat_v2_${supabaseId}_${category}_${language}_${page}_${limit}_${stateHash}_${tenMinSlot}`;

    if (!forceRefresh) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          console.log(`⚡ pers-cat-v2 cache hit in ${Date.now() - startTime}ms (page ${page})`);
          const parsed = JSON.parse(cached);
          recordServedIds(supabaseId, parsed).catch(() => {});
          return res.json(parsed);
        }
      } catch (err) {
        console.error('⚠️ Redis get error:', err.message);
      }
    }

    // Candidate filter — same shape as personalized-light, plus the
    // category pin. Only disliked articles are hard-excluded; liked
    // articles are NOT excluded (seeing a liked article again is fine,
    // and the previous behavior of dropping them shrank thin categories).
    const buildMatch = (sinceMs) => {
      const match = {
        language,
        category,
        publishedAt: { $gte: new Date(Date.now() - sinceMs) },
      };
      if (ctx) {
        // Disliked + recently-served (P0-2 follow-up).
        const excluded = [];
        if (ctx.dislikedIds.size > 0) {
          excluded.push(...[...ctx.dislikedIds].slice(0, 500));
        }
        if (ctx.servedIds?.size > 0) {
          excluded.push(...[...ctx.servedIds].slice(0, SERVED_MAX_EXCLUDE));
        }
        if (excluded.length > 0) {
          match._id = {
            $nin: excluded.map((id) => new mongoose.Types.ObjectId(id)),
          };
        }
      }
      return match;
    };

    // Need enough candidates to support pagination + interleave headroom.
    const candidateLimit = Math.min(page * limit + 200, 500);
    const includeEmbedding = !!ctx?.embedding && !shouldSkipEmbedding(ctx);

    const runCandidateQuery = (sinceMs, opts) =>
      Article.aggregate([
        { $match: buildMatch(sinceMs, opts) },
        { $sort: { publishedAt: -1 } },
        { $limit: candidateLimit },
        {
          $lookup: {
            from: 'sources',
            localField: 'sourceId',
            foreignField: '_id',
            as: 'source',
            pipeline: [
              { $match: { status: { $ne: 'blocked' } } },
              { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
            ],
          },
        },
        { $match: { 'source.0': { $exists: true } } },
        {
          $addFields: {
            sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
            sourceName: { $arrayElemAt: ['$source.name', 0] },
            sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
            sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
          },
        },
        {
          $project: {
            title: 1,
            content: 1,
            contentFormat: 1,
            url: 1,
            category: 1,
            publishedAt: 1,
            image: 1,
            viewCount: 1,
            likes: 1,
            dislikes: 1,
            commentCount: 1,
            likedBy: 1,
            dislikedBy: 1,
            sourceId: 1,
            sourceName: 1,
            sourceIcon: 1,
            sourceGroupName: 1,
            language: 1,
            ...(includeEmbedding ? { embedding_pca: 1 } : {}),
          },
        },
      ]);

    // Widen progressively for sparse category+language combinations
    // (e.g. Farsi/Tech can have <10 articles in 24h).
    const queryStart = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const startWindow = page === 1 ? 24 * HOUR : 48 * HOUR;
    const windows = [startWindow, 72 * HOUR, 7 * DAY, 30 * DAY];
    const minCandidates = limit + (page - 1) * limit;
    let candidates = [];
    let usedWindowMs = windows[0];
    for (const sinceMs of windows) {
      candidates = await runCandidateQuery(sinceMs);
      usedWindowMs = sinceMs;
      if (candidates.length >= minCandidates) break;
    }
    const dbTime = Date.now() - queryStart;

    let scored;
    if (ctx?.hasSignal) {
      scored = scorePersonalizedCandidates(candidates, ctx, { page });
    } else {
      for (const a of candidates) {
        a._score =
          PERS_W.recency * basicRecencyScore(a.publishedAt) +
          PERS_W.engagement *
            Math.tanh(
              ((a.viewCount || 0) * viewsWeight +
                (a.likes || 0) * likesWeight +
                (a.dislikes || 0) * dislikesWeight) /
                80
            );
        // Disliked categories can exist without hasSignal (dislikes don't
        // count toward it); starvation-guard rescue articles must still
        // sink below eligible ones.
        if (a.category && ctx?.dislikedCategories?.has(a.category)) {
          a._score += PERS_W.dislikedCategoryPenalty;
        }
      }
      scored = candidates.sort((x, y) => y._score - x._score);
    }

    // P0-2 follow-up: candidates already exclude the served set, so we
    // slice from the top of the fresh pool rather than offsetting by
    // page. See the same comment in personalized-fast above.
    const interleaved = interleaveBySourceGroup(scored, { minGap: 2, perGroupCap: 8 });
    const pageSlice = interleaved.slice(0, limit);

    const finalArticles = sanitizeForResponse(pageSlice, {
      isCategory: true,
      category,
      fetchedAt: new Date(),
      isRefreshed: forceRefresh,
      page,
      isPersonalized: !!ctx?.hasSignal,
    });

    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 600); // 10 min
      // Cache key uses supabase_id, so track under that; also track under
      // Mongo _id for any callers that still clear by Mongo id.
      await trackUserCacheKey(supabaseId, cacheKey);
      if (mongoId) await trackUserCacheKey(mongoId.toString(), cacheKey);
    } catch (err) {
      console.error('⚠️ Redis set error:', err.message);
    }

    const totalTime = Date.now() - startTime;
    const usedWindowHours = Math.round(usedWindowMs / (60 * 60 * 1000));
    console.log(
      `🏷️ pers-cat-v2: cat="${category}" page ${page}, ${finalArticles.length} articles in ${totalTime}ms ` +
      `(db ${dbTime}ms, candidates ${candidates.length}, window ${usedWindowHours}h, lang=${language}, ` +
      `signal=${!!ctx?.hasSignal}, embed=${includeEmbedding})`
    );

    res.setHeader('X-Performance-Time', totalTime);
    res.setHeader('X-DB-Query-Time', dbTime);
    res.setHeader('X-Page', page);
    res.setHeader(
      'X-Personalized',
      ctx?.hasSignal ? (includeEmbedding ? 'vector' : 'signal') : 'none'
    );
    res.setHeader('X-Candidates', candidates.length);
    res.setHeader('X-Window-Hours', usedWindowHours);

    recordServedIds(supabaseId, finalArticles).catch(() => {});
    return res.json(finalArticles);
  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ pers-cat-v2 error in ${errorTime}ms:`, error);

    // Fallback: best-effort plain category articles (recency-only) so the
    // category chip never returns 500 to the user.
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 50);
      const language = (req.query.language || req.mongoUser?.language || 'english').toLowerCase();
      const category = req.query.category;
      const skip = (page - 1) * limit;
      const fallback = await Article.find({
        language,
        category,
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      })
        .select(
          'title content contentFormat url category publishedAt image sourceId viewCount likes dislikes commentCount language'
        )
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      return res.json(fallback);
    } catch (fallbackError) {
      console.error('❌ Category fallback also failed:', fallbackError);
      return res
        .status(500)
        .json({ error: 'Error fetching personalized category articles', message: error.message });
    }
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

    // Handle search with Atlas Search (optimized) - early return for search queries
    if (search && search.trim()) {
      const searchTerm = search.trim();
      console.log(`🔍 Using Atlas Search for: "${searchTerm}"`);

      // Get allowed source IDs for publisher filtering
      let sourceIds = null;
      if (userPublisherGroups) {
        const publisherGroupsArray = Array.isArray(userPublisherGroups) ? userPublisherGroups : [userPublisherGroups];
        const Source = require('../models/Source');
        const allowedSources = await Source.find({
          groupName: { $in: publisherGroupsArray.map(g => new RegExp(`^${g}$`, 'i')) }
        }).select('_id').lean();
        sourceIds = allowedSources.map(s => s._id);

        if (sourceIds.length === 0) {
          return res.json({ articles: [], pagination: { page, limit, total: 0, pages: 0, hasNext: false, hasPrev: false } });
        }
      }

      // Use Atlas Search for optimized full-text search
      const skip = (page - 1) * limit;
      const { articles: searchResults, total } = await searchArticles({
        searchTerm,
        language,
        category,
        sourceIds,
        limit,
        skip
      });

      // Apply source group limiting for non-publisher users
      let finalArticles = searchResults;
      if (!userPublisherGroups) {
        finalArticles = limitArticlesPerSourceGroup(searchResults, 2);
      }

      // Add engagement scores and fetchId
      const enhancedArticles = finalArticles.map(a => ({
        ...a,
        fetchId: new mongoose.Types.ObjectId().toString(),
        engagementScore: calculateEngagementScore(a),
        finalScore: a.searchScore || 1
      }));

      const responseData = {
        articles: enhancedArticles,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1
        }
      };

      try {
        await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 300);
      } catch (err) {
        console.error('⚠️ Redis set error (safe to ignore):', err.message);
      }

      return res.json(responseData);
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

    // OPTIMIZED PAGINATION: Use cached counts or estimate instead of countDocuments()
    // This avoids expensive full collection scans on 100K+ documents
    const filterKey = JSON.stringify(filter);
    const countCacheKey = `articles_count_${simpleHash(filterKey)}`;
    let totalCount = null;

    // Try to get cached count first
    try {
      const cachedCount = await redis.get(countCacheKey);
      if (cachedCount) {
        totalCount = parseInt(cachedCount, 10);
        console.log(`📊 Using cached count: ${totalCount}`);
      }
    } catch (err) {
      console.error('⚠️ Redis count cache error (safe to ignore):', err.message);
    }

    // If no cached count and it's a simple filter (no category, no sourceId filter), use estimatedDocumentCount
    if (totalCount === null) {
      const isSimpleFilter = !category && !filter.sourceId && filter.language;
      if (isSimpleFilter) {
        // Use fast estimated count for simple queries
        totalCount = await Article.estimatedDocumentCount();
        console.log(`📊 Using estimated count (fast): ${totalCount}`);
      }
      // Note: For filtered queries, we'll determine hasNext from fetched results instead
    }

    // Calculate skip for proper pagination
    const skip = (page - 1) * limit;

    // Fetch articles with proper skip/limit for the current page
    // Fetch extra to allow for source group filtering AND to detect if there's a next page
    const fetchMultiplier = userPublisherGroups ? 4 : 3;
    const fetchLimit = limit * fetchMultiplier + 1; // +1 to detect hasNext without counting

    // OPTIMIZED: Use cached source map instead of .populate() for faster queries
    // This avoids the slow $lookup operation that was causing 3.66s avg query times
    const sourceMap = await getSourceMap();

    const raw = await Article.find(filter)
      .select('title content contentFormat url category publishedAt image viewCount likes dislikes commentCount likedBy dislikedBy sourceId language')
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(fetchLimit)
      .lean();

    // Enrich with source data from cache and filter blocked sources
    const filteredArticles = raw.filter(article => {
      const sourceId = article.sourceId?.toString();
      if (!sourceId) return false;
      const source = sourceMap.get(sourceId);
      // Include article only if source exists in cache (non-blocked sources)
      return !!source;
    }).map(article => {
      const source = sourceMap.get(article.sourceId?.toString());
      return {
        ...article,
        sourceName: source?.name || 'Unknown Source',
        sourceIcon: source?.icon || null,
        sourceGroupName: source?.groupName || null
      };
    });

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
          finalScore
          // Note: sourceName, sourceIcon, sourceGroupName already added from cache above
        };
      })
      .sort((x, y) => (y.finalScore ?? 0) - (x.finalScore ?? 0));

    // Source-group handling: publishers see all their allowed sources unchanged;
    // general (guest) users get interleaving — same total count, just reordered
    // so consecutive items don't come from the same source.
    let processedArticles = [];
    const sourceGroupCounts = {};

    // Tag _score for interleaving stability (uses already-computed finalScore)
    for (const a of enhancedArticles) {
      a._score = a.finalScore;
    }

    if (userPublisherGroups) {
      console.log(`🔀 PUBLISHER MODE: Skipping source group limits, using all ${enhancedArticles.length} articles`);
      processedArticles = enhancedArticles;
    } else {
      console.log(`🔀 GENERAL MODE: Interleaving source groups (minGap=2, perGroupCap=8)`);
      processedArticles = interleaveBySourceGroup(enhancedArticles, { minGap: 2, perGroupCap: 8 });
    }

    // Distribution stats for logging
    processedArticles.forEach((article) => {
      const sourceGroup =
        article.sourceGroupName || article.sourceId?.toString() || article.source || 'unknown-group';
      sourceGroupCounts[sourceGroup] = (sourceGroupCounts[sourceGroup] || 0) + 1;
    });

    // Take only the requested limit from processed articles
    const finalArticles = processedArticles.slice(0, limit);
    console.log(`🔀 Step 1: ${userPublisherGroups ? 'Skipped source group limits (publisher)' : 'Applied source group limits'} to ${enhancedArticles.length} articles, got ${processedArticles.length} filtered articles`);
    console.log(`🔀 Step 2: Taking first ${limit} articles, got ${finalArticles.length} final articles`);

    console.log(`🔀 PUBLIC: Selected ${finalArticles.length} articles from ${processedArticles.length} candidates ${userPublisherGroups ? '(publisher - no source limits)' : '(general - source limited)'}`);
    console.log(`📊 Total source group distribution:`, Object.entries(sourceGroupCounts).map(([group, count]) => `${group}:${count}`).join(', '));

    // Calculate distribution for this page only
    const pageSourceCounts = {};
    finalArticles.forEach(article => {
      const sourceGroup = article.sourceGroupName || article.sourceId?.toString() || article.source || 'unknown-group';
      pageSourceCounts[sourceGroup] = (pageSourceCounts[sourceGroup] || 0) + 1;
    });
    console.log(`📊 Page ${page} source distribution:`, Object.entries(pageSourceCounts).map(([group, count]) => `${group}:${count}`).join(', '));

    // OPTIMIZED PAGINATION: Determine hasNext from fetched results instead of counting
    // If we fetched more articles than we need after filtering, there's likely more
    const hasNextPage = processedArticles.length > limit;
    const hasPrevPage = page > 1;

    // Calculate total and pages - use cached/estimated count if available, otherwise estimate from current page
    let effectiveTotal = totalCount;
    let totalPages;

    if (totalCount !== null) {
      // We have a count (cached or estimated)
      totalPages = Math.ceil(totalCount / limit);
    } else {
      // No count available - estimate based on current results
      // If we got a full page + extras, assume there's more content
      if (hasNextPage) {
        // Estimate: current position + what we know exists
        effectiveTotal = (page * limit) + processedArticles.length;
        totalPages = page + 1; // At least one more page
      } else {
        // This is likely the last page
        effectiveTotal = ((page - 1) * limit) + finalArticles.length;
        totalPages = page;
      }

      // Cache this count estimate for future requests (shorter TTL for estimates)
      try {
        await redis.set(countCacheKey, effectiveTotal.toString(), 'EX', 600); // 10 min cache for count
        console.log(`📊 Cached estimated count: ${effectiveTotal}`);
      } catch (err) {
        console.error('⚠️ Redis count cache set error:', err.message);
      }
    }

    const responseData = {
      articles: finalArticles,
      pagination: {
        page,
        limit,
        total: effectiveTotal || 0,
        pages: totalPages || 1,
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

// React (like/dislike) - Ultra-optimized for instant response
/**
 * POST /articles/feedback/mute
 *
 * Explicit "show less" from the feed's not-interested panel.
 *   { type: 'source', value: '<sourceId>' }  — demote everything from this
 *     source's whole group (expanded to all sourceIds sharing groupName,
 *     e.g. the EN + AR editions of one outlet).
 *   { type: 'category', value: 'sports' }    — exclude the category. This is
 *     explicit intent, unlike the ≥3-dislikes derived bans, so it takes
 *     effect immediately; the nightly cron never rewrites muted_* fields.
 *   { ..., unmute: true }                    — reverse either.
 *
 * Sources are demoted (scorer penalty), not excluded — "show less", not
 * "never". Categories join the dislikedCategories machinery, which the
 * starvation guard already protects from feed collapse.
 */
articleRouter.post('/feedback/mute', auth, ensureMongoUser, async (req, res) => {
  try {
    const { type, value, unmute } = req.body;
    const userId = req.mongoUser.supabase_id;

    if (!['source', 'category'].includes(type) || !value) {
      return res
        .status(400)
        .json({ message: "type must be 'source' or 'category' and value is required" });
    }

    if (type === 'source') {
      if (!mongoose.Types.ObjectId.isValid(value)) {
        return res.status(400).json({ message: 'Invalid source ID' });
      }
      const source = await Source.findById(value).select('groupName').lean();
      if (!source) {
        return res.status(404).json({ message: 'Source not found' });
      }
      const groupSources = source.groupName
        ? await Source.find({ groupName: source.groupName }).select('_id').lean()
        : [{ _id: source._id }];
      const ids = groupSources.map((s) => s._id);
      await User.updateOne(
        { supabase_id: userId },
        unmute
          ? { $pullAll: { muted_sources: ids } }
          : { $addToSet: { muted_sources: { $each: ids } } }
      );
    } else {
      const category = String(value).toLowerCase();
      await User.updateOne(
        { supabase_id: userId },
        unmute
          ? { $pull: { muted_categories: category } }
          : { $addToSet: { muted_categories: category } }
      );
    }

    // Purge this user's feed caches + ctx so the next fetch reflects it.
    await clearUserArticleCaches(userId);
    await clearUserArticleCaches(req.mongoUser._id?.toString());

    res.json({ success: true, type, unmuted: !!unmute });
  } catch (error) {
    console.error('❌ /feedback/mute error:', error);
    res.status(500).json({ message: 'Error saving mute feedback', error: error.message });
  }
});

articleRouter.post('/:id/react', auth, ensureMongoUser, async (req, res) => {
  // Set a timeout for this specific route to prevent hanging
  req.setTimeout(10000); // 10 second timeout

  const startTime = Date.now(); // Move outside try block for catch access

  try {
    const { action } = req.body;
    const userId = req.mongoUser.supabase_id;
    const articleId = req.params.id;
    const mongoUser = req.mongoUser;

    if (!mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ message: 'Invalid article ID' });
    }
    // 'unreact' = undo: pull the user from both reaction arrays and stop.
    // Used by the feed's "Not interested → Undo" flow. The small EMA
    // embedding nudge from the original dislike is NOT reversed — the
    // nightly cron rebuilds the embedding from activity history anyway.
    if (!['like', 'dislike', 'unreact'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(articleId);

    // OPTIMIZATION: Use two sequential operations to avoid MongoDB conflict
    // First remove from both arrays, then add to the correct one
    const updateField = action === 'like' ? 'likedBy' : 'dislikedBy';

    // Step 1: Remove user from both likedBy and dislikedBy arrays
    await Article.findByIdAndUpdate(
      articleId,
      { $pull: { likedBy: userId, dislikedBy: userId } }
    );

    // Step 2: Add user to the correct array and get updated document
    // (unreact stops at the pull — just re-read the counts)
    const articleUpdate = action === 'unreact'
      ? await Article.findById(articleId)
          .select('likedBy dislikedBy likes dislikes commentCount')
          .lean()
      : await Article.findByIdAndUpdate(
          articleId,
          { $addToSet: { [updateField]: userId } },
          { new: true, select: 'likedBy dislikedBy likes dislikes commentCount' }
        ).lean();

    if (!articleUpdate) {
      return res.status(404).json({ message: 'Article not found' });
    }

    // Update user with same two-step approach
    const userUpdateField = action === 'like' ? 'liked_articles' : 'disliked_articles';

    // Step 1: Remove article from both user arrays
    await User.findByIdAndUpdate(
      mongoUser._id,
      { $pull: { liked_articles: articleObjectId, disliked_articles: articleObjectId } }
    );

    // Step 2: Add article to the correct user array (skipped for unreact)
    if (action !== 'unreact') {
      await User.findByIdAndUpdate(
        mongoUser._id,
        { $addToSet: { [userUpdateField]: articleObjectId } }
      );
    }

    // Calculate current counts from the updated arrays
    const likes = articleUpdate.likedBy?.length || 0;
    const dislikes = articleUpdate.dislikedBy?.length || 0;

    // Check if this was a new like (user wasn't already in likedBy before)
    // We need to check current array length vs previous - if we just added, it's new
    const wasNewLike = action === 'like';

    const processingTime = Date.now() - startTime;
    console.log(`✅ ${action} processed in ${processingTime}ms for user ${userId} on article ${articleId} (likes: ${likes}, dislikes: ${dislikes})`);

    // Update the cached counts in the article document synchronously before responding
    // This ensures the counts are immediately available for subsequent reads
    await Article.findByIdAndUpdate(
      articleId,
      { $set: { likes, dislikes } }
    );

    // Respond with the confirmed reaction data with counts
    res.json({
      userReact: action === 'unreact' ? null : action,
      likes,
      dislikes,
      processingTime,
      success: true
    });

    // Perform expensive operations asynchronously after responding
    setImmediate(async () => {
      try {
        // Clear only THIS user's cache entries (not a global KEYS scan).
        // The stateHash in the cache key already rotates on every action,
        // so the next request gets a fresh key regardless — this is
        // belt-and-suspenders for users who refresh within 10 min.
        // Track under both identities since personalized-light/fast key by
        // supabase_id and personalized-category keys by Mongo _id.
        await clearUserArticleCaches(userId);
        await clearUserArticleCaches(mongoUser._id?.toString());

        // Cheap O(128) EMA blend of the user's embedding toward (like) or
        // away from (dislike) this article. ~5ms of math, no OpenAI call.
        // Previously called updateUserProfileEmbedding here which did a
        // full OpenAI re-embed on EVERY reaction (~500-2000ms, $0.0002
        // per call). The daily cron still does the heavy re-aggregation
        // for views/saves/comments and recalibrates from scratch.
        await applyIncrementalEmbeddingUpdate(userId, articleObjectId, action);

        // 🎮 Log activity for gamification tracking + A/B telemetry (P3-1).
        // 'unreact' isn't in the UserActivity enum and shouldn't count as
        // engagement — skip it.
        if (action !== 'unreact') {
          await UserActivity.create({
            userId: userId,
            eventType: action, // 'like' or 'dislike'
            articleId: articleObjectId,
            contentType: 'article',
            timestamp: new Date(),
            treatment: getTreatmentForUser(userId),
          }).catch(err => console.error('⚠️ Failed to log activity:', err.message));
        }

        // 🎮 Award points for liking (gamification)
        if (wasNewLike) {
          try {
            const article = await Article.findById(articleId).select('category').lean();
            await PointsService.awardPoints(userId, 'ARTICLE_LIKE', {
              articleId: articleObjectId,
              category: article?.category
            });
            console.log(`🎮 Points awarded for like on article ${articleId}`);
          } catch (pointsErr) {
            console.error('⚠️ Failed to award like points:', pointsErr.message);
          }
        }
      } catch (asyncError) {
        console.error('⚠️ Error in async post-response operations:', asyncError);
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
      processingTime,
      success: false
    });
  }
});

// Related-by-embedding (small helper endpoint you already have)
// ⚠️ OPTIMIZED: Now uses embedding_pca with Atlas Vector Search for better performance
// Falls back to manual cosine similarity if vector search unavailable
articleRouter.get('/related-embedding/:id', async (req, res) => {
  const { id } = req.params;
  const startTime = Date.now();

  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);

    // Check cache first
    const cacheKey = `related_embedding_${id}_${limit}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`⚡ Related-embedding cache hit for ${id} in ${Date.now() - startTime}ms`);
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      // Continue without cache
    }

    // Get target article - prefer embedding_pca for vector search
    const target = await Article.findById(id)
      .select('embedding_pca embedding language')
      .lean();

    if (!target) {
      return res.status(404).json({ error: 'Article not found' });
    }

    let related = [];

    // Method 1: Try Atlas Vector Search with embedding_pca (fastest)
    if (target.embedding_pca && Array.isArray(target.embedding_pca) && target.embedding_pca.length > 0) {
      try {
        const vectorResults = await Article.aggregate([
          {
            $vectorSearch: {
              index: 'article_embeddings_pca',
              path: 'embedding_pca',
              queryVector: target.embedding_pca,
              numCandidates: limit * 10,
              limit: limit + 1, // +1 to exclude self
              filter: {
                language: target.language
              }
            }
          },
          {
            $match: { _id: { $ne: new mongoose.Types.ObjectId(id) } }
          },
          {
            $project: {
              _id: 1,
              title: 1,
              category: 1,
              publishedAt: 1,
              image: 1,
              similarity: { $meta: 'vectorSearchScore' }
            }
          },
          { $limit: limit }
        ], { maxTimeMS: 3000 });

        if (vectorResults.length > 0) {
          related = vectorResults;
          console.log(`✅ Related-embedding via vector search: ${related.length} results in ${Date.now() - startTime}ms`);
        }
      } catch (vectorErr) {
        console.warn('⚠️ Vector search failed, falling back:', vectorErr.message);
      }
    }

    // Method 2: Fallback to manual cosine similarity with limited sample
    if (related.length === 0 && target.embedding && Array.isArray(target.embedding) && target.embedding.length > 0) {
      // Use a smaller, indexed query - only recent articles with embeddings
      const sampleArticles = await Article.find({
        _id: { $ne: id },
        language: target.language,
        publishedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days only
      })
        .select('_id title category publishedAt embedding image')
        .sort({ publishedAt: -1 })
        .limit(100) // Reduced from 200
        .lean();

      // Filter to only articles with embeddings (in JS, faster than $exists in query)
      const articlesWithEmbeddings = sampleArticles.filter(a =>
        a.embedding && Array.isArray(a.embedding) && a.embedding.length > 0
      );

      const cosineSimilarity = (a, b) => {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          magA += a[i] * a[i];
          magB += b[i] * b[i];
        }
        return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
      };

      related = articlesWithEmbeddings
        .map(a => {
          const { embedding, ...rest } = a;
          return { ...rest, similarity: cosineSimilarity(target.embedding, embedding) };
        })
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      console.log(`✅ Related-embedding via fallback cosine: ${related.length} results in ${Date.now() - startTime}ms`);
    }

    // Method 3: Category-based fallback if no embeddings
    if (related.length === 0) {
      const target2 = await Article.findById(id).select('category language').lean();
      if (target2) {
        related = await Article.find({
          _id: { $ne: id },
          category: target2.category,
          language: target2.language
        })
          .select('_id title category publishedAt image')
          .sort({ publishedAt: -1 })
          .limit(limit)
          .lean();

        related = related.map(a => ({ ...a, similarity: 0.5 })); // Default similarity
        console.log(`✅ Related-embedding via category fallback: ${related.length} results in ${Date.now() - startTime}ms`);
      }
    }

    // Cache the results
    try {
      await redis.set(cacheKey, JSON.stringify(related), 'EX', 1800); // 30 min cache
    } catch (err) {
      // Continue without caching
    }

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

// GET related articles based on similarity (uses MongoDB Vector Search with language filtering)
articleRouter.get('/related/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 5, 20); // Max 20 related articles

    console.log(`🔍 Fetching related articles for: ${id}, limit: ${limit}`);

    // Optional auth (P3-4): if the caller sent a JWT, decode it and pull
    // the user's disliked articles + categories so we can filter them
    // out of the carousel. Unauthenticated callers get the unfiltered
    // result (existing behavior preserved).
    let dislikedArticleObjectIds = [];
    let dislikedCategorySet = null;
    try {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        // Verify if we can; fall back to decode-only — the dislike filter
        // is a soft preference, not a security boundary.
        let decoded;
        try {
          decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: process.env.SUPABASE_JWT_ISSUER,
          });
        } catch {
          decoded = jwt.decode(token);
        }
        const supabaseId = decoded?.sub;
        if (supabaseId) {
          const user = await User.findOne({ supabase_id: supabaseId })
            .select('disliked_articles disliked_categories')
            .lean();
          if (user) {
            dislikedArticleObjectIds = (user.disliked_articles || [])
              .slice(0, 500)
              .map((aid) => (typeof aid === 'string' ? new mongoose.Types.ObjectId(aid) : aid))
              .filter(Boolean);
            dislikedCategorySet = new Set(user.disliked_categories || []);
          }
        }
      }
    } catch (err) {
      // Non-fatal: just serve unfiltered.
      console.warn('⚠️ related/:id auth decode failed:', err.message);
    }
    const hasDislikedCats = dislikedCategorySet && dislikedCategorySet.size > 0;

    // Get the base article with its embedding
    const baseArticle = await Article.findById(id).select('title category language sourceId embedding_pca').lean();
    if (!baseArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }

    // Use article's language, default to 'english' if not set
    const articleLanguage = baseArticle.language || 'english';
    console.log(`📰 Base article: "${baseArticle.title?.slice(0, 50)}..." Category: ${baseArticle.category}, Language: ${articleLanguage}`);

    let relatedArticles = [];

    // Method 1: Try MongoDB Vector Search with $vectorSearch if embedding exists
    if (baseArticle.embedding_pca && baseArticle.embedding_pca.length === 128) {
      console.log('🔍 Using MongoDB Vector Search with PCA embeddings');

      try {
        // Use $vectorSearch aggregation for efficient similarity search
        const vectorResults = await Article.aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX,
              path: "embedding_pca",
              queryVector: baseArticle.embedding_pca,
              numCandidates: limit * 10,
              limit: limit * 3,
              filter: {
                language: articleLanguage // Filter by same language (requires Atlas index to have language as filter field)
              }
            }
          },
          // Exclude current article + disliked articles + disliked categories.
          // Atlas $vectorSearch's `filter` param only supports a small subset
          // of operators, so we apply user-specific dislikes here as a $match
          // stage rather than baking them into the index pre-filter.
          {
            $match: {
              _id: {
                $ne: new mongoose.Types.ObjectId(id),
                ...(dislikedArticleObjectIds.length > 0 ? { $nin: dislikedArticleObjectIds } : {}),
              },
              ...(hasDislikedCats
                ? { category: { $nin: [...dislikedCategorySet] } }
                : {}),
            }
          },
          { $addFields: { similarity: { $meta: "vectorSearchScore" } } },
          {
            $lookup: {
              from: 'sources',
              localField: 'sourceId',
              foreignField: '_id',
              as: 'sourceInfo',
              pipeline: [
                { $project: { name: 1, icon: 1, groupName: 1 } }
              ]
            }
          },
          {
            $addFields: {
              sourceName: { $arrayElemAt: ['$sourceInfo.name', 0] },
              sourceIcon: { $arrayElemAt: ['$sourceInfo.icon', 0] },
              sourceGroupName: { $arrayElemAt: ['$sourceInfo.groupName', 0] }
            }
          },
          {
            $project: {
              _id: 1,
              title: 1,
              content: 1,
              contentFormat: 1,
              category: 1,
              language: 1,
              sourceId: 1,
              sourceName: 1,
              sourceIcon: 1,
              sourceGroupName: 1,
              publishedAt: 1,
              image: 1,
              url: 1,
              viewCount: 1,
              likes: 1,
              dislikes: 1,
              commentCount: 1,
              similarity: 1
            }
          },
          { $limit: limit }
        ]);

        relatedArticles = vectorResults;
        console.log(`✅ Vector search returned ${relatedArticles.length} articles with similarities: ${relatedArticles.slice(0, 3).map(a => a.similarity?.toFixed(3) || 'N/A').join(', ')}`);
      } catch (vectorError) {
        console.warn(`⚠️ Vector search failed, falling back to category-based: ${vectorError.message}`);
        // Fall through to fallback method
      }
    }

    // Method 2: Fallback - category + language based similarity
    if (relatedArticles.length < limit) {
      console.log('🔍 Using category/language-based similarity as fallback');

      // Build a reusable "respect user dislikes" filter for the fallback paths.
      const dislikedCategoryFilter = hasDislikedCats
        ? { category: { $nin: [...dislikedCategorySet] } }
        : {};
      const buildIdNin = (excludeIdObjs) => {
        const combined = [...excludeIdObjs, ...dislikedArticleObjectIds];
        return combined.length > 0 ? { _id: { $nin: combined } } : {};
      };

      const remaining = limit - relatedArticles.length;
      const excludeIds = relatedArticles.map(a => a._id.toString()).concat([id]);
      const excludeIdObjs = excludeIds.map(eid => new mongoose.Types.ObjectId(eid));

      // First try same category + language, different source.
      // Skip this branch if the user has disliked the base article's category.
      let categoryArticles = [];
      if (!hasDislikedCats || !dislikedCategorySet.has(baseArticle.category)) {
        categoryArticles = await Article.find({
          ...buildIdNin(excludeIdObjs),
          category: baseArticle.category,
          language: articleLanguage,
          sourceId: { $ne: baseArticle.sourceId }
        })
          .select('title content category language sourceId publishedAt image url viewCount likes dislikes commentCount')
          .sort({ publishedAt: -1 })
          .limit(remaining)
          .lean();
      }

      relatedArticles = relatedArticles.concat(categoryArticles.map(a => ({ ...a, similarity: 0.7 })));

      // If still not enough, try same source + language
      if (relatedArticles.length < limit) {
        const stillRemaining = limit - relatedArticles.length;
        const newExcludeIdObjs = relatedArticles.map(a => new mongoose.Types.ObjectId(a._id.toString())).concat([new mongoose.Types.ObjectId(id)]);

        const sourceArticles = await Article.find({
          ...buildIdNin(newExcludeIdObjs),
          ...dislikedCategoryFilter,
          sourceId: baseArticle.sourceId,
          language: articleLanguage
        })
          .select('title content category language sourceId publishedAt image url viewCount likes dislikes commentCount')
          .sort({ publishedAt: -1 })
          .limit(stillRemaining)
          .lean();

        relatedArticles = relatedArticles.concat(sourceArticles.map(a => ({ ...a, similarity: 0.5 })));
      }

      // Last resort: same language, any category (still filtered)
      if (relatedArticles.length < limit) {
        const stillRemaining = limit - relatedArticles.length;
        const newExcludeIdObjs = relatedArticles.map(a => new mongoose.Types.ObjectId(a._id.toString())).concat([new mongoose.Types.ObjectId(id)]);

        const languageArticles = await Article.find({
          ...buildIdNin(newExcludeIdObjs),
          ...dislikedCategoryFilter,
          language: articleLanguage
        })
          .select('title content category language sourceId publishedAt image url viewCount likes dislikes commentCount')
          .sort({ publishedAt: -1 })
          .limit(stillRemaining)
          .lean();

        relatedArticles = relatedArticles.concat(languageArticles.map(a => ({ ...a, similarity: 0.3 })));
      }
    }

    // Clean up the results - return complete article objects
    const finalResults = relatedArticles.slice(0, limit).map(article => {
      // Remove embedding_pca from response to reduce payload size
      const { embedding_pca, embedding, sourceInfo, ...cleanArticle } = article;
      return {
        ...cleanArticle,
        similarity: article.similarity || 0
      };
    });

    console.log(`✅ Returning ${finalResults.length} related articles (language: ${articleLanguage})`);
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

/**
 * GET /api/articles/breaking
 * Get all active breaking news articles (non-expired)
 *
 * Query params:
 * - limit: max articles to return (default: 10)
 */
articleRouter.get('/breaking', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    const articles = await Article.find({
      isBreakingNews: true,
      $or: [
        { breakingNewsExpiry: null },
        { breakingNewsExpiry: { $gt: new Date() } },
      ],
    })
      .sort({ breakingNewsPriority: -1, publishedAt: -1 })
      .limit(limit)
      .populate('sourceId')
      .lean();

    // Enrich with source info
    const enrichedArticles = await enrichArticlesWithSources(articles);

    res.json({
      success: true,
      count: enrichedArticles.length,
      articles: enrichedArticles,
    });
  } catch (error) {
    console.error('❌ Error fetching breaking news:', error);
    res.status(500).json({ error: 'Failed to fetch breaking news' });
  }
});

/**
 * POST /api/articles/:id/mark-breaking
 * Mark article as breaking news and send push notification to all users
 *
 * Body:
 * {
 *   expiryHours: 1,     // Optional: hours until breaking status expires (default: 1)
 *   priority: 10        // Optional: priority level 0-10 (default: 10)
 * }
 */
articleRouter.post('/:id/mark-breaking', auth, async (req, res) => {
  try {
    const { expiryHours = 1, priority = 10 } = req.body;
    const articleId = req.params.id;

    // Verify article exists
    const article = await Article.findById(articleId).populate('sourceId');
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    // Update article with breaking news status
    article.isBreakingNews = true;
    article.breakingNewsExpiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);
    article.breakingNewsPriority = priority;
    await article.save();

    // Clear article caches
    await clearArticlesCache();

    console.log(`🔥 Article ${articleId} marked as breaking news`);

    // Send push notifications to all users (Phase 3.3)
    const pushResult = await NotificationService.sendBreakingNewsToAllUsers(article);

    res.json({
      success: true,
      article,
      message: 'Article marked as breaking news',
      pushSent: pushResult?.totalSent || 0,
      pushFailed: pushResult?.totalFailed || 0,
      usersReached: pushResult?.usersReached || 0,
    });
  } catch (error) {
    console.error('❌ Error marking article as breaking:', error);
    res.status(500).json({ error: 'Failed to mark article as breaking news' });
  }
});

/**
 * POST /api/articles/:id/unmark-breaking
 * Remove breaking news status from article
 */
articleRouter.post('/:id/unmark-breaking', auth, async (req, res) => {
  try {
    const article = await Article.findByIdAndUpdate(
      req.params.id,
      {
        isBreakingNews: false,
        breakingNewsExpiry: null,
        breakingNewsPriority: 0,
      },
      { new: true }
    ).populate('sourceId');

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    // Clear article caches
    await clearArticlesCache();

    console.log(`📰 Article ${req.params.id} unmarked as breaking news`);

    res.json({ success: true, article });
  } catch (error) {
    console.error('❌ Error unmarking breaking news:', error);
    res.status(500).json({ error: 'Failed to unmark breaking news' });
  }
});

// GET: Trending articles — ranked by view VELOCITY (views/hour) within a recent
// window, so a fast-rising fresh article beats a stale high-count one. Falls back
// to newest articles when no view data exists yet. Mirrors /recent's source
// enrichment so the client gets sourceName/sourceIcon/sourceGroupName.
// NOTE: must be declared before the `/:id` catch-all or it gets swallowed.
const TRENDING_CACHE_TTL = 300; // 5 min
const TRENDING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 72h
const TRENDING_MAX = 20;
const trendingCacheKey = (language) => `articles:trending:${language}`;

const TRENDING_SOURCE_LOOKUP = [
  {
    $lookup: {
      from: 'sources',
      localField: 'sourceId',
      foreignField: '_id',
      as: 'source',
      pipeline: [
        { $match: { status: { $ne: 'blocked' } } },
        { $project: { groupName: 1, name: 1, icon: 1, quality_score: 1 } },
      ],
    },
  },
  { $match: { 'source.0': { $exists: true } } },
  {
    $addFields: {
      sourceGroupName: { $arrayElemAt: ['$source.groupName', 0] },
      sourceName: { $arrayElemAt: ['$source.name', 0] },
      sourceIcon: { $arrayElemAt: ['$source.icon', 0] },
      sourceQualityScore: { $arrayElemAt: ['$source.quality_score', 0] },
    },
  },
  {
    $project: {
      title: 1,
      content: 1,
      contentFormat: 1,
      url: 1,
      category: 1,
      publishedAt: 1,
      image: 1,
      viewCount: 1,
      likes: 1,
      dislikes: 1,
      commentCount: 1,
      sourceId: 1,
      sourceName: 1,
      sourceIcon: 1,
      sourceGroupName: 1,
      language: 1,
    },
  },
];

articleRouter.get('/trending', async (req, res) => {
  try {
    const language = (req.query.language || 'english').toLowerCase();
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 6), TRENDING_MAX);

    try {
      const cached = await redis.get(trendingCacheKey(language));
      if (cached) {
        res.setHeader('X-Cache', 'hit');
        return res.json(JSON.parse(cached).slice(0, limit));
      }
    } catch (err) {
      // Fall through to direct query
    }

    const since = new Date(Date.now() - TRENDING_WINDOW_MS);

    // Primary: recent articles that have views, reranked by velocity in JS.
    let pool = await Article.aggregate([
      { $match: { language, publishedAt: { $gte: since }, viewCount: { $gt: 0 } } },
      { $sort: { viewCount: -1 } },
      { $limit: 100 },
      ...TRENDING_SOURCE_LOOKUP,
    ]);

    if (pool.length > 0) {
      pool = pool
        .map((a) => {
          const ageHours = Math.max(0.5, (Date.now() - new Date(a.publishedAt).getTime()) / 3.6e6);
          return { ...a, velocity: (a.viewCount || 0) / ageHours };
        })
        .sort((a, b) => b.velocity - a.velocity);
    } else {
      // Fallback: brand-new content with no views yet → newest first.
      pool = await Article.aggregate([
        { $match: { language, publishedAt: { $gte: since } } },
        { $sort: { publishedAt: -1 } },
        { $limit: TRENDING_MAX },
        ...TRENDING_SOURCE_LOOKUP,
      ]);
    }

    const trending = pool.slice(0, TRENDING_MAX);

    try {
      await redis.set(trendingCacheKey(language), JSON.stringify(trending), 'EX', TRENDING_CACHE_TTL);
    } catch (err) {
      // Non-fatal
    }

    res.setHeader('X-Cache', 'miss');
    return res.json(trending.slice(0, limit));
  } catch (error) {
    console.error('❌ /articles/trending error:', error);
    return res.status(500).json({ error: 'trending error', message: error.message });
  }
});

// GET one - Must be last to avoid conflicts with specific routes
articleRouter.get('/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id).populate('sourceId', 'name icon groupName');
    if (!article) return res.status(404).json({ message: 'Article not found' });

    // Add sourceName and sourceIcon from populated sourceId for client convenience
    const articleObj = article.toObject();
    if (article.sourceId && typeof article.sourceId === 'object') {
      articleObj.sourceName = article.sourceId.name || null;
      articleObj.sourceIcon = article.sourceId.icon || null;
    }

    res.json(articleObj);
  } catch (err) {
    console.error('GET /:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Find and Replace - Preview
articleRouter.post('/find-replace/preview', async (req, res) => {
  try {
    const { findText, replaceText } = req.body;

    if (!findText) {
      return res.status(400).json({ message: 'findText is required' });
    }

    console.log(`🔍 Preview find/replace: "${findText}" -> "${replaceText || '[REMOVE]'}" (markdown only)`);

    // Use Atlas Search for optimized content search (with fallback)
    const articles = await findInContent({
      findText,
      contentFormat: 'markdown',
      limit: 1000
    });

    const matchCount = articles.length;
    const examples = articles.slice(0, 3).map(a => ({
      id: a._id,
      title: a.title
    }));

    const totalMarkdown = await Article.countDocuments({ contentFormat: 'markdown' });

    console.log(`✅ Preview complete: ${matchCount} markdown articles found out of ${totalMarkdown} total`);

    res.json({
      matchCount,
      totalChecked: totalMarkdown,
      examples,
      findText,
      replaceText: replaceText || ''
    });
  } catch (error) {
    console.error('❌ Preview error:', error);
    res.status(500).json({ message: 'Failed to preview changes', error: error.message });
  }
});

// Find and Replace - Execute
articleRouter.post('/find-replace/execute', async (req, res) => {
  try {
    const { findText, replaceText } = req.body;

    if (!findText) {
      return res.status(400).json({ message: 'findText is required' });
    }

    // Detect if text contains non-Latin characters (Arabic, Farsi, etc.)
    const hasNonLatinChars = /[^\u0000-\u007F]/.test(findText);
    console.log(`🔄 Executing find/replace: "${findText}" -> "${replaceText || '[REMOVE]'}" (markdown only, Unicode: ${hasNonLatinChars})`);

    // Use Atlas Search to find articles (with fallback), then fetch full content for replacement
    const searchResults = await findInContent({
      findText,
      contentFormat: 'markdown',
      limit: 5000
    });

    // Fetch full articles for modification
    const articleIds = searchResults.map(a => a._id);
    const articles = await Article.find({ _id: { $in: articleIds } }).select('_id content contentFormat');

    let updatedCount = 0;

    // Build regex with proper Unicode support
    // For non-Latin text, use 'gu' flags for proper Unicode handling
    const escapedText = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = hasNonLatinChars
      ? new RegExp(escapedText, 'gu')  // Unicode-aware global replace
      : new RegExp(escapedText, 'gi'); // Case-insensitive for Latin text

    for (const article of articles) {
      const originalContent = article.content;
      const newContent = originalContent.replace(regex, replaceText || '');

      if (newContent !== originalContent) {
        // Clean up excessive whitespace
        article.content = newContent
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();

        await article.save();
        updatedCount++;

        if (updatedCount % 10 === 0) {
          console.log(`✅ Updated ${updatedCount} markdown articles...`);
        }
      }
    }

    // Clear caches after update
    await clearArticlesCache();

    console.log(`✅ Find/replace complete: ${updatedCount} markdown articles updated`);

    res.json({
      success: true,
      updatedCount,
      findText,
      replaceText: replaceText || '',
      message: `Successfully updated ${updatedCount} markdown article(s)`
    });
  } catch (error) {
    console.error('❌ Execute error:', error);
    res.status(500).json({ message: 'Failed to replace text', error: error.message });
  }
});

// ============================================================================
// Phase 3.3: Breaking News Routes
// ============================================================================

module.exports = articleRouter;
