// lotto-cron.js
require('dotenv').config();
const mongoose = require('mongoose');
const scrapeUaeLottoResults = require('./lottoscrape');
const LottoResult = require('./models/LottoResult');
const User = require('./models/User');
const sendExpoNotification = require('./utils/sendExpoNotification');

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

    // Fetch all users with Expo push tokens
    const users = await User.find({ pushToken: { $exists: true, $ne: null } });
    const tokens = users.map(u => u.pushToken);

    // Compose push notification
    const title = `UAE Lotto Draw #${result.drawNumber} Results`;
    const body = `Numbers: ${result.numbers.join(', ')} | Special: ${result.specialNumber} | Jackpot: ${result.prizeTiers[0]?.prize || ''}`;
    const data = {
        drawNumber: result.drawNumber,
        link: `gulfio://lotto/${result.drawNumber}`,
        numbers: result.numbers,
        specialNumber: result.specialNumber,
        prizeTiers: result.prizeTiers,
        raffles: result.raffles,
        totalWinners: result.totalWinners
    };

    if (tokens.length) {
        await sendExpoNotification(
            title,
            body,
            tokens,
            data
        );
        console.log('🔔 Expo push sent to', tokens.length, 'users');
    } else {
        console.log('No Expo push tokens found for users.');
    }

    process.exit(0);
}

main().catch(e => {
    console.error('[Lotto CRON] Error:', e.message);
    process.exit(1);
});
