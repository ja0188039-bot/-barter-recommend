const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  title: String,
  tags: String,
  percent: Number,
  price: Number,
  userId: String,
});

module.exports = mongoose.model('Item', itemSchema);