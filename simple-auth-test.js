const axios = require('axios');

async function simpleAuthTest() {
    console.log('🔬 Simple Auth Test - No Default Headers\n');

    try {
        const response = await axios.get('http://localhost:3000/api/debug/auth-test', {
            headers: {},
            validateStatus: () => true // Don't throw on non-2xx status
        });

        console.log('Response Status:', response.status);
        console.log('Response Data:', JSON.stringify(response.data, null, 2));
        console.log('Request Headers Sent:', JSON.stringify(response.config.headers, null, 2));

        if (response.status === 200) {
            console.log('❌ ERROR: Auth endpoint should NOT pass without authentication!');
        } else {
            console.log('✅ Good: Auth endpoint correctly rejected unauthorized request');
        }

    } catch (error) {
        console.log('Error:', error.message);
    }
}

simpleAuthTest();
