// Debug script for YouTube Shorts scraper issues
require('dotenv').config();
const { youtube } = require('btch-downloader');

// Mock source object
const mockSource = {
    _id: 'test123',
    name: 'Test Channel',
    youtubeChannelId: 'UCqwUrj10mAEsqezcItqvwEw' // Replace with a real channel ID that has shorts
};

async function debugYouTubeAPI() {
    console.log('🐛 Debugging YouTube API call...\n');
    
    const channelId = mockSource.youtubeChannelId;
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
    
    if (!YOUTUBE_API_KEY) {
        console.error('❌ YOUTUBE_API_KEY is not set');
        return;
    }
    
    console.log(`📺 Channel ID: ${channelId}`);
    console.log(`🔑 API Key: ${YOUTUBE_API_KEY.substring(0, 10)}...`);
    
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&videoDuration=short&q=%23Shorts&maxResults=5&key=${YOUTUBE_API_KEY}`;
    console.log(`🔍 API URL: ${url.replace(YOUTUBE_API_KEY, 'API_KEY_HIDDEN')}`);
    
    try {
        const axios = require('axios');
        const response = await axios.get(url);
        
        console.log('✅ YouTube API call successful!');
        console.log('📊 Response status:', response.status);
        console.log('📋 Items found:', response.data.items?.length || 0);
        
        if (response.data.items && response.data.items.length > 0) {
            console.log('\n📝 First video details:');
            const firstVideo = response.data.items[0];
            console.log('   Video ID:', firstVideo.id.videoId);
            console.log('   Title:', firstVideo.snippet.title);
            console.log('   Published:', firstVideo.snippet.publishedAt);
            
            // Test btch-downloader with this video
            const youtubeUrl = `https://youtube.com/watch?v=${firstVideo.id.videoId}`;
            console.log('\n🎬 Testing btch-downloader with this video...');
            console.log('   URL:', youtubeUrl);
            
            try {
                const result = await youtube(youtubeUrl);
                console.log('✅ btch-downloader successful!');
                console.log('📊 Result type:', typeof result);
                
                const rawUrl = (typeof result === 'object' && result.mp4);
                console.log('🔗 Extracted MP4 URL:', rawUrl ? rawUrl.substring(0, 100) + '...' : 'Not found');
                
                if (rawUrl && rawUrl.startsWith('http')) {
                    console.log('✅ Valid download URL found!');
                } else {
                    console.log('❌ No valid download URL found');
                }
                
            } catch (btchError) {
                console.error('❌ btch-downloader failed:', btchError.message);
            }
        } else {
            console.log('⚠️ No videos found in API response');
            console.log('📋 Full response:', JSON.stringify(response.data, null, 2));
        }
        
    } catch (error) {
        console.error('❌ YouTube API call failed:');
        console.error('   Status:', error.response?.status);
        console.error('   Status Text:', error.response?.statusText);
        console.error('   Error Data:', error.response?.data);
        console.error('   Error Message:', error.message);
    }
}

// Run the debug
debugYouTubeAPI();
