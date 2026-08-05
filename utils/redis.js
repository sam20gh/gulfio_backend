const Redis = require('ioredis');

let redis = null;

// Only initialize Redis if URL is provided and valid
if (process.env.REDIS_URL) {
    try {
        redis = new Redis(process.env.REDIS_URL, {
            connectTimeout: 10000,
            // Per-command cap: while the connection is down, a command gives up after
            // this many reconnect attempts and rejects. The wrapper methods below catch
            // that and return their safe default, so callers degrade instead of hanging.
            maxRetriesPerRequest: 3,
            enableOfflineQueue: true, // Allow commands to queue while connecting
            lazyConnect: false, // Connect immediately
            // Reconnect forever with capped backoff. This must never return null:
            // returning null makes ioredis give up permanently, so a single blip
            // would kill caching AND rate limiting until the container restarted.
            retryStrategy: (times) => Math.min(times * 200, 30000),
        });

        // Throttled so a long outage doesn't flood logs — ioredis emits 'error' on
        // every failed reconnect attempt.
        let lastErrorLog = 0;
        let sawError = false;
        redis.on('error', (err) => {
            sawError = true;
            const now = Date.now();
            if (now - lastErrorLog > 30000) {
                lastErrorLog = now;
                // Do NOT null out the client here — ioredis reconnects on its own, and
                // isConnected() already reports status === 'ready' so callers fail open
                // while it's down and resume automatically once it recovers.
                console.error('Redis error (reconnecting):', err.message);
            }
        });

        redis.on('ready', () => {
            if (sawError) {
                sawError = false;
                console.log('✅ Redis reconnected');
            } else {
                console.log('✅ Redis connected successfully');
            }
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
        if (!redis) return null;
        try {
            // Return the result so callers can detect NX-lock acquisition
            // (`SET key val EX 30 NX` returns 'OK' on success or null when the
            // key already exists). Existing callers that ignore the return are
            // unaffected.
            return await redis.set(key, value, ...args);
        } catch (error) {
            console.warn('Redis SET error:', error.message);
            return null;
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
    // Returns the value after increment (1 on first write), so callers can tell
    // "I just created this key" from "I bumped an existing one" — that's how the
    // daily-limit counters know when to set their TTL. Returns 0 when unavailable.
    incr: async (key) => {
        if (!redis) return 0;
        try {
            return await redis.incr(key);
        } catch (error) {
            console.warn('Redis INCR error:', error.message);
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