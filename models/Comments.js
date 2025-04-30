const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
    _id: ObjectId,
    articleId: ObjectId,      // Reference to the article
    userId: string,           // Supabase user ID
    username: string,         // For display
    comment: string,
    createdAt: ISODate
});

module.exports = mongoose.model('Comments', commentSchema);