// Production-ready server with Phase 3 optimizations
console.log('🚀 Starting MENA News API Server...');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

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
        port: process.env.PORT || 8080
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'MENA News API',
        version: '1.0.0',
        status: 'running',
        features: ['Phase 3 Performance Optimizations', 'Cache Warming Ready', 'Background Prefetching'],
        endpoints: {
            health: '/health',
            articles: '/api/articles/fast',
            sources: '/api/sources'
        },
        timestamp: new Date().toISOString()
    });
});

// Start server immediately
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
    console.log(`✅ Server running on ${HOST}:${PORT}`);
    
    // Initialize database and routes after server starts
    initializeApp().catch(error => {
        console.error('⚠️ Non-critical initialization error:', error.message);
    });
});

async function initializeApp() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        const mongoose = require('mongoose');
        
        await mongoose.connect(process.env.MONGO_URI, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            bufferCommands: false,
            maxPoolSize: 5,
            minPoolSize: 1,
        });
        
        console.log('✅ MongoDB connected');
        
        // Load and register routes
        await loadRoutes();
        
        // Initialize Phase 3 optimizations (cache warmer ready)
        await initializeOptimizations();
        
        console.log('🎉 API fully initialized and ready!');
        
    } catch (error) {
        console.error('❌ Initialization failed:', error.message);
        console.log('🔄 Server continues with basic functionality...');
    }
}

async function loadRoutes() {
    try {
        console.log('📡 Loading API routes...');
        
        // Load routes safely with error handling
        const routes = [
            { path: '/api/articles', module: './routes/articles' },
            { path: '/api/sources', module: './routes/sources' },
            { path: '/api/users', module: './routes/user' },
        ];
        
        for (const route of routes) {
            try {
                const routeModule = require(route.module);
                app.use(route.path, routeModule);
                console.log(`✅ Loaded ${route.path}`);
            } catch (error) {
                console.error(`⚠️ Failed to load ${route.path}:`, error.message);
            }
        }
        
    } catch (error) {
        console.error('❌ Route loading failed:', error.message);
    }
}

async function initializeOptimizations() {
    try {
        console.log('🚀 Initializing Phase 3 optimizations...');
        
        // Initialize recommendation system
        const { recommendationIndex } = require('./recommendation/fastIndex');
        setTimeout(async () => {
            try {
                await recommendationIndex.buildIndex();
                console.log('✅ Recommendation system ready');
            } catch (error) {
                console.error('⚠️ Recommendation system failed:', error.message);
            }
        }, 5000);
        
        // Initialize safe cache warmer (when ready)
        setTimeout(() => {
            try {
                const safeCacheWarmer = require('./services/cacheWarmerSafe');
                safeCacheWarmer.start();
                console.log('🔥 Cache warmer started');
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
