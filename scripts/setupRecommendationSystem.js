#!/usr/bin/env node

const { addMongoIndexes } = require('./addMongoIndexes');
const { reduceEmbeddings } = require('./reduceArticleEmbeddings');

async function setupRecommendationSystem() {
    console.log('🚀 Setting up AI Article Recommendation System...\n');

    try {
        // Step 1: Add MongoDB indexes
        console.log('📊 Step 1: Adding MongoDB indexes...');
        await addMongoIndexes();
        console.log('✅ MongoDB indexes added successfully\n');

        // Step 2: Reduce article embeddings
        console.log('🔄 Step 2: Reducing article embeddings with PCA...');
        await reduceEmbeddings();
        console.log('✅ Article embeddings reduced successfully\n');

        console.log('🎉 Recommendation system setup completed!');
        console.log('\n📋 Next steps:');
        console.log('1. Restart your server to initialize the Faiss index');
        console.log('2. Test the /articles/personalized endpoint');
        console.log('3. Optionally run: node scripts/precomputeRecommendations.js');
        console.log('4. Check Faiss status at: /articles/faiss-status');

    } catch (error) {
        console.error('❌ Setup failed:', error);
        process.exit(1);
    }
}

// Run setup if this script is executed directly
if (require.main === module) {
    setupRecommendationSystem().catch(console.error);
}

module.exports = { setupRecommendationSystem };
