require('dotenv').config();
const axios = require('axios');

async function listAvailableModels() {
    try {
        console.log('🔍 Checking available OpenAI models...');

        const response = await axios.get('https://api.openai.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        const chatModels = response.data.data.filter(model =>
            model.id.includes('gpt') || model.id.includes('turbo')
        );

        console.log('✅ Available Chat Models:');
        chatModels.forEach(model => {
            console.log(`- ${model.id} (${model.owned_by})`);
        });

        // Try the first available GPT model
        if (chatModels.length > 0) {
            const testModel = chatModels[0].id;
            console.log(`\n🧪 Testing with model: ${testModel}`);

            const testResponse = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: testModel,
                    messages: [
                        {
                            role: 'user',
                            content: 'Say "Hello, API is working!"'
                        }
                    ],
                    max_tokens: 20
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );

            console.log('✅ Test Response:', testResponse.data.choices[0].message.content);
            console.log(`✅ Working model: ${testModel}`);
        }

    } catch (error) {
        console.error('❌ Error:', error.response?.data?.error || error.message);
    }
}

listAvailableModels();