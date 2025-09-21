/**
 * Debug script to check MongoDB connection and collections
 */

require('dotenv').config();
const mongoose = require('mongoose');

// MongoDB connection
const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/gulfio';

async function connectToDatabase() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');
        console.log('🔗 Connection string:', MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')); // Hide credentials
        console.log('📍 Database name:', mongoose.connection.db.databaseName);
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

async function debugDatabase() {
    try {
        console.log('🔍 Debugging MongoDB database...\n');

        // List all collections
        const collections = await mongoose.connection.db.listCollections().toArray();
        console.log('📋 Available collections:');
        collections.forEach(collection => {
            console.log(`  - ${collection.name}`);
        });

        // Check if reels collection exists
        const reelsCollection = collections.find(c => c.name === 'reels');
        if (reelsCollection) {
            console.log('\n✅ Found reels collection');

            // Count documents in reels collection
            const reelsCount = await mongoose.connection.db.collection('reels').countDocuments();
            console.log(`📊 Total documents in reels collection: ${reelsCount}`);

            if (reelsCount > 0) {
                // Get a sample document
                const sampleReel = await mongoose.connection.db.collection('reels').findOne();
                console.log('\n📄 Sample reel document structure:');
                console.log('Keys:', Object.keys(sampleReel));
                console.log('Has embedding:', !!sampleReel.embedding);
                console.log('Embedding length:', sampleReel.embedding?.length || 'N/A');
                console.log('Has embedding_pca:', !!sampleReel.embedding_pca);
                console.log('PCA embedding length:', sampleReel.embedding_pca?.length || 'N/A');

                // Count reels with embeddings
                const withEmbedding = await mongoose.connection.db.collection('reels').countDocuments({
                    embedding: { $exists: true, $ne: null, $type: 'array' }
                });

                const withPCA = await mongoose.connection.db.collection('reels').countDocuments({
                    embedding_pca: { $exists: true, $ne: null, $type: 'array' }
                });

                console.log('\n📊 Embedding statistics:');
                console.log(`  - Reels with embedding: ${withEmbedding}`);
                console.log(`  - Reels with PCA embedding: ${withPCA}`);
                console.log(`  - Need PCA generation: ${withEmbedding - withPCA}`);
            }
        } else {
            console.log('\n❌ No reels collection found');
        }

        // Check if there are other potential reel collections
        const potentialCollections = collections.filter(c =>
            c.name.toLowerCase().includes('reel') ||
            c.name.toLowerCase().includes('video')
        );

        if (potentialCollections.length > 0) {
            console.log('\n🔍 Potential reel-related collections:');
            for (const collection of potentialCollections) {
                const count = await mongoose.connection.db.collection(collection.name).countDocuments();
                console.log(`  - ${collection.name}: ${count} documents`);
            }
        }

    } catch (error) {
        console.error('❌ Error debugging database:', error);
        throw error;
    }
}

async function main() {
    try {
        await connectToDatabase();
        await debugDatabase();
        console.log('\n✅ Debug completed successfully');
    } catch (error) {
        console.error('❌ Debug failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Disconnected from MongoDB');
    }
}

// Run the script
if (require.main === module) {
    main();
}

module.exports = { debugDatabase };
