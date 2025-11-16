#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

async function checkUserEmbedding() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected\n');

        const userId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d';

        console.log(`🔍 Looking up user: ${userId}\n`);

        const user = await User.findOne({ supabase_id: userId })
            .select('supabase_id email embedding embedding_pca liked_reels saved_reels viewed_reels following_sources')
            .lean();

        if (!user) {
            console.log('❌ User not found!');
            process.exit(1);
        }

        console.log('📊 User Data:');
        console.log('  Email:', user.email);
        console.log('  Supabase ID:', user.supabase_id);
        console.log('\n🧠 Embeddings:');
        console.log('  embedding (1536D):', user.embedding?.length || 0, 'dimensions');
        console.log('  embedding_pca (128D):', user.embedding_pca?.length || 0, 'dimensions');

        if (user.embedding_pca && user.embedding_pca.length > 0) {
            console.log('  ✅ User HAS embedding_pca');
            console.log('  First 5 values:', user.embedding_pca.slice(0, 5));
        } else {
            console.log('  ❌ User MISSING embedding_pca');
        }

        console.log('\n📱 Interactions:');
        console.log('  Liked reels:', user.liked_reels?.length || 0);
        console.log('  Saved reels:', user.saved_reels?.length || 0);
        console.log('  Viewed reels:', user.viewed_reels?.length || 0);
        console.log('  Following sources:', user.following_sources?.length || 0);

        // Also check UserActivity
        const UserActivity = require('./models/UserActivity');
        const activityCount = await UserActivity.countDocuments({
            userId,
            eventType: { $in: ['view', 'like', 'save', 'reel_view'] }
        });
        console.log('  UserActivity records:', activityCount);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

checkUserEmbedding();
