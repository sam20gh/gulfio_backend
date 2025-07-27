require('dotenv').config();
const axios = require('axios');

// Create a properly structured JWT token that our middleware can decode
// This still won't pass verification without the correct signature, but should parse correctly
const createTestJWT = () => {
    const header = {
        "alg": "HS256",
        "typ": "JWT"
    };

    const payload = {
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
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    return `${encodedHeader}.${encodedPayload}.fake-signature`;
};

async function testRealJWTFlow() {
    console.log('🎯 Testing Real JWT Authentication Flow\n');

    const testJWT = createTestJWT();
    console.log('📝 Created test JWT with real structure...\n');

    // Test 1: Auth endpoint with structured JWT
    console.log('1️⃣ Testing auth endpoint with structured JWT...');
    try {
        const response = await axios.get('http://localhost:3000/api/debug/auth-test', {
            headers: {
                'Authorization': `Bearer ${testJWT}`
            },
            validateStatus: () => true
        });

        console.log(`   Status: ${response.status}`);
        console.log(`   Message: ${response.data.message}`);
        if (response.data.user) {
            console.log(`   User ID: ${response.data.user.sub || response.data.user.user_id || response.data.user.id}`);
            console.log(`   Email: ${response.data.user.email}`);
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('');

    // Test 2: Personalized articles with structured JWT
    console.log('2️⃣ Testing personalized articles with structured JWT...');
    try {
        const response = await axios.get('http://localhost:3000/api/articles/personalized', {
            headers: {
                'Authorization': `Bearer ${testJWT}`
            },
            validateStatus: () => true
        });

        console.log(`   Status: ${response.status}`);
        if (response.status === 200) {
            console.log(`   ✅ SUCCESS! Personalized articles working`);
            console.log(`   Articles returned: ${response.data.articles ? response.data.articles.length : 'Check response'}`);
        } else {
            console.log(`   ❌ Failed: ${response.data.message}`);
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('\n🏁 Next Steps:');
    console.log('   1. If JWT parsing works but verification fails, we need proper signature');
    console.log('   2. For production testing, get real JWT from mobile app');
    console.log('   3. If everything works, deploy to Google Cloud');
    console.log('   4. Update frontend to use deployed backend URL');
}

testRealJWTFlow().catch(console.error);
