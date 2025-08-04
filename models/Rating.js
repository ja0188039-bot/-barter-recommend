const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  userId: String,       // 被評價的對象
  fromUserId: String,   // 評價來源（可選）
  score: Number,
  comment: String,
});

module.exports = mongoose.model('Rating', ratingSchema);