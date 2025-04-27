// utils/redis.js
const Redis = require('ioredis');

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    tls: {} // ← important! because Render uses SSL/TLS on Redis connection
});

module.exports = redis;
