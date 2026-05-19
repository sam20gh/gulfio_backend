// Clears only cache keys tied to Farsi feeds so the time-window widening fix
// takes effect immediately instead of waiting out the 10-minute TTL.
// Uses REDIS_URL from .env so credentials always match the live backend.
// Run: node clear-farsi-cache.js
require('dotenv').config();
const Redis = require('ioredis');

async function clearFarsiCache() {
    if (!process.env.REDIS_URL) {
        console.error('❌ REDIS_URL not set in environment');
        process.exit(1);
    }

    console.log('🔌 Connecting to Redis...');
    const redis = new Redis(process.env.REDIS_URL, {
        connectTimeout: 10000,
        maxRetriesPerRequest: 3,
    });

    redis.on('error', (err) => {
        console.error('Redis error:', err.message);
    });

    try {
        await new Promise((resolve, reject) => {
            redis.once('ready', resolve);
            redis.once('error', reject);
        });
        console.log('✅ Connected to Redis');

        const patterns = [
            'articles_pers_v2_*_farsi_*',
            'articles_pers_v2_page_*_farsi_*',
            'articles_following_*_farsi_*',
        ];

        let totalDeleted = 0;
        for (const pattern of patterns) {
            const keys = await redis.keys(pattern);
            console.log(`🎯 Pattern ${pattern} → ${keys.length} keys`);
            if (keys.length > 0) {
                const deleted = await redis.del(...keys);
                totalDeleted += deleted;
                console.log(`   ✅ Deleted ${deleted} keys`);
            }
        }

        console.log(`\n🎉 Done. Cleared ${totalDeleted} Farsi cache keys.`);
        console.log('   Next Farsi feed request will fetch fresh results with widened window.');
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await redis.quit().catch(() => {});
        console.log('🔌 Redis connection closed');
    }
}

clearFarsiCache();
