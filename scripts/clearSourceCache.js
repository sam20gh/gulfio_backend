const redis = require('../utils/redis');

const sourceId = '685f1af2fbf11130553a51c9';

redis.once('ready', async () => {
    try {
        const keys = await redis.keys(`*${sourceId}*`);
        if (keys.length === 0) {
            console.log('No keys matched.');
            return process.exit(0);
        }

        console.log(`Found ${keys.length} keys. Deleting...`);
        for (const key of keys) {
            await redis.del(key);
            console.log(`✅ Deleted: ${key}`);
        }

        console.log('🚀 Done clearing cache.');
        await redis.quit();
        process.exit(0);
    } catch (err) {
        console.error('❌ Error clearing Redis cache:', err);
        process.exit(1);
    }
});

// Optional: catch connection errors
redis.on('error', (err) => {
    console.error('❌ Redis connection error:', err);
});
