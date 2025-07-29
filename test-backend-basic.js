const axios = require('axios');

async function testWithCurrentToken() {
    // First, let's test the deployed backend directly without a token to see basic functionality
    const baseUrl = 'https://gulfio-backend-180255041979.me-central1.run.app/api';

    console.log('🔍 Testing backend basic functionality...');

    // Test regular articles endpoint
    try {
        console.log('\n1️⃣ Testing regular articles (should work)...');
        const regularResponse = await axios.get(`${baseUrl}/articles`, {
            params: {
                page: 1,
                limit: 3,
                language: 'english'
            },
            timeout: 10000
        });

        console.log('✅ Regular articles work:', regularResponse.data?.length || 0, 'articles');
        if (regularResponse.data && regularResponse.data.length > 0) {
            console.log('📊 Sample regular articles:');
            regularResponse.data.forEach((article, index) => {
                const publishedDate = new Date(article.publishedAt);
                const hoursOld = Math.round((new Date() - publishedDate) / (1000 * 60 * 60));
                console.log(`${index + 1}. "${article.title.substring(0, 50)}..." - ${hoursOld}h old`);
            });
        }
    } catch (error) {
        console.error('❌ Regular articles failed:', error.code || error.response?.status, error.message);
        console.error('❌ This suggests the backend deployment has issues');
        return;
    }

    console.log('\n✅ Backend basic functionality works!');
    console.log('\n🔑 TO TEST PERSONALIZED ARTICLES:');
    console.log('1. Open the mobile app');
    console.log('2. Look for console logs with JWT tokens');
    console.log('3. Copy a token and replace the token in test-personalized-articles.js');
    console.log('4. Run: node test-personalized-articles.js');

    console.log('\n📱 Or try logging in through the app now - the personalized articles should show fresh content!');
}

testWithCurrentToken();
