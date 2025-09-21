/**
 * Fix missing embeddings for reels
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

async function fixMissingEmbeddings() {
    try {
        console.log('🔄 Fixing reels with missing embeddings...\n');

        // Find reels that are missing embeddings entirely
        const reelsNeedingEmbedding = await Reel.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: null },
                { embedding: { $size: 0 } },
                { embedding: [] }
            ]
        }).select('_id caption reelId').lean();

        console.log(`🔍 Found ${reelsNeedingEmbedding.length} reels that need embeddings`);

        if (reelsNeedingEmbedding.length === 0) {
            console.log('✅ All reels already have embeddings!');
            return;
        }

        let processed = 0;
        let successes = 0;
        let failures = 0;
        const BATCH_SIZE = 25;

        // Process in batches
        for (let i = 0; i < reelsNeedingEmbedding.length; i += BATCH_SIZE) {
            const batch = reelsNeedingEmbedding.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(reelsNeedingEmbedding.length / BATCH_SIZE);

            console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} reels)`);

            for (const reel of batch) {
                try {
                    processed++;

                    // Generate embedding from caption
                    const embedInput = reel.caption || `Video reel ${reel.reelId || reel._id}`;
                    console.log(`🔄 [${processed}/${reelsNeedingEmbedding.length}] Processing: ${embedInput.substring(0, 60)}...`);

                    const embedding = await getDeepSeekEmbedding(embedInput);

                    if (embedding && embedding.length === 1536) {
                        // Generate PCA embedding too
                        const embedding_pca = await convertToPCAEmbedding(embedding);

                        // Update reel with both embeddings
                        const updateData = { embedding };
                        if (embedding_pca && embedding_pca.length === 128) {
                            updateData.embedding_pca = embedding_pca;
                        }

                        await Reel.updateOne(
                            { _id: reel._id },
                            { $set: updateData }
                        );

                        successes++;
                        console.log(`✅ [${processed}/${reelsNeedingEmbedding.length}] Generated embeddings for reel`);
                    } else {
                        failures++;
                        console.log(`❌ [${processed}/${reelsNeedingEmbedding.length}] Failed to generate embedding`);
                    }

                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));

                } catch (error) {
                    failures++;
                    console.error(`❌ [${processed}/${reelsNeedingEmbedding.length}] Error processing reel ${reel._id}:`, error.message);
                }
            }

            console.log(`✅ Batch ${batchNum} completed: ${successes} successes, ${failures} failures`);
        }

        console.log(`\n🎉 Embedding generation completed!
📊 Summary:
    - Total processed: ${processed}
    - Successes: ${successes}
    - Failures: ${failures}
    - Success rate: ${processed > 0 ? ((successes / processed) * 100).toFixed(1) : 0}%`);

        // Final verification
        const reelsWithEmbedding = await Reel.countDocuments({
            embedding: { $exists: true, $type: 'array', $ne: [] }
        });
        const totalReels = await Reel.countDocuments();

        console.log(`\n🔍 Final status:
    - Total reels: ${totalReels}
    - Reels with embeddings: ${reelsWithEmbedding}
    - Coverage: ${totalReels > 0 ? ((reelsWithEmbedding / totalReels) * 100).toFixed(1) : 0}%`);

    } catch (error) {
        console.error('❌ Error during embedding fix:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await fixMissingEmbeddings();
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
