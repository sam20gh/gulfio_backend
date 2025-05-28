// scripts/cleanupArticles.js
require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');
const Source = require('../models/Source');
const { clearArticlesCache } = require('../utils/cache');

async function runCleanup() {
    await mongoose.connect(process.env.MONGO_URI, {
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

        // 3. DELETE articles with invalid sourceIds
        console.log('🔍 Finding articles with invalid sourceIds...');

        // Get all valid source IDs
        const sources = await Source.find({}, '_id');
        const validSourceIds = sources.map(source => source._id.toString());

        // Find articles with sourceIds not in the valid list
        const orphanedArticles = await Article.find({
            sourceId: { $nin: validSourceIds }
        });

        if (orphanedArticles.length > 0) {
            console.log(`🗑️ Found ${orphanedArticles.length} articles with invalid sourceIds`);

            // Delete orphaned articles
            const { deletedCount } = await Article.deleteMany({
                sourceId: { $nin: validSourceIds }
            });

            console.log(`🗑️ Deleted ${deletedCount} orphaned articles with invalid sourceIds`);
        } else {
            console.log('✅ No articles with invalid sourceIds found');
        }

        // 4. CLEAR CACHE (if you need)
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
