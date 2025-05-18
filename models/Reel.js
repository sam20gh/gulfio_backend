const mongoose = require('mongoose');
const { Schema } = mongoose;
const ReelSchema = new Schema({
    source: { type: Schema.Types.ObjectId, ref: 'Source', required: true },
    reelId: { type: String, required: true },
    videoUrl: { type: String, required: true },
    scrapedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Reel', ReelSchema);