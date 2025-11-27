/**
 * Migration Script: Add city and language fields to existing users
 * 
 * This script updates all existing users to have:
 * - city: 'Dubai' (default)
 * - language: 'English' (default)
 * 
 * Run with: node scripts/migrate-user-city-language.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const MONGODB_URI = process.env.MONGO_URI;

async function migrateUsers() {
    try {
        console.log('🔍 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Count users without city or language fields
        const usersWithoutCity = await User.countDocuments({ city: { $exists: false } });
        const usersWithoutLanguage = await User.countDocuments({ language: { $exists: false } });

        console.log(`📊 Found ${usersWithoutCity} users without city field`);
        console.log(`📊 Found ${usersWithoutLanguage} users without language field`);

        // Update users missing city field
        const cityResult = await User.updateMany(
            { city: { $exists: false } },
            { $set: { city: 'Dubai' } }
        );
        console.log(`✅ Updated ${cityResult.modifiedCount} users with default city: Dubai`);

        // Update users missing language field
        const languageResult = await User.updateMany(
            { language: { $exists: false } },
            { $set: { language: 'English' } }
        );
        console.log(`✅ Updated ${languageResult.modifiedCount} users with default language: English`);

        // Also update users with null values
        const cityNullResult = await User.updateMany(
            { city: null },
            { $set: { city: 'Dubai' } }
        );
        console.log(`✅ Updated ${cityNullResult.modifiedCount} users with null city to: Dubai`);

        const languageNullResult = await User.updateMany(
            { language: null },
            { $set: { language: 'English' } }
        );
        console.log(`✅ Updated ${languageNullResult.modifiedCount} users with null language to: English`);

        // Verify the migration
        const totalUsers = await User.countDocuments();
        const usersWithCity = await User.countDocuments({ city: { $exists: true, $ne: null } });
        const usersWithLanguage = await User.countDocuments({ language: { $exists: true, $ne: null } });

        console.log('\n📋 Migration Summary:');
        console.log(`   Total users: ${totalUsers}`);
        console.log(`   Users with city: ${usersWithCity}`);
        console.log(`   Users with language: ${usersWithLanguage}`);

        // Show sample of updated users
        const sampleUsers = await User.find({}, 'email city language').limit(5);
        console.log('\n📝 Sample users after migration:');
        sampleUsers.forEach(user => {
            console.log(`   ${user.email}: city=${user.city}, language=${user.language}`);
        });

        console.log('\n🎉 Migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    }
}

migrateUsers();
