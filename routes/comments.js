const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Comment = require('../models/Comment'); // You'll need to create this model
const auth = require('../middleware/auth');

// GET comments for an article
router.get('/:articleId', async (req, res) => {
    try {
        const { articleId } = req.params;
        const comments = await Comment.find({ articleId: articleId })
            .sort({ createdAt: -1 });
        res.json(comments);
    } catch (error) {
        console.error('GET /comments error:', error);
        res.status(500).json({ message: 'Failed to get comments' });
    }
});

// POST new comment
router.post('/', auth, async (req, res) => {
    try {
        const { articleId, userId, username, comment } = req.body;
        if (!articleId || !userId || !comment) {
            return res.status(400).json({ message: 'Missing fields' });
        }

        const newComment = new Comment({
            articleId,
            userId,
            username,
            comment,
            createdAt: new Date(),
        });

        await newComment.save();
        res.status(201).json({ message: 'Comment added' });
    } catch (error) {
        console.error('POST /comments error:', error);
        res.status(500).json({ message: 'Failed to post comment' });
    }
});

module.exports = router;
