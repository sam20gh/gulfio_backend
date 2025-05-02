const express = require('express');
const Article = require('../models/Article');
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
    const { action } = req.body; // 'like' or 'dislike'
    const userId = req.mongoUser?.supabase_id;
    if (!userId) return res.status(401).json({ message: 'Unauthorised - user not found' });

    // Step 1: Remove user from both arrays
    await Article.updateOne({ _id: req.params.id }, {
      $pull: {
        likedBy: userId,
        dislikedBy: userId,
      }
    });

    // Step 2: Push user to the correct array
    let pushOp = {};
    if (action === 'like') {
      pushOp = { $push: { likedBy: userId } };
    } else if (action === 'dislike') {
      pushOp = { $push: { dislikedBy: userId } };
    } else {
      return res.status(400).json({ message: 'Invalid action' });
    }

    await Article.updateOne({ _id: req.params.id }, pushOp);

    // Step 3: Update the like/dislike counts in DB
    const updatedArticle = await Article.findById(req.params.id, 'likedBy dislikedBy');
    const likes = updatedArticle.likedBy.length;
    const dislikes = updatedArticle.dislikedBy.length;

    updatedArticle.likes = likes;
    updatedArticle.dislikes = dislikes;
    await updatedArticle.save();

    // Step 4: Respond
    res.json({
      likes,
      dislikes,
      userReact: action,
    });

    await clearArticlesCache();
  } catch (error) {
    console.error('Error in react route:', error);
    res.status(500).json({ message: 'Error reacting to article', error: error.message });
  }
});

// GET: Check if user has liked/disliked this article
articleRouter.get('/:id/react', auth, ensureMongoUser, async (req, res) => {
  try {
    const userId = req.mongoUser.supabase_id;

    const article = await Article.findById(
      req.params.id,
      'likedBy dislikedBy'
    ).lean(); // Use lean for performance if no virtuals/hooks needed

    if (!article) return res.status(404).json({ message: 'Article not found' });

    const userReact = article.likedBy?.includes(userId)
      ? 'like'
      : article.dislikedBy?.includes(userId)
        ? 'dislike'
        : null;

    res.json({ userReact });
  } catch (error) {
    console.error('Error checking user reaction:', error);
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




module.exports = articleRouter;