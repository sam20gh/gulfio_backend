const redis = require('./redis');

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

module.exports = { clearArticlesCache };
