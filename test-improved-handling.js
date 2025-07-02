// Test the improved RSS scraper with better error handling
require('dotenv').config();
const { youtube } = require('btch-downloader');

async function testImprovedErrorHandling() {
    console.log('🧪 Testing improved error handling...\n');
    
    // Test with the problematic video ID from the logs
    const problematicVideoId = '7-c0xnAPpMY';
    const youtubeUrl = `https://youtube.com/watch?v=${problematicVideoId}`;
    
    console.log(`🎬 Testing with problematic video: ${youtubeUrl}`);
    
    try {
        console.log('⬇️ Attempting to extract download URL...');
        
        let downloadResult;
        let retryCount = 0;
        const maxRetries = 2;
        
        // Retry logic for URL extraction
        while (retryCount <= maxRetries) {
            try {
                downloadResult = await youtube(youtubeUrl);
                console.log('✅ URL extraction successful!');
                break; // Success, exit retry loop
            } catch (extractError) {
                retryCount++;
                console.log(`⚠️ Extraction attempt ${retryCount} failed: ${extractError.message}`);
                if (retryCount <= maxRetries) {
                    console.log(`🔄 Retrying in 2 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    throw extractError; // Give up after max retries
                }
            }
        }
        
        console.log('📊 Result type:', typeof downloadResult);
        
        const rawUrl = (typeof downloadResult === 'object' && downloadResult.mp4);
        console.log('🎥 Extracted URL found:', !!rawUrl);
        
        if (rawUrl) {
            console.log('🔗 URL length:', rawUrl.length);
            console.log('📝 URL preview:', rawUrl.substring(0, 100) + '...');
            
            // Check duration if available
            const duration = downloadResult?.duration || downloadResult?.dur;
            if (duration) {
                console.log('⏱️ Duration:', Math.round(parseFloat(duration)), 'seconds');
            }
            
            console.log('\n💡 To test download, we would now attempt to fetch this URL...');
            console.log('   Note: The 403 error happens during the download step, not URL extraction');
        } else {
            console.log('❌ No valid URL found');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        
        if (error.message.includes('403') || error.message.includes('Forbidden')) {
            console.log('💡 This video may be geo-blocked or have restricted access');
        } else if (error.message.includes('Private video')) {
            console.log('💡 This video is private and cannot be accessed');
        }
    }
    
    console.log('\n🎉 Error handling test completed!');
}

testImprovedErrorHandling();
