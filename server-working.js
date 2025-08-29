// Working production server with proper route loading
console.log('🚀 Starting MENA News API Server...');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        port: process.env.PORT || 8080,
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'MENA News API',
        version: '1.0.0',
        status: 'running',
        features: ['Phase 3 Performance Optimizations'],
        mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
        documentation: '/docs',
        endpoints: {
            // Core API
            health: '/health',
            database_test: '/db-test',
            api_docs: '/docs',
            openapi_spec: '/docs/openapi.json',
            
            // Articles
            articles: '/api/articles',
            articles_personalized: '/api/articles/personalized',
            articles_fast: '/api/articles/personalized-fast',
            articles_light: '/api/articles/personalized-light',
            articles_by_category: '/api/articles/category/{category}',
            
            // Sources & Content
            sources: '/api/sources',
            source_groups: '/api/source',
            videos: '/api/videos',
            youtube: '/api/youtube',
            lotto: '/api/lotto',
            
            // User Management
            users: '/api/users',
            user_actions: '/api/user',
            engagement: '/api/engagement',
            recommendations: '/api/recommendations',
            recommend: '/api/recommend',
            
            // Content Management
            comments: '/api/comments',
            thumbnails: '/api/thumbnails',
            ads: '/api/ads',
            
            // Admin & Tools
            admin: '/api/admin',
            scrape: '/api/scrape',
            debug: '/api/debug',
            puppeteer_debug: '/api/puppeteer'
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

// Start server immediately
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
    console.log(`✅ Server running on ${HOST}:${PORT}`);
    
    // Initialize everything after server starts
    setTimeout(initializeApp, 1000);
});

async function initializeApp() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 30000, // Increased to 30 seconds for Cloud Run
            connectTimeoutMS: 30000,
            bufferCommands: false,
            maxPoolSize: 10,
            minPoolSize: 2,
            retryWrites: true,
            retryReads: true,
        });
        
        console.log('✅ MongoDB connected');
        
        // Load routes after DB connection
        loadRoutes();
        
        // Initialize optimizations
        setTimeout(initializeOptimizations, 5000);
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        console.log('🔄 Loading routes anyway with degraded functionality...');
        loadRoutes();
    }
}

function loadRoutes() {
    try {
        console.log('📡 Loading API routes...');
        
        // Add middleware to log MongoDB connection status (removed blocking check)
        app.use('/api', (req, res, next) => {
            if (mongoose.connection.readyState !== 1 && process.env.NODE_ENV !== 'production') {
                console.log(`⚠️ API route ${req.path} accessed with MongoDB readyState: ${mongoose.connection.readyState}`);
            }
            next();
        });
        
        // Load articles routes
        const articles = require('./routes/articles');
        app.use('/api/articles', articles);
        console.log('✅ Articles routes loaded');
        
        // Load other essential routes
        const sources = require('./routes/sources');
        app.use('/api/sources', sources);
        console.log('✅ Sources routes loaded');
        
        const userRoutes = require('./routes/user');
        app.use('/api/users', userRoutes);
        console.log('✅ User routes loaded');

        // Load all remaining routes
        const scrapeRoute = require('./routes/scrape');
        const userActions = require('./routes/userActions');
        const recommendations = require('./routes/recommendations');
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
        const adsRoutes = require('./routes/ads');

        app.use('/api/scrape', scrapeRoute);
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
        app.use('/api/ads', adsRoutes);
        
        console.log('🎉 All API routes loaded successfully!');
        
    } catch (error) {
        console.error('❌ Failed to load routes:', error.message);
        console.error('❌ Stack:', error.stack);
    }
}

async function initializeOptimizations() {
    try {
        console.log('🚀 Initializing optimizations...');
        
        // Initialize recommendation system
        setTimeout(async () => {
            try {
                const { recommendationIndex } = require('./recommendation/fastIndex');
                await recommendationIndex.buildIndex();
                console.log('✅ Recommendation system ready');
            } catch (error) {
                console.error('⚠️ Recommendation system failed:', error.message);
            }
        }, 5000);
        
        // Initialize safe cache warmer
        setTimeout(() => {
            try {
                const safeCacheWarmer = require('./services/cacheWarmerSafe');
                safeCacheWarmer.start();
                console.log('🔥 Safe cache warmer started');
            } catch (error) {
                console.error('⚠️ Cache warmer failed:', error.message);
            }
        }, 10000);
        
    } catch (error) {
        console.error('⚠️ Optimization initialization failed:', error.message);
    }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
