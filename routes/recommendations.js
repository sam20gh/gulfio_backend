
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Article = require('../models/Article');
const mongoose = require('mongoose');

// GET /api/recommendations/:supabaseId
router.get('/:supabaseId', async (req, res) => {
  const { supabaseId } = req.params;

  try {
    console.log('🔍 Fetching recommendations for user:', supabaseId);

    const user = await User.findOne({ supabase_id: supabaseId }).lean();
    if (!user) {
      console.log('❌ User not found, providing fallback recommendations:', supabaseId);

      // Provide fallback recommendations for non-existent users
      try {
        const recommended = await Article.find({})
          .select('-embedding')
          .sort({ viewCount: -1, likes: -1, publishedAt: -1 })
          .limit(10)
          .lean();
        console.log('✅ Fallback recommendations found:', recommended.length);
        return res.json({ recommended });
      } catch (fallbackError) {
        console.error('❌ Fallback recommendations failed:', fallbackError.message);
        return res.status(500).json({ message: 'Error generating recommendations' });
      }
    }

    console.log('✅ User found:', user.email);
    console.log('📊 User liked articles:', user.liked_articles?.length || 0);
    console.log('📊 User saved articles:', user.saved_articles?.length || 0);

    const likedIds = (user.liked_articles || []).map(id => new mongoose.Types.ObjectId(id));
    const savedIds = (user.saved_articles || []).map(id => new mongoose.Types.ObjectId(id));
    const allEngagedIds = [...new Set([...likedIds, ...savedIds])];

    console.log('🎯 Total engaged articles:', allEngagedIds.length);

    const engagedArticles = await Article.find({ _id: { $in: allEngagedIds } }).select('-embedding').lean();
    const engagedCategories = [...new Set(engagedArticles.map(a => a.category).filter(Boolean))];
    const engagedSources = [...new Set(
      engagedArticles
        .map(a => a.sourceId)
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id))
    )];

    console.log('📂 Engaged categories:', engagedCategories);
    console.log('📰 Engaged sources:', engagedSources.length);

    let recommended = [];

    // Only run personalized recommendations if user has engaged with content
    if (engagedCategories.length > 0 || engagedSources.length > 0) {
      console.log('🎯 Running personalized recommendations');

      try {
        // Exclude embeddings and get personalized recommendations
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
          // Exclude embedding field early to avoid memory issues
          {
            $project: {
              embedding: 0
            }
          },
          // Limit early to avoid memory issues
          { $limit: 1000 },
          {
            $addFields: {
              score: {
                $add: [
                  { $multiply: [{ $ifNull: ['$likes', 0] }, 2] },
                  { $ifNull: ['$viewCount', 0] },
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
          // Sort by score
          { $sort: { score: -1, publishedAt: -1 } },
          // Take top 50
          { $limit: 50 },
          // Group by title to eliminate duplicates
          {
            $group: {
              _id: '$title',
              article: { $first: '$$ROOT' }
            }
          },
          { $replaceRoot: { newRoot: '$article' } },
          // Final selection
          { $limit: 10 }
        ]);
        console.log('✅ Personalized recommendations aggregation completed');
      } catch (aggregationError) {
        console.error('❌ Personalized recommendations failed:', aggregationError.message);
        console.error('Full error:', aggregationError);
        recommended = []; // Force fallback
      }
    } else {
      console.log('📋 No user engagement, skipping personalized recommendations');
    }

    console.log('🔍 Personalized recommendations found:', recommended.length);

    // 🔁 Fallback logic if empty
    if (!recommended || recommended.length === 0) {
      console.log('🔄 Running fallback recommendations');
      try {
        recommended = await Article.find({})
          .select('-embedding')
          .sort({ viewCount: -1, likes: -1, publishedAt: -1 })
          .limit(10)
          .lean();
        console.log('✅ Fallback recommendations found:', recommended.length);
      } catch (fallbackError) {
        console.error('❌ Fallback recommendations failed:', fallbackError.message);
        console.error('Full fallback error:', fallbackError);
        recommended = [];
      }
    }

    console.log('📤 Returning recommendations:', recommended.length);
    res.json({ recommended });
  } catch (err) {
    console.error('❌ Recommendation error:', err.message);
    console.error('Full error:', err);
    res.status(500).json({ message: 'Error generating recommendations' });
  }
});

module.exports = router;
