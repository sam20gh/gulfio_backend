require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');

async function checkSpecificArticle() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB Atlas');
    
    // Check specific article
    const articleId = '67ebdef3d01091ea702d3114';
    console.log(`🔍 Checking article: ${articleId}`);
    
    const article = await Article.findById(articleId);
    if (!article) {
      console.log('❌ Article not found');
      return;
    }
    
    console.log('📰 Article found:');
    console.log('- Title:', article.title.substring(0, 80) + '...');
    console.log('- Has regular embedding:', !!article.embedding);
    console.log('- Regular embedding length:', article.embedding ? article.embedding.length : 'N/A');
    console.log('- Has PCA embedding:', !!article.embedding_pca);
    console.log('- PCA embedding length:', article.embedding_pca ? article.embedding_pca.length : 'N/A');
    
    // Overall database stats
    console.log('\n📊 Database Overview:');
    const totalArticles = await Article.countDocuments();
    const withEmbedding = await Article.countDocuments({ embedding: { $exists: true, $ne: null } });
    const withPCA = await Article.countDocuments({ embedding_pca: { $exists: true, $ne: null } });
    
    console.log('- Total articles:', totalArticles);
    console.log('- With regular embeddings:', withEmbedding);
    console.log('- With PCA embeddings:', withPCA);
    console.log('- Missing embeddings:', totalArticles - withEmbedding);
    
    // Sample of articles without embeddings
    const articlesWithoutEmbedding = await Article.find({ 
      embedding: { $exists: false } 
    }).limit(3).select('_id title publishedAt');
    
    if (articlesWithoutEmbedding.length > 0) {
      console.log('\n🔍 Sample articles without embeddings:');
      articlesWithoutEmbedding.forEach((art, i) => {
        console.log(`${i + 1}. ${art._id} - ${art.title?.substring(0, 50)}... (${art.publishedAt})`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

checkSpecificArticle();
