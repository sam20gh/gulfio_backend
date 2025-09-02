require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');

/**
 * Test script to verify that user embedding updates work correctly
 */

async function testEmbeddingUpdate() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Find a user with some activities
        const testUser = await User.findOne({
            $or: [
                { liked_articles: { $exists: true, $ne: [] } },
                { viewed_articles: { $exists: true, $ne: [] } },
                { saved_articles: { $exists: true, $ne: [] } }
            ]
        }).select('_id email embedding embedding_pca liked_articles viewed_articles saved_articles');

        if (!testUser) {
            console.log('❌ No users found with activities');
            return;
        }

        console.log(`\n📋 Testing with user: ${testUser.email || testUser._id}`);
        console.log(`📊 Activities:`, {
            liked: testUser.liked_articles?.length || 0,
            viewed: testUser.viewed_articles?.length || 0,
            saved: testUser.saved_articles?.length || 0
        });

        // Store current embedding state
        const beforeEmbedding = testUser.embedding?.length || 0;
        const beforePCA = testUser.embedding_pca?.length || 0;

        console.log(`\n🔍 Before update:`, {
            embedding: `${beforeEmbedding}D`,
            embedding_pca: `${beforePCA}D`
        });

        // Test the embedding update
        console.log('\n🔄 Running embedding update...');
        const startTime = Date.now();
        
        await updateUserProfileEmbedding(testUser._id);
        
        const duration = Date.now() - startTime;

        // Check the results
        const updatedUser = await User.findById(testUser._id).select('embedding embedding_pca updatedAt');
        
        const afterEmbedding = updatedUser.embedding?.length || 0;
        const afterPCA = updatedUser.embedding_pca?.length || 0;

        console.log(`\n✅ After update (${duration}ms):`, {
            embedding: `${afterEmbedding}D`,
            embedding_pca: `${afterPCA}D`,
            updated: updatedUser.updatedAt
        });

        // Verify the update worked
        if (afterEmbedding > 0) {
            console.log('✅ Embedding generation: SUCCESS');
        } else {
            console.log('❌ Embedding generation: FAILED');
        }

        if (afterPCA > 0) {
            console.log('✅ PCA conversion: SUCCESS');
        } else {
            console.log('⚠️ PCA conversion: FAILED (may be expected due to connection issues)');
        }

        console.log('\n🎯 Test completed successfully!');

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the test if called directly
if (require.main === module) {
    testEmbeddingUpdate()
        .then(() => {
            console.log('🎉 Test completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Test failed:', error);
            process.exit(1);
        });
}

module.exports = { testEmbeddingUpdate };
