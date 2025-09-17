const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema({
  title: String,
  tags:  [String],
  condition: Number,          // 完整度%
  price: Number,
  userId: String,
  rating: { type: Number, default: 0 },

  // 👇 新增：自動分類
  category:  { type: String, default: "other", index: true },
  priceBand: { type: String, index: true } // 例如 "0-499", "500-1999", "5000+"
}, { versionKey: false });

module.exports = mongoose.model("Item", ItemSchema);
