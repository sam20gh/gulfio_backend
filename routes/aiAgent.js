const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const {
    generateResponse,
    searchArticles,
    getSuggestedQuestions,
    generateQueryEmbedding,
} = require('../services/aiAgentService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractUserId(user) {
    return user?.sub || user?.uid || user?.user_id || user?.id || null;
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

// ─── POST /chat/message ───────────────────────────────────────────────────────

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
        // Phase 1 — parallel: verify session + generate query embedding
        const [session, queryEmbedding] = await Promise.all([
            ChatSession.findOne({ _id: sessionId, userId }),
            generateQueryEmbedding(message),
        ]);

        if (!session) {
            return res.status(404).json({ success: false, error: 'Chat session not found' });
        }

        // Phase 2 — parallel: save user message + run vector search (uses precomputed embedding)
        const userMessage = new ChatMessage({
            sessionId,
            userId,
            role: 'user',
            content: message,
            timestamp: new Date(),
        });

        const [, relevantArticles] = await Promise.all([
            userMessage.save(),
            searchArticles(message, category, userId, usePersonalization, null, queryEmbedding),
        ]);

        // Phase 3 — generate AI response (sequential: needs articles)
        const aiResponse = await generateResponse(message, relevantArticles);

        // Phase 4 — parallel: save AI message + update session (use $inc — no countDocuments)
        const aiMessage = new ChatMessage({
            sessionId,
            userId,
            role: 'assistant',
            content: aiResponse.text,
            articleReferences: aiResponse.articles.map(a => a._id),
            timestamp: new Date(),
            metadata: aiResponse.metadata,
        });

        const sessionUpdate = {
            $set: { lastMessageAt: new Date() },
            $inc: { messageCount: 2 }, // user msg + AI msg
        };
        if (session.messageCount === 0) {
            sessionUpdate.$set.title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
        }

        await Promise.all([
            aiMessage.save(),
            ChatSession.findByIdAndUpdate(sessionId, sessionUpdate),
        ]);

        res.json({
            success: true,
            response: aiResponse.text,
            articles: aiResponse.articles,
            messageId: aiMessage._id,
            metadata: aiResponse.metadata,
        });
    } catch (error) {
        console.error('Error processing message:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to process message',
            fallback: "I'm having trouble right now. Please try again in a moment.",
        });
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
