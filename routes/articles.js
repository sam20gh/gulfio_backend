const express = require('express');
const Article = require('../models/Article');
const auth = require('../middleware/auth');
const articleRouter = express.Router();

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