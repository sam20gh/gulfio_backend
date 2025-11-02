const jwt = require('jsonwebtoken');
const axios = require('axios');

// Test JWT token creation (simulating what Supabase would send)
const testPayload = {
    "aud": "authenticated",
    "exp": 1762025907,
    "iat": 1730490507,
    "iss": "https://uwbxhxsqisplrnvrltzv.supabase.co/auth/v1",
    "sub": "235b9b1c-8a10-44ed-b7e2-add8e14efe27",
    "email": "test@example.com",
    "phone": "",
    "app_metadata": {
        "provider": "email",
        "providers": ["email"]
    },
    "user_metadata": {},
    "role": "authenticated",
    "aal": "aal1",
    "amr": [{ "method": "password", "timestamp": 1730490507 }],
    "session_id": "abc123"
};

// Supabase JWT secret from environment
const JWT_SECRET = "QKi2YHmsTmCvNYRilddeYzs4SeRF5LGcMDCIWTIrbSOiwKewsYQ5RzN+P94Yqlw9gVakeCBMkyKAIGlEdQx+fw==";

async function testChatSession() {
    try {
        console.log('🔐 Creating test JWT token...');

        // Create a test JWT token similar to what Supabase would generate
        const testToken = jwt.sign(testPayload, JWT_SECRET, {
            algorithm: 'HS256'
        });

        console.log('✅ Test JWT token created');
        console.log('🔍 Token payload:', JSON.stringify(jwt.decode(testToken), null, 2));

        // Test chat session creation
        console.log('\n🚀 Testing chat session creation...');

        const response = await axios.post(
            'https://gulfio-backend-180255041979.me-central1.run.app/api/ai/chat/session',
            {
                language: 'english'
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${testToken}`
                },
                timeout: 30000 // 30 second timeout
            }
        );

        console.log('✅ Chat session created successfully!');
        console.log('📋 Response:', JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.error('❌ Test failed:', error.message);

        if (error.response) {
            console.error('❌ Status:', error.response.status);
            console.error('❌ Response data:', JSON.stringify(error.response.data, null, 2));
            console.error('❌ Response headers:', JSON.stringify(error.response.headers, null, 2));
        } else if (error.request) {
            console.error('❌ Network error - no response received');
        } else {
            console.error('❌ Request setup error:', error.message);
        }

        console.error('❌ Full error:', error);
    }
}

// Run the test
testChatSession();