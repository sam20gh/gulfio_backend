const mongoose = require('mongoose');
const Source = require('../models/Source');
require('dotenv').config({ path: '../.env' });

// MongoDB connection
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('MongoDB connected successfully');
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
        process.exit(1);
    }
};

const updateSourceLanguage = async () => {
    try {
        await connectDB();

        // Find sources where language is not set or is null
        const result = await Source.updateMany(
            { $or: [{ language: { $exists: false } }, { language: null }] },
            { $set: { language: "english" } }
        );

        console.log(`Updated ${result.modifiedCount} sources with default language "english"`);

        // Also log how many sources already had language set
        const totalSources = await Source.countDocuments();
        console.log(`${totalSources - result.modifiedCount} sources already had language set`);
        console.log(`Total sources in database: ${totalSources}`);

        process.exit(0);
    } catch (error) {
        console.error('Error updating source languages:', error);
        process.exit(1);
    }
};

updateSourceLanguage();
