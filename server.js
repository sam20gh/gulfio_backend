const app = require('./app');
const scrapeAllSources = require('./scraper/scrape');
const cron = require('node-cron');



app.listen(5002, () => {
    console.log('Server running on http://localhost:5002');
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
