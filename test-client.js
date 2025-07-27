const axios = require('axios');

// Test configuration
const BASE_URL = 'http://localhost:3000/api';
const TEST_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV3YnhoeHNxaXNwbHJudnJsdHp2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ4MDc5MTYsImV4cCI6MjA2MDM4MzkxNn0.XBxAMm7z7ffQBsLTBfZrwjJe9v1wzttnwO9sEKnPyeY'; // This is the anon key, we need a real user token

async function testEndpoints() {
    console.log('🧪 Testing Backend Endpoints...\n');

    // Test 1: Basic health check (with admin key)
    try {
        console.log('1️⃣ Testing basic articles endpoint...');
        const response = await axios.get(`${BASE_URL}/articles`, {
            headers: {
                'x-api-key': 'vjK7QyBPI1eEiBXkNwQ6NmIbUWyyQPu8x8sJgVwdAMccqKrsWwdrmFBF70vUQLH2J4yQIAqiv7nHAVd9Dq0UqGlX3wyqoARbgt7acN3SXWxRsAVclHV8kqELENZoYRS3'
            }
        });
        console.log('✅ Articles endpoint working:', response.status);
        console.log('   - Articles count:', response.data.articles?.length || 'N/A');
    } catch (error) {
        console.log('❌ Articles endpoint failed:', error.message);
    }

    console.log('');

    // Test 2: Auth endpoint without any headers (should fail)
    try {
        console.log('2️⃣ Testing auth endpoint without any headers...');
        const response = await axios.get(`${BASE_URL}/debug/auth-test`);
        console.log('❌ UNEXPECTED: Auth test passed without auth:', response.data);
    } catch (error) {
        console.log('✅ Expected auth failure:', error.response?.status, error.response?.data?.message);
    }

    console.log('');

    // Test 3: Auth endpoint with anon token (should fail with proper JWT error)
    try {
        console.log('3️⃣ Testing auth endpoint with anon token (no admin key)...');
        const response = await axios.get(`${BASE_URL}/debug/auth-test`, {
            headers: {
                'Authorization': `Bearer ${TEST_TOKEN}`
                // Note: No x-api-key header
            }
        });
        console.log('❌ UNEXPECTED: Auth test passed with anon token:', response.data);
    } catch (error) {
        console.log('✅ Expected auth failure with anon token:', error.response?.status, error.response?.data?.message);
    }

    console.log('');

    // Test 4: Auth endpoint with admin key (should pass)
    try {
        console.log('4️⃣ Testing auth endpoint with admin key...');
        const response = await axios.get(`${BASE_URL}/debug/auth-test`, {
            headers: {
                'x-api-key': 'vjK7QyBPI1eEiBXkNwQ6NmIbUWyyQPu8x8sJgVwdAMccqKrsWwdrmFBF70vUQLH2J4yQIAqiv7nHAVd9Dq0UqGlX3wyqoARbgt7acN3SXWxRsAVClHV8kqELENZoYRS3'
            }
        });
        console.log('✅ Admin auth working:', response.data);
    } catch (error) {
        console.log('❌ Admin auth failed:', error.response?.status, error.response?.data?.message);
    }

    console.log('');

    // Test 5: Personalized articles with anon token (should fail)
    try {
        console.log('5️⃣ Testing personalized articles with anon token...');
        const response = await axios.get(`${BASE_URL}/articles/personalized`, {
            headers: {
                'Authorization': `Bearer ${TEST_TOKEN}`
                // Note: No x-api-key header
            }
        });
        console.log('❌ UNEXPECTED: Personalized articles passed:', response.data);
    } catch (error) {
        console.log('✅ Expected personalized failure:', error.response?.status, error.response?.data?.message);
    }

    console.log('\n🎯 Test Summary:');
    console.log('   - Basic endpoints should work with admin key');
    console.log('   - Auth endpoints should reject requests without proper auth');
    console.log('   - Admin key should bypass authentication');
    console.log('   - For JWT testing, we need a real Supabase user token from the mobile app');
}

// Run tests
testEndpoints().catch(console.error);
