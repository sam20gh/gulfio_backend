const mongoose = require('mongoose');
const User = require('./models/User');
const Article = require('./models/Article');
const UserActivity = require('./models/UserActivity');
require('dotenv').config();

async function debugRecommendations() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        const supabaseId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d';

        // Find the user
        const user = await User.findOne({ supabase_id: supabaseId }).lean();
        if (!user) {
            console.log('❌ User not found:', supabaseId);
            return;
        }

        console.log('✅ Found user:', user._id);

        // Check user activities
        const activityCount = await UserActivity.countDocuments({ userId: user._id });
        console.log('📊 User activities count:', activityCount);

        if (activityCount > 0) {
            const activities = await UserActivity.find({ userId: user._id }).limit(5);
            console.log('Recent activities:');
            activities.forEach((activity, index) => {
                console.log(`${index + 1}. ${activity.eventType} - ${activity.articleId} - ${activity.timestamp}`);
            });
        }

        // Test the aggregation pipeline
        console.log('\n🔍 Testing aggregation pipeline...');

        const pipeline = [
            { $match: { userId: user._id } },
            { $group: { _id: '$eventType', count: { $sum: 1 } } }
        ];

        try {
            const result = await UserActivity.aggregate(pipeline);
            console.log('✅ Basic aggregation succeeded:', result);
        } catch (error) {
            console.log('❌ Basic aggregation failed:', error.message);
        }

        // Test fallback logic
        console.log('\n🔍 Testing fallback logic...');

        try {
            const fallbackArticles = await Article.find({})
                .sort({ publishedAt: -1 })
                .limit(10)
                .lean();

            console.log('✅ Fallback articles found:', fallbackArticles.length);
            if (fallbackArticles.length > 0) {
                console.log('First fallback article:', fallbackArticles[0].title);
            }
        } catch (error) {
            console.log('❌ Fallback query failed:', error.message);
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

debugRecommendations();
