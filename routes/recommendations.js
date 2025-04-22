
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

    // Get user-engaged categories and sources
    const engagedArticles = await Article.find({ _id: { $in: allEngagedIds } }).lean();
    const engagedCategories = [...new Set(engagedArticles.map(a => a.category).filter(Boolean))];
    const engagedSources = [...new Set(engagedArticles.map(a => a.sourceId).filter(Boolean))];

    // Recommend articles by:
    // - Not yet engaged
    // - Matching category or source
    // - High likes/views
    const recommended = await Article.aggregate([
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
              { $ifNull: ['$views', 0] },
              {
                $cond: {
                  if: { $gt: ['$publishedAt', new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)] }, // past week
                  then: 5,
                  else: 0
                }
              }
            ]
          }
        }
      },
      { $sort: { score: -1, publishedAt: -1 } },
      { $limit: 10 }
    ]);

    res.json({ recommended });
  } catch (err) {
    console.error('Recommendation error:', err);
    res.status(500).json({ message: 'Error generating recommendations' });
  }
});


module.exports = router;
