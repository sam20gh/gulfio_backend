require('dotenv').config();
const axios = require('axios');

async function testDeployedAuthenticationFix() {
    console.log('🎯 Testing Deployed Backend - Authentication Fix Verification\n');

    const DEPLOYED_URL = 'https://gulfio-backend-180255041979.me-central1.run.app/api';
    const ADMIN_KEY = process.env.ADMIN_API_KEY;

    console.log('🔧 Testing deployed backend with our authentication fixes...\n');

    // Test 1: Push token endpoint that was failing with 500 error
    console.log('1️⃣ Testing PUSH TOKEN endpoint (was causing 500 error)...');
    try {
        const testJWT = createTestJWT();
        const response = await axios.post(`${DEPLOYED_URL}/users/push-token`, {
            token: 'test-push-token-deployment'
        }, {
            headers: {
                'Authorization': `Bearer ${testJWT}`
            },
            validateStatus: () => true
        });

        console.log(`   Status: ${response.status}`);
        console.log(`   Response: ${response.data.message || JSON.stringify(response.data)}`);

        if (response.status === 200) {
            console.log('   ✅ FIXED! Push token endpoint now working');
        } else if (response.status === 500) {
            console.log('   ❌ Still failing - deployment may not be complete');
        } else {
            console.log('   ⚠️ Different status - check logs');
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('');

    // Test 2: Debug endpoint to verify environment variables
    console.log('2️⃣ Testing DEBUG endpoint (verifies dotenv fix)...');
    try {
        const response = await axios.get(`${DEPLOYED_URL}/debug/auth-test`, {
            headers: {
                'x-api-key': ADMIN_KEY
            },
            validateStatus: () => true
        });

        console.log(`   Status: ${response.status}`);
        if (response.status === 200) {
            console.log('   ✅ Debug endpoint working - environment variables loaded');
        } else {
            console.log('   ❌ Debug endpoint issue');
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('');

    // Test 3: Personalized articles
    console.log('3️⃣ Testing PERSONALIZED ARTICLES (was failing with auth)...');
    try {
        const testJWT = createTestJWT();
        const response = await axios.get(`${DEPLOYED_URL}/articles/personalized`, {
            headers: {
                'Authorization': `Bearer ${testJWT}`
            },
            validateStatus: () => true
        });

        console.log(`   Status: ${response.status}`);
        if (response.status === 200) {
            console.log('   ✅ FIXED! Personalized articles working');
        } else {
            console.log(`   ❌ Status: ${response.status}, Message: ${response.data.message}`);
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('\n🏁 Deployment Verification Summary:');
    console.log('   - Push token endpoint should be fixed (was 500 error)');
    console.log('   - Authentication middleware should work properly');
    console.log('   - Environment variables should be loaded');
    console.log('   - Mobile app errors should be resolved!');

    console.log('\n📱 Next Steps:');
    console.log('   1. If tests pass: Mobile app should work perfectly');
    console.log('   2. If tests fail: Check deployment completion');
    console.log('   3. Monitor mobile app for resolved authentication issues');
}

function createTestJWT() {
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
}

testDeployedAuthenticationFix().catch(console.error);
