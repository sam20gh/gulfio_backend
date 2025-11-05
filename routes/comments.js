const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Comment = require('../models/Comment'); // You'll need to create this model
const User = require('../models/User');
const auth = require('../middleware/auth');
const NotificationService = require('../utils/notificationService');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding');

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
// GET comments for a reel
router.get('/reel/:reelId', async (req, res) => {
    try {
        const { reelId } = req.params;
        const comments = await Comment.find({ reelId })
            .sort({ createdAt: -1 });
        res.json(comments);
    } catch (error) {
        console.error('GET /comments/reel/:reelId error:', error);
        res.status(500).json({ message: 'Failed to get reel comments' });
    }
});

// POST new comment
router.post('/', auth, async (req, res) => {
    try {
        const { articleId, reelId, userId, username, comment } = req.body;
        if ((!articleId && !reelId) || !userId || !comment) {
            return res.status(400).json({ message: 'Missing fields' });
        }
        const newComment = new Comment({
            articleId,
            reelId,
            userId,
            username,
            comment,
            createdAt: new Date(),
        });

        await newComment.save();

        // Update user embedding after posting comment
        try {
            const commenterUser = await User.findOne({ supabase_id: userId });
            if (commenterUser) {
                await updateUserProfileEmbedding(commenterUser._id);
            }
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

        // Check for mentions in the comment and send notifications
        try {
            const commenterUser = await User.findOne({ supabase_id: userId });
            const commenterName = commenterUser ? (commenterUser.name || commenterUser.email) : username;

            await NotificationService.sendMentionNotifications(
                comment,
                userId,
                commenterName,
                'comment',
                newComment._id,
                articleId
            );
        } catch (mentionError) {
            console.error('Error sending mention notifications:', mentionError);
            // Don't fail the request if mention notifications fail
        }

        res.status(201).json({ message: 'Comment added' });
    } catch (error) {
        console.error('POST /comments error:', error);
        res.status(500).json({ message: 'Failed to post comment' });
    }
});

// PATCH /comments/:id — Edit a comment
router.patch('/:id', auth, async (req, res) => {
    try {
        const { comment } = req.body;
        if (!comment) return res.status(400).json({ message: 'No comment provided' });

        const updated = await Comment.findByIdAndUpdate(req.params.id, { comment }, { new: true });
        if (!updated) return res.status(404).json({ message: 'Comment not found' });

        // Update user embedding after editing comment
        try {
            const user = await User.findOne({ supabase_id: updated.userId });
            if (user) {
                await updateUserProfileEmbedding(user._id);
            }
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

        res.json(updated);
    } catch (error) {
        console.error('PATCH /comments/:id error:', error);
        res.status(500).json({ message: 'Failed to update comment' });
    }
});

// DELETE /comments/:id — Delete a comment
router.delete('/:id', auth, async (req, res) => {
    try {
        const userId = req.user.sub; // Get userId from JWT token

        // First, find the comment to check ownership
        const comment = await Comment.findById(req.params.id);
        if (!comment) {
            return res.status(404).json({ message: 'Comment not found' });
        }

        // Check if the user owns this comment
        if (comment.userId !== userId) {
            return res.status(403).json({ message: 'You can only delete your own comments' });
        }

        // Delete the comment
        const deleted = await Comment.findByIdAndDelete(req.params.id);

        // Update user embedding after deleting comment
        try {
            const user = await User.findOne({ supabase_id: deleted.userId });
            if (user) {
                await updateUserProfileEmbedding(user._id);
            }
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

        res.json({ message: 'Comment deleted' });
    } catch (error) {
        console.error('DELETE /comments/:id error:', error);
        res.status(500).json({ message: 'Failed to delete comment' });
    }
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
    const userId = req.user.sub;        // ← derive from auth middleware (JWT "sub")
    const commentId = req.params.id;

    try {
        // Get the comment first to check the author
        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ message: 'Comment not found' });
        }

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

            // Send notification to comment author (if not liking their own comment)
            if (comment.userId !== userId) {
                try {
                    const likerUser = await User.findOne({ supabase_id: userId });
                    const likerName = likerUser ? (likerUser.name || likerUser.email) : 'Someone';

                    await NotificationService.sendCommentLikeNotification(
                        comment.userId,
                        userId,
                        likerName,
                        commentId,
                        comment.articleId
                    );
                } catch (notificationError) {
                    console.error('Error sending comment like notification:', notificationError);
                    // Don't fail the request if notification fails
                }
            }
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

        // Update user embedding after comment reaction
        try {
            const reactingUser = await User.findOne({ supabase_id: userId });
            if (reactingUser) {
                await updateUserProfileEmbedding(reactingUser._id);
            }
        } catch (embeddingError) {
            console.error('Error updating user embedding:', embeddingError);
            // Don't fail the request if embedding update fails
        }

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
        const userId = req.user.sub; // Use consistent property name

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
// in comments.js, just after your react routes

// 1) Add a reply
// POST /comments/:id/reply
router.post('/:id/reply', auth, async (req, res) => {
    const commentId = req.params.id;
    const { reply } = req.body;
    if (!reply || !reply.trim()) {
        return res.status(400).json({ message: 'Reply text is required' });
    }

    // Fetch the parent comment to get the original author
    let parentComment;
    try {
        parentComment = await Comment.findById(commentId);
        if (!parentComment) {
            return res.status(404).json({ message: 'Comment not found' });
        }
    } catch (err) {
        console.error('Error fetching parent comment:', err);
        return res.status(500).json({ message: 'Failed to fetch comment' });
    }

    // Build reply entry
    const userId = req.user.sub;
    const username = req.user.email;
    const newReply = { userId, username, reply, createdAt: new Date() };

    // Save the reply
    let updatedComment;
    try {
        updatedComment = await Comment.findByIdAndUpdate(
            commentId,
            { $push: { replies: newReply } },
            { new: true }
        );
    } catch (err) {
        console.error('Error saving reply:', err);
        return res.status(500).json({ message: 'Failed to add reply' });
    }

    // Send notification to the original commenter (if not replying to their own comment)
    if (parentComment.userId !== userId) {
        try {
            const replierUser = await User.findOne({ supabase_id: userId });
            const replierName = replierUser ? (replierUser.name || replierUser.email) : 'Someone';

            await NotificationService.sendCommentReplyNotification(
                parentComment.userId,
                userId,
                replierName,
                newReply.reply,
                commentId,
                parentComment.articleId
            );
        } catch (err) {
            console.error('Error sending reply notification:', err);
            // Don't block response on notification failure
        }
    }

    // Check for mentions in the reply and send notifications
    try {
        const replierUser = await User.findOne({ supabase_id: userId });
        const replierName = replierUser ? (replierUser.name || replierUser.email) : username;

        await NotificationService.sendMentionNotifications(
            newReply.reply,
            userId,
            replierName,
            'reply',
            commentId,
            parentComment.articleId
        );
    } catch (mentionError) {
        console.error('Error sending mention notifications for reply:', mentionError);
        // Don't fail the request if mention notifications fail
    }

    return res.status(201).json(updatedComment);
});

// 2) Delete your own reply
// DELETE /comments/:commentId/reply/:replyId
router.delete('/:commentId/reply/:replyId', auth, async (req, res) => {
    const { commentId, replyId } = req.params;
    const userId = req.user.sub;

    try {
        // only pull out the reply subdoc if it belongs to you
        const updated = await Comment.findOneAndUpdate(
            {
                _id: commentId,
                'replies._id': replyId,
                'replies.userId': userId
            },
            {
                $pull: { replies: { _id: replyId } }
            },
            { new: true }
        );

        if (!updated) {
            return res.status(404).json({ message: 'Reply not found or not yours' });
        }
        return res.json(updated);
    } catch (err) {
        console.error('DELETE /comments/:commentId/reply/:replyId error:', err);
        return res.status(500).json({ message: 'Failed to delete reply' });
    }
});
router.get('/:id/comments', async (req, res) => {
    try {
        const userId = req.params.id; // This is the Supabase ID

        // Verify user exists
        const user = await User.findOne({ supabase_id: userId });
        if (!user) return res.status(404).send({ message: 'User not found' });

        // Fetch comments using userId (which stores Supabase ID)
        const comments = await Comment
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .lean(); // Use lean for better performance

        // Fetch article titles for comments with articleIds
        const Article = require('../models/Article');
        const articleIds = comments
            .filter(c => c.articleId)
            .map(c => c.articleId);
        
        const articles = await Article
            .find({ _id: { $in: articleIds } })
            .select('_id title')
            .lean();

        const articleMap = {};
        articles.forEach(a => {
            articleMap[a._id.toString()] = a.title;
        });

        // Map comments to frontend format
        const mappedComments = comments.map(c => ({
            _id: c._id,
            text: c.comment, // Map 'comment' field to 'text'
            articleId: c.articleId,
            articleTitle: articleMap[c.articleId] || 'Unknown Article',
            createdAt: c.createdAt
        }));

        // Return with count for frontend
        res.json({
            count: mappedComments.length,
            comments: mappedComments
        });
    } catch (err) {
        console.error('Error fetching user comments:', err);
        res.status(500).send({ message: 'Server error' });
    }
});


module.exports = router;
