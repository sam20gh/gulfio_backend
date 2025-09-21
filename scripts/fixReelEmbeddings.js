/**
 * Comprehensive script to fix embeddings for all reels
 * - Generates missing embeddings for reels that don't have them
 * - Generates missing PCA embeddings for reels that have embedding but no PCA
 */

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
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

async function fixReelEmbeddings() {
    try {
        console.log('🔄 Starting comprehensive reel embedding fix...');

        // Get statistics first
        const totalReels = await Reel.countDocuments();
        const reelsWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] }
        });
        const reelsWithPCA = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $ne: [] }
        });

        console.log(`📊 Current status:
        - Total reels: ${totalReels}
        - Reels with embedding: ${reelsWithEmbedding}
        - Reels with PCA embedding: ${reelsWithPCA}`);

        // 1. Find reels that need embeddings (missing both embedding and PCA)
        const reelsNeedingEmbedding = await Reel.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $size: 0 } }
            ]
        }).select('_id caption reelId').lean();

        console.log(`\n🔍 Found ${reelsNeedingEmbedding.length} reels that need embeddings`);

        // 2. Find reels that only need PCA embedding
        const reelsNeedingPCA = await Reel.find({
            embedding: { $exists: true, $type: 'array', $ne: [] },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: null },
                { embedding_pca: { $size: 0 } }
            ]
        }).select('_id embedding caption reelId').lean();

        console.log(`🔍 Found ${reelsNeedingPCA.length} reels that need PCA embeddings`);

        let stats = {
            embeddingsGenerated: 0,
            pcaGenerated: 0,
            embeddingsFailed: 0,
            pcaFailed: 0
        };

        // Process reels that need both embeddings
        if (reelsNeedingEmbedding.length > 0) {
            console.log('\n📝 Generating missing embeddings...');

            for (let i = 0; i < reelsNeedingEmbedding.length; i++) {
                const reel = reelsNeedingEmbedding[i];

                try {
                    // Generate embedding from caption
                    const embedInput = reel.caption || `Video reel ${reel.reelId || reel._id}`;
                    const embedding = await getDeepSeekEmbedding(embedInput);

                    if (embedding && embedding.length === 1536) {
                        // Generate PCA embedding too
                        const embedding_pca = await convertToPCAEmbedding(embedding);

                        // Update reel with both embeddings
                        const updateData = { embedding };
                        if (embedding_pca && embedding_pca.length === 128) {
                            updateData.embedding_pca = embedding_pca;
                            stats.pcaGenerated++;
                        } else {
                            stats.pcaFailed++;
                        }

                        await Reel.updateOne(
                            { _id: reel._id },
                            { $set: updateData }
                        );

                        stats.embeddingsGenerated++;
                        console.log(`✅ Generated embeddings for reel ${i + 1}/${reelsNeedingEmbedding.length}: ${reel._id}`);

                        // Rate limiting to avoid overwhelming the API
                        if (i % 5 === 0 && i > 0) {
                            console.log('⏳ Rate limiting: waiting 2 seconds...');
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    } else {
                        console.warn(`⚠️ Failed to generate embedding for reel ${reel._id}`);
                        stats.embeddingsFailed++;
                    }

                } catch (error) {
                    console.error(`❌ Error processing reel ${reel._id}:`, error.message);
                    stats.embeddingsFailed++;
                }
            }
        }

        // Process reels that only need PCA embeddings
        if (reelsNeedingPCA.length > 0) {
            console.log('\n🧮 Generating missing PCA embeddings...');

            const batchSize = 50;
            for (let i = 0; i < reelsNeedingPCA.length; i += batchSize) {
                const batch = reelsNeedingPCA.slice(i, i + batchSize);
                console.log(`📦 Processing PCA batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(reelsNeedingPCA.length / batchSize)}`);

                for (const reel of batch) {
                    try {
                        // Validate existing embedding
                        if (!Array.isArray(reel.embedding) || reel.embedding.length !== 1536) {
                            console.warn(`⚠️ Reel ${reel._id}: Invalid embedding (length: ${reel.embedding?.length || 'N/A'})`);
                            stats.pcaFailed++;
                            continue;
                        }

                        // Generate PCA embedding
                        const embedding_pca = await convertToPCAEmbedding(reel.embedding);

                        if (embedding_pca && embedding_pca.length === 128) {
                            await Reel.updateOne(
                                { _id: reel._id },
                                { $set: { embedding_pca: embedding_pca } }
                            );

                            stats.pcaGenerated++;
                            console.log(`✅ Generated PCA for reel ${reel._id}`);
                        } else {
                            console.warn(`⚠️ Failed to generate PCA for reel ${reel._id}`);
                            stats.pcaFailed++;
                        }

                    } catch (error) {
                        console.error(`❌ Error generating PCA for reel ${reel._id}:`, error.message);
                        stats.pcaFailed++;
                    }
                }

                // Small delay between batches
                if (i + batchSize < reelsNeedingPCA.length) {
                    console.log('⏳ Waiting 2 seconds before next batch...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        // Final verification
        const finalReelsWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] }
        });
        const finalReelsWithPCA = await Reel.countDocuments({
            embedding_pca: { $exists: true, $type: 'array', $ne: [] }
        });

        console.log('\n🎉 Comprehensive embedding fix completed!');
        console.log(`📊 Summary:
        - Embeddings generated: ${stats.embeddingsGenerated}
        - PCA embeddings generated: ${stats.pcaGenerated}
        - Embedding generation failures: ${stats.embeddingsFailed}
        - PCA generation failures: ${stats.pcaFailed}`);

        console.log(`\n🔍 Final verification:
        - Reels with embedding: ${reelsWithEmbedding} → ${finalReelsWithEmbedding} (+${finalReelsWithEmbedding - reelsWithEmbedding})
        - Reels with PCA embedding: ${reelsWithPCA} → ${finalReelsWithPCA} (+${finalReelsWithPCA - reelsWithPCA})
        - Total reels: ${totalReels}
        - Embedding coverage: ${((finalReelsWithEmbedding / totalReels) * 100).toFixed(2)}%
        - PCA coverage: ${((finalReelsWithPCA / totalReels) * 100).toFixed(2)}%`);

    } catch (error) {
        console.error('❌ Error fixing reel embeddings:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await fixReelEmbeddings();
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

module.exports = { fixReelEmbeddings };
