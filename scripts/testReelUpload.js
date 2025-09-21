/**
 * Test script to verify the reel upload endpoint with embedding_pca generation
 */

const axios = require('axios');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:5000';

async function testReelUpload() {
    try {
        console.log('🧪 Testing reel upload with embedding_pca generation...');
        console.log(`🌐 Server URL: ${SERVER_URL}`);

        // Test data
        const testData = {
            reelUrl: 'https://www.instagram.com/reel/test123/', // This would be a real Instagram URL in practice
            caption: 'Test reel for embedding generation. This is a sample caption to test both embedding and PCA embedding creation.',
            sourceId: '6756c3df7f53f07cea40e01e' // Replace with a valid source ID from your database
        };

        console.log('\n📤 Test payload:');
        console.log(JSON.stringify(testData, null, 2));

        // Make the request
        const response = await axios.post(`${SERVER_URL}/api/videos/reels/upload`, testData, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 60000 // 60 second timeout
        });

        console.log('\n✅ Upload successful!');
        console.log('📋 Response:');
        console.log(JSON.stringify(response.data, null, 2));

        // Check if the reel was saved with both embeddings
        if (response.data.reel && response.data.reel._id) {
            console.log('\n🔍 Verifying embeddings in database...');

            // You could add a database query here to verify both embeddings were saved
            console.log('✅ Reel uploaded with ID:', response.data.reel._id);
        }

    } catch (error) {
        console.error('❌ Test failed:');

        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        } else if (error.request) {
            console.error('No response received:', error.message);
        } else {
            console.error('Error:', error.message);
        }
    }
}

async function testEmbeddingGeneration() {
    try {
        console.log('\n🧠 Testing embedding generation...');

        const { getDeepSeekEmbedding } = require('../utils/deepseek');
        const { convertToPCAEmbedding } = require('../utils/pcaEmbedding');

        const testText = 'This is a test caption for embedding generation';

        console.log('📝 Generating embedding for:', testText);
        const embedding = await getDeepSeekEmbedding(testText);

        if (embedding && embedding.length === 1536) {
            console.log('✅ Embedding generated successfully:', embedding.length, 'dimensions');

            console.log('🧮 Generating PCA embedding...');
            const embedding_pca = await convertToPCAEmbedding(embedding);

            if (embedding_pca && embedding_pca.length === 128) {
                console.log('✅ PCA embedding generated successfully:', embedding_pca.length, 'dimensions');
                return true;
            } else {
                console.error('❌ PCA embedding generation failed');
                return false;
            }
        } else {
            console.error('❌ Embedding generation failed');
            return false;
        }

    } catch (error) {
        console.error('❌ Embedding test failed:', error.message);
        return false;
    }
}

async function main() {
    console.log('🚀 Starting reel upload tests...\n');

    // Test 1: Verify embedding generation works
    const embeddingTest = await testEmbeddingGeneration();

    if (!embeddingTest) {
        console.log('⚠️ Skipping upload test due to embedding generation failure');
        return;
    }

    // Test 2: Test the upload endpoint (commented out since it requires a real Instagram URL)
    console.log('\n⚠️ Upload endpoint test is commented out since it requires:');
    console.log('  - A real Instagram reel URL');
    console.log('  - Valid AWS credentials');
    console.log('  - A valid source ID from your database');
    console.log('\nTo test the upload endpoint:');
    console.log('1. Replace the test data with real values');
    console.log('2. Uncomment the testReelUpload() call below');
    console.log('3. Run the script again');

    // Uncomment this line to test the actual upload endpoint:
    // await testReelUpload();

    console.log('\n✅ Test completed');
}

if (require.main === module) {
    main();
}
