const mongoose = require('mongoose');
const faiss = require('faiss-node');
const { Matrix } = require('ml-matrix');
const { PCA } = require('ml-pca');
const Article = require('../models/Article');
const { fromVector, isValidEmbedding } = require('../utils/vector');
require('dotenv').config(); // Load environment variables

async function reduceEmbeddings() {
    try {
        // Connect to MongoDB
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/menaapp');

        const ORIGINAL_DIMENSIONS = 1536;
        const REDUCED_DIMENSIONS = 128; console.log('📊 Fetching articles with embeddings...');
        const articles = await Article.find({
            embedding: { $exists: true, $ne: null, $not: { $size: 0 } }
        }).lean();

        console.log(`Found ${articles.length} articles with embeddings`);

        if (articles.length < 10) {
            console.error('❌ Insufficient articles with embeddings. Need at least 10 articles.');
            return;
        }

        // Filter articles with valid embeddings. `embedding` is a BSON Binary float32
        // vector — isValidEmbedding/fromVector handle it (and legacy arrays).
        const validArticles = articles
            .filter(article => isValidEmbedding(article.embedding, ORIGINAL_DIMENSIONS))
            .map(article => ({ ...article, embedding: fromVector(article.embedding) }));

        console.log(`Found ${validArticles.length} articles with valid ${ORIGINAL_DIMENSIONS}D embeddings`);

        if (validArticles.length === 0) {
            console.error('❌ No valid embeddings found');
            return;
        }

        const embeddings = validArticles.map(a => a.embedding);

        console.log('🧮 Creating embedding matrix...');
        const matrix = new Matrix(embeddings.length, ORIGINAL_DIMENSIONS);
        for (let i = 0; i < embeddings.length; i++) {
            for (let j = 0; j < ORIGINAL_DIMENSIONS; j++) {
                matrix.set(i, j, embeddings[i][j]);
            }
        }

        console.log('🔄 Training PCA model...');
        const pca = new PCA(matrix, { nComponents: REDUCED_DIMENSIONS });

        console.log('✨ Applying PCA transformation...');
        const reducedMatrix = pca.predict(matrix);

        console.log('💾 Updating articles with PCA embeddings...');
        let updatedCount = 0;

        for (let i = 0; i < validArticles.length; i++) {
            const reducedEmbedding = [];
            for (let j = 0; j < REDUCED_DIMENSIONS; j++) {
                reducedEmbedding.push(reducedMatrix.get(i, j));
            }

            await Article.updateOne(
                { _id: validArticles[i]._id },
                { $set: { embedding_pca: reducedEmbedding } }
            );

            updatedCount++;

            // Progress indicator
            if (updatedCount % 100 === 0) {
                console.log(`📝 Updated ${updatedCount}/${validArticles.length} articles`);
            }
        }

        console.log(`✅ Successfully updated ${updatedCount} articles with PCA embeddings`);
        console.log(`📏 Reduced embeddings from ${ORIGINAL_DIMENSIONS}D to ${REDUCED_DIMENSIONS}D`);

    } catch (error) {
        console.error('❌ Error reducing embeddings:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

// Run the function
if (require.main === module) {
    reduceEmbeddings().catch(console.error);
}

module.exports = { reduceEmbeddings };
