require('dotenv').config();
const axios = require('axios');

async function testDeployedBackend() {
    console.log('🔧 Testing Deployed Backend Authentication\n');
    
    const DEPLOYED_URL = 'https://gulfio-backend-180255041979.me-central1.run.app/api';
    const ADMIN_KEY = process.env.ADMIN_API_KEY;
    
    console.log('🎯 Testing deployed backend:', DEPLOYED_URL);
    console.log('🔑 Using admin key:', ADMIN_KEY ? 'YES' : 'NO');
    console.log('');
    
    // Test 1: Basic health check
    console.log('1️⃣ Testing basic health check...');
    try {
        const response = await axios.get(`${DEPLOYED_URL}/articles`, {
            validateStatus: () => true
        });
        console.log(`   Status: ${response.status}`);
        if (response.status === 200) {
            console.log('   ✅ Basic endpoint working');
        } else {
            console.log('   ❌ Basic endpoint failed:', response.data?.message);
        }
    } catch (error) {
        console.log('   ❌ ERROR:', error.message);
    }
    
    console.log('');
    
    // Test 2: Push token endpoint with admin key
    console.log('2️⃣ Testing push token endpoint with admin key...');
    try {
        const response = await axios.post(`${DEPLOYED_URL}/users/push-token`, {
            token: 'test-push-token'
        }, {
            headers: {
                'x-api-key': ADMIN_KEY
            },
            validateStatus: () => true
        });
        
        console.log(`   Status: ${response.status}`);
        console.log(`   Response:`, response.data);
        
        if (response.status === 500) {
            console.log('   ❌ This is the error causing mobile app failures!');
        }
    } catch (error) {
        console.log('   ❌ ERROR:', error.message);
    }
    
    console.log('');
    
    // Test 3: Check if debug endpoint exists
    console.log('3️⃣ Testing debug endpoint...');
    try {
        const response = await axios.get(`${DEPLOYED_URL}/debug/auth-test`, {
            headers: {
                'x-api-key': ADMIN_KEY
            },
            validateStatus: () => true
        });
        console.log(`   Status: ${response.status}`);
        if (response.status === 404) {
            console.log('   ⚠️ Debug endpoint not found - backend needs redeployment');
        } else {
            console.log('   ✅ Debug endpoint exists');
        }
    } catch (error) {
        console.log('   ❌ ERROR:', error.message);
    }
    
    console.log('\n📋 Summary:');
    console.log('   - The deployed backend likely has the old authentication code');
    console.log('   - Need to redeploy with our fixes');
    console.log('   - Push token endpoint is failing with 500 error');
}

testDeployedBackend().catch(console.error);
