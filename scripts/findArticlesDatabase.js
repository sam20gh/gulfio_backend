const mongoose = require('mongoose');

async function findArticlesDatabase() {
  try {
    const databases = ['gulfio', 'menaapp', 'news_scraper'];
    
    for (const dbName of databases) {
      console.log(`\n🔍 Checking database: ${dbName}`);
      
      try {
        // Connect to specific database
        await mongoose.connect(`mongodb://localhost:27017/${dbName}`);
        
        // Check collections
        const collections = await mongoose.connection.db.listCollections().toArray();
        console.log(`📚 Collections: ${collections.map(c => c.name).join(', ')}`);
        
        // Check if articles collection exists
        const hasArticles = collections.some(c => c.name === 'articles');
        
        if (hasArticles) {
          const articlesCount = await mongoose.connection.db.collection('articles').countDocuments();
          console.log(`📄 Articles count: ${articlesCount}`);
          
          if (articlesCount > 0) {
            // Check for embeddings
            const withEmbeddings = await mongoose.connection.db.collection('articles').countDocuments({
              embedding: { $exists: true, $ne: null, $not: { $size: 0 } }
            });
            console.log(`🧠 Articles with embeddings: ${withEmbeddings}`);
            
            // Sample one article
            const sample = await mongoose.connection.db.collection('articles').findOne({});
            if (sample) {
              console.log(`📋 Sample article:`);
              console.log(`  Title: ${sample.title?.substring(0, 50) || 'No title'}...`);
              console.log(`  Has embedding: ${sample.embedding ? 'Yes' : 'No'}`);
              console.log(`  Embedding length: ${sample.embedding?.length || 'N/A'}`);
              console.log(`  Language: ${sample.language || 'Not set'}`);
              console.log(`  Published: ${sample.publishedAt ? new Date(sample.publishedAt).toISOString().split('T')[0] : 'Not set'}`);
            }
            
            if (withEmbeddings > 0) {
              console.log(`✅ Found ${withEmbeddings} articles with embeddings in ${dbName}!`);
            }
          }
        } else {
          console.log('❌ No articles collection found');
        }
        
        await mongoose.disconnect();
        
      } catch (error) {
        console.error(`❌ Error checking ${dbName}:`, error.message);
        try {
          await mongoose.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error in findArticlesDatabase:', error);
  }
}

// Run the function
if (require.main === module) {
  findArticlesDatabase().catch(console.error);
}

module.exports = { findArticlesDatabase };
