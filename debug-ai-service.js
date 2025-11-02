const axios = require('axios');

const BACKEND_URL = 'https://gulfio-backend-180255041979.me-central1.run.app';
const API_KEY = 'mena-news-2024-api-key';

async function debugAIService() {
    console.log('🔍 Debugging AI service issues...\n');
    
    // First, test the suggestions endpoint (should work without auth)
    console.log('1. Testing suggestions endpoint...');
    try {
        const response = await axios.get(`${BACKEND_URL}/api/ai/suggestions`);
        console.log('✅ Suggestions working:', response.data.suggestions.slice(0, 2));
    } catch (error) {
        console.log('❌ Suggestions failed:', error.message);
    }
    
    console.log('\n2. Testing test endpoint with simple message...');
    const startTime = Date.now();
    try {
        const response = await axios.post(
            `${BACKEND_URL}/api/ai/test/message`,
            { message: 'Hello' },
            {
                headers: {
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 // Longer timeout for debugging
            }
        );
        
        const duration = Date.now() - startTime;
        console.log('✅ Test endpoint working!');
        console.log(`⏱️  Response time: ${duration}ms`);
        console.log(`📝 Response: ${response.data.response?.substring(0, 100)}...`);
        
    } catch (error) {
        const duration = Date.now() - startTime;
        console.log(`❌ Test endpoint failed after ${duration}ms`);
        console.log('Error:', error.message);
        if (error.response?.data) {
            console.log('Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
    
    console.log('\n3. Testing actual mobile app endpoint...');
    const sessionStart = Date.now();
    try {
        // Test creating a session first
        const sessionResponse = await axios.post(
            `${BACKEND_URL}/api/ai/chat/session`,
            { title: 'Debug Test Session' },
            {
                headers: {
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );
        
        console.log('✅ Session created successfully');
        console.log('Session ID:', sessionResponse.data.session?._id);
        
    } catch (error) {
        const duration = Date.now() - sessionStart;
        console.log(`❌ Session creation failed after ${duration}ms`);
        console.log('Error:', error.message);
        if (error.response?.data) {
            console.log('Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

debugAIService().catch(console.error);