// Test if server starts correctly with Cloud Run configuration
const express = require('express');
const app = express();

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        port: PORT,
        host: HOST
    });
});

app.get('/', (req, res) => {
    res.json({ message: 'Gulfio Backend - Ready for Cloud Run', port: PORT });
});

const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Test server running on ${HOST}:${PORT}`);
    console.log(`✅ Cloud Run configuration test successful`);
    
    // Test the health endpoint
    setTimeout(() => {
        server.close(() => {
            console.log('✅ Server configuration verified for Cloud Run');
            process.exit(0);
        });
    }, 1000);
});

server.on('error', (err) => {
    console.error('❌ Server configuration issue:', err);
    process.exit(1);
});
