const express = require('express');
const Article = require('../models/Article');
const auth = require('../middleware/auth');
const articleRouter = express.Router();

articleRouter.get('/', auth, async (req, res) => {
  const articles = await Article.find().sort({ publishedAt: -1 });
  res.json(articles);
});

articleRouter.post('/', auth, async (req, res) => {
  try {
    const {
      title,
      content,
      url,
      sourceId,
      category,
      publishedAt,
      image = [],
    } = req.body;

    const newArticle = new Article({
      title,
      content,
      url,
      sourceId,
      category,
      publishedAt: publishedAt || new Date(),
      image,
    });

    const savedArticle = await newArticle.save();
    res.status(201).json(savedArticle);
  } catch (err) {
    console.error('Error creating article:', err.message);
    res.status(500).json({ error: 'Failed to create article' });
  }
});
articleRouter.put('/:id', auth, async (req, res) => {
  const { id } = req.params;
  const {
    title,
    content,
    url,
    sourceId,
    category,
    publishedAt,
    image = [],
  } = req.body;

  try {
    const updatedArticle = await Article.findByIdAndUpdate(
      id,
      {
        title,
        content,
        url,
        sourceId,
        category,
        publishedAt: publishedAt || new Date(),
        image,
      },
      { new: true }
    );

    if (!updatedArticle) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json(updatedArticle);
  } catch (err) {
    console.error('Error updating article:', err.message);
    res.status(500).json({ error: 'Failed to update article' });
  }
});
articleRouter.delete('/:id', auth, async (req, res) => {
  const { id } = req.params;

  try {
    const deletedArticle = await Article.findByIdAndDelete(id);

    if (!deletedArticle) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json(deletedArticle);
  } catch (err) {
    console.error('Error deleting article:', err.message);
    res.status(500).json({ error: 'Failed to delete article' });
  }
});


module.exports = articleRouter;