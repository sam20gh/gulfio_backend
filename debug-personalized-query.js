/**
 * Debug why personalized feed returns 0 reels
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function debugPersonalizedQuery() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);

        const db = mongoose.connection.db;
        const reelsCollection = db.collection('reels');
        const usersCollection = db.collection('users');

        const userId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d';

        // Get user embedding
        console.log('\n1️⃣ Fetching user embedding...');
        const user = await usersCollection.findOne({ supabase_id: userId });

        if (!user || !user.embedding_pca) {
            console.log('❌ User has no embedding_pca!');
            process.exit(1);
        }

        console.log(`✅ User embedding: ${user.embedding_pca.length}D`);

        // Check total reels
        console.log('\n2️⃣ Checking total reels...');
        const totalReels = await reelsCollection.countDocuments();
        console.log(`Total reels: ${totalReels}`);

        // Check reels with embeddings
        const reelsWithEmbedding = await reelsCollection.countDocuments({
            embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } }
        });
        console.log(`Reels with embedding_pca: ${reelsWithEmbedding}`);

        // Check reels with videoUrl
        const reelsWithVideo = await reelsCollection.countDocuments({
            videoUrl: { $exists: true, $ne: null }
        });
        console.log(`Reels with videoUrl: ${reelsWithVideo}`);

        // Check recent reels (last 30 days)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recentReels = await reelsCollection.countDocuments({
            scrapedAt: { $gte: thirtyDaysAgo }
        });
        console.log(`Reels from last 30 days: ${recentReels}`);

        // Check reels matching ALL criteria
        const matchingReels = await reelsCollection.countDocuments({
            embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } },
            videoUrl: { $exists: true, $ne: null },
            scrapedAt: { $gte: thirtyDaysAgo }
        });
        console.log(`Reels matching all criteria: ${matchingReels}`);

        // Get user's viewed reels count
        console.log('\n3️⃣ Checking user activity...');
        const viewedCount = user.viewed_reels?.length || 0;
        console.log(`User's viewed reels: ${viewedCount}`);

        // Try a simple vector search
        console.log('\n4️⃣ Testing vector search...');
        try {
            const vectorResults = await reelsCollection.aggregate([
                {
                    $vectorSearch: {
                        index: 'default',
                        queryVector: user.embedding_pca,
                        path: 'embedding_pca',
                        numCandidates: 100,
                        limit: 20
                    }
                },
                {
                    $project: {
                        _id: 1,
                        videoUrl: 1,
                        scrapedAt: 1,
                        searchScore: { $meta: 'vectorSearchScore' }
                    }
                }
            ]).toArray();

            console.log(`✅ Vector search returned: ${vectorResults.length} reels`);

            if (vectorResults.length > 0) {
                console.log('\nTop 3 results:');
                vectorResults.slice(0, 3).forEach((reel, i) => {
                    console.log(`  ${i + 1}. Score: ${reel.searchScore?.toFixed(4)}, Has video: ${!!reel.videoUrl}, Date: ${reel.scrapedAt?.toISOString().split('T')[0]}`);
                });
            }

            // Check how many have videoUrl
            const withVideo = vectorResults.filter(r => r.videoUrl).length;
            console.log(`  With videoUrl: ${withVideo}/${vectorResults.length}`);

            // Check how many are recent
            const recentVectorReels = vectorResults.filter(r => r.scrapedAt && r.scrapedAt >= thirtyDaysAgo).length;
            console.log(`  From last 30 days: ${recentVectorReels}/${vectorResults.length}`);

            // Check how many match all criteria
            const matchingVectorReels = vectorResults.filter(r =>
                r.videoUrl && r.scrapedAt && r.scrapedAt >= thirtyDaysAgo
            ).length;
            console.log(`  Matching all criteria: ${matchingVectorReels}/${vectorResults.length}`);

        } catch (err) {
            console.error('❌ Vector search error:', err.message);
        }

        // Check if scrapedAt field has issues
        console.log('\n5️⃣ Checking scrapedAt field...');
        const reelsWithoutScrapedAt = await reelsCollection.countDocuments({
            scrapedAt: { $exists: false }
        });
        console.log(`Reels without scrapedAt: ${reelsWithoutScrapedAt}`);

        const reelsWithNullScrapedAt = await reelsCollection.countDocuments({
            scrapedAt: null
        });
        console.log(`Reels with null scrapedAt: ${reelsWithNullScrapedAt}`);

        // Sample a few reels to see their structure
        console.log('\n6️⃣ Sample reel structure:');
        const sampleReels = await reelsCollection.find()
            .limit(3)
            .project({ _id: 1, videoUrl: 1, scrapedAt: 1, 'embedding_pca': 1 })
            .toArray();

        sampleReels.forEach((reel, i) => {
            console.log(`\nReel ${i + 1}:`);
            console.log(`  _id: ${reel._id}`);
            console.log(`  videoUrl: ${reel.videoUrl ? 'present' : 'missing'}`);
            console.log(`  scrapedAt: ${reel.scrapedAt || 'missing'}`);
            console.log(`  embedding_pca: ${reel.embedding_pca ? `${reel.embedding_pca.length}D` : 'missing'}`);
        });

        await mongoose.disconnect();
        console.log('\n✅ Debug complete!');

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

debugPersonalizedQuery();
