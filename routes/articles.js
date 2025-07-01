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

async function clearArticlesCache() {
  const keys = await redis.keys('articles_*');
  if (keys.length > 0) {
    await redis.del(keys);
    console.log('🧹 Cleared article caches:', keys);
  }
}

articleRouter.get('/', auth, async (req, res) => {
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
articleRouter.get('/search', auth, async (req, res) => {
  try {
    const query = req.query.query?.trim();
    const language = req.query.language || 'english'; // Add language filtering to search

    if (!query) return res.status(400).json({ message: 'Missing search query' });

    const regex = new RegExp(query, 'i'); // case-insensitive
    const results = await Article.find({
      title: { $regex: regex },
      language // Add language filter 
    })
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

// 🔍 GET /articles/related/:id
// articleRouter.get('/related/:id', async (req, res) => {
//   try {
//     const originalArticle = await Article.findById(req.params.id);
//     const language = req.query.language || originalArticle?.language || 'english';

//     if (!originalArticle) {
//       return res.status(404).json({ message: 'Article not found' });
//     }

//     // ✅ Use MongoDB Aggregation to remove duplicates
//     const relatedArticles = await Article.aggregate([
//       {
//         $match: {
//           _id: { $ne: originalArticle._id },
//           category: originalArticle.category,
//           language: language // Add language filter
//         },
//       },
//       {
//         $group: {
//           _id: "$_id",
//           doc: { $first: "$$ROOT" }
//         }
//       },
//       {
//         $replaceRoot: { newRoot: "$doc" }
//       },
//       {
//         $sort: { publishedAt: -1 }
//       },
//       {
//         $limit: 20
//       }
//     ]);

//     // Inject a unique fetchId to each article
//     const enhancedRelatedArticles = relatedArticles.map(article => ({
//       ...article,
//       fetchId: new mongoose.Types.ObjectId().toString()
//     }));

//     console.log('✅ Related Articles after full deduplication:', enhancedRelatedArticles.map(a => a.fetchId));
//     res.json(enhancedRelatedArticles);

//   } catch (error) {
//     console.error('Error fetching related articles:', error.message);
//     res.status(500).json({ message: 'Server Error' });
//   }
// });
// routes/articles.js
articleRouter.get('/related/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id).populate('relatedIds');
    if (!article) return res.status(404).json({ error: 'Article not found' });

    res.json(article.relatedIds);
  } catch (err) {
    console.error('❌ Error fetching related:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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


module.exports = articleRouter;