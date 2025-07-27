const axios = require('axios');

// Test configuration
const BASE_URL = 'http://localhost:3000/api';

// This is a simulated token with the same structure as your real token
// (This won't actually work since it's not signed correctly, but it will test our JWT parsing)
const FAKE_USER_TOKEN = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({
    "iss": "https://uwbxhxsqisplrnvrltzv.supabase.co/auth/v1",
    "sub": "1d9861e0-db07-437b-8de9-8b8f1c8d8e6d",
    "aud": "authenticated",
    "exp": Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    "iat": Math.floor(Date.now() / 1000),
    "email": "sam20gh@gmail.com",
    "phone": "",
    "app_metadata": {
        "provider": "email",
        "providers": ["email"]
    },
    "user_metadata": {
        "email": "sam20gh@gmail.com",
        "email_verified": true,
        "phone_verified": false,
        "sub": "1d9861e0-db07-437b-8de9-8b8f1c8d8e6d"
    },
    "role": "authenticated",
    "aal": "aal1",
    "amr": [{ "method": "password", "timestamp": Math.floor(Date.now() / 1000) }],
    "session_id": "54ee8ba5-568f-4b9f-b567-8995b47b7c1c",
    "is_anonymous": false
})).toString('base64url')}.fake-signature`;

async function testWithRealJWT() {
    console.log('🧪 Testing with Real JWT Structure...\n');

    // Test 1: Auth endpoint with properly structured JWT (will fail verification but should show parsing)
    try {
        console.log('1️⃣ Testing auth endpoint with real JWT structure...');
        const response = await axios.get(`${BASE_URL}/debug/auth-test`, {
            headers: {
                'Authorization': `Bearer ${FAKE_USER_TOKEN}`
                // No admin key - pure JWT test
            }
        });
        console.log('✅ Unexpected success with fake JWT:', response.data);
    } catch (error) {
        console.log('🔍 JWT parsing result:', error.response?.status, error.response?.data?.message);
        console.log('🔍 This should show our enhanced JWT debugging logs in the backend');
    }

    console.log('');

    // Test 2: Personalized articles with structured JWT
    try {
        console.log('2️⃣ Testing personalized articles with real JWT structure...');
        const response = await axios.get(`${BASE_URL}/articles/personalized`, {
            headers: {
                'Authorization': `Bearer ${FAKE_USER_TOKEN}`
            }
        });
        console.log('✅ Unexpected success:', response.data);
    } catch (error) {
        console.log('🔍 Personalized articles result:', error.response?.status, error.response?.data?.message);
    }

    console.log('');
    console.log('🎯 Key Points:');
    console.log('   - Check backend logs for JWT debugging output');
    console.log('   - Our middleware should decode the JWT and show structure');
    console.log('   - Should fail verification but succeed in parsing');
    console.log('   - For real testing, we need the actual signed token from mobile app');
}

// Run tests
testWithRealJWT().catch(console.error);
