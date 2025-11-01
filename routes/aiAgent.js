const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const { generateResponse, searchArticles, getSuggestedQuestions } = require('../services/aiAgentService');

// Get suggested questions for new users
router.get('/suggestions', async (req, res) => {
    try {
        console.log('🤖 Getting AI suggestions...');

        const suggestions = await getSuggestedQuestions();

        res.json({
            success: true,
            suggestions
        });
    } catch (error) {
        console.error('❌ Error getting suggestions:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get suggestions',
            suggestions: [
                'What are the latest news from UAE?',
                'Tell me about recent business developments',
                'Any sports updates from the region?',
                'What\'s happening in Saudi Arabia?'
            ]
        });
    }
});

// Start a new chat session
router.post('/chat/session', auth, async (req, res) => {
    try {
        console.log('🤖 Creating new chat session for user:', req.user.uid);

        const chatSession = new ChatSession({
            userId: req.user.uid,
            startedAt: new Date(),
            isActive: true,
            language: req.body.language || 'english'
        });

        await chatSession.save();

        console.log('✅ Chat session created:', chatSession._id);

        res.json({
            success: true,
            sessionId: chatSession._id,
            session: chatSession
        });
    } catch (error) {
        console.error('❌ Error creating chat session:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create chat session'
        });
    }
});

// Send a message and get AI response
router.post('/chat/message', auth, async (req, res) => {
    try {
        const { sessionId, message, category, usePersonalization = true } = req.body;

        console.log('🤖 Processing message:', {
            sessionId,
            userId: req.user.uid,
            message: message?.substring(0, 100),
            category
        });

        if (!message || !sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Message and sessionId are required'
            });
        }

        // Verify session belongs to user
        const session = await ChatSession.findOne({
            _id: sessionId,
            userId: req.user.uid
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        // Save user message
        const userMessage = new ChatMessage({
            sessionId,
            userId: req.user.uid,
            role: 'user',
            content: message,
            timestamp: new Date()
        });
        await userMessage.save();

        console.log('✅ User message saved');

        // Search relevant articles using Atlas Vector Search
        console.log('🔍 Searching articles...');
        const relevantArticles = await searchArticles(
            message,
            category,
            req.user.uid,
            usePersonalization
        );

        // Generate AI response
        console.log('🤖 Generating AI response...');
        const aiResponse = await generateResponse(
            message,
            relevantArticles,
            sessionId,
            req.user.uid
        );

        // Save AI response
        const aiMessage = new ChatMessage({
            sessionId,
            userId: req.user.uid,
            role: 'assistant',
            content: aiResponse.text,
            articleReferences: aiResponse.articles.map(a => a._id),
            timestamp: new Date(),
            metadata: aiResponse.metadata
        });
        await aiMessage.save();

        // Update session
        await ChatSession.findByIdAndUpdate(sessionId, {
            lastMessageAt: new Date(),
            messageCount: await ChatMessage.countDocuments({ sessionId }),
            title: session.messageCount === 0 ? message.substring(0, 50) + '...' : session.title
        });

        console.log('✅ AI response generated and saved');

        res.json({
            success: true,
            response: aiResponse.text,
            articles: aiResponse.articles,
            messageId: aiMessage._id,
            metadata: aiResponse.metadata
        });
    } catch (error) {
        console.error('❌ Error processing message:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process message',
            fallback: 'I\'m having trouble processing your request right now. Please try again in a moment.'
        });
    }
});

// Get chat history
router.get('/chat/history/:sessionId', auth, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { limit = 50, offset = 0 } = req.query;

        console.log('📜 Getting chat history for session:', sessionId);

        // Verify session belongs to user
        const session = await ChatSession.findOne({
            _id: sessionId,
            userId: req.user.uid
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        const messages = await ChatMessage.find({
            sessionId,
            userId: req.user.uid
        })
            .sort({ timestamp: 1 }) // Ascending order for chat history
            .skip(parseInt(offset))
            .limit(parseInt(limit))
            .populate('articleReferences', 'title url category publishedAt')
            .lean();

        console.log(`✅ Retrieved ${messages.length} messages`);

        res.json({
            success: true,
            messages,
            session
        });
    } catch (error) {
        console.error('❌ Error fetching chat history:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch chat history'
        });
    }
});

// Get all user sessions
router.get('/chat/sessions', auth, async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        console.log('📋 Getting chat sessions for user:', req.user.uid);

        const sessions = await ChatSession.find({
            userId: req.user.uid
        })
            .sort({ lastMessageAt: -1 })
            .limit(parseInt(limit))
            .lean();

        console.log(`✅ Retrieved ${sessions.length} sessions`);

        res.json({
            success: true,
            sessions
        });
    } catch (error) {
        console.error('❌ Error fetching sessions:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch sessions'
        });
    }
});

// Delete a chat session
router.delete('/chat/session/:sessionId', auth, async (req, res) => {
    try {
        const { sessionId } = req.params;

        console.log('🗑️ Deleting chat session:', sessionId);

        // Verify session belongs to user
        const session = await ChatSession.findOne({
            _id: sessionId,
            userId: req.user.uid
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Chat session not found'
            });
        }

        // Delete all messages in the session
        await ChatMessage.deleteMany({ sessionId });

        // Delete the session
        await ChatSession.findByIdAndDelete(sessionId);

        console.log('✅ Chat session deleted successfully');

        res.json({
            success: true,
            message: 'Chat session deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting session:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete session'
        });
    }
});

// Search articles endpoint (for testing)
router.get('/search', auth, async (req, res) => {
    try {
        const { q: query, category, limit = 5 } = req.query;

        if (!query) {
            return res.status(400).json({
                success: false,
                error: 'Query parameter is required'
            });
        }

        console.log('🔍 Search request:', { query, category, limit });

        const articles = await searchArticles(query, category, req.user.uid, true);

        res.json({
            success: true,
            query,
            articles: articles.slice(0, parseInt(limit)),
            totalFound: articles.length
        });
    } catch (error) {
        console.error('❌ Error searching articles:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search articles'
        });
    }
});

module.exports = router;