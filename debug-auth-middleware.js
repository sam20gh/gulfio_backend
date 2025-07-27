const axios = require('axios');

async function debugAuthMiddleware() {
    console.log('🔧 Next Steps: Debugging Auth Middleware\n');

    const tests = [
        {
            name: 'No Auth Headers',
            headers: {},
            expectStatus: 401,
            expectMessage: 'should fail - missing token'
        },
        {
            name: 'Invalid Bearer Token',
            headers: { 'Authorization': 'Bearer invalid-token' },
            expectStatus: 403,
            expectMessage: 'should fail - invalid token'
        },
        {
            name: 'Admin Key Bypass',
            headers: { 'x-api-key': 'vjK7QyBPI1eEiBXkNwQ6NmIbUWyyQPu8x8sJgVwdAMccqKrsWwdrmFBF70vUQLH2J4yQIAqiv7nHAVd9Dq0UqGlX3wyqoARbgt7acN3SXWxRsAVclHV8kqELENZoYRS3' },
            expectStatus: 200,
            expectMessage: 'should pass - valid admin key'
        }
    ];

    for (const test of tests) {
        console.log(`🧪 Testing: ${test.name}`);
        try {
            const response = await axios.get('http://localhost:3000/api/debug/auth-test', {
                headers: test.headers,
                validateStatus: () => true
            });

            console.log(`   Status: ${response.status} (expected: ${test.expectStatus})`);
            console.log(`   Message: ${response.data.message || 'No message'}`);

            if (response.status === test.expectStatus) {
                console.log(`   ✅ PASS: ${test.expectMessage}`);
            } else {
                console.log(`   ❌ FAIL: ${test.expectMessage}`);
                console.log(`   Full response:`, JSON.stringify(response.data, null, 2));
            }
        } catch (error) {
            console.log(`   ❌ ERROR: ${error.message}`);
        }
        console.log('');
    }

    // Test personalized articles with admin key
    console.log('🎯 Testing personalized articles with admin key...');
    try {
        const response = await axios.get('http://localhost:3000/api/articles/personalized', {
            headers: { 'x-api-key': 'vjK7QyBPI1eEiBXkNwQ6NmIbUWyyQPu8x8sJgVwdAMccqKrsWwdrmFBF70vUQLH2J4yQIAqiv7nHAVd9Dq0UqGlX3wyqoARbgt7acN3SXWxRsAVclHV8kqELENZoYRS3' },
            validateStatus: () => true
        });

        console.log(`   Status: ${response.status}`);
        if (response.status === 200) {
            console.log(`   ✅ Personalized articles working with admin key`);
            console.log(`   Articles returned: ${response.data.articles ? response.data.articles.length : 'Unknown'}`);
        } else {
            console.log(`   ❌ Personalized articles failed: ${response.data.message}`);
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
    }

    console.log('\n📋 Summary:');
    console.log('   1. Auth middleware should reject requests without tokens (401)');
    console.log('   2. Auth middleware should reject invalid tokens (403)');
    console.log('   3. Admin key should bypass authentication (200)');
    console.log('   4. If tests pass, the issue is with JWT token structure/verification');
    console.log('   5. Next: Test with real JWT token from mobile app');
}

debugAuthMiddleware().catch(console.error);
