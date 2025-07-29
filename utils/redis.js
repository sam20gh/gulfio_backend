const Redis = require('ioredis');

let redis = null;

// Only initialize Redis if URL is provided and valid
if (process.env.REDIS_URL && !process.env.REDIS_URL.includes('red-d07c0eqli9vc73f5pbp0')) {
    try {
        redis = new Redis(process.env.REDIS_URL, {
            connectTimeout: 10000,
            maxRetriesPerRequest: 0,
            enableOfflineQueue: false,
        });

        redis.on('error', (err) => {
            console.error('Redis error:', err);
            redis = null; // Disable redis on error
        });

        redis.on('connect', () => {
            console.log('✅ Redis connected successfully');
        });
    } catch (error) {
        console.warn('⚠️ Redis initialization failed, continuing without cache:', error.message);
        redis = null;
    }
} else {
    console.log('⚠️ Redis disabled - URL not configured or using invalid hostname');
}

// Export a safe Redis wrapper
module.exports = {
    get: async (key) => {
        if (!redis) return null;
        try {
            return await redis.get(key);
        } catch (error) {
            console.warn('Redis GET error:', error.message);
            return null;
        }
    },
    set: async (key, value, ex) => {
        if (!redis) return;
        try {
            if (ex) {
                await redis.set(key, value, 'EX', ex);
            } else {
                await redis.set(key, value);
            }
        } catch (error) {
            console.warn('Redis SET error:', error.message);
        }
    },
    del: async (key) => {
        if (!redis) return;
        try {
            await redis.del(key);
        } catch (error) {
            console.warn('Redis DEL error:', error.message);
        }
    },
    isConnected: () => redis && redis.status === 'ready'
};