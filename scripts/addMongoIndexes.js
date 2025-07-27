const mongoose = require('mongoose');
require('dotenv').config(); // Load environment variables

async function addMongoIndexes() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/menaapp');
    
    const db = mongoose.connection.db;
    
    console.log('📊 Adding indexes for optimized article recommendations...');
    
    // Articles collection indexes
    console.log('🔍 Adding indexes to articles collection...');
    
    // Index for viewCount (descending) - for trending articles
    await db.collection('articles').createIndex({ "viewCount": -1 });
    console.log('✅ Added index: { viewCount: -1 }');
    
    // Index for publishedAt (descending) - for recency sorting
    await db.collection('articles').createIndex({ "publishedAt": -1 });
    console.log('✅ Added index: { publishedAt: -1 }');
    
    // Index for category - for category-based filtering
    await db.collection('articles').createIndex({ "category": 1 });
    console.log('✅ Added index: { category: 1 }');
    
    // Index for language - for language filtering
    await db.collection('articles').createIndex({ "language": 1 });
    console.log('✅ Added index: { language: 1 }');
    
    // Index for embedding_pca - for Faiss index building
    await db.collection('articles').createIndex({ "embedding_pca": 1 });
    console.log('✅ Added index: { embedding_pca: 1 }');
    
    // Compound index for language and viewCount (for trending by language)
    await db.collection('articles').createIndex({ "language": 1, "viewCount": -1 });
    console.log('✅ Added compound index: { language: 1, viewCount: -1 }');
    
    // Compound index for language and publishedAt (for recent by language)
    await db.collection('articles').createIndex({ "language": 1, "publishedAt": -1 });
    console.log('✅ Added compound index: { language: 1, publishedAt: -1 }');
    
    // Users collection indexes
    console.log('🔍 Adding indexes to users collection...');
    
    // Index for supabase_id - primary user lookup
    await db.collection('users').createIndex({ "supabase_id": 1 }, { unique: true });
    console.log('✅ Added unique index: { supabase_id: 1 }');
    
    // Index for embedding_pca - for user similarity calculations
    await db.collection('users').createIndex({ "embedding_pca": 1 });
    console.log('✅ Added index: { embedding_pca: 1 }');
    
    // Index for disliked_articles - for filtering recommendations
    await db.collection('users').createIndex({ "disliked_articles": 1 });
    console.log('✅ Added index: { disliked_articles: 1 }');
    
    console.log('🎉 All indexes created successfully!');
    
    // List all indexes to verify
    console.log('📋 Current indexes:');
    const articleIndexes = await db.collection('articles').listIndexes().toArray();
    const userIndexes = await db.collection('users').listIndexes().toArray();
    
    console.log('\n📄 Articles collection indexes:');
    articleIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });
    
    console.log('\n👤 Users collection indexes:');
    userIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });
    
  } catch (error) {
    console.error('❌ Error adding MongoDB indexes:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the function
if (require.main === module) {
  addMongoIndexes().catch(console.error);
}

module.exports = { addMongoIndexes };
