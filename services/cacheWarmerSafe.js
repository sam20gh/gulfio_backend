class SafeCacheWarmer {
    constructor() {
        this.activeUsers = new Set();
        this.warmingInProgress = new Map();
        this.lastWarmTime = new Map();
        this.WARM_INTERVAL = 15 * 60 * 1000; // 15 minutes
        this.USER_ACTIVITY_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours
        this.isStarted = false;
        this.intervalId = null;
        this.cleanupIntervalId = null;
    }

    /**
     * Safe initialization - lazy load dependencies
     */
    async initialize() {
        if (this.isInitialized) return true;

        try {
            // Dynamically import dependencies to avoid startup issues
            const { User, Article, Source } = require('../models');
            const { redis } = require('../utils/redis');
            
            this.User = User;
            this.Article = Article;
            this.Source = Source;
            this.redis = redis;
            this.isInitialized = true;
            
            console.log('✅ Cache warmer initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Cache warmer initialization failed:', error.message);
            this.isInitialized = false;
            return false;
        }
    }

    /**
     * Mark user as active for cache warming
     */
    markUserActive(userId) {
        try {
            this.activeUsers.add(userId);
            console.log(`📊 Cache Warmer: User ${userId} marked as active. Total: ${this.activeUsers.size}`);
        } catch (error) {
            console.error('❌ Error marking user active:', error.message);
        }
    }

    /**
     * Start background cache warming service
     */
    async start() {
        if (this.isStarted) {
            console.log('⚠️ Cache warmer already started');
            return;
        }

        const initialized = await this.initialize();
        if (!initialized) {
            console.error('❌ Cannot start cache warmer - initialization failed');
            return;
        }

        try {
            console.log('🔥 Starting Safe Cache Warmer service...');
            this.isStarted = true;
            
            // Initial warm cycle (delayed)
            setTimeout(() => {
                this.warmActiveUsers().catch(error => {
                    console.error('❌ Initial warm cycle error:', error.message);
                });
            }, 30000); // Wait 30 seconds before first run

            // Schedule regular warming
            this.intervalId = setInterval(() => {
                this.warmActiveUsers().catch(error => {
                    console.error('❌ Scheduled warm cycle error:', error.message);
                });
            }, this.WARM_INTERVAL);

            // Clean up inactive users every hour
            this.cleanupIntervalId = setInterval(() => {
                this.cleanupInactiveUsers().catch(error => {
                    console.error('❌ Cleanup cycle error:', error.message);
                });
            }, 60 * 60 * 1000);

            console.log('✅ Safe Cache Warmer started successfully');
        } catch (error) {
            console.error('❌ Failed to start cache warmer:', error.message);
            this.stop();
        }
    }

    /**
     * Stop the cache warmer service
     */
    stop() {
        console.log('🛑 Stopping Cache Warmer service...');
        this.isStarted = false;
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = null;
        }
        
        console.log('✅ Cache Warmer stopped');
    }

    /**
     * Warm cache for all active users
     */
    async warmActiveUsers() {
        if (!this.isInitialized || !this.isStarted) {
            console.log('⏭️ Cache warmer not ready, skipping warm cycle');
            return;
        }

        const activeUsersList = Array.from(this.activeUsers);
        if (activeUsersList.length === 0) {
            console.log('📊 Cache Warmer: No active users to warm');
            return;
        }

        console.log(`🔥 Cache Warmer: Starting warm cycle for ${activeUsersList.length} active users`);

        const promises = activeUsersList.slice(0, 10).map(userId => 
            this.warmUserCache(userId).catch(error => {
                console.error(`❌ Error warming user ${userId}:`, error.message);
                return null;
            })
        );
        
        const results = await Promise.allSettled(promises);
        const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
        const failed = results.filter(r => r.status === 'rejected' || r.value === null).length;
        
        console.log(`🔥 Cache Warmer: Warm cycle complete. Success: ${successful}, Failed: ${failed}`);
    }

    /**
     * Warm cache for a specific user
     */
    async warmUserCache(userId) {
        if (!this.isInitialized || !userId) return;

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

            // Get user data with timeout
            const user = await Promise.race([
                this.User.findOne({ supabase_id: userId }).lean(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('User query timeout')), 5000)
                )
            ]);

            if (!user) {
                console.log(`⚠️ Cache Warmer: User ${userId} not found`);
                return;
            }

            // Warm only the most critical cache - fast articles
            await this.warmFastArticles(userId);

            const duration = Date.now() - startTime;
            console.log(`✅ Cache Warmer: User ${userId} cache warmed in ${duration}ms`);

        } catch (error) {
            console.error(`❌ Cache Warmer: Error warming cache for user ${userId}:`, error.message);
        } finally {
            this.warmingInProgress.delete(userId);
        }
    }

    /**
     * Pre-warm fast articles cache only (most critical)
     */
    async warmFastArticles(userId) {
        const language = 'english';
        const limit = 20;
        const page = 1;
        const cacheKey = `articles_fast_${userId}_page_${page}_limit_${limit}_lang_${language}`;

        try {
            // Check if already cached
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                console.log(`💾 Cache Warmer: Fast articles already cached for ${userId}`);
                return;
            }

            // Get user to exclude dislikes
            const user = await this.User.findOne({ supabase_id: userId }, 'disliked_articles').lean();
            const excludeIds = user?.disliked_articles || [];

            const articles = await Promise.race([
                this.Article.find({
                    language,
                    _id: { $nin: excludeIds },
                    publishedAt: { 
                        $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) // Last 48 hours
                    }
                })
                .populate('sourceId', 'name icon groupName')
                .sort({ publishedAt: -1, viewCount: -1 })
                .limit(limit)
                .lean(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Article query timeout')), 8000)
                )
            ]);

            if (articles && articles.length > 0) {
                const response = articles.map(article => ({
                    ...article,
                    fetchId: new Date().toISOString(),
                    isLight: true,
                    isWarmed: true
                }));

                await this.redis.set(cacheKey, JSON.stringify(response), 'EX', 1800); // 30 minutes
                console.log(`🔥 Cache Warmer: Cached ${articles.length} fast articles for ${userId}`);
            }
        } catch (error) {
            console.error(`⚠️ Cache Warmer: Error warming fast articles for ${userId}:`, error.message);
        }
    }

    /**
     * Clean up users who haven't been active recently
     */
    async cleanupInactiveUsers() {
        const before = this.activeUsers.size;
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
            console.log(`🧹 Cache Warmer: Cleaned up ${inactiveUsers.length} inactive users. Active: ${before} -> ${after}`);
        }
    }

    /**
     * Get cache warming statistics
     */
    getStats() {
        return {
            isInitialized: this.isInitialized,
            isStarted: this.isStarted,
            activeUsers: this.activeUsers.size,
            warmingInProgress: this.warmingInProgress.size,
            recentlyWarmed: this.lastWarmTime.size,
            intervalId: !!this.intervalId,
            cleanupIntervalId: !!this.cleanupIntervalId
        };
    }

    /**
     * Force warm cache for specific user
     */
    async forceWarmUser(userId) {
        console.log(`🔥 Cache Warmer: Force warming user ${userId}`);
        this.markUserActive(userId);
        
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                throw new Error('Cache warmer not initialized');
            }
        }
        
        await this.warmUserCache(userId);
    }
}

// Create singleton instance
const safeCacheWarmer = new SafeCacheWarmer();

module.exports = safeCacheWarmer;
