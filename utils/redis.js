const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
    tls: {} // Important for Render's SSL Redis
});

module.exports = redis;
