require('dotenv').config();
const axios = require('axios');

async function testOpenAI() {
    try {
        console.log('🔍 Testing OpenAI API connection...');
        console.log('API Key:', process.env.OPENAI_API_KEY ? 'Present' : 'Missing');

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'user',
                        content: 'Hello, respond with just "API working"'
                    }
                ],
                max_tokens: 10
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        console.log('✅ OpenAI API Response:', response.data.choices[0].message.content);
        console.log('✅ Model used:', response.data.model);
        console.log('✅ Usage:', response.data.usage);

    } catch (error) {
        console.error('❌ OpenAI API Error:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            error: error.response?.data?.error || error.message
        });
    }
}

testOpenAI();