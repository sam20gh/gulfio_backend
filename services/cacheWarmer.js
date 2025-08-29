const User = require('../models/User');
const Article = require('../models/Article');
const Source = require('../models/Source');
const { redis } = require('../utils/redis');

class CacheWarmer {
    constructor() {
        this.activeUsers = new Set();
        this.warmingInProgress = new Map();
        this.lastWarmTime = new Map();
        this.WARM_INTERVAL = 15 * 60 * 1000; // 15 minutes
        this.USER_ACTIVITY_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
    }

    /**
     * Mark user as active for cache warming
     */
    markUserActive(userId) {
        this.activeUsers.add(userId);
        console.log(`📊 Cache Warmer: User ${userId} marked as active. Total active users: ${this.activeUsers.size}`);
    }

    /**
     * Start background cache warming service
     */
    start() {
        try {
            console.log('🔥 Starting Cache Warmer service...');
            this.startTime = Date.now();

            // Don't start warming immediately - wait until server is fully up
            setTimeout(() => {
                console.log('🔥 Cache Warmer: Delayed initialization starting...');
                this.warmActiveUsers().catch(err => {
                    console.error('⚠️ Initial cache warming failed:', err.message);
                });
            }, 30000); // Wait 30 seconds after server start

            // Schedule regular warming (less frequent for stability)
            setInterval(() => {
                this.warmActiveUsers().catch(err => {
                    console.error('⚠️ Scheduled cache warming failed:', err.message);
                });
            }, this.WARM_INTERVAL * 2); // 30 minutes instead of 15

            // Clean up inactive users every 2 hours (less frequent)
            setInterval(() => {
                this.cleanupInactiveUsers().catch(err => {
                    console.error('⚠️ Cache cleanup failed:', err.message);
                });
            }, 120 * 60 * 1000); // 2 hours

            console.log('✅ Cache Warmer service started successfully (delayed mode)');
        } catch (error) {
            console.error('❌ Failed to start Cache Warmer service:', error.message);
            // Don't throw - let the app continue without cache warming
        }
    }

    /**
     * Warm cache for all active users
     */
    async warmActiveUsers() {
        const activeUsersList = Array.from(this.activeUsers);
        console.log(`🔥 Cache Warmer: Starting warm cycle for ${activeUsersList.length} active users`);

        const promises = activeUsersList.map(userId => this.warmUserCache(userId));
        const results = await Promise.allSettled(promises);

        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`🔥 Cache Warmer: Warm cycle complete. Success: ${successful}, Failed: ${failed}`);
    }

    /**
     * Warm cache for a specific user
     */
    async warmUserCache(userId) {
        // Prevent duplicate warming
        if (this.warmingInProgress.get(userId)) {
            console.log(`⏭️ Cache Warmer: Skipping ${userId}, already warming`);
            return;
        }

        // Check if recently warmed
        const lastWarm = this.lastWarmTime.get(userId);
        const now = Date.now();
        if (lastWarm && (now - lastWarm) < this.WARM_INTERVAL * 0.5) {
            console.log(`⏭️ Cache Warmer: Skipping ${userId}, recently warmed`);
            return;
        }

        this.warmingInProgress.set(userId, true);
        this.lastWarmTime.set(userId, now);

        try {
            console.log(`🔥 Cache Warmer: Warming cache for user ${userId}`);
            const startTime = Date.now();

            // Get user data
            const user = await User.findOne({ supabase_id: userId }).lean();
            if (!user) {
                console.log(`⚠️ Cache Warmer: User ${userId} not found`);
                return;
            }

            // Warm multiple cache keys
            await Promise.all([
                this.warmPersonalizedArticles(userId, user),
                this.warmFastArticles(userId),
                this.warmUserSources(userId, user)
            ]);

            const duration = Date.now() - startTime;
            console.log(`✅ Cache Warmer: User ${userId} cache warmed in ${duration}ms`);

        } catch (error) {
            console.error(`❌ Cache Warmer: Error warming cache for user ${userId}:`, error.message);
        } finally {
            this.warmingInProgress.delete(userId);
        }
    }

    /**
     * Pre-warm personalized articles cache
     */
    async warmPersonalizedArticles(userId, user) {
        const language = 'english';
        const limit = 20;
        const page = 1;

        const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const noveltySeed = this.simpleHash(`${userId}:${page}:${dayKey}`);
        const cacheKey = `articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}_${dayKey}_${noveltySeed}`;

        // Check if already cached
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log(`💾 Cache Warmer: Personalized articles already cached for ${userId}`);
                return;
            }
        } catch (err) {
            // Continue if Redis error
        }

        // Pre-generate personalized articles
        const userEmbedding = user?.embedding_pca || user?.embedding;
        if (!userEmbedding) {
            console.log(`⚠️ Cache Warmer: No user embedding for ${userId}`);
            return;
        }

        // Get recent articles for vector search
        const articles = await Article.aggregate([
            {
                $match: {
                    language,
                    publishedAt: {
                        $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
                    }
                }
            },
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
            { $limit: limit }
        ]);

        if (articles.length > 0) {
            const response = articles.map(article => ({
                ...article,
                fetchId: new Date().toISOString(),
                isWarmed: true
            }));

            // Cache for 1 hour
            try {
                await redis.set(cacheKey, JSON.stringify(response), 'EX', 3600);
                console.log(`🔥 Cache Warmer: Cached ${articles.length} personalized articles for ${userId}`);
            } catch (err) {
                console.error(`⚠️ Cache Warmer: Redis set error:`, err.message);
            }
        }
    }

    /**
     * Pre-warm fast articles cache
     */
    async warmFastArticles(userId) {
        const language = 'english';
        const limit = 20;
        const page = 1;
        const cacheKey = `articles_fast_${userId}_page_${page}_limit_${limit}_lang_${language}`;

        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log(`💾 Cache Warmer: Fast articles already cached for ${userId}`);
                return;
            }
        } catch (err) {
            // Continue if Redis error
        }

        // Get user to exclude dislikes
        const user = await User.findOne({ supabase_id: userId }, 'disliked_articles').lean();
        const excludeIds = user?.disliked_articles || [];

        const articles = await Article.find({
            language,
            _id: { $nin: excludeIds },
            publishedAt: {
                $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) // Last 48 hours
            }
        })
            .populate('sourceId', 'name icon groupName')
            .sort({ publishedAt: -1, viewCount: -1 })
            .limit(limit)
            .lean();

        if (articles.length > 0) {
            const response = articles.map(article => ({
                ...article,
                fetchId: new Date().toISOString(),
                isLight: true,
                isWarmed: true
            }));

            try {
                await redis.set(cacheKey, JSON.stringify(response), 'EX', 1800); // 30 minutes
                console.log(`🔥 Cache Warmer: Cached ${articles.length} fast articles for ${userId}`);
            } catch (err) {
                console.error(`⚠️ Cache Warmer: Redis set error:`, err.message);
            }
        }
    }

    /**
     * Pre-warm user sources cache
     */
    async warmUserSources(userId, user) {
        const cacheKey = `sources_all_cached`;

        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log(`💾 Cache Warmer: Sources already cached globally`);
                return;
            }
        } catch (err) {
            // Continue if Redis error
        }

        const sources = await Source.find({}).lean();
        if (sources.length > 0) {
            try {
                await redis.set(cacheKey, JSON.stringify(sources), 'EX', 7200); // 2 hours
                console.log(`🔥 Cache Warmer: Cached ${sources.length} sources globally`);
            } catch (err) {
                console.error(`⚠️ Cache Warmer: Redis set error:`, err.message);
            }
        }
    }

    /**
     * Clean up users who haven't been active recently
     */
    async cleanupInactiveUsers() {
        const before = this.activeUsers.size;

        // In a real implementation, you'd check user activity from database
        // For now, just remove users who haven't been warmed recently
        const now = Date.now();
        const inactiveUsers = [];

        for (const userId of this.activeUsers) {
            const lastWarm = this.lastWarmTime.get(userId);
            if (!lastWarm || (now - lastWarm) > this.USER_ACTIVITY_THRESHOLD) {
                inactiveUsers.push(userId);
            }
        }

        inactiveUsers.forEach(userId => {
            this.activeUsers.delete(userId);
            this.lastWarmTime.delete(userId);
            this.warmingInProgress.delete(userId);
        });

        const after = this.activeUsers.size;
        if (inactiveUsers.length > 0) {
            console.log(`🧹 Cache Warmer: Cleaned up ${inactiveUsers.length} inactive users. Active users: ${before} -> ${after}`);
        }
    }

    /**
     * Simple hash function for cache keys
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    /**
     * Get cache warming statistics
     */
    getStats() {
        return {
            activeUsers: this.activeUsers.size,
            warmingInProgress: this.warmingInProgress.size,
            recentlyWarmed: this.lastWarmTime.size,
            uptime: Date.now() - this.startTime
        };
    }

    /**
     * Force warm cache for specific user
     */
    async forceWarmUser(userId) {
        console.log(`🔥 Cache Warmer: Force warming user ${userId}`);
        this.markUserActive(userId);
        await this.warmUserCache(userId);
    }
}

// Create singleton instance
const cacheWarmer = new CacheWarmer();

module.exports = cacheWarmer;
