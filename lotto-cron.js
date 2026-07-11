// lotto-cron.js
require('dotenv').config();
const mongoose = require('mongoose');
const scrapeUaeLottoResults = require('./scraper/lottoscrape');
const LottoResult = require('./models/LottoResult');
const NotificationService = require('./utils/notificationService');

async function main() {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

    // Scrape latest lottery result
    const result = await scrapeUaeLottoResults();
    if (!result) return process.exit(1);

    // Upsert result by drawNumber
    const existing = await LottoResult.findOne({ drawNumber: result.drawNumber });
    if (existing) {
        await LottoResult.updateOne({ drawNumber: result.drawNumber }, result);
        console.log('✅ Updated existing result for draw', result.drawNumber);
    } else {
        await LottoResult.create(result);
        console.log('✅ Saved new result for draw', result.drawNumber);
    }

    // Phase 0: policy-filtered lotto push (settings, dedupe per draw, quiet
    // hours, daily budget, holdout). Previously this blasted every user with
    // a token, ignoring notification settings.
    const notifyResult = await NotificationService.sendLottoResultNotification(result);
    console.log('🔔 Lotto notification result:', JSON.stringify(notifyResult));

    process.exit(0);
}

main().catch(e => {
    console.error('[Lotto CRON] Error:', e.message);
    process.exit(1);
});
