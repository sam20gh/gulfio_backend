/**
 * Script to update all existing reels with PCA embeddings
 * This will process reels that have embedding but missing embedding_pca
 */

const mongoose = require('mongoose');
const Reel = require('../models/Reel');
const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');

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

async function updateReelPCAEmbeddings() {
    try {
        console.log('🔄 Starting PCA embedding update for reels...');

        // Find reels that have embedding but missing embedding_pca
        const reelsToUpdate = await Reel.find({
            embedding: { $exists: true, $ne: null, $type: 'array' },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { embedding_pca: { $size: 0 } }
            ]
        }).select('_id embedding caption reelId').lean();

        console.log(`📊 Found ${reelsToUpdate.length} reels that need PCA embedding updates`);

        if (reelsToUpdate.length === 0) {
            console.log('✅ All reels already have PCA embeddings!');
            return;
        }

        let processed = 0;
        let successful = 0;
        let failed = 0;

        // Process in batches to avoid memory issues
        const batchSize = 50;
        for (let i = 0; i < reelsToUpdate.length; i += batchSize) {
            const batch = reelsToUpdate.slice(i, i + batchSize);
            console.log(`\n📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(reelsToUpdate.length / batchSize)} (${batch.length} reels)`);

            for (const reel of batch) {
                try {
                    processed++;

                    // Validate embedding
                    if (!Array.isArray(reel.embedding) || reel.embedding.length !== 1536) {
                        console.warn(`⚠️ Reel ${reel._id}: Invalid embedding (length: ${reel.embedding?.length || 'N/A'})`);
                        failed++;
                        continue;
                    }

                    // Generate PCA embedding
                    const embedding_pca = await convertToPCAEmbedding(reel.embedding);

                    if (embedding_pca && embedding_pca.length === 128) {
                        // Update the reel with PCA embedding
                        await Reel.updateOne(
                            { _id: reel._id },
                            { $set: { embedding_pca: embedding_pca } }
                        );

                        successful++;
                        console.log(`✅ Updated reel ${reel._id} (${processed}/${reelsToUpdate.length}): ${reel.caption?.substring(0, 50)}...`);
                    } else {
                        console.warn(`⚠️ Failed to generate PCA embedding for reel ${reel._id}`);
                        failed++;
                    }

                    // Progress update every 10 reels
                    if (processed % 10 === 0) {
                        console.log(`📈 Progress: ${processed}/${reelsToUpdate.length} processed (${successful} successful, ${failed} failed)`);
                    }

                } catch (error) {
                    console.error(`❌ Error processing reel ${reel._id}:`, error.message);
                    failed++;
                }
            }

            // Small delay between batches to avoid overwhelming the system
            if (i + batchSize < reelsToUpdate.length) {
                console.log('⏳ Waiting 2 seconds before next batch...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log('\n🎉 PCA embedding update completed!');
        console.log(`📊 Summary:
        - Total reels processed: ${processed}
        - Successfully updated: ${successful}
        - Failed updates: ${failed}
        - Success rate: ${((successful / processed) * 100).toFixed(2)}%`);

        // Verify the update
        const updatedCount = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $ne: [] }
        });

        const totalWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] }
        });

        console.log(`\n🔍 Verification:
        - Reels with embedding: ${totalWithEmbedding}
        - Reels with PCA embedding: ${updatedCount}
        - Coverage: ${((updatedCount / totalWithEmbedding) * 100).toFixed(2)}%`);

    } catch (error) {
        console.error('❌ Error updating reel PCA embeddings:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await updateReelPCAEmbeddings();
        console.log('✅ Script completed successfully');
    } catch (error) {
        console.error('❌ Script failed:', error);
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

module.exports = { updateReelPCAEmbeddings };
