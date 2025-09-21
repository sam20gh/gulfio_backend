/**
 * Find and fix the last remaining reel missing embedding
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Reel = require('../models/Reel');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');

// MongoDB connection
const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio';

async function connectToDatabase() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');
        console.log('📍 Database:', mongoose.connection.db.databaseName);
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

async function fixLastReel() {
    try {
        console.log('🔄 Finding the last reel missing embedding...\n');

        // Find the specific reel that's missing embedding
        const reelMissingEmbedding = await Reel.findOne({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $size: 0 } },
                { embedding: [] }
            ]
        }).select('_id caption reelId createdAt').lean();

        if (!reelMissingEmbedding) {
            console.log('✅ All reels have embeddings! No work needed.');
            return;
        }

        console.log('🔍 Found reel missing embedding:');
        console.log(`   ID: ${reelMissingEmbedding._id}`);
        console.log(`   Caption: ${reelMissingEmbedding.caption || 'No caption'}`);
        console.log(`   Created: ${reelMissingEmbedding.createdAt || 'Unknown'}`);

        // Try to generate embedding for this reel
        const embedInput = reelMissingEmbedding.caption || `Video reel ${reelMissingEmbedding.reelId || reelMissingEmbedding._id}`;
        console.log(`\n🔄 Generating embedding for: "${embedInput.substring(0, 60)}..."`);

        // Try multiple times if needed
        let embedding = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (!embedding && attempts < maxAttempts) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/${maxAttempts}...`);
                embedding = await getDeepSeekEmbedding(embedInput);

                if (embedding && embedding.length === 1536) {
                    console.log('✅ Successfully generated 1536D embedding');
                    break;
                } else {
                    console.log(`❌ Invalid embedding received: ${embedding ? embedding.length : 'null'} dimensions`);
                    embedding = null;
                }
            } catch (error) {
                console.log(`❌ Attempt ${attempts} failed:`, error.message);
                if (attempts < maxAttempts) {
                    console.log('⏳ Waiting 2 seconds before retry...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        if (embedding && embedding.length === 1536) {
            // Generate PCA embedding too
            console.log('🔄 Generating PCA embedding...');
            const embedding_pca = await convertToPCAEmbedding(embedding);

            // Update reel with both embeddings
            const updateData = { embedding };
            if (embedding_pca && embedding_pca.length === 128) {
                updateData.embedding_pca = embedding_pca;
                console.log('✅ Generated 128D PCA embedding');
            } else {
                console.log('❌ Failed to generate PCA embedding');
            }

            await Reel.updateOne(
                { _id: reelMissingEmbedding._id },
                { $set: updateData }
            );

            console.log('\n🎉 Successfully updated reel with embeddings!');

            // Verify the update
            const updatedReel = await Reel.findById(reelMissingEmbedding._id).select('embedding embedding_pca').lean();
            console.log(`✅ Verification: embedding length = ${updatedReel.embedding?.length || 0}`);
            console.log(`✅ Verification: PCA embedding length = ${updatedReel.embedding_pca?.length || 0}`);

        } else {
            console.log('\n❌ Failed to generate embedding after all attempts');
            console.log('💡 This reel may need manual attention or the caption may be problematic');
        }

        // Final count
        const totalReels = await Reel.countDocuments();
        const reelsWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] }
        });
        const reelsWithPCA = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $ne: [] }
        });

        console.log(`\n📊 Final status:
    - Total reels: ${totalReels}
    - Reels with embeddings: ${reelsWithEmbedding}
    - Reels with PCA embeddings: ${reelsWithPCA}
    - Embedding coverage: ${totalReels > 0 ? ((reelsWithEmbedding / totalReels) * 100).toFixed(2) : 0}%
    - PCA coverage: ${totalReels > 0 ? ((reelsWithPCA / totalReels) * 100).toFixed(2) : 0}%`);

    } catch (error) {
        console.error('❌ Error during fix:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await fixLastReel();
        console.log('✅ Script completed successfully');
    } catch (error) {
        console.error('❌ Script failed:', error);
    } finally {
        console.log('👋 Disconnecting from MongoDB');
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main();
}
