const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const sources = require('./routes/sources');
const articles = require('./routes/articles');
const scrapeRoute = require('./routes/scrape');
const userRoutes = require('./routes/user');
const userActions = require('./routes/userActions');
const recommendations = require('./routes/recommendations');




require('dotenv').config();
const app = express();

app.use(cors({
    origin: '*', // Or specify your app's origin e.g. 'https://your-app-url'
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'], // ✅ crucial
}));

app.use((req, res, next) => {
    console.log('🔐 Incoming Request Headers:', req.headers);
    next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ Failed to connect to MongoDB Atlas:', err));

app.use(express.json());
app.use('/api/sources', sources);
app.use('/api/articles', articles);
app.use('/api/scrape', scrapeRoute);
app.use('/api/users', userRoutes);
app.use('/api/user', userActions);
app.use('/api/recommendations', recommendations);

module.exports = app;
