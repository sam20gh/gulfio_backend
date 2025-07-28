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

        console.log('\n4️⃣ Testing personalized articles with JWT:');
        console.log('   🔑 Copy a JWT token from the app logs above and paste it here:');

        // Test with actual JWT token - using a token structure from your logs
        const sampleToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzUzNzI2NjUxLCJpYXQiOjE3NTM3MjMwNTEsImlzcyI6Imh0dHBzOi8vdXdieGh4c3Fpc3Bscm52cmx0enYuc3VwYWJhc2UuY28vYXV0aC92MSIsInN1YiI6IjFkOTg2MWUwLWRiMDctNDM3Yi04ZGU5LThiOGYxYzhkOGU2ZCIsImVtYWlsIjoic2FtMjBnaEBnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6ImVtYWlsIiwicHJvdmlkZXJzIjpbImVtYWlsIl19LCJ1c2VyX21ldGFkYXRhIjp7ImVtYWlsIjoic2FtMjBnaEBnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGhvbmVfdmVyaWZpZWQiOmZhbHNlLCJzdWIiOiIxZDk4NjFlMC1kYjA3LTQzN2ItOGRlOS04YjhmMWM4ZDhlNmQifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJwYXNzd29yZCIsInRpbWVzdGFtcCI6MTc1MzcyMzA1MX1dLCJzZXNzaW9uX2lkIjoiZTM0MzdmNmQtOGE5OS00MjZhLWE3YzktOWIzMDgyZWZlNGQzIiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.PLACEHOLDER_SIGNATURE';

        if (sampleToken && sampleToken !== 'REPLACE_WITH_ACTUAL_JWT_TOKEN' && !sampleToken.includes('your_signature_here')) {
            try {
                console.log('🧠 Testing personalized articles with JWT...');

                const personalizedResponse = await axios.get(`${baseUrl}/articles/personalized`, {
                    params: {
                        page: 1,
                        limit: 10,
                        language: 'english',
                        noCache: 'true',
                        timestamp: Date.now(),
                        priority: 'recent'
                    },
                    headers: {
                        'Authorization': `Bearer ${sampleToken}`,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0'
                    }
                });

                console.log('✅ Personalized articles:', personalizedResponse.data?.length || 0, 'articles');
                if (personalizedResponse.data && personalizedResponse.data.length > 0) {
                    console.log('📊 First 5 personalized articles:');
                    personalizedResponse.data.slice(0, 5).forEach((article, index) => {
                        const publishedDate = new Date(article.publishedAt);
                        const hoursOld = Math.round((new Date() - publishedDate) / (1000 * 60 * 60));
                        const isFresh = article.isFresh ? ' [FRESH]' : '';
                        const isTrending = article.isTrending ? ' [TRENDING]' : '';
                        console.log(`${index + 1}. "${article.title.substring(0, 50)}..." - ${hoursOld}h old${isFresh}${isTrending}`);
                    });
                }

            } catch (personalizedError) {
                console.error('❌ Personalized articles error:', personalizedError.response?.status, personalizedError.response?.data || personalizedError.message);
            }
        } else {
            console.log('   ⚠️ Replace the token above with a real JWT from the app logs to test');
        }

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

testPersonalizedArticles();
