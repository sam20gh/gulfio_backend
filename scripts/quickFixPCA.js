/**
 * Quick fix script to generate PCA embeddings for all reels that have regular embeddings
 * but are missing PCA embeddings
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Reel = require('../models/Reel');
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

async function quickFixPCAEmbeddings() {
    try {
        console.log('🔄 Quick fix: Generating missing PCA embeddings...\n');

        // Find reels that have valid embeddings but missing or invalid PCA embeddings
        const reelsNeedingPCA = await Reel.find({
            embedding: { $exists: true, $type: 'array', $size: 1536 }, // Has valid 1536D embedding
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { embedding_pca: { $size: 0 } }, // Empty array
                { embedding_pca: { $not: { $size: 128 } } } // Not 128D
            ]
        }).select('_id embedding caption reelId createdAt').lean();

        console.log(`📊 Found ${reelsNeedingPCA.length} reels that need PCA embeddings`);

        if (reelsNeedingPCA.length === 0) {
            console.log('✅ All reels already have valid PCA embeddings!');
            return;
        }

        let processed = 0;
        let successful = 0;
        let failed = 0;

        // Process in batches to avoid memory issues
        const batchSize = 25;
        for (let i = 0; i < reelsNeedingPCA.length; i += batchSize) {
            const batch = reelsNeedingPCA.slice(i, i + batchSize);
            console.log(`\n📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(reelsNeedingPCA.length / batchSize)} (${batch.length} reels)`);

            for (const reel of batch) {
                try {
                    processed++;

                    // Generate PCA embedding
                    const embedding_pca = await convertToPCAEmbedding(reel.embedding);

                    if (embedding_pca && embedding_pca.length === 128) {
                        // Update the reel with PCA embedding
                        await Reel.updateOne(
                            { _id: reel._id },
                            { $set: { embedding_pca: embedding_pca } }
                        );

                        successful++;
                        const caption = reel.caption?.substring(0, 40) || 'No caption';
                        console.log(`✅ ${processed}/${reelsNeedingPCA.length}: Updated ${reel._id} - "${caption}..."`);
                    } else {
                        console.warn(`⚠️ Failed to generate PCA for reel ${reel._id}`);
                        failed++;
                    }

                    // Progress update every 10 reels
                    if (processed % 10 === 0) {
                        console.log(`📈 Progress: ${processed}/${reelsNeedingPCA.length} (${successful} ✅, ${failed} ❌)`);
                    }

                } catch (error) {
                    console.error(`❌ Error processing reel ${reel._id}:`, error.message);
                    failed++;
                }
            }

            // Small delay between batches
            if (i + batchSize < reelsNeedingPCA.length) {
                console.log('⏳ Waiting 1 second before next batch...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        console.log('\n🎉 PCA embedding fix completed!');
        console.log(`📊 Summary:
        - Total reels processed: ${processed}
        - Successfully updated: ${successful}
        - Failed updates: ${failed}
        - Success rate: ${processed > 0 ? ((successful / processed) * 100).toFixed(2) : 0}%`);

        // Final verification
        const updatedCount = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $size: 128 }
        });

        const totalWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $size: 1536 }
        });

        const totalReels = await Reel.countDocuments();

        console.log(`\n🔍 Final verification:
        - Total reels: ${totalReels}
        - Reels with valid embedding (1536D): ${totalWithEmbedding}
        - Reels with valid PCA embedding (128D): ${updatedCount}
        - PCA coverage: ${totalWithEmbedding > 0 ? ((updatedCount / totalWithEmbedding) * 100).toFixed(2) : 0}%
        - Overall coverage: ${totalReels > 0 ? ((updatedCount / totalReels) * 100).toFixed(2) : 0}%`);

    } catch (error) {
        console.error('❌ Error fixing PCA embeddings:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await quickFixPCAEmbeddings();
        console.log('\n✅ Quick fix completed successfully');
    } catch (error) {
        console.error('❌ Quick fix failed:', error);
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

module.exports = { quickFixPCAEmbeddings };
