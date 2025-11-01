const axios = require('axios');

async function testAIEndpoint() {
    try {
        console.log('🤖 Testing AI suggestions endpoint...');

        const response = await axios.get('http://localhost:3000/api/ai/suggestions', {
            timeout: 5000
        });

        console.log('✅ Success!');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        }
    }
}

testAIEndpoint();