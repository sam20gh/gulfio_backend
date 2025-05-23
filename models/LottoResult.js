// models/LottoResult.js
const mongoose = require('mongoose');

const PrizeTierSchema = new mongoose.Schema({
    tier: String,
    match: String,
    prize: String,
    winners: String
}, { _id: false });

const RaffleWinnerSchema = new mongoose.Schema({
    chanceId: String,
    amount: String
}, { _id: false });

const LottoResultSchema = new mongoose.Schema({
    drawNumber: { type: String, required: true, unique: true },
    drawDateTime: String,
    numbers: [String],
    specialNumber: String,
    prizeTiers: [PrizeTierSchema],
    raffles: [RaffleWinnerSchema],
    totalWinners: String,
    scrapedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('LottoResult', LottoResultSchema);
