const express = require('express');
const Article = require('../models/Article');
const auth = require('../middleware/auth');
const articleRouter = express.Router();
const ensureMongoUser = require('../middleware/ensureMongoUser');
const cache = require('../utils/cache')
const mongoose = require('mongoose');

articleRouter.get('/', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const cacheKey = `articles_page_${page}_limit_${limit}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('🧠 Returning cached articles');
      return res.json(cached);
    }

    const skip = (page - 1) * limit;
    const articles = await Article.find()
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    cache.set(cacheKey, articles);
    res.json(articles);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching articles', error: error.message });
  }
});

// POST: Like or dislike an article

articleRouter.post('/:id/react', auth, ensureMongoUser, async (req, res) => {
  try {
    const { action } = req.body; // 'like' or 'dislike'
    const userId = req.mongoUser?.supabase_id;
    if (!userId) return res.status(401).json({ message: 'Unauthorised - user not found' });

    const pullUserFromBoth = {
      $pull: {
        likedBy: userId,
        dislikedBy: userId,
      }
    };

    await Article.updateOne({ _id: req.params.id }, pullUserFromBoth); // Remove from both arrays

    let pushOp = {};
    if (action === 'like') {
      pushOp = { $push: { likedBy: userId } };
    } else if (action === 'dislike') {
      pushOp = { $push: { dislikedBy: userId } };
    } else {
      return res.status(400).json({ message: 'Invalid action' });
    }

    await Article.updateOne({ _id: req.params.id }, pushOp); // Add to appropriate array

    // Fetch new like/dislike counts
    const updatedArticle = await Article.findById(req.params.id, 'likes dislikes likedBy dislikedBy');

    const likes = updatedArticle.likedBy?.length || 0;
    const dislikes = updatedArticle.dislikedBy?.length || 0;

    res.json({
      likes,
      dislikes,
      userReact: action,
    });
  } catch (error) {
    console.error('Error in react route:', error);
    res.status(500).json({ message: 'Error reacting to article', error: error.message });
  }
  cache.flushAll();
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
    const skip = (page - 1) * limit;

    const cacheKey = `articles_feature_page_${page}_limit_${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('🧠 Returning cached feature articles');
      return res.json(cached);
    }

    const query = { category: 'feature' };

    const articles = await Article.find(query)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalFeaturedArticles = await Article.countDocuments(query);

    const response = {
      articles,
      totalPages: Math.ceil(totalFeaturedArticles / limit),
      currentPage: page,
    };

    cache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching featured articles', error: error.message });
  }
});


// GET: Fetch headline articles with pagination
articleRouter.get('/headline', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    const cacheKey = `articles_headline_page_${page}_limit_${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('🧠 Returning cached headline articles');
      return res.json(cached);
    }

    const query = { category: 'headline' };

    const articles = await Article.find(query)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalHeadlineArticles = await Article.countDocuments(query);

    const response = {
      articles,
      totalPages: Math.ceil(totalHeadlineArticles / limit),
      currentPage: page,
    };

    cache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching headline articles', error: error.message });
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
  cache.flushAll();
});


module.exports = articleRouter;