require('dotenv').config();
const mongoose = require('mongoose');
const { initializePCAModel, convertToPCAEmbedding } = require('../utils/pcaEmbedding');
const Article = require('../models/Article');

async function testPCAEmbedding() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Initialize PCA model
        console.log('🔄 Initializing PCA model...');
        await initializePCAModel();

        // Get a sample article with regular embedding
        console.log('📋 Getting sample article...');
        const sampleArticle = await Article.findOne({
            embedding: { $exists: true, $ne: null, $size: 1536 },
            embedding_pca: { $exists: false }
        }).lean();

        if (!sampleArticle) {
            console.log('❌ No sample article found (all articles already have PCA embeddings!)');
            return;
        }

        console.log('📝 Sample article:', sampleArticle.title.substring(0, 50));
        console.log('📏 Original embedding dimensions:', sampleArticle.embedding.length);

        // Test PCA conversion
        console.log('🔄 Converting to PCA embedding...');
        const pcaEmbedding = await convertToPCAEmbedding(sampleArticle.embedding);

        if (pcaEmbedding) {
            console.log('✅ PCA conversion successful!');
            console.log('📏 PCA embedding dimensions:', pcaEmbedding.length);
            console.log('🔢 First 5 PCA values:', pcaEmbedding.slice(0, 5));

            // Verify it's different from original
            const originalFirst5 = sampleArticle.embedding.slice(0, 5);
            console.log('🔢 Original first 5 values:', originalFirst5);

            const isDifferent = !pcaEmbedding.slice(0, 5).every((val, i) =>
                Math.abs(val - originalFirst5[i]) < 0.001
            );
            console.log('✅ PCA values are different from original:', isDifferent);

        } else {
            console.log('❌ PCA conversion failed');
        }

    } catch (error) {
        console.error('❌ Test error:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

testPCAEmbedding();
