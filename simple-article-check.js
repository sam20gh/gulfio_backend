require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('./models/Article');

async function checkArticleEmbeddings() {
    try {
        console.log('🔍 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);

        // Get total article count
        const totalArticles = await Article.countDocuments();
        console.log(`📊 Total articles in database: ${totalArticles}`);

        // Check if any articles have embedding_pca field
        const withEmbeddings = await Article.countDocuments({ embedding_pca: { $exists: true, $ne: null } });
        console.log(`🔍 Articles with embedding_pca field: ${withEmbeddings}`);

        // Get a sample article to check structure
        const sampleArticle = await Article.findOne({}).select('title embedding_pca').lean();
        console.log('🔍 Sample article structure:');
        console.log('Title:', sampleArticle?.title);
        console.log('Has embedding_pca:', !!sampleArticle?.embedding_pca);
        console.log('Embedding length:', sampleArticle?.embedding_pca?.length || 0);

        // If no embeddings, get first few articles to see what we have
        if (withEmbeddings === 0) {
            console.log('❌ No articles have embedding_pca field!');
            const sampleArticles = await Article.find({}).select('title content').limit(3).lean();
            console.log('📝 Sample articles without embeddings:');
            sampleArticles.forEach((article, index) => {
                console.log(`${index + 1}. ${article.title} (${article.content?.substring(0, 100)}...)`);
            });
        }

    } catch (error) {
        console.error('❌ Error checking articles:', error);
    } finally {
        await mongoose.connection.close();
        console.log('🔒 Database connection closed');
    }
}

checkArticleEmbeddings();