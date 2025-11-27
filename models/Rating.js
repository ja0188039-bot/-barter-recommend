const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  // 被評價的對象
  email:     String,

  // 評價來源（可選）
  fromEmail: String,

  score:   Number,
  comment: String,
}, { versionKey: false });

module.exports = mongoose.model('Rating', ratingSchema);
