// models/Item.js
const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema({
  title: String,
  tags:  [String],
  condition: Number,  // 完整度%
  price: Number,

  // 物品擁有者的 email（取代原本的 Firebase uid）
  email: { type: String, required: true, index: true },
  // ✅ 新增：圖片網址（可選）
  imageUrl: { type: String, default: null },

  rating:   { type: Number, default: 0 },
  category: { type: String, default: "other", index: true },
  priceBand:{ type: String, index: true },
}, { versionKey: false });

module.exports = mongoose.model("Item", ItemSchema);



