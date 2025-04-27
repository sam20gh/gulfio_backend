const Redis = require('ioredis');

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    tls: {
        rejectUnauthorized: false,
    },
    connectTimeout: 10000, // optional
    maxRetriesPerRequest: 1, // 👈 prevent endless retries
    retryStrategy: () => null, // 👈 no auto-retry
});

module.exports = redis;
