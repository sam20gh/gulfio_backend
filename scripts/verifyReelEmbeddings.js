/**
 * Script to verify PCA embedding generation in the upload process
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Reel = require('../models/Reel');

// MongoDB connection
const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio';

async function connectToDatabase() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

async function verifyReelEmbeddings() {
    try {
        console.log('🔍 Verifying reel embeddings...\n');

        // Get the most recent reels
        const recentReels = await Reel.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .select('_id reelId caption createdAt embedding embedding_pca')
            .lean();

        console.log(`📊 Analyzing ${recentReels.length} most recent reels:\n`);

        for (const [index, reel] of recentReels.entries()) {
            console.log(`${index + 1}. Reel ID: ${reel._id}`);
            console.log(`   File: ${reel.reelId}`);
            console.log(`   Created: ${reel.createdAt}`);
            console.log(`   Caption: ${reel.caption?.substring(0, 50)}...`);
            console.log(`   Has embedding: ${!!reel.embedding} (${reel.embedding?.length || 0}D)`);
            console.log(`   Has PCA embedding: ${!!reel.embedding_pca} (${reel.embedding_pca?.length || 0}D)`);

            // Check if embeddings are valid
            const hasValidEmbedding = Array.isArray(reel.embedding) && reel.embedding.length === 1536;
            const hasValidPCA = Array.isArray(reel.embedding_pca) && reel.embedding_pca.length === 128;

            console.log(`   ✅ Valid embedding: ${hasValidEmbedding}`);
            console.log(`   ✅ Valid PCA: ${hasValidPCA}`);
            console.log('');
        }

        // Check overall statistics
        const totalReels = await Reel.countDocuments();
        const reelsWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $size: 1536 }
        });
        const reelsWithPCA = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $size: 128 }
        });
        const reelsWithBoth = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $size: 1536 },
            embedding_pca: { $exists: true, $type: 'array', $size: 128 }
        });

        console.log('📈 Overall Statistics:');
        console.log(`   Total reels: ${totalReels}`);
        console.log(`   With valid embedding (1536D): ${reelsWithEmbedding}`);
        console.log(`   With valid PCA embedding (128D): ${reelsWithPCA}`);
        console.log(`   With both embeddings: ${reelsWithBoth}`);
        console.log(`   Complete coverage: ${((reelsWithBoth / totalReels) * 100).toFixed(2)}%`);

        // Check for any reels missing embeddings
        const missingEmbedding = await Reel.countDocuments({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $not: { $size: 1536 } } }
            ]
        });

        const missingPCA = await Reel.countDocuments({
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { embedding_pca: { $not: { $size: 128 } } }
            ]
        });

        console.log('\n🚨 Issues to address:');
        console.log(`   Reels missing valid embedding: ${missingEmbedding}`);
        console.log(`   Reels missing valid PCA: ${missingPCA}`);

        if (missingEmbedding === 0 && missingPCA === 0) {
            console.log('\n🎉 Perfect! All reels have both valid embeddings.');
            console.log('   ✅ The upload process is working correctly.');
            console.log('   ✅ All existing data has been processed.');
        } else {
            console.log('\n⚠️ Some reels need attention:');
            if (missingEmbedding > 0) {
                console.log(`   - Run: npm run fix-reel-embeddings (to fix missing embeddings)`);
            }
            if (missingPCA > 0) {
                console.log(`   - Run: npm run update-reel-pca (to fix missing PCA embeddings)`);
            }
        }

    } catch (error) {
        console.error('❌ Error verifying reel embeddings:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await verifyReelEmbeddings();
        console.log('\n✅ Verification completed successfully');
    } catch (error) {
        console.error('❌ Verification failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
    }
}

// Run the script
if (require.main === module) {
    main();
}

module.exports = { verifyReelEmbeddings };
