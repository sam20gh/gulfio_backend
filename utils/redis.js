const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
    tls: {
        rejectUnauthorized: false,
    },
    connectTimeout: 10000,        // Timeout after 10s if can't connect
    maxRetriesPerRequest: 0,      // 💥 Very important: Don't retry failed commands
    enableOfflineQueue: false,    // 💥 Very important: Don't queue commands when disconnected
});

module.exports = redis;