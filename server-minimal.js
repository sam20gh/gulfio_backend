// Minimal server for Cloud Run testing
const express = require('express');
const cors = require('cors');

const app = express();

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
        message: 'MENA News API - Minimal Version',
        version: '1.0.0',
        port: process.env.PORT || 8080,
        timestamp: new Date().toISOString()
    });
});

// Test endpoint
app.get('/test', (req, res) => {
    res.json({
        message: 'Test endpoint working',
        environment: process.env.NODE_ENV || 'development',
        port: process.env.PORT || 8080
    });
});

// Start server
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

console.log(`🚀 Starting minimal server on ${HOST}:${PORT}...`);
console.log(`📅 Started at: ${new Date().toISOString()}`);
console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);

const server = app.listen(PORT, HOST, () => {
    console.log(`✅ Minimal server is running on ${HOST}:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
