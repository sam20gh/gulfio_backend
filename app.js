const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const sources = require('./routes/sources');
const articles = require('./routes/articles');
const scrapeRoute = require('./routes/scrape');
const userRoutes = require('./routes/user');
const userActions = require('./routes/userActions');
const recommendations = require('./routes/recommendations');
const Article = require('./models/Article');
const sourceGroupRoutes = require('./routes/sourceGroup');
const engagementRouter = require('./routes/engagement');
const adminRoutes = require('./routes/admin');
const commentsRouter = require('./routes/comments');
const videoRoutes = require('./routes/videos');
const youtubeRoutes = require('./routes/youtube');
const lottoRoutes = require('./routes/lotto');
const recommendationRoutes = require('./routes/recommend');
const thumbnailRoutes = require('./routes/thumbnails');
const { recommendationIndex } = require('./recommendation/fastIndex');
require('dotenv').config();
const app = express();


const createIndexes = async () => {
    try {
        await Article.collection.createIndex({ category: 1, publishedAt: -1 });
        await Article.collection.createIndex({ publishedAt: -1 });
        console.log('✅ MongoDB indexes created');
    } catch (error) {
        console.error('❌ Failed to create indexes:', error);
    }
};

app.use(cors({
    origin: '*', // Or specify your app's origin e.g. 'https://your-app-url'
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'], // ✅ crucial
}));

app.use((req, res, next) => {
    console.log('🔐 Incoming Request Headers:', req.headers);
    next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});

mongoose.connect(process.env.MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas');
        await createIndexes(); // 👈 Run after DB connection

        // Initialize recommendation system in background
        setTimeout(async () => {
            try {
                console.log('🤖 Initializing recommendation system...');
                await recommendationIndex.buildIndex();
                console.log('✅ Recommendation system ready');
            } catch (error) {
                console.error('⚠️ Failed to initialize recommendation system:', error);
            }
        }, 5000); // Wait 5 seconds after startup
    })
    .catch(err => console.error('❌ Failed to connect to MongoDB Atlas:', err));

app.use(express.json());
app.use('/api/sources', sources);
app.use('/api/articles', articles);
app.use('/api/scrape', scrapeRoute);
app.use('/api/users', userRoutes);
app.use('/api/user', userActions);
app.use('/api/recommendations', recommendations);
app.use('/api/source', sourceGroupRoutes);
app.use('/api/engagement', engagementRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/comments', commentsRouter);
app.use('/api/videos', videoRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/lotto', lottoRoutes);
app.use('/api/thumbnails', thumbnailRoutes);
app.use('/api', recommendationRoutes);
module.exports = app;
