const axios = require('axios');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/embeddings'; // Replace if different!
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; // Set in your .env file

/**
 * Get embedding vector for the provided text from DeepSeek API
 * @param {string} text - The input text to embed
 * @returns {Promise<number[]>} - The embedding vector as an array of numbers
 */
async function getDeepSeekEmbedding(text) {
    if (!DEEPSEEK_API_KEY) {
        throw new Error('DEEPSEEK_API_KEY not set in environment variables');
    }
    if (!text || typeof text !== 'string') {
        throw new Error('Text must be a non-empty string');
    }

    try {
        const response = await axios.post(
            DEEPSEEK_API_URL,
            { input: text },
            {
                headers: {
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        // Adjust according to DeepSeek's response structure
        if (response.data && response.data.embedding) {
            return response.data.embedding;
        } else {
            throw new Error('Invalid response from DeepSeek API');
        }
    } catch (err) {
        console.error('DeepSeek embedding error:', err.response?.data || err.message);
        throw err;
    }
}

module.exports = { getDeepSeekEmbedding };
