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
const authRoutes = require('./routes/auth');
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
const aiAgentRoutes = require('./routes/aiAgent'); // AI Agent routes
const { recommendationIndex } = require('./recommendation/fastIndex');
// const cacheWarmer = require('./services/cacheWarmer'); // Temporarily disabled for deployment
require('dotenv').config();
const app = express();


const createIndexes = async () => {
    try {
        // Core indexes for article queries
        await Article.collection.createIndex({ category: 1, publishedAt: -1 });
        await Article.collection.createIndex({ publishedAt: -1 });
        await Article.collection.createIndex({ language: 1, publishedAt: -1 });

        // Compound indexes for personalized queries
        await Article.collection.createIndex({ language: 1, category: 1, publishedAt: -1 });
        await Article.collection.createIndex({ language: 1, sourceId: 1, publishedAt: -1 });
        await Article.collection.createIndex({ sourceId: 1, publishedAt: -1 });

        // Additional performance indexes
        await Article.collection.createIndex({ url: 1 }, { unique: true });
        await Article.collection.createIndex({ viewCount: -1 });

        console.log('✅ MongoDB indexes created successfully');
    } catch (error) {
        console.error('❌ Failed to create indexes:', error);
    }
};

// Initialize cache warmer after successful MongoDB connection (temporarily disabled)
const initializeCacheWarmer = () => {
    // setTimeout(() => {
    //     if (mongoose.connection.readyState === 1) {
    //         console.log('🔥 Starting Cache Warmer service...');
    //         cacheWarmer.start();
    //     } else {
    //         console.log('⏳ Waiting for MongoDB connection before starting Cache Warmer...');
    //         initializeCacheWarmer();
    //     }
    // }, 15000); // Wait 15 seconds to ensure everything is ready
};

app.use(cors({
    origin: '*', // Or specify your app's origin e.g. 'https://your-app-url'
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'], // ✅ crucial
}));

// Light logging for production (removed header logging to improve performance)
app.use((req, res, next) => {
    if (process.env.NODE_ENV !== 'production') {
        console.log(`${req.method} ${req.path}`);
    }
    next();
});

mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 30000, // Increased for dedicated cluster
    socketTimeoutMS: 45000, // 45 seconds socket timeout for dedicated cluster
    connectTimeoutMS: 30000, // 30 seconds to establish connection
    bufferCommands: false, // Disable buffering to fail fast
    maxPoolSize: 10, // Increased pool size for dedicated cluster
    minPoolSize: 2, // Maintain at least 2 socket connections
    maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
    retryWrites: true, // Enable retry writes for better reliability
    retryReads: true, // Enable retry reads for better reliability
    heartbeatFrequencyMS: 10000, // Check server status every 10 seconds
})
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas');
        console.log('📊 MongoDB Connection State:', mongoose.connection.readyState);

        // Create indexes in background to avoid blocking startup
        setTimeout(async () => {
            try {
                await createIndexes();
            } catch (error) {
                console.error('⚠️ Failed to create indexes (non-critical):', error.message);
            }
        }, 5000);

        // Initialize recommendation system in background
        setTimeout(async () => {
            try {
                console.log('🤖 Initializing recommendation system...');
                await recommendationIndex.buildIndex();
                console.log('✅ Recommendation system ready');
            } catch (error) {
                console.error('⚠️ Failed to initialize recommendation system (non-critical):', error.message);
            }
        }, 10000); // Wait 10 seconds after startup

        // Initialize cache warmer service
        setTimeout(() => {
            initializeCacheWarmer();
        }, 30000); // Start after 30 seconds
    })
    .catch(err => {
        console.error('❌ Failed to connect to MongoDB Atlas:', err.message);
        console.error('📊 Connection details:', {
            readyState: mongoose.connection.readyState,
            host: mongoose.connection.host,
            name: mongoose.connection.name,
        });
        // Don't exit the process - let the app serve with degraded functionality
        console.log('⚠️ Continuing without MongoDB connection...');
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

// Middleware to log MongoDB connection status (removed blocking check)
app.use('/api', (req, res, next) => {
    if (mongoose.connection.readyState !== 1 && process.env.NODE_ENV !== 'production') {
        console.log(`⚠️ API route ${req.path} accessed with MongoDB readyState: ${mongoose.connection.readyState}`);
    }
    next();
});

// Health check endpoint for Google Cloud Run
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root endpoint - API information
app.get('/', (req, res) => {
    res.json({
        message: 'MENA News API',
        version: '1.0.0',
        status: 'running',
        features: ['Phase 3 Performance Optimizations'],
        documentation: '/docs',
        mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
        endpoints: {
            health: '/health',
            database_test: '/db-test',
            api_docs: '/docs',
            openapi_spec: '/docs/openapi.json',
            articles: '/api/articles',
            sources: '/api/sources',
            users: '/api/users'
        },
        timestamp: new Date().toISOString()
    });
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
app.use('/api/auth', authRoutes);
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
app.use('/api/ai', aiAgentRoutes); // AI Agent routes

// Image proxy endpoint for SSL certificate issues
app.get('/api/proxy-image', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        // Security check: only allow specific domains
        const allowedDomains = ['timesofdubai.ae', 'whatson.ae', 'khaleejtimes.com'];
        const urlObj = new URL(url);
        const isAllowed = allowedDomains.some(domain => urlObj.hostname.includes(domain));

        if (!isAllowed) {
            return res.status(403).json({ error: 'Domain not allowed' });
        }

        console.log('🔄 Proxying image request for:', url);

        const fetch = require('node-fetch');
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Set appropriate headers
        res.set({
            'Content-Type': response.headers.get('content-type') || 'image/jpeg',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
        });

        // Pipe the image data
        response.body.pipe(res);

    } catch (error) {
        console.error('❌ Proxy image error:', error.message);
        res.status(500).json({ error: 'Failed to proxy image', details: error.message });
    }
});
module.exports = app;
