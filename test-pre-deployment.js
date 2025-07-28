require('dotenv').config();
const axios = require('axios');

async function testLocalBackendComplete() {
    console.log('🔧 Complete Local Backend Test (Pre-Deployment)\n');

    const BASE_URL = 'http://localhost:3000/api';
    const ADMIN_KEY = process.env.ADMIN_API_KEY;

    // Create a test JWT with proper structure
    const createTestJWT = () => {
        const header = { "alg": "HS256", "typ": "JWT" };
        const payload = {
            "iss": "https://uwbxhxsqisplrnvrltzv.supabase.co/auth/v1",
            "sub": "1d9861e0-db07-437b-8de9-8b8f1c8d8e6d",
            "aud": "authenticated",
            "exp": Math.floor(Date.now() / 1000) + 3600,
            "iat": Math.floor(Date.now() / 1000),
            "email": "sam20gh@gmail.com",
            "user_metadata": { "email": "sam20gh@gmail.com" },
            "role": "authenticated"
        };

        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${encodedHeader}.${encodedPayload}.fake-signature`;
    };

    const testJWT = createTestJWT();

    const tests = [
        {
            name: 'Push Token Endpoint (Fixed)',
            method: 'POST',
            url: `${BASE_URL}/users/push-token`,
            headers: { 'Authorization': `Bearer ${testJWT}` },
            data: { token: 'test-push-token-12345' },
            expect: 200
        },
        {
            name: 'Personalized Articles',
            method: 'GET',
            url: `${BASE_URL}/articles/personalized`,
            headers: { 'Authorization': `Bearer ${testJWT}` },
            expect: 200
        },
        {
            name: 'User Profile (/me)',
            method: 'GET',
            url: `${BASE_URL}/users/me`,
            headers: { 'Authorization': `Bearer ${testJWT}` },
            expect: 200
        },
        {
            name: 'Recommendations',
            method: 'GET',
            url: `${BASE_URL}/recommendations`,
            headers: { 'Authorization': `Bearer ${testJWT}` },
            expect: 200
        }
    ];

    console.log('🎯 Testing Critical Endpoints with JWT:\n');

    for (const test of tests) {
        console.log(`${test.name}:`);
        try {
            const config = {
                method: test.method,
                url: test.url,
                headers: test.headers,
                validateStatus: () => true
            };

            if (test.data) {
                config.data = test.data;
            }

            const response = await axios(config);

            console.log(`   Status: ${response.status} (expected: ${test.expect})`);

            if (response.status === test.expect) {
                console.log(`   ✅ SUCCESS`);
                if (test.name.includes('Articles') && response.data.articles) {
                    console.log(`   📊 Articles returned: ${response.data.articles.length}`);
                }
            } else {
                console.log(`   ❌ FAILED: ${response.data.message || 'Unknown error'}`);
            }
        } catch (error) {
            console.log(`   ❌ ERROR: ${error.message}`);
        }
        console.log('');
    }

    console.log('🏁 Pre-Deployment Summary:');
    console.log('   If all tests pass, the backend is ready for deployment');
    console.log('   The main fixes:');
    console.log('   - ✅ dotenv.config() added to app.js');
    console.log('   - ✅ Enhanced auth middleware with JWT fallback');
    console.log('   - ✅ ensureMongoUser middleware with comprehensive logging');
    console.log('   - ✅ Push token route fixed to use ensureMongoUser');
}

testLocalBackendComplete().catch(console.error);
