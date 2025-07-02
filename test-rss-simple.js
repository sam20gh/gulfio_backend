// Simple RSS feed test (no database required)
const axios = require('axios');
const xml2js = require('xml2js');

async function testRSSFeed() {
    console.log('📡 Testing YouTube RSS feed access...\n');
    
    const channelId = 'UCqwUrj10mAEsqezcItqvwEw'; // Example channel
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    
    console.log(`🔍 Channel ID: ${channelId}`);
    console.log(`📡 RSS URL: ${rssUrl}`);
    
    try {
        console.log('⬇️ Fetching RSS feed...');
        const { data: xmlData } = await axios.get(rssUrl);
        console.log('✅ RSS feed fetched successfully');
        console.log(`📊 XML data length: ${xmlData.length} characters`);
        
        console.log('🔍 Parsing XML...');
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xmlData);
        
        const entries = result.feed?.entry || [];
        console.log(`📋 Found ${entries.length} videos in feed`);
        
        if (entries.length > 0) {
            console.log('\n📝 First 3 videos:');
            entries.slice(0, 3).forEach((entry, index) => {
                const videoId = entry['yt:videoId']?.[0];
                const title = entry.title?.[0];
                const publishedAt = entry.published?.[0];
                
                console.log(`   ${index + 1}. ${title}`);
                console.log(`      Video ID: ${videoId}`);
                console.log(`      Published: ${publishedAt}`);
                console.log(`      URL: https://youtube.com/watch?v=${videoId}\n`);
            });
        }
        
        console.log('✅ RSS feed test successful!');
        
    } catch (error) {
        console.error('❌ RSS feed test failed:');
        console.error('Error:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Status Text:', error.response.statusText);
        }
    }
}

testRSSFeed();
