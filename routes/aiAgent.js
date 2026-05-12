/**
 * AI Agent routes.
 *
 * Streaming endpoint: POST /api/ai/chat/message/stream
 *   Body: { sessionId, message, category?, usePersonalization? }
 *   Auth: Bearer token (same as POST /chat/message)
 *   Response: text/event-stream
 *     event: meta   data: { messageId, articles, sessionId }
 *     event: delta  data: { text: "<token chunk>" }
 *     event: done   data: { metadata }
 *     event: error  data: { error, fallback }
 *
 *   Frontend (fetch + ReadableStream) example:
 *     const res = await fetch(url, { method: 'POST', headers: {...auth, 'Content-Type':'application/json'}, body });
 *     const reader = res.body.getReader();
 *     // parse `event:` + `data:` frames separated by blank lines.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const auth = require('../middleware/auth');
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const redis = require('../utils/redis');
const {
    generateResponse,
    streamResponse,
    searchArticles,
    getSuggestedQuestions,
    generateQueryEmbedding,
    buildArticleReferences,
} = require('../services/aiAgentService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractUserId(user) {
    return user?.sub || user?.uid || user?.user_id || user?.id || null;
}

function answerCacheKey({ message, category, language }) {
    const norm = `${(message || '').trim().toLowerCase()}|${category || ''}|${language || ''}`;
    return `ai:answer:${crypto.createHash('sha1').update(norm).digest('hex')}`;
}

const ANSWER_TTL = 60 * 10; // 10 min — popular news questions repeat

// Best-effort persistence: never block the response on it
function persistAssistantTurn({ sessionId, userId, content, articles, metadata, isFirstMessage, firstMessageText }) {
    const aiMessage = new ChatMessage({
        sessionId,
        userId,
        role: 'assistant',
        content,
        articleReferences: (articles || []).map(a => a._id),
        timestamp: new Date(),
        metadata,
    });

    const sessionUpdate = {
        $set: { lastMessageAt: new Date() },
        $inc: { messageCount: 2 },
    };
    if (isFirstMessage && firstMessageText) {
        sessionUpdate.$set.title = firstMessageText.substring(0, 50) + (firstMessageText.length > 50 ? '...' : '');
    }

    return Promise.all([
        aiMessage.save(),
        ChatSession.findByIdAndUpdate(sessionId, sessionUpdate),
    ]).then(() => aiMessage._id).catch(err => {
        console.error('persistAssistantTurn failed:', err.message);
        return null;
    });
}

// ─── GET /suggestions ─────────────────────────────────────────────────────────

router.get('/suggestions', async (req, res) => {
    try {
        const suggestions = await getSuggestedQuestions();
        res.json({ success: true, suggestions });
    } catch (error) {
        console.error('Error getting suggestions:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to get suggestions',
            suggestions: [
                "What's happening in the UAE today?",
                'Latest business news from Saudi Arabia',
                'Gulf sports updates',
                "What's new in Qatar?",
            ],
        });
    }
});

// ─── POST /chat/session ───────────────────────────────────────────────────────

router.post('/chat/session', auth, async (req, res) => {
    try {
        const userId = extractUserId(req.user);
        if (!userId) {
            return res.status(400).json({ success: false, error: 'User ID not found in token' });
        }

        const chatSession = new ChatSession({
            userId,
            startedAt: new Date(),
            isActive: true,
            language: req.body.language || 'english',
        });
        await chatSession.save();

        res.json({ success: true, sessionId: chatSession._id, session: chatSession });
    } catch (error) {
        console.error('Error creating chat session:', error.message);
        res.status(500).json({ success: false, error: 'Failed to create chat session' });
    }
});

// ─── POST /chat/message (non-streaming, with response cache) ──────────────────

router.post('/chat/message', auth, async (req, res) => {
    const { sessionId, message, category, usePersonalization = true } = req.body;
    const userId = extractUserId(req.user);

    if (!message || !sessionId) {
        return res.status(400).json({ success: false, error: 'message and sessionId are required' });
    }
    if (!userId) {
        return res.status(400).json({ success: false, error: 'User ID not found in token' });
    }

    try {
        const session = await ChatSession.findOne({ _id: sessionId, userId }).lean();
        if (!session) {
            return res.status(404).json({ success: false, error: 'Chat session not found' });
        }

        const cacheKey = answerCacheKey({ message, category, language: session.language });
        const cacheStart = Date.now();
        const cachedRaw = await redis.get(cacheKey);
        if (cachedRaw) {
            try {
                const cached = JSON.parse(cachedRaw);
                const cacheMetadata = {
                    ...cached.metadata,
                    cached: true,
                    originalResponseTime: cached.metadata?.responseTime,
                    responseTime: Date.now() - cacheStart,
                };
                res.json({
                    success: true,
                    response: cached.response,
                    articles: cached.articles,
                    metadata: cacheMetadata,
                    cached: true,
                });
                // Persist user + assistant messages in the background so history stays intact
                new ChatMessage({ sessionId, userId, role: 'user', content: message, timestamp: new Date() }).save().catch(() => {});
                persistAssistantTurn({
                    sessionId, userId,
                    content: cached.response,
                    articles: cached.articles,
                    metadata: cacheMetadata,
                    isFirstMessage: (session.messageCount || 0) === 0,
                    firstMessageText: message,
                });
                return;
            } catch { /* fall through to full path */ }
        }

        // Parallel: precompute embedding while we wait for nothing
        const queryEmbedding = await generateQueryEmbedding(message);

        // Parallel: persist user message + run vector search (uses precomputed embedding)
        const userMessage = new ChatMessage({
            sessionId, userId, role: 'user', content: message, timestamp: new Date(),
        });
        const [, relevantArticles] = await Promise.all([
            userMessage.save(),
            searchArticles(message, category, userId, usePersonalization, null, queryEmbedding),
        ]);

        const aiResponse = await generateResponse(message, relevantArticles);

        // Respond immediately
        res.json({
            success: true,
            response: aiResponse.text,
            articles: aiResponse.articles,
            metadata: aiResponse.metadata,
        });

        // Off the critical path: cache + persist assistant message + update session
        if (!aiResponse.metadata?.fallback) {
            redis.set(cacheKey, JSON.stringify({
                response: aiResponse.text,
                articles: aiResponse.articles,
                metadata: aiResponse.metadata,
            }), 'EX', ANSWER_TTL).catch(() => {});
        }
        persistAssistantTurn({
            sessionId, userId,
            content: aiResponse.text,
            articles: aiResponse.articles,
            metadata: aiResponse.metadata,
            isFirstMessage: (session.messageCount || 0) === 0,
            firstMessageText: message,
        });
    } catch (error) {
        console.error('Error processing message:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: 'Failed to process message',
                fallback: "I'm having trouble right now. Please try again in a moment.",
            });
        }
    }
});

// ─── POST /chat/message/stream (SSE) ──────────────────────────────────────────

router.post('/chat/message/stream', auth, async (req, res) => {
    const { sessionId, message, category, usePersonalization = true } = req.body;
    const userId = extractUserId(req.user);

    if (!message || !sessionId) {
        return res.status(400).json({ success: false, error: 'message and sessionId are required' });
    }
    if (!userId) {
        return res.status(400).json({ success: false, error: 'User ID not found in token' });
    }

    // SSE headers
    res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });
    res.flushHeaders?.();

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Heartbeat to keep proxies from closing the connection
    const heartbeat = setInterval(() => res.write(':\n\n'), 15_000);

    const abortController = new AbortController();
    req.on('close', () => {
        abortController.abort();
        clearInterval(heartbeat);
    });

    try {
        const session = await ChatSession.findOne({ _id: sessionId, userId }).lean();
        if (!session) {
            send('error', { error: 'Chat session not found' });
            clearInterval(heartbeat);
            return res.end();
        }

        // Cache hit: replay the cached answer as a single delta and skip OpenAI entirely
        const cacheKey = answerCacheKey({ message, category, language: session.language });
        const cacheStart = Date.now();
        const cachedRaw = await redis.get(cacheKey);
        if (cachedRaw) {
            try {
                const cached = JSON.parse(cachedRaw);
                send('meta', { sessionId, articles: cached.articles });
                send('delta', { text: cached.response });
                send('done', {
                    metadata: {
                        ...cached.metadata,
                        cached: true,
                        originalResponseTime: cached.metadata?.responseTime,
                        responseTime: Date.now() - cacheStart,
                    },
                });
                clearInterval(heartbeat);
                res.end();

                // Persist both turns in the background
                new ChatMessage({ sessionId, userId, role: 'user', content: message, timestamp: new Date() }).save().catch(() => {});
                persistAssistantTurn({
                    sessionId, userId,
                    content: cached.response,
                    articles: cached.articles,
                    metadata: { ...cached.metadata, cached: true },
                    isFirstMessage: (session.messageCount || 0) === 0,
                    firstMessageText: message,
                });
                return;
            } catch { /* fall through to full path */ }
        }

        // Persist user message in parallel with retrieval (don't await)
        const userMessage = new ChatMessage({
            sessionId, userId, role: 'user', content: message, timestamp: new Date(),
        });
        const userSavePromise = userMessage.save().catch(err => {
            console.error('user message save failed:', err.message);
        });

        const queryEmbedding = await generateQueryEmbedding(message);
        const relevantArticles = await searchArticles(
            message, category, userId, usePersonalization, null, queryEmbedding,
        );

        // Emit articles up front so the UI can render references immediately
        send('meta', {
            sessionId,
            articles: buildArticleReferences(relevantArticles),
        });

        const result = await streamResponse(message, relevantArticles, {
            signal: abortController.signal,
            onDelta: (chunk) => send('delta', { text: chunk }),
        });

        send('done', { metadata: result.metadata });
        clearInterval(heartbeat);
        res.end();

        // Background: ensure user save resolved, then persist assistant turn + cache
        userSavePromise.finally(() => {
            persistAssistantTurn({
                sessionId, userId,
                content: result.text,
                articles: result.articles,
                metadata: result.metadata,
                isFirstMessage: (session.messageCount || 0) === 0,
                firstMessageText: message,
            });
        });

        redis.set(cacheKey, JSON.stringify({
            response: result.text,
            articles: result.articles,
            metadata: result.metadata,
        }), 'EX', ANSWER_TTL).catch(() => {});
    } catch (error) {
        console.error('SSE chat error:', error.message);
        try {
            send('error', {
                error: 'Failed to process message',
                fallback: "I'm having trouble right now. Please try again in a moment.",
            });
        } catch { /* connection already gone */ }
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
    }
});

// ─── GET /chat/history/:sessionId ─────────────────────────────────────────────

router.get('/chat/history/:sessionId', auth, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { limit = 50, offset = 0 } = req.query;
        const userId = extractUserId(req.user);

        if (!userId) {
            return res.status(400).json({ success: false, error: 'User ID not found in token' });
        }

        const session = await ChatSession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, error: 'Chat session not found' });
        }

        const messages = await ChatMessage.find({ sessionId, userId })
            .sort({ timestamp: 1 })
            .skip(parseInt(offset))
            .limit(parseInt(limit))
            .populate('articleReferences', 'title url category publishedAt')
            .lean();

        res.json({ success: true, messages, session });
    } catch (error) {
        console.error('Error fetching chat history:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch chat history' });
    }
});

// ─── GET /chat/sessions ───────────────────────────────────────────────────────

router.get('/chat/sessions', auth, async (req, res) => {
    try {
        const { limit = 20 } = req.query;
        const userId = extractUserId(req.user);

        if (!userId) {
            return res.status(400).json({ success: false, error: 'User ID not found in token' });
        }

        const sessions = await ChatSession.find({ userId })
            .sort({ lastMessageAt: -1 })
            .limit(parseInt(limit))
            .lean();

        res.json({ success: true, sessions });
    } catch (error) {
        console.error('Error fetching sessions:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch sessions' });
    }
});

// ─── DELETE /chat/session/:sessionId ──────────────────────────────────────────

router.delete('/chat/session/:sessionId', auth, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = extractUserId(req.user);

        if (!userId) {
            return res.status(400).json({ success: false, error: 'User ID not found in token' });
        }

        const session = await ChatSession.findOne({ _id: sessionId, userId });
        if (!session) {
            return res.status(404).json({ success: false, error: 'Chat session not found' });
        }

        await Promise.all([
            ChatMessage.deleteMany({ sessionId }),
            ChatSession.findByIdAndDelete(sessionId),
        ]);

        res.json({ success: true, message: 'Chat session deleted successfully' });
    } catch (error) {
        console.error('Error deleting session:', error.message);
        res.status(500).json({ success: false, error: 'Failed to delete session' });
    }
});

// ─── GET /search (test endpoint) ──────────────────────────────────────────────

router.get('/search', auth, async (req, res) => {
    try {
        const { q: query, category, limit = 5 } = req.query;
        const userId = extractUserId(req.user);

        if (!query) {
            return res.status(400).json({ success: false, error: 'Query parameter q is required' });
        }

        const articles = await searchArticles(query, category, userId, true);

        res.json({
            success: true,
            query,
            articles: articles.slice(0, parseInt(limit)),
            totalFound: articles.length,
        });
    } catch (error) {
        console.error('Error searching articles:', error.message);
        res.status(500).json({ success: false, error: 'Failed to search articles' });
    }
});

module.exports = router;
