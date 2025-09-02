require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Article = require('../models/Article');
const { PCA } = require('ml-pca');
const { Matrix } = require('ml-matrix');

/**
 * Simple script to convert user embeddings to PCA using a smaller, stable dataset
 */

async function updateUserPCAEmbeddingsSimple() {
    let pcaModel = null;

    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 0,
            connectTimeoutMS: 5000,
            maxPoolSize: 5,
        });
        console.log('✅ Connected to MongoDB');

        // Step 1: Build a simple PCA model using just a few hundred articles
        console.log('🔄 Building simplified PCA model...');
        const sampleArticles = await Article.find({
            embedding: { $exists: true, $ne: null, $size: 1536 }
        })
            .select('embedding')
            .limit(500) // Much smaller dataset for stability
            .lean();

        if (sampleArticles.length < 50) {
            throw new Error('Not enough articles with embeddings for PCA');
        }

        console.log(`📊 Using ${sampleArticles.length} articles for PCA training`);

        // Create matrix from embeddings
        const embeddings = sampleArticles.map(a => a.embedding);
        const matrix = new Matrix(embeddings);

        // Train PCA model
        pcaModel = new PCA(matrix, { center: true, scale: false });
        console.log('✅ PCA model trained successfully');

        // Step 2: Find users needing PCA conversion
        const usersWithEmbeddings = await User.find({
            embedding: { $exists: true, $ne: [], $size: 1536 },
            $or: [
                { embedding_pca: { $exists: false } },
                { embedding_pca: { $size: 0 } }
            ]
        }).select('_id email embedding');

        console.log(`📊 Found ${usersWithEmbeddings.length} users needing PCA conversion`);

        if (usersWithEmbeddings.length === 0) {
            console.log('✅ All users already have PCA embeddings');
            return;
        }

        // Step 3: Convert each user's embedding
        let successCount = 0;
        let errorCount = 0;

        for (const user of usersWithEmbeddings) {
            try {
                console.log(`🔄 Processing ${user.email || user._id}...`);

                // Convert embedding to PCA using our trained model
                const inputMatrix = new Matrix([user.embedding]);
                const pcaResult = pcaModel.predict(inputMatrix, { nComponents: 128 });
                const pcaEmbedding = Array.from(pcaResult.getRow(0));

                // Update user in database
                await User.updateOne(
                    { _id: user._id },
                    {
                        $set: {
                            embedding_pca: pcaEmbedding,
                            updatedAt: new Date()
                        }
                    }
                );

                console.log(`✅ Converted to ${pcaEmbedding.length}D PCA embedding`);
                successCount++;

                // Small delay to avoid overwhelming the database
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error) {
                console.error(`❌ Error processing ${user.email || user._id}:`, error.message);
                errorCount++;
            }
        }

        console.log(`\n📊 PCA Conversion Results:`);
        console.log(`✅ Successfully converted: ${successCount} users`);
        console.log(`❌ Failed: ${errorCount} users`);
        console.log(`📋 Total processed: ${successCount + errorCount} users`);

    } catch (error) {
        console.error('❌ Script error:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the script if called directly
if (require.main === module) {
    updateUserPCAEmbeddingsSimple()
        .then(() => {
            console.log('🎉 Simple PCA conversion script completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Simple PCA conversion script failed:', error);
            process.exit(1);
        });
}

module.exports = { updateUserPCAEmbeddingsSimple };
