require('dotenv').config();
const mongoose = require('mongoose');
const Article = require('../models/Article');

async function setDefaultLanguage() {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('🗄️  Connected to MongoDB');

        // Find articles without language field or with null/undefined language
        const articlesWithoutLanguage = await Article.countDocuments({
            $or: [
                { language: { $exists: false } },
                { language: null },
                { language: '' }
            ]
        });

        console.log(`🔍 Found ${articlesWithoutLanguage} articles without language`);

        if (articlesWithoutLanguage > 0) {
            // Update all articles without language to 'english'
            const result = await Article.updateMany(
                {
                    $or: [
                        { language: { $exists: false } },
                        { language: null },
                        { language: '' }
                    ]
                },
                { $set: { language: 'english' } }
            );

            console.log(`✅ Updated ${result.modifiedCount} articles with default language 'english'`);
        } else {
            console.log('✅ All articles already have language field set');
        }
    } catch (error) {
        console.error('❌ Error setting default language:', error);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

setDefaultLanguage()