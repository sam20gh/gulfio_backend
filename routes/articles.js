const express = require('express');
const Article = require('../models/Article');
const User = require('../models/User');
const auth = require('../middleware/auth');
const articleRouter = express.Router();
const ensureMongoUser = require('../middleware/ensureMongoUser');
const cache = require('../utils/cache')
const mongoose = require('mongoose');
const redis = require('../utils/redis');
const { getDeepSeekEmbedding } = require('../utils/deepseek');
const { updateUserProfileEmbedding } = require('../utils/userEmbedding'); // Add this import
const { initializeFaissIndex, searchFaissIndex, getFaissIndexStatus } = require('../recommendation/faissIndex');

/**
 * Calculate engagement score for an article
 * @param {Object} article - Article object
 * @returns {number} Engagement score
 */
async function calculateEngagementScore(article) {
  const viewsWeight = 0.4;
  const likesWeight = 0.4;
  const dislikesWeight = -0.2;
  const recencyWeight = 0.2;

  const now = new Date();
  const hoursSincePublished = (now - new Date(article.publishedAt)) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 1 - hoursSincePublished / (24 * 7)); // Decay over 7 days

  return (
    (article.viewCount || 0) * viewsWeight +
    (article.likes || 0) * likesWeight +
    (article.dislikes || 0) * dislikesWeight +
    recencyScore * recencyWeight
  );
}

// GET: Personalized article recommendations
articleRouter.get('/personalized', auth, ensureMongoUser, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const language = req.query.language || 'english';
    const userId = req.mongoUser.supabase_id;

    console.log(`🎯 Fetching personalized articles for user ${userId}, page ${page}, limit ${limit}, language ${language}`);

    const cacheKey = `articles_personalized_${userId}_page_${page}_limit_${limit}_lang_${language}`;

    // Check cache
    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached personalized articles');
      return res.json(JSON.parse(cached));
    }

    // Get user data
    const user = await User.findOne({ supabase_id: userId }).lean();
    let userEmbedding = user?.embedding_pca || user?.embedding;

    // Check Faiss index status
    const faissStatus = getFaissIndexStatus();
    console.log('📊 Faiss status:', faissStatus);

    // Fallback if no user embedding or Faiss not initialized
    if (!userEmbedding || !Array.isArray(userEmbedding) || !faissStatus.isInitialized) {
      console.warn('⚠️ Falling back to engagement-based sorting');
      console.warn(`User embedding: ${userEmbedding ? 'exists' : 'missing'}, Faiss initialized: ${faissStatus.isInitialized}`);

      const skip = (page - 1) * limit;
      const articles = await Article.find({
        language,
        _id: { $nin: user?.disliked_articles || [] } // Exclude disliked articles
      })
        .sort({ viewCount: -1, publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const response = articles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isFallback: true
      }));

      // Cache fallback results for shorter time
      try {
        await redis.set(cacheKey, JSON.stringify(response), 'EX', 1800); // 30 minutes
      } catch (err) {
        console.error('⚠️ Redis set error (safe to ignore):', err.message);
      }

      return res.json(response);
    }

    // Use Faiss for personalized recommendations
    console.log('🔍 Using Faiss for personalized recommendations');

    // Get more results than needed for filtering and mixing
    const searchLimit = limit * 2;
    const { ids, distances } = await searchFaissIndex(userEmbedding, searchLimit);

    // Fetch article details
    let articles = await Article.find({
      _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
      language,
      _id: { $nin: user?.disliked_articles || [] } // Exclude disliked articles
    }).lean();

    console.log(`📄 Found ${articles.length} articles from Faiss search`);

    // Calculate combined scores (similarity + engagement)
    const scoredArticles = articles.map(article => {
      const index = ids.indexOf(article._id.toString());
      const similarity = index !== -1 ? Math.max(0, 1 - distances[index]) : 0; // Convert distance to similarity
      const engagementScore = calculateEngagementScore(article);
      const finalScore = (similarity * 0.6) + (engagementScore * 0.4);

      return {
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        similarity,
        engagementScore,
        finalScore,
      };
    });

    // Sort by final score and take the requested limit
    let finalArticles = scoredArticles
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);

    // Add trending articles for diversity (10% of results)
    const trendingLimit = Math.ceil(limit * 0.1);
    if (trendingLimit > 0) {
      console.log(`📈 Adding ${trendingLimit} trending articles for diversity`);

      const trendingArticles = await Article.find({
        language,
        viewCount: { $exists: true, $gt: 0 },
        _id: { $nin: finalArticles.map(a => a._id) },
        _id: { $nin: user?.disliked_articles || [] },
      })
        .sort({ viewCount: -1, publishedAt: -1 })
        .limit(trendingLimit)
        .lean();

      const trendingEnhanced = trendingArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isTrending: true,
        engagementScore: calculateEngagementScore(article)
      }));

      // Randomly insert trending articles
      for (let i = 0; i < trendingEnhanced.length; i++) {
        const insertIndex = Math.floor(Math.random() * (finalArticles.length + 1));
        finalArticles.splice(insertIndex, 0, trendingEnhanced[i]);
      }
    }

    // Ensure we don't exceed the requested limit
    finalArticles = finalArticles.slice(0, limit);

    console.log(`✅ Returning ${finalArticles.length} personalized articles`);
    console.log(`📊 Composition: ${finalArticles.filter(a => a.isTrending).length} trending, ${finalArticles.filter(a => !a.isTrending).length} personalized`);

    // Cache results for 6 hours
    try {
      await redis.set(cacheKey, JSON.stringify(finalArticles), 'EX', 6 * 3600);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(finalArticles);

  } catch (error) {
    console.error('❌ Error fetching personalized articles:', error);

    // Fallback to basic articles on error
    try {
      const skip = ((parseInt(req.query.page) || 1) - 1) * (parseInt(req.query.limit) || 20);
      const fallbackArticles = await Article.find({
        language: req.query.language || 'english'
      })
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(parseInt(req.query.limit) || 20)
        .lean();

      const response = fallbackArticles.map(article => ({
        ...article,
        fetchId: new mongoose.Types.ObjectId().toString(),
        isErrorFallback: true
      }));

      res.json(response);
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      res.status(500).json({
        error: 'Error fetching personalized articles',
        message: error.message
      });
    }
  }
});

async function clearArticlesCache() {
  const keys = await redis.keys('articles_*');
  if (keys.length > 0) {
    await redis.del(keys);
    console.log('🧹 Cleared article caches:', keys);
  }
}

articleRouter.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const language = req.query.language || 'english'; // Get language from query param or default to English

    const cacheKey = `articles_page_${page}_limit_${limit}_lang_${language}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({ language }) // Filter by language
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    // Inject a unique fetchId to each article
    const enhancedArticles = articles.map(article => ({
      ...article.toObject(),
      fetchId: new mongoose.Types.ObjectId().toString()
    }));

    try {
      await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(enhancedArticles);
  } catch (error) {
    console.error('❌ Error fetching articles:', error);
    res.status(500).json({ error: 'Error fetching articles', message: error.message });
  }
});


// routes/articles.js
articleRouter.get('/articles/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });
    res.json(article);
  } catch (err) {
    console.error('GET /articles/:id error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST: Like or dislike an article

articleRouter.post('/:id/react', auth, ensureMongoUser, async (req, res) => {
  try {
    const { action } = req.body;
    const userId = req.mongoUser.supabase_id;
    const articleId = req.params.id;
    const mongoUser = req.mongoUser;

    if (!mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ message: 'Invalid article ID' });
    }

    if (!['like', 'dislike'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }

    // 1. Update article record
    await Article.updateOne(
      { _id: articleId },
      { $pull: { likedBy: userId, dislikedBy: userId } }
    );

    const pushOp = action === 'like'
      ? { $push: { likedBy: userId } }
      : { $push: { dislikedBy: userId } };

    await Article.updateOne({ _id: articleId }, pushOp);

    // 2. Update user record
    const articleObjectId = new mongoose.Types.ObjectId(articleId);
    await User.updateOne(
      { _id: mongoUser._id },
      {
        $pull: {
          liked_articles: articleObjectId,
          disliked_articles: articleObjectId
        }
      }
    );

    if (action === 'like') {
      await User.updateOne(
        { _id: mongoUser._id },
        { $addToSet: { liked_articles: articleObjectId } }
      );
    } else if (action === 'dislike') {
      await User.updateOne(
        { _id: mongoUser._id },
        { $addToSet: { disliked_articles: articleObjectId } }
      );
    }

    // 3. Update user profile embedding after interaction
    await updateUserProfileEmbedding(mongoUser._id);

    // 4. Return updated counts
    const updatedArticle = await Article.findById(articleId, 'likedBy dislikedBy');
    const likes = updatedArticle?.likedBy?.length || 0;
    const dislikes = updatedArticle?.dislikedBy?.length || 0;

    updatedArticle.likes = likes;
    updatedArticle.dislikes = dislikes;
    await updatedArticle.save();

    res.json({
      userReact: action,
      likes,
      dislikes
    });

    await clearArticlesCache?.();
  } catch (error) {
    console.error('Error in POST /:id/react:', error);
    res.status(500).json({ message: 'Error reacting to article', error: error.message });
  }
});

// GET: Check if user has liked/disliked this article
articleRouter.get('/:id/react', auth, ensureMongoUser, async (req, res) => {
  try {
    const userId = req.mongoUser.supabase_id;
    const mongoUser = req.mongoUser;
    const articleId = req.params.id;

    // Validate article ID
    if (!mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ message: 'Invalid article ID' });
    }

    const article = await Article.findById(articleId, 'likedBy dislikedBy').lean();
    if (!article) return res.status(404).json({ message: 'Article not found' });

    const likedBy = article.likedBy || [];
    const dislikedBy = article.dislikedBy || [];

    // Determine user's reaction
    const userReact = likedBy.includes(userId)
      ? 'like'
      : dislikedBy.includes(userId)
        ? 'dislike'
        : null;

    // Determine if the article is saved
    const isSaved = mongoUser.saved_articles?.some(id =>
      id.equals(new mongoose.Types.ObjectId(articleId))
    );

    res.json({
      userReact,
      likes: likedBy.length,
      dislikes: dislikedBy.length,
      isSaved,
    });
  } catch (error) {
    console.error('Error in GET /articles/:id/react:', error);
    res.status(500).json({ message: 'Error checking user reaction' });
  }
});

// POST: Increment article view count
articleRouter.post('/:id/view', auth, ensureMongoUser, async (req, res) => {
  try {
    const article = await Article.findByIdAndUpdate(
      req.params.id,
      { $inc: { viewCount: 1 } },
      { new: true }
    );

    if (!article) return res.status(404).json({ message: 'Article not found' });

    // If user is authenticated, update their profile embedding
    if (req.mongoUser) {
      await updateUserProfileEmbedding(req.mongoUser._id);
    }

    res.json({ viewCount: article.viewCount });
  } catch (error) {
    res.status(500).json({ message: 'Error updating view count', error: error.message });
  }
});



articleRouter.get('/feature', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const language = req.query.language || 'english'; // Get language from query or default

    const cacheKey = `articles_feature_page_${page}_limit_${limit}_lang_${language}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({
      category: 'feature',
      language // Add language filter
    })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalFeatureArticles = await Article.countDocuments({
      category: 'feature',
      language // Also count by language
    });

    const response = {
      articles,
      totalPages: Math.ceil(totalFeatureArticles / limit),
      currentPage: page,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching feature articles:', error);
    res.status(500).json({ error: 'Error fetching feature articles', message: error.message });
  }
});


// GET: Fetch headline articles with pagination
articleRouter.get('/headline', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const language = req.query.language || 'english'; // Get language from query

    const cacheKey = `articles_headline_page_${page}_limit_${limit}_lang_${language}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({
      category: 'headline',
      language // Add language filter
    })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalHeadlineArticles = await Article.countDocuments({
      category: 'headline',
      language // Count by language too
    });

    const response = {
      articles,
      totalPages: Math.ceil(totalHeadlineArticles / limit),
      currentPage: page,
    };

    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching headline articles:', error);
    res.status(500).json({ error: 'Error fetching headline articles', message: error.message });
  }
});
// GET: Fetch articles by category with pagination
articleRouter.get('/category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const language = req.query.language || 'english';

    const cacheKey = `articles_category_${category}_page_${page}_limit_${limit}_lang_${language}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (!req.query.noCache && cached) {
      console.log('🧠 Returning cached category articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({
      category: { $regex: new RegExp(category, 'i') }, // Case-insensitive category match
      language
    })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    // Inject a unique fetchId to each article
    const enhancedArticles = articles.map(article => ({
      ...article.toObject(),
      fetchId: new mongoose.Types.ObjectId().toString()
    }));

    try {
      await redis.set(cacheKey, JSON.stringify(enhancedArticles), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(enhancedArticles);
  } catch (error) {
    console.error('❌ Error fetching articles by category:', error);
    res.status(500).json({ error: 'Error fetching articles by category', message: error.message });
  }
});

articleRouter.get('/search', auth, async (req, res) => {
  try {
    const query = req.query.query?.trim();
    const language = req.query.language || 'english'; // Add language filtering to search

    if (!query) return res.status(400).json({ message: 'Missing search query' });

    const regex = new RegExp(query, 'i'); // case-insensitive

    // First, get source IDs that match the search query
    const matchingSources = await require('../models/Source').find({
      $or: [
        { name: { $regex: regex } },
        { groupName: { $regex: regex } }
      ]
    }).select('_id');

    const matchingSourceIds = matchingSources.map(source => source._id);

    // Search in articles with enhanced fields and source matching
    const results = await Article.find({
      $or: [
        { title: { $regex: regex } },
        { content: { $regex: regex } },
        { sourceId: { $in: matchingSourceIds } } // Include articles from matching sources
      ],
      language // Add language filter 
    })
      .populate('sourceId', 'name icon') // Populate source info
      .sort({ publishedAt: -1 })
      .limit(50);

    res.json(results);
  } catch (error) {
    console.error('Error in /search:', error);
    res.status(500).json({ message: 'Error searching articles', error: error.message });
  }
});

articleRouter.get('/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ message: 'Article not found' });
    }
    res.json(article);
  } catch (error) {
    console.error('Error fetching article by ID:', error);
    res.status(500).json({ message: 'Error fetching article', error: error.message });
  }
});

articleRouter.get('/related-embedding/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const target = await Article.findById(id);
    if (!target?.embedding) return res.status(404).json({ error: 'No embedding found' });

    const allArticles = await Article.find({ _id: { $ne: id }, embedding: { $exists: true } });

    const cosineSimilarity = (a, b) => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
    };

    const related = allArticles
      .map(a => ({
        ...a.toObject(),
        similarity: cosineSimilarity(target.embedding, a.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    res.json(related);
  } catch (err) {
    console.error('Error finding related articles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// POST: Add a new article
articleRouter.post('/', auth, async (req, res) => {
  try {
    const { title, content, url, sourceId, category, publishedAt, image } = req.body;
    if (!title || !content || !url || !sourceId || !category || !image) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    try {
      // 1. Generate embedding text
      const embeddingInput = `${title}\n\n${content?.slice(0, 512) || ''}`; // Limit content length if needed

      // 2. Get embedding from DeepSeek
      let embedding = [];
      try {
        embedding = await getDeepSeekEmbedding(embeddingInput);
      } catch (embeddingError) {
        console.warn('DeepSeek embedding error (article will save without embedding):', embeddingError.message);
        // Optionally: return error, or allow saving without embedding
      }

      // 3. Save article with embedding
      const newArticle = new Article({
        title,
        content,
        url,
        sourceId,
        category,
        publishedAt,
        image,
        embedding, // <-- NEW FIELD
      });
      const savedArticle = await newArticle.save();
      res.status(201).json(savedArticle);

    } catch (error) {
      res.status(400).json({ message: 'Error creating article', error: error.message });
    }
  } catch (error) {
    res.status(400).json({ message: 'Error creating article', error: error.message });
  }
});

// PUT: Update an article by ID
articleRouter.put('/:id', auth, async (req, res) => {
  try {
    const updatedArticle = await Article.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!updatedArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }
    res.json(updatedArticle);
  } catch (error) {
    res.status(400).json({ message: 'Error updating article', error: error.message });
  }
});

// DELETE: Delete an article by ID
articleRouter.delete('/:id', auth, async (req, res) => {
  try {
    const deletedArticle = await Article.findByIdAndDelete(req.params.id);
    if (!deletedArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }
    res.json({ message: 'Article deleted successfully' });
  } catch (error) {
    res.status(400).json({ message: 'Error deleting article', error: error.message });
  }
  await clearArticlesCache();
});


articleRouter.get('/related/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    // Step 1: Try 5 most recent from same source
    let related = await Article.find({
      sourceId: article.sourceId,
      _id: { $ne: article._id },
    })
      .sort({ publishedAt: -1 })
      .limit(5);

    // Step 2: Fallback to top 5 trending articles if not enough
    if (!related || related.length < 5) {
      related = await Article.find({
        _id: { $ne: article._id },
        viewCount: { $exists: true },
      })
        .sort({ viewCount: -1, publishedAt: -1 })
        .limit(5);
    }

    res.json(related);
  } catch (err) {
    console.error('❌ Error in /related/:id:', err);
    res.status(500).json({ error: 'Failed to fetch related articles' });
  }
})

articleRouter.post('/:id/update-embedding', auth, async (req, res) => {
  const { embedding } = req.body;
  if (!embedding || !Array.isArray(embedding)) {
    return res.status(400).json({ message: 'embedding (array) required' });
  }
  try {
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });
    article.embedding = embedding;
    await article.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update embedding' });
  }
});

// GET: Faiss index status (for debugging and monitoring)
articleRouter.get('/faiss-status', auth, async (req, res) => {
  try {
    const status = getFaissIndexStatus();
    const articleCount = await Article.countDocuments({ embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } } });
    const userCount = await User.countDocuments({ embedding_pca: { $exists: true, $ne: null, $not: { $size: 0 } } });

    res.json({
      faiss: status,
      database: {
        articlesWithPCA: articleCount,
        usersWithPCA: userCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error getting Faiss status:', error);
    res.status(500).json({ error: 'Error getting Faiss status', message: error.message });
  }
});

// Initialize Faiss index when the module loads
console.log('🚀 Initializing Faiss index for article recommendations...');
initializeFaissIndex().catch(err => {
  console.error('❌ Failed to initialize Faiss index:', err);
  console.log('⚠️ Personalized recommendations will fallback to engagement-based sorting');
});

module.exports = articleRouter;