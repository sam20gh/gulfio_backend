const redis = new Redis(process.env.REDIS_URL, {
    tls: {
        rejectUnauthorized: false,
    },
    connectTimeout: 10000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
});

redis.on('error', (err) => {
    console.error('Redis error:', err);
});

module.exports = redis;