require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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
const debugRoutes = require('./routes/debug');
const puppeteerDebugRoutes = require('./routes/puppeteer-debug');
const docsRouter = require('./routes/docs');
const adsRoutes = require('./routes/ads'); // AdMob revenue tracking routes
const { recommendationIndex } = require('./recommendation/fastIndex');
const cacheWarmer = require('./services/cacheWarmer');
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

// Initialize cache warmer after successful MongoDB connection
const initializeCacheWarmer = () => {
    setTimeout(() => {
        if (mongoose.connection.readyState === 1) {
            console.log('🔥 Starting Cache Warmer service...');
            cacheWarmer.start();
        } else {
            console.log('⏳ Waiting for MongoDB connection before starting Cache Warmer...');
            initializeCacheWarmer();
        }
    }, 5000); // Wait 5 seconds to ensure everything is ready
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

mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000, // Increased to 30 seconds for Cloud Run
    socketTimeoutMS: 0, // No socket timeout for Cloud Run
    connectTimeoutMS: 30000, // 30 seconds to establish connection
    bufferCommands: false, // Disable buffering to fail fast
    maxPoolSize: 10, // Maintain up to 10 socket connections
    minPoolSize: 1, // Maintain at least 1 socket connection
})
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas');
        console.log('📊 MongoDB Connection State:', mongoose.connection.readyState);
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

        // Initialize cache warmer service
        initializeCacheWarmer();
    })
    .catch(err => {
        console.error('❌ Failed to connect to MongoDB Atlas:', err);
        console.error('📊 Connection details:', {
            readyState: mongoose.connection.readyState,
            host: mongoose.connection.host,
            name: mongoose.connection.name,
        });
    });

// Monitor connection status
mongoose.connection.on('connected', () => {
    console.log('✅ Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
    console.error('❌ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
    console.log('⚠️ Mongoose disconnected from MongoDB');
});

app.use(express.json());

// Serve static files from public directory
app.use('/static', express.static(path.join(__dirname, 'public')));

// Middleware to check MongoDB connection for API routes
app.use('/api', (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            error: 'Database not ready',
            message: 'MongoDB connection not established yet. Please try again in a moment.',
            readyState: mongoose.connection.readyState
        });
    }
    next();
});

// Health check endpoint for Google Cloud Run
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root endpoint - API welcome page
app.get('/', (req, res) => {
    const path = require('path');
    const indexPath = path.join(__dirname, 'public', 'index.html');
    const fs = require('fs');

    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.json({
            message: 'Welcome to MENA News API',
            version: '1.0.0',
            documentation: '/docs',
            endpoints: {
                health: '/health',
                database_test: '/db-test',
                api_docs: '/docs',
                openapi_spec: '/docs/openapi.json'
            },
            timestamp: new Date().toISOString()
        });
    }
});

// Database connectivity test endpoint
app.get('/db-test', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                status: 'db-not-ready',
                readyState: mongoose.connection.readyState,
                message: 'MongoDB connection not established yet',
                timestamp: new Date().toISOString()
            });
        }

        const Article = require('./models/Article');
        const count = await Article.countDocuments().maxTimeMS(5000);
        res.status(200).json({
            status: 'db-connected',
            articleCount: count,
            readyState: mongoose.connection.readyState,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('DB Test Error:', error);
        res.status(500).json({
            status: 'db-error',
            error: error.message,
            readyState: mongoose.connection.readyState,
            timestamp: new Date().toISOString()
        });
    }
});

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
app.use('/api/debug', debugRoutes);
app.use('/api/puppeteer', puppeteerDebugRoutes);
app.use('/docs', docsRouter);
app.use('/api', recommendationRoutes);
app.use('/api/ads', adsRoutes); // AdMob revenue tracking routes
module.exports = app;
