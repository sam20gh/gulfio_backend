const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const sources = require('./routes/sources');
const articles = require('./routes/articles');
const scrapeRoute = require('./routes/scrape');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: ['http://localhost:5173'],
    credentials: true
}));

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ Failed to connect to MongoDB Atlas:', err));

app.use(express.json());
app.use('/api/sources', sources);
app.use('/api/articles', articles);
app.use('/api/scrape', scrapeRoute);

module.exports = app;
