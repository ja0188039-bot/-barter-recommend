// models/Item.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema({
  title: String,
  tags:  [String],
  condition: Number,  // 完整度%
  price: Number,
  userId: { type: String, required: true, index: true }, // 確保每筆物品一定掛到帳號
  rating: { type: Number, default: 0 },

  category:  { type: String, default: "other", index: true },
  priceBand: { type: String, index: true }
}, { versionKey: false });

module.exports = mongoose.model("Item", ItemSchema);


