const Redis = require('ioredis');

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    tls: {
        servername: process.env.REDIS_HOST, // <-- ADD THIS
        rejectUnauthorized: false, // make SSL handshake loose (recommended on Render internal)
    },
    connectTimeout: 10000, // optional but safe
});

module.exports = redis;
