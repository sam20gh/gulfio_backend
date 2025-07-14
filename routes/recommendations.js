
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Article = require('../models/Article');
const mongoose = require('mongoose');

// GET /api/recommendations/:supabaseId
router.get('/:supabaseId', async (req, res) => {
  const { supabaseId } = req.params;

  try {
    const user = await User.findOne({ supabase_id: supabaseId }).lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const likedIds = user.liked_articles.map(id => new mongoose.Types.ObjectId(id));
    const savedIds = user.saved_articles.map(id => new mongoose.Types.ObjectId(id));
    const allEngagedIds = [...new Set([...likedIds, ...savedIds])];

    const engagedArticles = await Article.find({ _id: { $in: allEngagedIds } }).select('-embedding').lean();
    const engagedCategories = [...new Set(engagedArticles.map(a => a.category).filter(Boolean))];
    const engagedSources = [...new Set(
      engagedArticles
        .map(a => a.sourceId)
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id))
    )];

    let recommended = [];
    
    // Only run personalized recommendations if user has engaged with content
    if (engagedCategories.length > 0 || engagedSources.length > 0) {
      recommended = await Article.aggregate([
        {
          $match: {
            _id: { $nin: allEngagedIds },
            $or: [
              { category: { $in: engagedCategories } },
              { sourceId: { $in: engagedSources } }
            ]
          }
        },
        {
          $addFields: {
            score: {
              $add: [
                { $multiply: [{ $ifNull: ['$likes', 0] }, 2] },
                { $ifNull: ['$viewCount', 0] }, // 👈 correct field
                {
                  $cond: {
                    if: {
                      $gt: ['$publishedAt', new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)]
                    },
                    then: 5,
                    else: 0
                  }
                }
              ]
            }
          }
        },
        // Sort early by score
        { $sort: { score: -1, publishedAt: -1 } },
        // Group by title to eliminate duplicates
        {
          $group: {
            _id: '$title',
            article: { $first: '$$ROOT' }
          }
        },
        { $replaceRoot: { newRoot: '$article' } },
        // Limit max 2 per source
        {
          $group: {
            _id: '$sourceId',
            articles: { $push: '$$ROOT' }
          }
        },
        {
          $project: {
            articles: { $slice: ['$articles', 2] } // max 2 per source
          }
        },
        { $unwind: '$articles' },
        { $replaceRoot: { newRoot: '$articles' } },
        // Shuffle for randomness
        { $sample: { size: 10 } }
      ]);
    }

    // 🔁 Fallback logic if empty
    if (!recommended || recommended.length === 0) {
      recommended = await Article.find({})
        .sort({ viewCount: -1, likes: -1, publishedAt: -1 })
        .limit(10)
        .lean();
    }

    res.json({ recommended });
  } catch (err) {
    console.error('Recommendation error:', err);
    res.status(500).json({ message: 'Error generating recommendations' });
  }
});

module.exports = router;
