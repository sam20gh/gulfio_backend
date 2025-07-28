const axios = require('axios');

async function testPersonalizedArticles() {
  try {
    // Test the actual deployed backend (correct URL with /api path)
    const baseUrl = 'https://gulfio-backend-180255041979.me-central1.run.app/api';
    
    console.log('🔍 Testing deployed backend personalized articles...');
    console.log('🌐 URL:', `${baseUrl}/articles/personalized`);
    
    // First, let's test without authentication to see regular articles
    console.log('\n1️⃣ Testing regular articles (no auth):');
    try {
      const regularResponse = await axios.get(`${baseUrl}/articles`, {
        params: {
          page: 1,
          limit: 5,
          language: 'english'
        }
      });
      
      console.log('✅ Regular articles:', regularResponse.data?.length || 0, 'articles');
      if (regularResponse.data && regularResponse.data.length > 0) {
        console.log('📊 First 3 regular articles:');
        regularResponse.data.slice(0, 3).forEach((article, index) => {
          const publishedDate = new Date(article.publishedAt);
          const hoursOld = Math.round((new Date() - publishedDate) / (1000 * 60 * 60));
          console.log(`${index + 1}. "${article.title.substring(0, 60)}..." - ${hoursOld}h old`);
        });
      }
    } catch (regError) {
      console.error('❌ Regular articles error:', regError.response?.status, regError.response?.data || regError.message);
    }

    // Test the backend health/status
    console.log('\n2️⃣ Testing backend health:');
    try {
      const healthResponse = await axios.get(`${baseUrl}/health`);
      console.log('✅ Backend health:', healthResponse.data);
    } catch (healthError) {
      console.log('⚠️ Health endpoint not available');
    }

    console.log('\n3️⃣ Testing fresh articles availability:');
    try {
      const freshResponse = await axios.get(`${baseUrl}/articles`, {
        params: {
          page: 1,
          limit: 10,
          language: 'english',
          fresh: 'true' // Check if there's a fresh articles filter
        }
      });
      
      console.log('✅ Fresh articles check:', freshResponse.data?.length || 0, 'articles');
      if (freshResponse.data && freshResponse.data.length > 0) {
        console.log('📊 Freshest articles in database:');
        freshResponse.data.slice(0, 3).forEach((article, index) => {
          const publishedDate = new Date(article.publishedAt);
          const hoursOld = Math.round((new Date() - publishedDate) / (1000 * 60 * 60));
          console.log(`${index + 1}. "${article.title.substring(0, 60)}..." - ${hoursOld}h old`);
        });
      }
    } catch (freshError) {
      console.error('❌ Fresh articles error:', freshError.response?.status);
    }

    console.log('\n4️⃣ For personalized articles test:');
    console.log('   Run the menaApp, check logs for JWT token, then update this script');
    console.log('   Token format: eyJ... (very long string)');
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testPersonalizedArticles();
