const mongoose = require('mongoose');

async function checkDatabases() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    
    // Try different possible connection URLs
    const possibleUrls = [
      process.env.MONGO_URL,
      'mongodb://localhost:27017/menaapp',
      'mongodb://localhost:27017',
      'mongodb://127.0.0.1:27017/menaapp',
      'mongodb://127.0.0.1:27017'
    ].filter(Boolean);
    
    console.log('🔍 Checking possible MongoDB URLs:');
    possibleUrls.forEach(url => console.log(`  - ${url}`));
    
    // Use the first available URL (process.env.MONGO_URL or fallback)
    const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
    console.log(`\n🎯 Using: ${mongoUrl}`);
    
    await mongoose.connect(mongoUrl);
    
    // List all databases
    console.log('\n📂 Available databases:');
    const admin = mongoose.connection.db.admin();
    const dbList = await admin.listDatabases();
    
    dbList.databases.forEach(db => {
      console.log(`  - ${db.name} (${(db.sizeOnDisk / (1024*1024)).toFixed(2)} MB)`);
    });
    
    // Check the current database name
    console.log(`\n🎯 Currently connected to: ${mongoose.connection.name}`);
    
    // Check collections in current database
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`\n📚 Collections in current database (${collections.length}):`);
    
    for (const collection of collections) {
      const collectionName = collection.name;
      const count = await mongoose.connection.db.collection(collectionName).countDocuments();
      console.log(`  - ${collectionName}: ${count} documents`);
    }
    
    // If we're in a database with articles, let's check them
    if (collections.some(c => c.name === 'articles')) {
      console.log('\n📄 Checking articles collection:');
      const articles = await mongoose.connection.db.collection('articles');
      const sampleArticle = await articles.findOne({});
      
      if (sampleArticle) {
        console.log('📋 Sample article structure:');
        console.log(`  Title: ${sampleArticle.title || 'No title'}`);
        console.log(`  Has embedding: ${sampleArticle.embedding ? 'Yes' : 'No'}`);
        console.log(`  Embedding length: ${sampleArticle.embedding?.length || 'N/A'}`);
        console.log(`  Language: ${sampleArticle.language || 'Not set'}`);
      }
    }
    
    console.log('\n💡 Environment variables:');
    console.log(`  MONGO_URL: ${process.env.MONGO_URL || 'Not set'}`);
    console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'Not set'}`);
    
  } catch (error) {
    console.error('❌ Error checking databases:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Run the function
if (require.main === module) {
  checkDatabases().catch(console.error);
}

module.exports = { checkDatabases };
