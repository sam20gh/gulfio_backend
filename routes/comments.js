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
// PATCH /comments/:id — Edit a comment
router.patch('/:id', auth, async (req, res) => {
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ message: 'No comment provided' });

    const updated = await Comment.findByIdAndUpdate(req.params.id, { comment }, { new: true });
    if (!updated) return res.status(404).json({ message: 'Comment not found' });

    res.json(updated);
});

// DELETE /comments/:id — Delete a comment
router.delete('/:id', auth, async (req, res) => {
    const deleted = await Comment.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Comment not found' });

    res.json({ message: 'Comment deleted' });
});

// POST /comments/:id/react
router.post('/:id/react', auth, async (req, res) => {
    const { action, userId } = req.body;
    if (!['like', 'dislike'].includes(action)) return res.status(400).json({ message: 'Invalid action' });

    await Comment.updateOne({ _id: req.params.id }, {
        $pull: { likedBy: userId, dislikedBy: userId }
    });

    if (action === 'like') {
        await Comment.updateOne({ _id: req.params.id }, { $push: { likedBy: userId } });
    } else {
        await Comment.updateOne({ _id: req.params.id }, { $push: { dislikedBy: userId } });
    }

    const updated = await Comment.findById(req.params.id);
    res.json({
        likes: updated.likedBy.length,
        dislikes: updated.dislikedBy.length,
        userReact: action,
    });
});
router.post('/:id/reply', auth, async (req, res) => {
    try {
        console.log("Incoming reply data:", req.body);

        const { reply, userId, username } = req.body;

        if (!reply || !userId || !username) {
            console.error("Missing fields");
            return res.status(400).json({ message: 'Reply, userId, and username are required' });
        }

        const updatedComment = await Comment.findByIdAndUpdate(
            req.params.id,
            {
                $push: {
                    replies: {
                        userId,
                        username,
                        reply,
                        createdAt: new Date(),
                    },
                },
            },
            { new: true }
        );

        if (!updatedComment) {
            console.error("Comment not found");
            return res.status(404).json({ message: 'Comment not found' });
        }

        res.json(updatedComment);
    } catch (error) {
        console.error('POST /comments/:id/reply error:', error.message);
        res.status(500).json({ message: 'Failed to add reply' });
    }
});


module.exports = router;
