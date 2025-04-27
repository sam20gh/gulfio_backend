const Redis = require('ioredis');

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    tls: {
        rejectUnauthorized: false, // make SSL handshake loose (recommended on Render internal)
    },
    connectTimeout: 10000,
});

module.exports = redis;
