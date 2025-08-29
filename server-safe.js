// Safe server with delayed initialization
console.log('🚀 Starting server...');

try {
    require('dotenv').config();
    const express = require('express');
    const cors = require('cors');
    const path = require('path');

    const app = express();

    // Basic middleware
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
            message: 'MENA News API - Safe Version',
            version: '1.0.0',
            status: 'running',
            endpoints: {
                health: '/health',
                api_test: '/api/test'
            },
            timestamp: new Date().toISOString()
        });
    });

    // Test endpoint
    app.get('/api/test', (req, res) => {
        res.json({
            message: 'API working',
            environment: process.env.NODE_ENV || 'development'
        });
    });

    // Start server immediately
    const PORT = process.env.PORT || 8080;
    const HOST = process.env.HOST || '0.0.0.0';

    const server = app.listen(PORT, HOST, () => {
        console.log(`✅ Server is running on ${HOST}:${PORT}`);

        // Initialize heavy components AFTER server starts
        setTimeout(() => {
            initializeDatabase();
        }, 2000);
    });

    // Database initialization (delayed)
    async function initializeDatabase() {
        try {
            console.log('🔗 Initializing database connection...');
            const mongoose = require('mongoose');

            await mongoose.connect(process.env.MONGO_URI, {
                serverSelectionTimeoutMS: 10000,
                connectTimeoutMS: 10000,
                bufferCommands: false,
                maxPoolSize: 5,
                minPoolSize: 1,
            });

            console.log('✅ MongoDB connected');

            // Add API routes after DB connection
            setTimeout(() => {
                addApiRoutes(app);
            }, 1000);

        } catch (error) {
            console.error('⚠️ Database connection failed:', error.message);
            console.log('🔄 Server will continue without database...');
        }
    }

    // Add API routes (delayed)
    function addApiRoutes(app) {
        try {
            console.log('📡 Loading API routes...');

            // Load routes one by one to avoid import issues
            const articles = require('./routes/articles');
            app.use('/api/articles', articles);
            console.log('✅ Articles routes loaded');

            const sources = require('./routes/sources');
            app.use('/api/sources', sources);
            console.log('✅ Sources routes loaded');

            const userRoutes = require('./routes/user');
            app.use('/api/users', userRoutes);
            console.log('✅ User routes loaded');

            console.log('✅ All API routes loaded successfully');

        } catch (error) {
            console.error('⚠️ Failed to load some routes:', error.message);
            console.log('🔄 Server will continue with basic functionality...');
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

    console.log('✅ Server setup complete');

} catch (error) {
    console.error('❌ Critical error starting server:', error);
    console.error('❌ Error stack:', error.stack);
    process.exit(1);
}
