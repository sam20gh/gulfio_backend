require('dotenv').config();
const axios = require('axios');

async function testAIChat() {
    try {
        const baseURL = 'https://gulfio-backend-180255041979.me-central1.run.app';

        // Create a chat session
        console.log('🔍 Creating chat session...');
        const sessionResponse = await axios.post(`${baseURL}/api/ai/chat/session`, {}, {
            headers: {
                'Authorization': 'Bearer test-token', // Using a test token for now
                'Content-Type': 'application/json'
            }
        });

        const sessionId = sessionResponse.data.sessionId;
        console.log(`✅ Created session: ${sessionId}`);

        // Send a test message
        console.log('🔍 Sending test message...');
        const messageResponse = await axios.post(`${baseURL}/api/ai/chat/message`, {
            sessionId: sessionId,
            message: 'Tell me about recent football news'
        }, {
            headers: {
                'Authorization': 'Bearer test-token',
                'Content-Type': 'application/json'
            }
        });

        console.log('✅ AI Response:');
        console.log(messageResponse.data.response);

    } catch (error) {
        console.error('❌ Error testing AI chat:', error.response?.data || error.message);
    }
}

testAIChat();