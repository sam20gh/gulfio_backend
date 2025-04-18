
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

    // Get categories and sources from liked/saved articles
    const engagedArticles = await Article.find({ _id: { $in: allEngagedIds } }).lean();

    const engagedCategories = [...new Set(engagedArticles.map(a => a.category).filter(Boolean))];
    const engagedSources = [...new Set(engagedArticles.map(a => a.sourceId).filter(Boolean))];

    // Recommend fresh articles that match any liked/saved category or source
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
      { $group: { _id: '$_id', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { publishedAt: -1 } },
      { $limit: 5 }
    ]);

    res.json({ recommended });
  } catch (err) {
    console.error('Recommendation error:', err);
    res.status(500).json({ message: 'Error generating recommendations' });
  }
});

module.exports = router;
