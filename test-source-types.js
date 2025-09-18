#!/usr/bin/env node

/**
 * Test script to demonstrate testing both HTML and RSS sources
 * Usage: node test-source-types.js [source-id]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const testSingleSource = require('./scraper/testSingleSource');

async function main() {
    try {
        // Connect to MongoDB
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('✅ MongoDB connected');

        // Get source ID from command line argument
        const sourceId = process.argv[2];
        if (!sourceId) {
            console.log('❌ Please provide a source ID as an argument');
            console.log('Usage: node test-source-types.js [source-id]');
            process.exit(1);
        }

        console.log(`\n🧪 Testing source: ${sourceId}`);
        console.log('='.repeat(50));

        // Run the test
        const results = await testSingleSource(sourceId);

        // Display results
        console.log('\n📊 TEST RESULTS');
        console.log('='.repeat(50));
        console.log(`Source: ${results.source.name}`);
        console.log(`Type: ${results.source.type || 'html'}`);
        console.log(`URL: ${results.source.url}`);
        console.log(`Success: ${results.success ? '✅' : '❌'}`);
        console.log(`Articles Found: ${results.articles.length}`);
        console.log(`Errors: ${results.errors.length}`);

        if (results.errors.length > 0) {
            console.log('\n❌ ERRORS:');
            results.errors.forEach((error, index) => {
                console.log(`${index + 1}. ${error}`);
            });
        }

        console.log('\n📝 PROCESSING STEPS:');
        results.steps.forEach((step, index) => {
            console.log(`${index + 1}. ${step}`);
        });

        if (results.articles.length > 0) {
            console.log('\n📰 SAMPLE ARTICLES:');
            results.articles.forEach((article, index) => {
                console.log(`\n--- Article ${index + 1} ---`);
                console.log(`Title: ${article.title.slice(0, 100)}${article.title.length > 100 ? '...' : ''}`);
                console.log(`URL: ${article.url}`);
                console.log(`Content Length: ${article.contentLength} characters`);
                console.log(`Images: ${article.imageCount}`);
                if (article.pubDate) {
                    console.log(`Published: ${article.pubDate}`);
                }
                if (article.content && article.content !== 'No content found') {
                    console.log(`Preview: ${article.content.slice(0, 150)}${article.content.length > 150 ? '...' : ''}`);
                }
            });
        }

        console.log('\n🏁 Test completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    } finally {
        // Close MongoDB connection
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
            console.log('🔌 MongoDB disconnected');
        }
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n⚠️ Received SIGINT, shutting down gracefully...');
    if (mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n⚠️ Received SIGTERM, shutting down gracefully...');
    if (mongoose.connection.readyState === 1) {
        await mongoose.disconnect();
    }
    process.exit(0);
});

main();
