const express = require('express');
const Article = require('../models/Article');
const auth = require('../middleware/auth');
const articleRouter = express.Router();
const ensureMongoUser = require('../middleware/ensureMongoUser');
const mongoose = require('mongoose');

articleRouter.get('/', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const articles = await Article.find()
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

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

    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article not found' });

    // Remove user from both lists
    article.likedBy = (article.likedBy || []).filter(id => id !== userId);
    article.dislikedBy = (article.dislikedBy || []).filter(id => id !== userId);

    let userReact = null;
    if (action === 'like') {
      article.likedBy.push(userId);
      userReact = 'like';
    } else if (action === 'dislike') {
      article.dislikedBy.push(userId);
      userReact = 'dislike';
    } else {
      return res.status(400).json({ message: 'Invalid action' });
    }

    // Recalculate counts
    article.likes = article.likedBy.length;
    article.dislikes = article.dislikedBy.length;

    await article.save();

    res.json({
      likes: article.likes,
      dislikes: article.dislikes,
      liked_articles: req.mongoUser.liked_articles,
      userReact,
    });
  } catch (error) {
    console.error('Error in react route:', error);
    res.status(500).json({ message: 'Error reacting to article', error: error.message });
  }
});
// GET: Check if user has liked/disliked this article
articleRouter.get('/:id/react', auth, ensureMongoUser, async (req, res) => {
  try {
    const articleId = new mongoose.Types.ObjectId(req.params.id);
    const user = req.mongoUser;

    const isLiked = user.liked_articles?.some(id => id.equals(articleId));
    const isDisliked = user.disliked_articles?.some(id => id.equals(articleId));

    let userReact = null;
    if (isLiked) userReact = 'like';
    else if (isDisliked) userReact = 'dislike';

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
    const limit = parseInt(req.query.limit) || 5; // Example: Default limit 5 for features
    const skip = (page - 1) * limit;

    const query = { category: 'feature' }; // Filter by category 'feature'

    const articles = await Article.find(query)
      .sort({ publishedAt: -1 }) // Sort by published date, newest first
      .skip(skip)
      .limit(limit);

    // Get total count of featured articles for pagination metadata
    const totalFeaturedArticles = await Article.countDocuments(query);

    res.json({
      articles,
      totalPages: Math.ceil(totalFeaturedArticles / limit),
      currentPage: page
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching featured articles', error: error.message });
  }
});

// GET: Fetch headline articles with pagination
articleRouter.get('/headline', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5; // Example: Default limit 5 for headlines
    const skip = (page - 1) * limit;

    const query = { category: 'headline' }; // Filter by category 'headline'

    const articles = await Article.find(query)
      .sort({ publishedAt: -1 }) // Sort by published date, newest first
      .skip(skip)
      .limit(limit);

    // Get total count of headline articles for pagination metadata
    const totalHeadlineArticles = await Article.countDocuments(query);

    res.json({
      articles,
      totalPages: Math.ceil(totalHeadlineArticles / limit),
      currentPage: page
    });
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
});

module.exports = articleRouter;