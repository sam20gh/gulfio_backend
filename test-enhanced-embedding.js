const User = require('./models/User');
const { updateUserProfileEmbedding } = require('./utils/userEmbedding');
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio');
        console.log('✅ Connected to MongoDB');

        // Get a user to test with
        const users = await User.find({}).select('_id email supabase_id embedding embedding_pca liked_articles viewed_articles').limit(3);

        console.log('\n📋 Available users:');
        users.forEach((user, index) => {
            console.log(`${index + 1}. ${user._id} (${user.email || 'no email'}) - Embedding: ${!!user.embedding && user.embedding.length > 0}, PCA: ${!!user.embedding_pca && user.embedding_pca.length > 0}, Activities: ${(user.liked_articles?.length || 0) + (user.viewed_articles?.length || 0)}`);
        });

        if (users.length === 0) {
            console.log('❌ No users found');
            process.exit(1);
        }

        // Test with the first user
        const testUser = users[0];
        console.log(`\n🧪 Testing enhanced embedding system with user: ${testUser._id}`);

        await updateUserProfileEmbedding(testUser._id);

        console.log('\n✅ Test completed successfully - checking results...');

        // Check the updated user
        const updatedUser = await User.findById(testUser._id).select('embedding embedding_pca');
        console.log(`📊 Results - Embedding: ${updatedUser.embedding?.length || 0}D, PCA: ${updatedUser.embedding_pca?.length || 0}D`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
})();
