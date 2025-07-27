require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');

async function quickCheck() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');
        console.log('📍 Database:', mongoose.connection.db.databaseName);

        const totalArticles = await Article.countDocuments();
        console.log('📊 Total articles:', totalArticles);

        const articlesWithEmbedding = await Article.countDocuments({
            embedding: { $exists: true, $ne: null }
        });
        console.log('📊 Articles with embeddings:', articlesWithEmbedding);

        const articlesWithPCA = await Article.countDocuments({
            embedding_pca: { $exists: true, $ne: null }
        });
        console.log('📊 Articles with PCA embeddings:', articlesWithPCA);

        // Check if the specific article exists here
        const specificArticle = await Article.findById('67ebdef3d01091ea702d3114');
        if (specificArticle) {
            console.log('✅ Specific article found in test database');
            console.log('- Has embedding:', !!specificArticle.embedding);
            console.log('- Has PCA:', !!specificArticle.embedding_pca);
        } else {
            console.log('❌ Specific article NOT found in test database');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected');
    }
}

quickCheck();
