const mongoose = require('mongoose');
const User = require('./models/User');
const Article = require('./models/Article');
require('dotenv').config();

async function testRecommendationAPI() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const supabaseId = '1d9861e0-db07-437b-8de9-8b8f1c8d8e6d';
    
    console.log('🔍 Fetching recommendations for user:', supabaseId);
    
    const user = await User.findOne({ supabase_id: supabaseId }).lean();
    if (!user) {
      console.log('❌ User not found:', supabaseId);
      return;
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
        // Test the personalized aggregation
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
          { $sort: { score: -1, publishedAt: -1 } },
          { $limit: 50 },
          {
            $group: {
              _id: '$title',
              article: { $first: '$$ROOT' }
            }
          },
          { $replaceRoot: { newRoot: '$article' } },
          { $limit: 10 }
        ]);
        
        console.log('✅ Personalized recommendations found:', recommended.length);
      } catch (aggregationError) {
        console.error('❌ Personalized recommendations failed:', aggregationError.message);
        recommended = []; // Force fallback
      }
    } else {
      console.log('📋 No user engagement, skipping personalized recommendations');
    }

    console.log('🔍 Personalized recommendations found:', recommended.length);

    // Fallback logic if empty
    if (!recommended || recommended.length === 0) {
      console.log('🔄 Running fallback recommendations');
      recommended = await Article.find({})
        .sort({ viewCount: -1, likes: -1, publishedAt: -1 })
        .limit(10)
        .lean();
      console.log('✅ Fallback recommendations found:', recommended.length);
    }

    console.log('📤 Final recommendations:', recommended.length);
    if (recommended.length > 0) {
      console.log('First recommendation:', recommended[0].title);
    }
    
    // Return the same format as the API
    const result = { recommended };
    console.log('📤 API Response:', JSON.stringify(result, null, 2));
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Recommendation error:', err);
    process.exit(1);
  }
}

testRecommendationAPI();
