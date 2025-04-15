const express = require('express');
const cors = require('cors');
const authMiddleware = require('./middleware/auth');
const app = express();
const scrapeAllSources = require('./scraper/scrape');
const cron = require('node-cron');

// Enable CORS for all origins (for development only)
app.use(cors());

// Alternatively, restrict CORS to specific origins
// app.use(cors({
//     origin: ['http://localhost:19006', 'http://10.0.6.159:8081'], // Add your app's development URLs
//     methods: ['GET', 'POST', 'PUT', 'DELETE'],
//     allowedHeaders: ['Content-Type', 'x-api-key']
// }));

app.use(express.json());

// Example route with authentication middleware
app.use('/api', authMiddleware, (req, res) => {
    res.json({ message: 'API is working!' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
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
