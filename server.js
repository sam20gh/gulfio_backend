const app = require('./app'); // <-- use the real app.js instance
const scrapeAllSources = require('./scraper/scrape');
const cron = require('node-cron');

// Start the server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`🚀 Server is running on ${HOST}:${PORT}`);
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
