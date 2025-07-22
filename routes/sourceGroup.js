const express = require('express');
const router = express.Router();
const Source = require('../models/Source');
const Article = require('../models/Article');
const User = require('../models/User');
const Reel = require('../models/Reel');
const auth = require('../middleware/auth'); // Supabase auth
const ensureMongoUser = require('../middleware/ensureMongoUser');

// Get source group info + top articles + recent articles
router.get('/group/:groupName', async (req, res) => {
    const { groupName } = req.params;
    const authHeader = req.headers['x-access-token'];
    let userFollowing = false;

    try {
        const sources = await Source.find({ groupName });
        if (!sources.length) return res.status(404).json({ message: 'No sources found for this group' });

        const mainSource = sources[0];
        const sourceIds = sources.map(source => source._id);

        // Check if user is authenticated and following
        if (authHeader) {
            try {
                const jwt = require('jsonwebtoken');
                const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
                const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;
                
                // Verify and decode the JWT token properly
                let decoded;
                try {
                    decoded = jwt.verify(authHeader, JWT_SECRET, {
                        algorithms: ['HS256'],
                        issuer: SUPABASE_ISSUER,
                    });
                    console.log('✅ JWT verified successfully for user:', decoded?.sub);
                } catch (jwtError) {
                    console.log('❌ JWT verification failed:', jwtError.message);
                    // Fallback to decode without verification for debugging
                    try {
                        decoded = jwt.decode(authHeader);
                        console.log('⚠️ Using unverified JWT decode. Token payload:', {
                            sub: decoded?.sub,
                            iss: decoded?.iss,
                            exp: decoded?.exp
                        });
                    } catch (decodeError) {
                        console.log('❌ JWT decode also failed:', decodeError.message);
                        decoded = null;
                    }
                }

                if (decoded && decoded.sub) {
                    console.log('🔍 Checking follow status for user:', decoded.sub);
                    const user = await User.findOne({ supabase_id: decoded.sub });
                    if (user) {
                        userFollowing = user.following_sources.includes(groupName);
                        console.log('✅ User following status:', userFollowing, 'for group:', groupName);
                        console.log('📋 User following_sources:', user.following_sources.slice(0, 5), '...(truncated)');
                    } else {
                        console.log('❌ No user found with supabase_id:', decoded.sub);
                    }
                } else {
                    console.log('❌ Invalid JWT token or missing sub claim');
                }
            } catch (authError) {
                console.log('❌ Auth check failed, proceeding as unauthenticated user:', authError.message);
            }
        } else {
            console.log('ℹ️ No auth header provided, treating as anonymous request');
        }        // Get total count of articles for this group
        console.log('Querying articles for sourceIds:', sourceIds);
        const totalArticleCount = await Article.countDocuments({ sourceId: { $in: sourceIds } });
        console.log('Total article count for group', groupName, ':', totalArticleCount);

        // Debug: Let's also check if there are any articles at all for debugging
        const sampleArticles = await Article.find({ sourceId: { $in: sourceIds } }).limit(3);
        console.log('Sample articles found:', sampleArticles.length);
        if (sampleArticles.length > 0) {
            console.log('First article sourceId:', sampleArticles[0].sourceId);
        }

        const topArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .sort({ likeCount: -1 })
            .limit(5)
            .select('_id title publishedAt likeCount url image');

        const recentArticles = await Article.find({ sourceId: { $in: sourceIds } })
            .sort({ publishedAt: -1 })
            .limit(10)
            .select('_id title publishedAt url image');

        const reels = await Reel.find({ source: { $in: sourceIds } })
            .sort({ publishedAt: -1 })
            .limit(10)
            .select('_id description videoUrl thumbnail publishedAt');

        const responseData = {
            sourceInfo: {
                name: mainSource.name,
                icon: mainSource.icon,
                followers: sources.reduce((acc, s) => acc + (s.followers || 0), 0),
                _id: mainSource._id,
                bioSection: mainSource.bioSection,
                bioLink: mainSource.bioLink,
                totalArticleCount, // ✅ Real post count
            },
            topArticles,
            recentArticles,
            reels,
            isFollowing: userFollowing, // ✅ Real following status
        };

        console.log('Sending response for group', groupName, ':', {
            totalArticleCount,
            isFollowing: userFollowing,
            topArticlesCount: topArticles.length,
            recentArticlesCount: recentArticles.length,
            reelsCount: reels.length
        });

        res.json(responseData);

    } catch (error) {
        console.error('Error fetching source group:', error);
        res.status(500).json({ message: 'Error fetching source group' });
    }
});

// Follow/Unfollow Source Group
router.post('/follow-group', auth, ensureMongoUser, async (req, res) => {
    const { groupName } = req.body;
    const user = req.mongoUser;

    try {
        if (!groupName) return res.status(400).json({ message: 'groupName is required' });

        const isFollowing = user.following_sources.includes(groupName);

        if (isFollowing) {
            // Unfollow
            user.following_sources.pull(groupName);
            await Source.updateMany({ groupName }, { $inc: { followers: -1 } });
        } else {
            // Follow
            user.following_sources.push(groupName);
            await Source.updateMany({ groupName }, { $inc: { followers: 1 } });
        }

        await user.save();

        res.json({
            following_sources: user.following_sources,
            action: isFollowing ? 'unfollowed' : 'followed',
        });
    } catch (error) {
        console.error('Error following/unfollowing group:', error);
        res.status(500).json({ message: 'Error updating follow status' });
    }
});


module.exports = router;
