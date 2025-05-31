const axios = require('axios');

const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = "text-embedding-3-small"; // Or use "text-embedding-ada-002"

async function getDeepSeekEmbedding(texts) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    // Always send as array
    const input = Array.isArray(texts) ? texts : [texts];
    try {
        const response = await axios.post(
            OPENAI_API_URL,
            {
                model: DEFAULT_MODEL,
                input
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        if (
            response.data &&
            Array.isArray(response.data.data) &&
            response.data.data[0]?.embedding
        ) {
            // Return array or single embedding depending on input
            return input.length === 1
                ? response.data.data[0].embedding
                : response.data.data.map(item => item.embedding);
        } else {
            throw new Error('Invalid response from OpenAI API');
        }
    } catch (err) {
        console.error('OpenAI embedding error:', err.response?.data || err.message);
        throw err;
    }
}

module.exports = { getDeepSeekEmbedding };
