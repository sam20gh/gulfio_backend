// Simplified server for debugging
console.log('🚀 Starting server...');

try {
    require('dotenv').config();
    console.log('✅ dotenv loaded');

    const express = require('express');
    console.log('✅ express loaded');

    const cors = require('cors');
    console.log('✅ cors loaded');

    const app = express();
    console.log('✅ express app created');

    // Basic middleware
    app.use(cors());
    app.use(express.json({ limit: '50mb' }));
    console.log('✅ middleware configured');

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
            message: 'MENA News API - Debug Version',
            version: '1.0.0',
            port: process.env.PORT || 8080,
            timestamp: new Date().toISOString()
        });
    });

    console.log('✅ routes configured');

    // Start server
    const PORT = process.env.PORT || 8080;
    const HOST = process.env.HOST || '0.0.0.0';

    console.log(`🚀 Starting server on ${HOST}:${PORT}...`);

    const server = app.listen(PORT, HOST, () => {
        console.log(`✅ Server is running on ${HOST}:${PORT}`);
        console.log(`📅 Started at: ${new Date().toISOString()}`);
        console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    });

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
    console.error('❌ Error starting server:', error);
    console.error('❌ Error stack:', error.stack);
    process.exit(1);
}
