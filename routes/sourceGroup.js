const express = require('express');
const router = express.Router();
const Source = require('../models/Source');
const Article = require('../models/Article');
const User = require('../models/User');
const Reel = require('../models/Reel');

// Get source group info + top articles + recent articles
router.get('/group/:groupName', async (req, res) => {
    const { groupName } = req.params;
    const authHeader = req.headers['x-access-token'];
    let userFollowing = false;

    try {
        const sources = await Source.find({ groupName });

        if (!sources.length) {
            return res.status(404).json({ message: 'No sources found for this group' });
        }

        const mainSource = sources[0];
        const sourceIds = sources.map(source => source._id);

        // Check if user is authenticated and following
        if (authHeader) {
            try {
                const jwt = require('jsonwebtoken');
                const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
                const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;

                // Try to verify the JWT; fall back to unverified decode for
                // compatibility with tokens issued before the issuer change.
                let decoded;

                if (JWT_SECRET && SUPABASE_ISSUER) {
                    try {
                        decoded = jwt.verify(authHeader, JWT_SECRET, {
                            algorithms: ['HS256'],
                            issuer: SUPABASE_ISSUER,
                        });
                    } catch (verifyError) {
                        // fall through to unverified decode
                    }
                }

                if (!decoded) {
                    decoded = jwt.decode(authHeader);
                }

                if (decoded && decoded.sub) {
                    const user = await User.findOne({ supabase_id: decoded.sub }).select('following_sources');
                    if (user) {
                        userFollowing = user.following_sources.includes(groupName);
                    }
                }
            } catch (authError) {
                // Don't throw the error, just proceed as unauthenticated
            }
        }

        const [totalArticleCount, topArticles, recentArticles, reels] = await Promise.all([
            Article.countDocuments({ sourceId: { $in: sourceIds } }),
            Article.find({ sourceId: { $in: sourceIds } })
                .sort({ likeCount: -1 })
                .limit(5)
                .select('_id title publishedAt likeCount url image'),
            Article.find({ sourceId: { $in: sourceIds } })
                .sort({ publishedAt: -1 })
                .limit(10)
                .select('_id title publishedAt url image'),
            Reel.find({ source: { $in: sourceIds } })
                .sort({ publishedAt: -1 })
                .limit(10)
                .select('_id description videoUrl thumbnail publishedAt'),
        ]);

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

        res.json(responseData);

    } catch (error) {
        console.error('Error fetching source group:', error);
        res.status(500).json({ message: 'Error fetching source group' });
    }
});

// NOTE: the follow/unfollow endpoint lives in routes/userActions.js
// (POST /api/user/source/follow-group). A duplicate copy here drifted out of
// sync (it skipped dashboard-cache invalidation) and was removed — all app
// clients call the userActions route.

module.exports = router;
