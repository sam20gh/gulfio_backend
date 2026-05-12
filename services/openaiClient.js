const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const redis = require('../utils/redis');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;
const EMBED_CACHE_TTL = 60 * 60 * 24; // 24h

const keepAliveAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 50,
    maxFreeSockets: 10,
});

const openaiAxios = axios.create({
    baseURL: 'https://api.openai.com/v1',
    httpsAgent: keepAliveAgent,
    headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
    },
});

function embedCacheKey(text) {
    return `ai:embed:${EMBEDDING_MODEL}:${crypto.createHash('sha1').update(text.trim().toLowerCase()).digest('hex')}`;
}

async function embedQuery(text) {
    const key = embedCacheKey(text);
    const cached = await redis.get(key);
    if (cached) {
        try {
            return JSON.parse(cached);
        } catch {
            // fall through to refetch
        }
    }

    const { data } = await openaiAxios.post('/embeddings', {
        input: text,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMS,
    }, { timeout: 8000 });

    const vector = data.data[0].embedding;
    // Fire-and-forget cache write (don't slow the request path)
    redis.set(key, JSON.stringify(vector), 'EX', EMBED_CACHE_TTL).catch(() => {});
    return vector;
}

async function chatCompletion({ messages, model, max_tokens, temperature = 0.7, signal }) {
    const { data } = await openaiAxios.post('/chat/completions', {
        model,
        messages,
        temperature,
        max_tokens,
        presence_penalty: 0.1,
        frequency_penalty: 0.1,
    }, { timeout: 25000, signal });
    return data.choices[0].message.content;
}

/**
 * Stream chat completion deltas. Calls onDelta(textChunk) for each token group,
 * resolves with the full assembled text when complete.
 */
async function streamChatCompletion({ messages, model, max_tokens, temperature = 0.7, onDelta, signal }) {
    const response = await openaiAxios.post('/chat/completions', {
        model,
        messages,
        temperature,
        max_tokens,
        presence_penalty: 0.1,
        frequency_penalty: 0.1,
        stream: true,
    }, {
        responseType: 'stream',
        timeout: 30000,
        signal,
    });

    let buffer = '';
    let fullText = '';

    return new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep partial line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(payload);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullText += delta;
                        try { onDelta?.(delta); } catch { /* consumer error shouldn't kill stream */ }
                    }
                } catch {
                    // ignore malformed SSE frames from upstream
                }
            }
        });

        response.data.on('end', () => resolve(fullText));
        response.data.on('error', reject);
    });
}

module.exports = {
    openaiAxios,
    embedQuery,
    chatCompletion,
    streamChatCompletion,
    EMBEDDING_MODEL,
    EMBEDDING_DIMS,
};
