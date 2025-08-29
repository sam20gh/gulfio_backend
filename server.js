const app = require('./app'); // <-- use the real app.js instance
const scrapeAllSources = require('./scraper/scrape');
const cron = require('node-cron');

// Start the server immediately (don't wait for MongoDB)
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

console.log(`🚀 Starting server on ${HOST}:${PORT}...`);
const server = app.listen(PORT, HOST, () => {
    console.log(`✅ Server is running on ${HOST}:${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📅 Started at: ${new Date().toISOString()}`);
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

cron.schedule('0 * * * *', () => {
    console.log('🕛 Running hourly scraper...');
    scrapeAllSources('hourly');
});

// Run daily scrapers at midnight every day
cron.schedule('0 0 * * *', () => {
    console.log('🕛 Running daily scraper...');
    scrapeAllSources('daily');
});

// Run weekly scrapers at midnight every Monday
cron.schedule('0 0 * * 1', () => {
    console.log('🕛 Running weekly scraper...');
    scrapeAllSources('weekly');
});
