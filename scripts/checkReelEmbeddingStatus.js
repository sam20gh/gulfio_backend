/**
 * Quick verification script to check reel embedding status
 */

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

async function checkReelEmbeddingStatus() {
    try {
        console.log('🔍 Checking reel embedding status...\n');

        // Basic counts
        const totalReels = await Reel.countDocuments();
        const reelsWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] }
        });
        const reelsWithPCA = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $ne: [] }
        });

        // More detailed counts
        const reelsWithValidEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $size: 1536 }
        });
        const reelsWithValidPCA = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $size: 128 }
        });

        // Reels that need work
        const reelsNeedingEmbedding = await Reel.countDocuments({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $size: 0 } }
            ]
        });

        const reelsNeedingPCA = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { embedding_pca: { $size: 0 } }
            ]
        });

        // Sample reels for debugging
        const sampleReelsWithoutEmbedding = await Reel.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $size: 0 } }
            ]
        }).select('_id caption reelId scrapedAt').limit(3).lean();

        const sampleReelsWithoutPCA = await Reel.find({
            embedding: { $exists: true, $type: 'array', $ne: [] },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { embedding_pca: { $size: 0 } }
            ]
        }).select('_id caption reelId scrapedAt embedding').limit(3).lean();

        console.log(`📊 REEL EMBEDDING STATUS REPORT
        
🎯 OVERVIEW:
        Total reels: ${totalReels}
        
🧠 EMBEDDING STATUS:
        ✅ With embedding: ${reelsWithEmbedding} (${((reelsWithEmbedding / totalReels) * 100).toFixed(2)}%)
        ✅ Valid 1536D embedding: ${reelsWithValidEmbedding} (${((reelsWithValidEmbedding / totalReels) * 100).toFixed(2)}%)
        ❌ Missing embedding: ${reelsNeedingEmbedding} (${((reelsNeedingEmbedding / totalReels) * 100).toFixed(2)}%)
        
🧮 PCA EMBEDDING STATUS:
        ✅ With PCA embedding: ${reelsWithPCA} (${((reelsWithPCA / totalReels) * 100).toFixed(2)}%)
        ✅ Valid 128D PCA embedding: ${reelsWithValidPCA} (${((reelsWithValidPCA / totalReels) * 100).toFixed(2)}%)
        ❌ Missing PCA embedding: ${reelsNeedingPCA} (${((reelsNeedingPCA / totalReels) * 100).toFixed(2)}%)
        
🔧 WORK NEEDED:
        - Generate ${reelsNeedingEmbedding} embeddings
        - Generate ${reelsNeedingPCA} PCA embeddings
        `);

        if (sampleReelsWithoutEmbedding.length > 0) {
            console.log('\n📋 SAMPLE REELS WITHOUT EMBEDDING:');
            sampleReelsWithoutEmbedding.forEach((reel, i) => {
                console.log(`   ${i + 1}. ID: ${reel._id}`);
                console.log(`      Caption: ${reel.caption?.substring(0, 50) || 'No caption'}...`);
                console.log(`      Date: ${reel.scrapedAt || 'Unknown'}`);
                console.log('');
            });
        }

        if (sampleReelsWithoutPCA.length > 0) {
            console.log('\n📋 SAMPLE REELS WITHOUT PCA EMBEDDING:');
            sampleReelsWithoutPCA.forEach((reel, i) => {
                console.log(`   ${i + 1}. ID: ${reel._id}`);
                console.log(`      Caption: ${reel.caption?.substring(0, 50) || 'No caption'}...`);
                console.log(`      Embedding length: ${reel.embedding?.length || 'N/A'}`);
                console.log(`      Date: ${reel.scrapedAt || 'Unknown'}`);
                console.log('');
            });
        }

        console.log('\n💡 RECOMMENDED ACTIONS:');
        if (reelsNeedingEmbedding > 0) {
            console.log(`   🔧 Run: node scripts/fixReelEmbeddings.js (fixes both embedding and PCA)`);
        } else if (reelsNeedingPCA > 0) {
            console.log(`   🔧 Run: node scripts/updateReelPCAEmbeddings.js (fixes only PCA)`);
        } else {
            console.log(`   ✅ All reels have embeddings! No action needed.`);
        }

    } catch (error) {
        console.error('❌ Error checking reel embedding status:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await checkReelEmbeddingStatus();
        console.log('\n✅ Status check completed');
    } catch (error) {
        console.error('❌ Status check failed:', error);
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

module.exports = { checkReelEmbeddingStatus };
