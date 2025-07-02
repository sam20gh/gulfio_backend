// Test script for btch-downloader package
const { youtube } = require('btch-downloader');

async function testBtchDownloader() {
    console.log('🧪 Testing btch-downloader package...\n');

    // Test with a known YouTube URL (replace with a real one)
    const testUrl = 'https://youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Roll for testing

    try {
        console.log(`🔍 Testing URL: ${testUrl}`);
        const result = await youtube(testUrl);

        console.log('✅ btch-downloader test successful!');
        console.log('📊 Result type:', typeof result);
        console.log('📋 Result structure:', JSON.stringify(result, null, 2));

        if (Array.isArray(result)) {
            console.log(`📦 Array with ${result.length} items`);
            if (result[0]) {
                console.log('🔗 First item URL:', result[0].url);
            }
        } else if (typeof result === 'object') {
            console.log('🔗 MP4 URL:', result.mp4);
        }

    } catch (error) {
        console.error('❌ btch-downloader test failed:');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
    }
}

// Run the test
testBtchDownloader();
