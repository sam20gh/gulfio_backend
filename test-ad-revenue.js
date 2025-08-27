// Test script to simulate AdMob revenue events for testing the system

const mongoose = require('mongoose');
require('dotenv').config();

const AdRevenueEvent = require('./models/AdRevenueEvent');
const Source = require('./models/Source');
const Article = require('./models/Article');

async function simulateAdRevenue() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Get some sample articles and sources
        const articles = await Article.find({}).limit(10);
        const sources = await Source.find({}).limit(5);

        if (articles.length === 0 || sources.length === 0) {
            console.log('❌ No articles or sources found. Please add some data first.');
            process.exit(1);
        }

        console.log(`📊 Found ${articles.length} articles and ${sources.length} sources`);

        // Simulate ad revenue events
        const events = [];
        const platforms = ['android', 'ios'];
        const adUnits = ['TEST', 'ca-app-pub-6546605536002166/9412569479'];
        
        for (let i = 0; i < 50; i++) {
            const article = articles[Math.floor(Math.random() * articles.length)];
            const source = sources[Math.floor(Math.random() * sources.length)];
            const platform = platforms[Math.floor(Math.random() * platforms.length)];
            const adUnit = adUnits[Math.floor(Math.random() * adUnits.length)];
            
            // Generate realistic revenue values (in micro-units)
            // Typical mobile ad revenue ranges from $0.001 to $0.05 per impression
            const baseRevenue = Math.random() * 50000; // $0.00001 to $0.05 in micro-units
            const value = Math.floor(baseRevenue);
            
            const event = {
                adUnitId: adUnit,
                articleId: article._id,
                sourceId: source._id,
                sourceName: source.name,
                value: value,
                currency: 'USD',
                precision: Math.floor(Math.random() * 4), // 0-3 precision levels
                platform: platform,
                ts: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000) // Random time in last 7 days
            };
            
            events.push(event);
        }

        // Insert all events
        const insertResult = await AdRevenueEvent.insertMany(events);
        console.log(`✅ Created ${insertResult.length} simulated ad revenue events`);

        // Test the API endpoint by making a summary request
        const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';
        
        try {
            const fetch = require('node-fetch');
            const response = await fetch(`${API_BASE_URL}/api/ads/summary/sources`);
            
            if (response.ok) {
                const summary = await response.json();
                console.log('\n📊 Revenue Summary:');
                console.log(`Total Revenue: $${summary.totals.totalRevenueUSD}`);
                console.log(`Total Impressions: ${summary.totals.totalImpressions}`);
                console.log(`Total Payout: $${summary.totals.totalPayoutUSD}`);
                
                console.log('\n🏢 By Source:');
                summary.summary.forEach(source => {
                    console.log(`  ${source.sourceName}: $${source.totalRevenueUSD} (${source.impressions} impressions, $${source.payout} payout)`);
                });
            }
        } catch (fetchError) {
            console.log('⚠️ Could not test API endpoint (server may not be running):', fetchError.message);
        }

        process.exit(0);

    } catch (error) {
        console.error('❌ Error simulating ad revenue:', error);
        process.exit(1);
    }
}

simulateAdRevenue();
