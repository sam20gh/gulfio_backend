const Redis = require('ioredis');

let redis = null;

// Only initialize Redis if URL is provided and valid
if (process.env.REDIS_URL) {
    try {
        redis = new Redis(process.env.REDIS_URL, {
            connectTimeout: 10000,
            maxRetriesPerRequest: 3,
            enableOfflineQueue: true, // Allow commands to queue while connecting
            lazyConnect: false, // Connect immediately
            retryStrategy: (times) => {
                if (times > 3) {
                    console.warn('⚠️ Redis max retries reached, disabling cache');
                    return null; // Stop retrying
                }
                return Math.min(times * 100, 2000); // Exponential backoff
            }
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
    set: async (key, value, ...args) => {
        if (!redis) return;
        try {
            await redis.set(key, value, ...args);
        } catch (error) {
            console.warn('Redis SET error:', error.message);
        }
    },
    del: async (...keys) => {
        if (!redis) return 0;
        try {
            return await redis.del(...keys);
        } catch (error) {
            console.warn('Redis DEL error:', error.message);
            return 0;
        }
    },
    sadd: async (key, ...members) => {
        if (!redis) return 0;
        try {
            return await redis.sadd(key, ...members);
        } catch (error) {
            console.warn('Redis SADD error:', error.message);
            return 0;
        }
    },
    smembers: async (key) => {
        if (!redis) return [];
        try {
            return await redis.smembers(key);
        } catch (error) {
            console.warn('Redis SMEMBERS error:', error.message);
            return [];
        }
    },
    scard: async (key) => {
        if (!redis) return 0;
        try {
            return await redis.scard(key);
        } catch (error) {
            console.warn('Redis SCARD error:', error.message);
            return 0;
        }
    },
    srem: async (key, ...members) => {
        if (!redis) return 0;
        try {
            return await redis.srem(key, ...members);
        } catch (error) {
            console.warn('Redis SREM error:', error.message);
            return 0;
        }
    },
    expire: async (key, seconds) => {
        if (!redis) return;
        try {
            await redis.expire(key, seconds);
        } catch (error) {
            console.warn('Redis EXPIRE error:', error.message);
        }
    },
    keys: async (pattern) => {
        if (!redis) return [];
        try {
            return await redis.keys(pattern);
        } catch (error) {
            console.warn('Redis KEYS error:', error.message);
            return [];
        }
    },
    isConnected: () => redis && redis.status === 'ready'
};