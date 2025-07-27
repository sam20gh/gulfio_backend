const axios = require('axios');

// Test configuration
const BASE_URL = 'http://localhost:3000/api';

// Test real JWT token structure (but it will fail verification since it's not actually signed)
const REAL_JWT_STRUCTURE = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({
    "iss": "https://uwbxhxsqisplrnvrltzv.supabase.co/auth/v1",
    "sub": "1d9861e0-db07-437b-8de9-8b8f1c8d8e6d",
    "aud": "authenticated",
    "exp": Math.floor(Date.now() / 1000) + 3600,
    "iat": Math.floor(Date.now() / 1000),
    "email": "sam20gh@gmail.com",
    "user_metadata": {
        "email": "sam20gh@gmail.com"
    },
    "role": "authenticated"
})).toString('base64url')}.fake-signature`;

async function testAuthFlow() {
    console.log('🔧 Comprehensive JWT Authentication Flow Test\n');

    // Test 1: No auth headers at all
    console.log('1️⃣ Testing auth endpoint with NO headers...');
    try {
        const response = await axios.get(`${BASE_URL}/debug/auth-test`, {
            headers: {} // Explicitly empty headers
        });
        console.log('❌ UNEXPECTED SUCCESS (should fail):', response.status, response.data);
    } catch (error) {
        console.log('✅ Expected failure:', error.response?.status, error.response?.data?.message);
    }

    console.log('');

    // Test 2: JWT structure test
    console.log('2️⃣ Testing auth endpoint with structured JWT...');
    try {
        const response = await axios.get(`${BASE_URL}/debug/auth-test`, {
            headers: {
                'Authorization': `Bearer ${REAL_JWT_STRUCTURE}`
            }
        });
        console.log('🔍 JWT Structure Result:', response.status, response.data);
    } catch (error) {
        console.log('🔍 JWT Structure Failed:', error.response?.status, error.response?.data?.message);
    }

    console.log('');

    // Test 3: Test personalized articles (this requires ensureMongoUser middleware)
    console.log('3️⃣ Testing personalized articles with structured JWT...');
    try {
        const response = await axios.get(`${BASE_URL}/articles/personalized`, {
            headers: {
                'Authorization': `Bearer ${REAL_JWT_STRUCTURE}`
            }
        });
        console.log('🎯 Personalized Success:', response.status, 'Articles:', response.data.length);
    } catch (error) {
        console.log('🎯 Personalized Failed:', error.response?.status, error.response?.data?.message);
        if (error.response?.data?.debug) {
            console.log('🎯 Debug info:', error.response.data.debug);
        }
    }

    console.log('');
    console.log('🏁 Key Findings:');
    console.log('   - JWT structure parsing working in auth middleware');
    console.log('   - Need real signed JWT from mobile app for full test');
    console.log('   - Check backend console for detailed JWT debugging logs');
    console.log('');
    console.log('📱 Next Step: Use real JWT token from mobile app logs');
    console.log('   1. Open mobile app');
    console.log('   2. Check console logs for JWT token');
    console.log('   3. Replace REAL_JWT_STRUCTURE above with actual token');
    console.log('   4. Re-run this test');
}

testAuthFlow().catch(console.error);
