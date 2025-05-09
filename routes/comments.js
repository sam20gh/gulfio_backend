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
// This endpoint allows users to react to a comment (like/dislike)
// It expects a JSON body with the action (like/dislike)
// and the userId (extracted from the JWT token)
// The userId is used to identify the user who is reacting
// The commentId is extracted from the URL parameter
// The reaction is stored in the comment document

router.post('/:id/react', auth, async (req, res) => {
    const { action } = req.body;
    const userId = req.user.sub;        // ← derive from auth middleware (JWT “sub”)
    const commentId = req.params.id;

    try {
        // 1) remove any existing reaction
        await Comment.updateOne(
            { _id: commentId },
            { $pull: { likedBy: userId, dislikedBy: userId } }
        );

        // 2) add the new reaction if any
        if (action === 'like') {
            await Comment.updateOne(
                { _id: commentId },
                { $addToSet: { likedBy: userId } }
            );
        } else if (action === 'dislike') {
            await Comment.updateOne(
                { _id: commentId },
                { $addToSet: { dislikedBy: userId } }
            );
        }

        // 3) re-fetch authoritative counts & userReact
        const updated = await Comment.findById(commentId);
        const likes = updated.likedBy.length;
        const dislikes = updated.dislikedBy.length;
        let userReact = null;
        if (updated.likedBy.includes(userId)) userReact = 'like';
        else if (updated.dislikedBy.includes(userId)) userReact = 'dislike';


        return res.json({ likes, dislikes, userReact });

    } catch (err) {
        console.error('POST /comments/:id/react error:', err);

        return res.status(500).json({ message: 'Failed to react to comment' });
    }
});

// GET /comments/:id/react
router.get('/:id/react', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const comment = await Comment.findById(id);
        if (!comment) {
            return res.status(404).json({ message: 'Comment not found' });
        }

        // Determine user reaction
        let userReact = null;
        if (comment.likedBy.includes(userId)) {
            userReact = 'like';
        } else if (comment.dislikedBy.includes(userId)) {
            userReact = 'dislike';
        }

        res.json({
            likes: comment.likedBy.length,
            dislikes: comment.dislikedBy.length,
            userReact,
        });
    } catch (error) {
        console.error('GET /comments/:id/react error:', error.message);
        res.status(500).json({ message: 'Failed to fetch reactions' });
    }
});

module.exports = router;
