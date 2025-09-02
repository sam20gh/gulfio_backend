require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');

/**
 * Script to convert existing user embeddings to PCA format
 * Run this after the main embedding update to add PCA embeddings
 */

async function updateUserPCAEmbeddings() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Find users with embeddings but no PCA embeddings
        const usersWithEmbeddings = await User.find({
            embedding: { $exists: true, $ne: [], $size: 1536 },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: { $size: 0 } }
            ]
        }).select('_id email embedding embedding_pca');

        console.log(`📊 Found ${usersWithEmbeddings.length} users with embeddings needing PCA conversion`);

        if (usersWithEmbeddings.length === 0) {
            console.log('✅ All users already have PCA embeddings');
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (const user of usersWithEmbeddings) {
            try {
                console.log(`\n🔄 Processing user ${successCount + errorCount + 1}/${usersWithEmbeddings.length}: ${user.email}`);

                // Convert embedding to PCA
                const embedding_pca = await convertToPCAEmbedding(user.embedding);

                if (embedding_pca && embedding_pca.length > 0) {
                    // Update user with PCA embedding
                    await User.updateOne(
                        { _id: user._id },
                        {
                            $set: {
                                embedding_pca: embedding_pca,
                                updatedAt: new Date()
                            }
                        }
                    );

                    console.log(`✅ Successfully converted to ${embedding_pca.length}D PCA embedding`);
                    successCount++;
                } else {
                    console.log(`⚠️ Failed to convert embedding to PCA`);
                    errorCount++;
                }

                // Small delay to avoid overwhelming the system
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                console.error(`❌ Error processing user ${user.email}:`, error.message);
                errorCount++;
            }
        }

        console.log(`\n📊 PCA Conversion Summary:`);
        console.log(`✅ Successfully converted: ${successCount} users`);
        console.log(`❌ Failed: ${errorCount} users`);
        console.log(`📋 Total processed: ${successCount + errorCount} users`);

    } catch (error) {
        console.error('❌ Script error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the script if called directly
if (require.main === module) {
    updateUserPCAEmbeddings()
        .then(() => {
            console.log('🎉 PCA conversion script completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 PCA conversion script failed:', error);
            process.exit(1);
        });
}

module.exports = { updateUserPCAEmbeddings };
