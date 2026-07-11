const mongoose = require('mongoose');

/**
 * One quiz per day per language, generated on demand from the day's top
 * stories (see routes/quiz.js). Questions carry their correct answer —
 * grading is still done server-side on submit.
 */
const dailyQuizSchema = new mongoose.Schema({
    date: { type: String, required: true },      // 'YYYY-MM-DD' (Gulf day)
    language: { type: String, required: true, default: 'english' },
    questions: [{
        _id: false,
        id: { type: String, required: true },     // 'q1'..'q5'
        question: { type: String, required: true },
        options: [{
            _id: false,
            id: { type: String, required: true },  // 'a'..'d'
            label: { type: String, required: true },
        }],
        correctOptionId: { type: String, required: true },
        articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
    }],
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
}, { timestamps: true });

// One quiz per day+language; also guards concurrent generation
dailyQuizSchema.index({ date: 1, language: 1 }, { unique: true });

module.exports = mongoose.model('DailyQuiz', dailyQuizSchema);
