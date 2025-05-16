// scripts/cleanupArticles.js
require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');
const { clearArticlesCache } = require('../utils/cache');

async function runCleanup() {
    await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    console.log('🗄️  Connected to MongoDB');

    try {
        // 1. DELETE articles with no images or empty image array
        const emptyImageFilter = {
            $or: [
                { image: { $exists: false } },
                { image: { $size: 0 } }
            ]
        };
        const { deletedCount: deletedEmpty } = await Article.deleteMany(emptyImageFilter);
        console.log(`🗑️  Deleted ${deletedEmpty} articles with empty/missing images`);

        // 2. FIND duplicate titles
        const dupes = await Article.aggregate([
            {
                $group: {
                    _id: '$title',
                    count: { $sum: 1 },
                    ids: { $push: '$_id' }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]);

        let totalDupeDeleted = 0;
        for (const { _id: title, ids } of dupes) {
            // keep the first one, delete the rest
            const [keepId, ...toDelete] = ids;
            const { deletedCount } = await Article.deleteMany({ _id: { $in: toDelete } });
            totalDupeDeleted += deletedCount;
            console.log(`🗑️  "${title}" — kept ${keepId.toString()}, deleted ${deletedCount} duplicates`);
        }
        console.log(`🗑️  Total duplicate-article deletions: ${totalDupeDeleted}`);

        // 3. CLEAR CACHE (if you need)
        if (typeof clearArticlesCache === 'function') {
            await clearArticlesCache();
            console.log('♻️  Articles cache cleared');
        }

    } catch (err) {
        console.error('❌ Error during cleanup:', err);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

runCleanup();
