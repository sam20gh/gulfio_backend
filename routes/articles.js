const express = require('express');
const Article = require('../models/Article');
const auth = require('../middleware/auth');
const articleRouter = express.Router();

articleRouter.get('/', auth, async (req, res) => {
  const articles = await Article.find().sort({ publishedAt: -1 });
  res.json(articles);
});


module.exports = articleRouter;