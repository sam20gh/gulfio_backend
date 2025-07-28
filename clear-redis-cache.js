const redis = require('redis');

async function clearRedisCache() {
    const redisUrl = 'rediss://red-d07c0eqli9vc73f5pbp0:92Ujc6G8EX2raydimHZVNiaPCVmg66AE@oregon-keyvalue.render.com:6379';

    console.log('🔌 Connecting to Redis...');

    const client = redis.createClient({
        url: redisUrl,
        socket: {
            tls: true,
            rejectUnauthorized: false
        }
    });

    try {
        await client.connect();
        console.log('✅ Connected to Redis');

        // List all keys first
        console.log('\n🔍 Checking existing cache keys...');
        const keys = await client.keys('*');
        console.log(`📊 Found ${keys.length} cached keys:`);

        // Show personalized article cache keys
        const personalizedKeys = keys.filter(key => key.includes('personalized') || key.includes('articles'));
        if (personalizedKeys.length > 0) {
            console.log('🎯 Personalized article cache keys:');
            personalizedKeys.forEach(key => console.log(`   - ${key}`));
        }

        // Clear all cache
        console.log('\n🧹 Clearing ALL Redis cache...');
        const result = await client.flushAll();
        console.log('✅ Cache cleared:', result);

        // Verify cache is empty
        const keysAfter = await client.keys('*');
        console.log(`✅ Cache verification: ${keysAfter.length} keys remaining`);

        console.log('\n🎉 Redis cache successfully cleared!');
        console.log('   The next personalized articles request will fetch fresh results');

    } catch (error) {
        console.error('❌ Redis error:', error.message);
    } finally {
        await client.quit();
        console.log('🔌 Redis connection closed');
    }
}

clearRedisCache();
