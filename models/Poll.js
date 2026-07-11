const mongoose = require('mongoose');

/**
 * One opinion poll per article, generated on demand by the LLM the first
 * time a reader opens the article (see routes/polls.js).
 */
const pollSchema = new mongoose.Schema({
    articleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Article',
        required: true,
        unique: true, // one poll per article; also guards concurrent generation
    },
    question: { type: String, required: true },
    options: [{
        _id: false,
        id: { type: String, required: true }, // 'a' | 'b' | 'c' | 'd'
        label: { type: String, required: true },
        votes: { type: Number, default: 0 },
    }],
    totalVotes: { type: Number, default: 0 },
    language: { type: String, default: 'english' },
    category: { type: String },
    // 'generated' = LLM question; 'fallback' = generic question after LLM failure
    origin: { type: String, enum: ['generated', 'fallback'], default: 'generated' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
}, { timestamps: true });

module.exports = mongoose.model('Poll', pollSchema);
