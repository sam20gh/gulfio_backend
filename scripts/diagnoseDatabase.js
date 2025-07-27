const mongoose = require('mongoose');
const Article = require('../models/Article');
require('dotenv').config(); // Load environment variables

async function diagnoseDatabase() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/menaapp');

        // Check total articles
        const totalArticles = await Article.countDocuments();
        console.log(`📊 Total articles in database: ${totalArticles}`);

        // Check articles with any embedding field
        const withEmbedding = await Article.countDocuments({ embedding: { $exists: true } });
        console.log(`🧠 Articles with embedding field: ${withEmbedding}`);

        // Check articles with non-empty embeddings
        const withNonEmptyEmbedding = await Article.countDocuments({
            embedding: { $exists: true, $ne: null, $not: { $size: 0 } }
        });
        console.log(`✅ Articles with non-empty embeddings: ${withNonEmptyEmbedding}`);

        // Check articles with PCA embeddings
        const withPCAEmbedding = await Article.countDocuments({
            embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } }
        });
        console.log(`🔄 Articles with PCA embeddings: ${withPCAEmbedding}`);

        // Sample a few articles to see their structure
        console.log('\n📋 Sampling first 3 articles:');
        const sampleArticles = await Article.find().limit(3).lean();

        sampleArticles.forEach((article, index) => {
            console.log(`\n📄 Article ${index + 1}:`);
            console.log(`  Title: ${article.title?.substring(0, 50)}...`);
            console.log(`  Has embedding: ${article.embedding ? 'Yes' : 'No'}`);
            console.log(`  Embedding type: ${Array.isArray(article.embedding) ? 'Array' : typeof article.embedding}`);
            console.log(`  Embedding length: ${article.embedding?.length || 'N/A'}`);
            console.log(`  Has embedding_pca: ${article.embedding_pca ? 'Yes' : 'No'}`);
            console.log(`  Language: ${article.language || 'Not set'}`);
            console.log(`  Published: ${article.publishedAt || 'Not set'}`);
        });

        // Check if there are articles with embeddings but different structure
        const articlesWithEmbeddingData = await Article.aggregate([
            {
                $project: {
                    title: 1,
                    hasEmbedding: { $ne: ['$embedding', null] },
                    embeddingType: { $type: '$embedding' },
                    embeddingSize: { $size: { $ifNull: ['$embedding', []] } }
                }
            },
            { $limit: 5 }
        ]);

        console.log('\n🔍 Embedding analysis:');
        articlesWithEmbeddingData.forEach((doc, index) => {
            console.log(`  ${index + 1}. ${doc.title?.substring(0, 30)}... - Has: ${doc.hasEmbedding}, Type: ${doc.embeddingType}, Size: ${doc.embeddingSize}`);
        });

    } catch (error) {
        console.error('❌ Error diagnosing database:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from MongoDB');
    }
}

// Run the function
if (require.main === module) {
    diagnoseDatabase().catch(console.error);
}

module.exports = { diagnoseDatabase };
