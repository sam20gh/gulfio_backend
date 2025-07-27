const mongoose = require('mongoose');
require('dotenv').config(); // Load environment variables

async function checkMongoConnection() {
    try {
        console.log('🔍 Checking MongoDB connection details...');

        const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/menaapp';
        console.log(`📡 Connection URI: ${mongoUri.replace(/\/\/[^:]*:[^@]*@/, '//***:***@')}`);

        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(mongoUri);

        const db = mongoose.connection.db;
        console.log(`🎯 Connected to database: ${db.databaseName}`);

        // List all collections
        const collections = await db.listCollections().toArray();
        console.log(`\n📚 Collections in database '${db.databaseName}' (${collections.length}):`);

        if (collections.length === 0) {
            console.log('  (No collections found)');
        } else {
            for (const collection of collections) {
                const count = await db.collection(collection.name).countDocuments();
                console.log(`  - ${collection.name}: ${count} documents`);

                // If this is articles, show a sample
                if (collection.name === 'articles' && count > 0) {
                    const sample = await db.collection('articles').findOne({});
                    console.log(`    Sample: ${sample.title?.substring(0, 40) || 'No title'}...`);
                }
            }
        }

        // Try to find any collection that might contain articles
        console.log('\n🔍 Searching for article-like collections...');
        const articleCollections = collections.filter(c =>
            c.name.toLowerCase().includes('article') ||
            c.name.toLowerCase().includes('news') ||
            c.name.toLowerCase().includes('post')
        );

        if (articleCollections.length > 0) {
            console.log('📄 Found article-like collections:');
            for (const collection of articleCollections) {
                const count = await db.collection(collection.name).countDocuments();
                console.log(`  - ${collection.name}: ${count} documents`);
            }
        } else {
            console.log('❌ No article-like collections found');
        }

        // Check if we need to populate the database
        if (collections.length === 0) {
            console.log('\n💡 The database appears to be empty. You may need to:');
            console.log('   1. Run your scraping scripts to populate articles');
            console.log('   2. Import existing data');
            console.log('   3. Check if you\'re connecting to the right database');
        }

    } catch (error) {
        console.error('❌ Error checking MongoDB connection:', error);
    } finally {
        try {
            await mongoose.disconnect();
            console.log('\n🔌 Disconnected from MongoDB');
        } catch (e) {
            console.error('Error disconnecting:', e);
        }
    }
}

// Run the function
if (require.main === module) {
    checkMongoConnection().catch(console.error);
}

module.exports = { checkMongoConnection };
