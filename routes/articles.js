const express = require('express');
const Article = require('../models/Article');
const User = require('../models/User');
const auth = require('../middleware/auth');
const articleRouter = express.Router();
const ensureMongoUser = require('../middleware/ensureMongoUser');
const cache = require('../utils/cache')
const mongoose = require('mongoose');
const redis = require('../utils/redis');

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
    const cacheKey = `articles_page_${page}_limit_${limit}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (cached) {
      console.log('🧠 Returning cached articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find()
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    try {
      await redis.set(cacheKey, JSON.stringify(articles), 'EX', 300);
    } catch (err) {
      console.error('⚠️ Redis set error (safe to ignore):', err.message);
    }

    res.json(articles);
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

    // 3. Return updated counts
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
articleRouter.post('/:id/view', async (req, res) => {
  try {
    const article = await Article.findByIdAndUpdate(
      req.params.id,
      { $inc: { viewCount: 1 } },
      { new: true }
    );
    if (!article) return res.status(404).json({ message: 'Article not found' });

    res.json({ viewCount: article.viewCount });
  } catch (error) {
    res.status(500).json({ message: 'Error updating view count', error: error.message });
  }
});



articleRouter.get('/feature', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const cacheKey = `articles_feature_page_${page}_limit_${limit}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (cached) {
      console.log('🧠 Returning cached feature articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({ category: 'feature' })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalFeatureArticles = await Article.countDocuments({ category: 'feature' });

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
    const cacheKey = `articles_headline_page_${page}_limit_${limit}`;

    let cached;
    try {
      cached = await redis.get(cacheKey);
    } catch (err) {
      console.error('⚠️ Redis get error (safe to ignore):', err.message);
    }

    if (cached) {
      console.log('🧠 Returning cached headline articles');
      return res.json(JSON.parse(cached));
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find({ category: 'headline' })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalHeadlineArticles = await Article.countDocuments({ category: 'headline' });

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
    if (!query) return res.status(400).json({ message: 'Missing search query' });

    const regex = new RegExp(query, 'i'); // case-insensitive
    const results = await Article.find({ title: { $regex: regex } })
      .sort({ publishedAt: -1 })
      .limit(50); // limit to avoid overfetching

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




// POST: Add a new article
articleRouter.post('/', auth, async (req, res) => {
  try {
    const { title, content, url, sourceId, category, publishedAt, image } = req.body;
    if (!title || !content || !url || !sourceId || !category || !image) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const newArticle = new Article({
      title,
      content,
      url,
      sourceId,
      category,
      publishedAt,
      image,
    });
    const savedArticle = await newArticle.save();
    res.status(201).json(savedArticle);
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
articleRouter.get('/related/:id', async (req, res) => {
  try {
    const originalArticle = await Article.findById(req.params.id);

    if (!originalArticle) {
      return res.status(404).json({ message: 'Article not found' });
    }

    // ✅ Use MongoDB Aggregation to remove duplicates
    const relatedArticles = await Article.aggregate([
      {
        $match: {
          _id: { $ne: originalArticle._id },
          category: originalArticle.category,
        },
      },
      {
        $group: {
          _id: "$_id",
          doc: { $first: "$$ROOT" }
        }
      },
      {
        $replaceRoot: { newRoot: "$doc" }
      },
      {
        $sort: { publishedAt: -1 }
      },
      {
        $limit: 20
      }
    ]);

    console.log('✅ Related Articles after full deduplication:', relatedArticles.map(a => a._id));
    res.json(relatedArticles);

  } catch (error) {
    console.error('Error fetching related articles:', error.message);
    res.status(500).json({ message: 'Server Error' });
  }
});


module.exports = articleRouter;