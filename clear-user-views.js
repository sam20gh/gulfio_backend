/**
 * Clear user's recent view history from MongoDB
 * Since Redis is disabled, views are tracked in UserActivity
 */

require('dotenv').config();
const mongoose = require('mongoose');
const UserActivity = require('./models/UserActivity');

async function clearUserViewHistory() {
    const userId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d'; // sam20gh@gmail.com

    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);

        console.log(`\n🧹 Clearing view history for user: ${userId}`);

        // Count current view activities
        const beforeCount = await UserActivity.countDocuments({
            userId,
            eventType: 'reel_view'
        });

        console.log(`📊 Found ${beforeCount} view records`);

        if (beforeCount === 0) {
            console.log('ℹ️ No view records to clear');
        } else {
            // Option 1: Delete ALL view history (nuclear option)
            // const result = await UserActivity.deleteMany({
            //     userId,
            //     eventType: 'reel_view'
            // });

            // Option 2: Keep only last 5 views (recommended)
            const recentViews = await UserActivity.find({
                userId,
                eventType: 'reel_view'
            })
                .sort({ timestamp: -1 })
                .limit(5)
                .select('_id')
                .lean();

            const keepIds = recentViews.map(v => v._id);

            const result = await UserActivity.deleteMany({
                userId,
                eventType: 'reel_view',
                _id: { $nin: keepIds }
            });

            console.log(`✅ Deleted ${result.deletedCount} old view records`);
            console.log(`✅ Kept last 5 views for continuity`);
        }

        const afterCount = await UserActivity.countDocuments({
            userId,
            eventType: 'reel_view'
        });

        console.log(`\n📊 View history summary:`);
        console.log(`   Before: ${beforeCount} views`);
        console.log(`   After: ${afterCount} views`);
        console.log(`   Cleared: ${beforeCount - afterCount} views`);

        console.log(`\n🎉 User view history cleared!`);
        console.log(`\n💡 Next steps:`);
        console.log(`   1. Deploy the updated code: ./deploy-secure.sh`);
        console.log(`   2. Test the feed: ./test-reels-feed.sh`);
        console.log(`   3. You should now see new videos!`);

        await mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

clearUserViewHistory();
