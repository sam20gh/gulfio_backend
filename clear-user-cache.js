/**
 * Clear Redis cache for a specific user
 * This will force fresh feed generation
 */

require('dotenv').config();
const redis = require('./utils/redis');

async function clearUserCache() {
    const userId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d'; // sam20gh@gmail.com

    try {
        console.log(`🧹 Clearing cache for user: ${userId}`);

        // Clear viewed reels cache
        const viewedKey = `user:viewed:${userId}`;
        const deleted1 = await redis.del(viewedKey);
        console.log(`✅ Cleared viewed reels cache: ${deleted1 ? 'yes' : 'no'}`);

        // Clear user embedding cache
        const embeddingKey = `user:emb:${userId}`;
        const deleted2 = await redis.del(embeddingKey);
        console.log(`✅ Cleared embedding cache: ${deleted2 ? 'yes' : 'no'}`);

        // Find and clear any personalized feed caches
        console.log(`🔍 Searching for feed caches...`);

        // Get all keys matching the pattern
        const pattern = `reels_personalized_${userId}*`;
        const keys = await redis.keys(pattern);

        if (keys.length > 0) {
            console.log(`📋 Found ${keys.length} feed cache keys`);
            for (const key of keys) {
                await redis.del(key);
                console.log(`  ✅ Deleted: ${key}`);
            }
        } else {
            console.log(`ℹ️ No feed cache keys found`);
        }

        console.log(`\n🎉 Cache cleared successfully!`);
        console.log(`\n💡 Next steps:`);
        console.log(`   1. Test the feed: ./test-reels-feed.sh`);
        console.log(`   2. Or refresh mobile app`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

clearUserCache();
