// The shared wrapper in utils/redis.js exposes plain command methods only — it is
// not an EventEmitter, so the old redis.once('ready')/redis.on('error')/redis.quit()
// form threw before this script could do anything. The wrapper connects eagerly and
// queues commands while connecting, so commands can just be issued directly.
const redis = require('../utils/redis');

const sourceId = process.argv[2] || '685f1af2fbf11130553a51c9';

(async () => {
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
        process.exit(0);
    } catch (err) {
        console.error('❌ Error clearing Redis cache:', err);
        process.exit(1);
    }
})();
