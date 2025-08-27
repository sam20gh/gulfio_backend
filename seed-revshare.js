// Script to seed rev-share data for existing sources
// This demonstrates how to set revenue sharing percentages for different sources

const mongoose = require('mongoose');
require('dotenv').config();

const Source = require('./models/Source');

async function seedRevShare() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Get all existing sources
        const sources = await Source.find({});
        console.log(`📊 Found ${sources.length} sources`);

        // Set example rev-share percentages based on source names
        const revShareUpdates = [
            { name: 'Emirates247', revSharePercent: 65 },
            { name: 'Gulf News', revSharePercent: 95 },
            { name: 'Al Arabiya', revSharePercent: 75 },
            { name: 'Khaleej Times', revSharePercent: 80 },
            { name: 'The National', revSharePercent: 85 },
        ];

        let updatedCount = 0;

        for (const update of revShareUpdates) {
            const result = await Source.updateOne(
                { name: { $regex: new RegExp(update.name, 'i') } },
                {
                    $set: {
                        revSharePercent: update.revSharePercent,
                        payoutCurrency: 'USD'
                    }
                }
            );

            if (result.modifiedCount > 0) {
                console.log(`✅ Updated ${update.name} with ${update.revSharePercent}% rev-share`);
                updatedCount++;
            }
        }

        // Set default values for remaining sources
        const defaultResult = await Source.updateMany(
            { revSharePercent: { $exists: false } },
            {
                $set: {
                    revSharePercent: 70, // Default 70%
                    payoutCurrency: 'USD'
                }
            }
        );

        console.log(`✅ Set default rev-share for ${defaultResult.modifiedCount} sources`);
        console.log(`📊 Total updated: ${updatedCount + defaultResult.modifiedCount} sources`);

        // Display final summary
        const updatedSources = await Source.find({ revSharePercent: { $exists: true } })
            .select('name revSharePercent payoutCurrency')
            .sort({ revSharePercent: -1 });

        console.log('\n📋 Rev-Share Summary:');
        updatedSources.forEach(source => {
            console.log(`  ${source.name}: ${source.revSharePercent}% (${source.payoutCurrency})`);
        });

        process.exit(0);

    } catch (error) {
        console.error('❌ Error seeding rev-share data:', error);
        process.exit(1);
    }
}

seedRevShare();
