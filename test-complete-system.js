const User = require('./models/User');
const Article = require('./models/Article');
const UserActivity = require('./models/UserActivity');
const { updateUserProfileEmbedding } = require('./utils/userEmbedding');
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio');
        console.log('✅ Connected to MongoDB');

        // Get a user and some articles to create test activities
        const user = await User.findOne({}).select('_id email supabase_id');
        const articles = await Article.find({}).limit(5).select('_id title');

        if (!user || articles.length === 0) {
            console.log('❌ No user or articles found');
            process.exit(1);
        }

        console.log('\n📝 Creating test activities...');
        console.log(`User: ${user.email} (${user._id})`);
        console.log(`Articles: ${articles.length} found`);

        // Add some test activities to the user's direct arrays
        const articleIds = articles.map(a => a._id);
        await User.updateOne(
            { _id: user._id },
            {
                $set: {
                    liked_articles: [articleIds[0], articleIds[1]], // 2 liked
                    viewed_articles: articleIds.slice(0, 4), // 4 viewed (includes liked ones)
                    saved_articles: [articleIds[2]] // 1 saved
                }
            }
        );

        // Also create some UserActivity records to test integration
        const testActivities = [
            {
                userId: user.supabase_id,
                eventType: 'view',
                articleId: articleIds[3],
                timestamp: new Date(),
                duration: 5
            },
            {
                userId: user.supabase_id,
                eventType: 'read_time',
                articleId: articleIds[4],
                timestamp: new Date(),
                duration: 30 // 30 seconds reading
            },
            {
                userId: user.supabase_id,
                eventType: 'like',
                articleId: articleIds[0], // Same as direct like (should not duplicate)
                timestamp: new Date()
            }
        ];

        // Remove any existing UserActivity for this user and add new test data
        await UserActivity.deleteMany({ userId: user.supabase_id });
        await UserActivity.insertMany(testActivities);

        console.log('✅ Test data created - Direct activities + UserActivity records');

        // Test the enhanced embedding system
        console.log('\n🧪 Testing enhanced embedding system...');
        await updateUserProfileEmbedding(user._id);

        // Check results
        const updatedUser = await User.findById(user._id).select('embedding embedding_pca liked_articles viewed_articles saved_articles');
        const userActivityCount = await UserActivity.countDocuments({ userId: user.supabase_id });

        console.log('\n📊 Test Results:');
        console.log(`- Direct activities: ${updatedUser.liked_articles.length} liked, ${updatedUser.viewed_articles.length} viewed, ${updatedUser.saved_articles.length} saved`);
        console.log(`- UserActivity records: ${userActivityCount}`);
        console.log(`- Generated embedding: ${updatedUser.embedding?.length || 0}D`);
        console.log(`- Generated PCA: ${updatedUser.embedding_pca?.length || 0}D`);
        console.log('\n✅ Enhanced embedding system test completed successfully!');

        process.exit(0);
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
})();
