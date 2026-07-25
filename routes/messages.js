const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const auth = require('../middleware/auth');
const ensureMongoUser = require('../middleware/ensureMongoUser');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Article = require('../models/Article');
const Reel = require('../models/Reel');
const NotificationService = require('../utils/notificationService');
const supabaseAdmin = require('../utils/supabaseAdmin');

function validateObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// article_share/reel_share messages only store sharedRefId — batch-fetch the
// actual title/image so the thread can render a real preview card instead of
// a bare icon. Missing/deleted content just falls back to no sharedPreview.
async function attachSharedPreviews(messages) {
    const articleIds = messages
        .filter((m) => m.type === 'article_share' && m.sharedRefId)
        .map((m) => m.sharedRefId.toString());
    const reelIds = messages
        .filter((m) => m.type === 'reel_share' && m.sharedRefId)
        .map((m) => m.sharedRefId.toString());

    if (!articleIds.length && !reelIds.length) return messages;

    const [articles, reels] = await Promise.all([
        articleIds.length
            ? Article.find({ _id: { $in: articleIds } }).select('title image category').lean()
            : [],
        reelIds.length
            ? Reel.find({ _id: { $in: reelIds } }).select('caption thumbnailUrl').lean()
            : [],
    ]);

    const articleMap = new Map(articles.map((a) => [a._id.toString(), a]));
    const reelMap = new Map(reels.map((r) => [r._id.toString(), r]));

    return messages.map((m) => {
        if (m.type === 'article_share' && m.sharedRefId) {
            const a = articleMap.get(m.sharedRefId.toString());
            if (a) {
                return {
                    ...m,
                    sharedPreview: {
                        title: a.title,
                        image: Array.isArray(a.image) ? a.image[0] : a.image || null,
                        category: a.category || null,
                    },
                };
            }
        }
        if (m.type === 'reel_share' && m.sharedRefId) {
            const r = reelMap.get(m.sharedRefId.toString());
            if (r) {
                return {
                    ...m,
                    sharedPreview: { title: r.caption || 'Blip', image: r.thumbnailUrl || null },
                };
            }
        }
        return m;
    });
}

function computePairKey(idA, idB) {
    return [idA.toString(), idB.toString()].sort().join('_');
}

// Mirrors the follow/block check in routes/userActions.js `/:targetSupabaseId/action` —
// following_users/blocked_users are stored as mixed ObjectId/String arrays, so
// comparisons go through .toString() rather than .equals().
function isBlockedEitherWay(userA, userB) {
    const aId = userA._id.toString();
    const bId = userB._id.toString();
    const aBlocksB = (userA.blocked_users || []).some(id => id.toString() === bId);
    const bBlocksA = (userB.blocked_users || []).some(id => id.toString() === aId);
    return aBlocksB || bBlocksA;
}

function isMutualFollow(userA, userB) {
    const aId = userA._id.toString();
    const bId = userB._id.toString();
    const aFollowsB = (userA.following_users || []).some(id => id.toString() === bId);
    const bFollowsA = (userB.following_users || []).some(id => id.toString() === aId);
    return aFollowsB && bFollowsA;
}

function previewFor(type, text) {
    switch (type) {
        case 'image': return '📷 Photo';
        case 'article_share': return '📰 Shared an article';
        case 'reel_share': return '🎬 Shared a reel';
        default: return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
}

// Realtime delivery, phase 2. Two broadcasts per send:
//  - conversation:{id} carries the full message, for a thread screen that's
//    currently open (both participants may be subscribed).
//  - user:{supabase_id} is a lightweight "something changed" ping for the
//    inbox list / unread badge, scoped to the recipient only.
// Both are best-effort — channel.send() falls back to a stateless REST POST
// when the channel was never joined, so this never blocks on a websocket.
async function broadcastNewMessage(conversationId, enrichedMessage, recipientSupabaseId) {
    try {
        await supabaseAdmin.channel(`conversation:${conversationId}`).send({
            type: 'broadcast',
            event: 'new_message',
            payload: enrichedMessage,
        });
    } catch (err) {
        console.error('Error broadcasting new_message:', err);
    }

    try {
        await supabaseAdmin.channel(`user:${recipientSupabaseId}`).send({
            type: 'broadcast',
            event: 'conversation_updated',
            payload: { conversationId },
        });
    } catch (err) {
        console.error('Error broadcasting conversation_updated:', err);
    }
}

function computeIsUnread(conversation, meIdStr) {
    if (!conversation.lastMessageAt || !conversation.lastMessageSenderId) return false;
    if (conversation.lastMessageSenderId.toString() === meIdStr) return false;
    const readUpTo = conversation.readUpTo instanceof Map
        ? conversation.readUpTo.get(meIdStr)
        : (conversation.readUpTo || {})[meIdStr];
    return !readUpTo || new Date(conversation.lastMessageAt) > new Date(readUpTo);
}

function serializeConversation(conversation, meIdStr) {
    const otherParticipant = (conversation.participants || []).find(
        p => (p && p._id ? p._id.toString() : p.toString()) !== meIdStr
    );

    return {
        _id: conversation._id,
        status: conversation.status,
        isOutgoingRequest: conversation.status === 'pending'
            && conversation.requestedBy
            && conversation.requestedBy.toString() === meIdStr,
        otherUser: otherParticipant && otherParticipant._id ? {
            _id: otherParticipant._id,
            supabase_id: otherParticipant.supabase_id,
            name: otherParticipant.name,
            avatar_url: otherParticipant.avatar_url,
            profile_image: otherParticipant.profile_image,
        } : (otherParticipant || null),
        lastMessageAt: conversation.lastMessageAt,
        lastMessagePreview: conversation.lastMessagePreview,
        isUnread: computeIsUnread(conversation, meIdStr),
    };
}

// GET /api/messages/unread-count — badge count for the messages tab.
router.get('/unread-count', auth, ensureMongoUser, async (req, res) => {
    try {
        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id }).select('_id').lean();
        const conversations = await Conversation.find({
            participants: me._id,
            status: 'inbox',
            lastMessageSenderId: { $ne: me._id },
        }).select('lastMessageAt lastMessageSenderId readUpTo').lean();

        const meIdStr = me._id.toString();
        const unreadCount = conversations.filter(c => computeIsUnread(c, meIdStr)).length;

        res.json({ unreadCount });
    } catch (err) {
        console.error('Error computing unread message count:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/messages/conversations — find or create a 1:1 conversation.
// Status is decided at creation time: mutual follow -> 'inbox', else 'pending'
// (message request), matching Instagram's DM permission model.
router.post('/conversations', auth, ensureMongoUser, async (req, res) => {
    try {
        const { targetSupabaseId } = req.body;
        if (!targetSupabaseId) {
            return res.status(400).json({ message: 'targetSupabaseId is required' });
        }

        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
        const target = await User.findOne({ supabase_id: targetSupabaseId });

        if (!target) {
            return res.status(404).json({ message: 'Target user not found' });
        }
        if (target._id.equals(me._id)) {
            return res.status(400).json({ message: 'Cannot message yourself' });
        }
        if (isBlockedEitherWay(me, target)) {
            return res.status(403).json({ message: 'Unable to message this user' });
        }

        const pairKey = computePairKey(me._id, target._id);
        let conversation = await Conversation.findOne({ pairKey });

        if (!conversation) {
            try {
                conversation = await Conversation.create({
                    participants: [me._id, target._id],
                    pairKey,
                    status: isMutualFollow(me, target) ? 'inbox' : 'pending',
                    requestedBy: me._id,
                });
            } catch (createErr) {
                // Two concurrent POSTs raced to create the same pair — whoever
                // lost just re-reads the winner instead of erroring out.
                if (createErr.code === 11000) {
                    conversation = await Conversation.findOne({ pairKey });
                } else {
                    throw createErr;
                }
            }
        }

        conversation = await conversation.populate('participants', 'supabase_id name avatar_url profile_image');
        res.json(serializeConversation(conversation.toObject(), me._id.toString()));
    } catch (err) {
        console.error('Error creating/finding conversation:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/messages/conversations?folder=inbox|requests
router.get('/conversations', auth, ensureMongoUser, async (req, res) => {
    try {
        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id }).select('_id').lean();
        const folder = req.query.folder === 'requests' ? 'requests' : 'inbox';

        const query = folder === 'requests'
            ? { participants: me._id, status: 'pending', requestedBy: { $ne: me._id } }
            : { participants: me._id, $or: [{ status: 'inbox' }, { status: 'pending', requestedBy: me._id }] };

        const conversations = await Conversation.find(query)
            .sort({ lastMessageAt: -1 })
            .limit(100)
            .populate('participants', 'supabase_id name avatar_url profile_image')
            .lean();

        const meIdStr = me._id.toString();
        res.json({ conversations: conversations.map(c => serializeConversation(c, meIdStr)) });
    } catch (err) {
        console.error('Error listing conversations:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/messages/conversations/:id — single conversation, e.g. for deep links.
router.get('/conversations/:id', auth, ensureMongoUser, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id)) {
            return res.status(400).json({ message: 'Invalid conversation id' });
        }

        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id }).select('_id').lean();
        const conversation = await Conversation.findById(req.params.id)
            .populate('participants', 'supabase_id name avatar_url profile_image')
            .lean();

        if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

        const meIdStr = me._id.toString();
        const isParticipant = conversation.participants.some(
            p => (p._id ? p._id.toString() : p.toString()) === meIdStr
        );
        if (!isParticipant) return res.status(403).json({ message: 'Not a participant' });

        res.json(serializeConversation(conversation, meIdStr));
    } catch (err) {
        console.error('Error fetching conversation:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/messages/conversations/:id/accept — recipient accepts a request.
router.post('/conversations/:id/accept', auth, ensureMongoUser, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id)) {
            return res.status(400).json({ message: 'Invalid conversation id' });
        }

        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id }).select('_id');
        const conversation = await Conversation.findById(req.params.id);

        if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
        const meIdStr = me._id.toString();
        if (!conversation.participants.some(p => p.toString() === meIdStr)) {
            return res.status(403).json({ message: 'Not a participant' });
        }
        if (conversation.requestedBy.toString() === meIdStr) {
            return res.status(400).json({ message: 'Cannot accept your own request' });
        }

        conversation.status = 'inbox';
        await conversation.save();

        const populated = await conversation.populate('participants', 'supabase_id name avatar_url profile_image');
        res.json(serializeConversation(populated.toObject(), meIdStr));
    } catch (err) {
        console.error('Error accepting conversation:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/messages/conversations/:id/messages?beforeId=&limit= — paginated
// history, newest page first call. Marks the thread read when loading the
// latest page (no beforeId).
router.get('/conversations/:id/messages', auth, ensureMongoUser, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id)) {
            return res.status(400).json({ message: 'Invalid conversation id' });
        }

        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id }).select('_id');
        const conversation = await Conversation.findById(req.params.id);

        if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
        const meIdStr = me._id.toString();
        if (!conversation.participants.some(p => p.toString() === meIdStr)) {
            return res.status(403).json({ message: 'Not a participant' });
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
        const query = { conversationId: conversation._id };
        if (req.query.beforeId && validateObjectId(req.query.beforeId)) {
            query._id = { $lt: req.query.beforeId };
        }

        const messages = await Message.find(query).sort({ _id: -1 }).limit(limit).lean();

        if (!req.query.beforeId) {
            conversation.readUpTo.set(meIdStr, new Date());
            conversation.markModified('readUpTo');
            await conversation.save();
        }

        const enriched = await attachSharedPreviews(messages);
        res.json({ messages: enriched.reverse(), hasMore: messages.length === limit });
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/messages/conversations/:id/messages — send a message.
// Realtime delivery (Supabase Broadcast) is phase 2; for now the app polls
// this conversation's history while the thread is open.
router.post('/conversations/:id/messages', auth, ensureMongoUser, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id)) {
            return res.status(400).json({ message: 'Invalid conversation id' });
        }

        const { type = 'text', mediaUrl = null, sharedRefId = null } = req.body;
        const text = (req.body.text || '').trim();

        if (!['text', 'image', 'article_share', 'reel_share'].includes(type)) {
            return res.status(400).json({ message: 'Invalid message type' });
        }
        if (type === 'text' && !text) {
            return res.status(400).json({ message: 'text is required for text messages' });
        }
        if (type === 'image' && !mediaUrl) {
            return res.status(400).json({ message: 'mediaUrl is required for image messages' });
        }
        if ((type === 'article_share' || type === 'reel_share') && !validateObjectId(sharedRefId)) {
            return res.status(400).json({ message: 'sharedRefId is required for shared content' });
        }

        const me = await User.findOne({ supabase_id: req.mongoUser.supabase_id });
        const conversation = await Conversation.findById(req.params.id);

        if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
        const meIdStr = me._id.toString();
        if (!conversation.participants.some(p => p.toString() === meIdStr)) {
            return res.status(403).json({ message: 'Not a participant' });
        }

        const otherParticipantId = conversation.participants.find(p => p.toString() !== meIdStr);
        const other = await User.findById(otherParticipantId);
        if (!other || isBlockedEitherWay(me, other)) {
            return res.status(403).json({ message: 'Unable to message this user' });
        }

        const message = await Message.create({
            conversationId: conversation._id,
            senderId: me._id,
            type,
            text,
            mediaUrl,
            sharedRefId: sharedRefId || null,
        });

        // A reply from the non-requester implicitly accepts a pending request
        // (matches Instagram: replying to a request accepts it).
        if (conversation.status === 'pending' && conversation.requestedBy.toString() !== meIdStr) {
            conversation.status = 'inbox';
        }

        const preview = previewFor(type, text);
        conversation.lastMessageAt = message.createdAt;
        conversation.lastMessageSenderId = me._id;
        conversation.lastMessagePreview = preview;
        conversation.readUpTo.set(meIdStr, message.createdAt);
        conversation.markModified('readUpTo');
        await conversation.save();

        const [enrichedMessage] = await attachSharedPreviews([message.toObject()]);
        res.status(201).json({ message: enrichedMessage });

        broadcastNewMessage(conversation._id.toString(), enrichedMessage, other.supabase_id);

        NotificationService.sendDirectMessageNotification(
            other.supabase_id,
            me.supabase_id,
            me.name || me.email || 'Someone',
            conversation._id.toString(),
            preview
        ).catch(err => console.error('Error sending DM push notification:', err));
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
