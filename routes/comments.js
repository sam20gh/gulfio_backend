const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const db = require('../utils/db'); // or wherever your Mongo client is

// GET all comments for an article
router.get('/:articleId', async (req, res) => {
    const { articleId } = req.params;
    try {
        const comments = await db.collection('comments')
            .find({ articleId: new ObjectId(articleId) })
            .sort({ createdAt: -1 })
            .toArray();
        res.json(comments);
    } catch (e) {
        console.error('GET /comments error:', e);
        res.status(500).json({ error: 'Failed to get comments' });
    }
});

// POST a new comment
router.post('/', async (req, res) => {
    const { articleId, userId, username, comment } = req.body;
    if (!articleId || !userId || !comment) return res.status(400).json({ error: 'Missing fields' });

    try {
        await db.collection('comments').insertOne({
            articleId: new ObjectId(articleId),
            userId,
            username,
            comment,
            createdAt: new Date(),
        });
        res.status(201).json({ message: 'Comment added' });
    } catch (e) {
        console.error('POST /comments error:', e);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

module.exports = router;
