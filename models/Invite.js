const mongoose = require("mongoose");

const InviteSchema = new mongoose.Schema({
  fromUserId: { type: String, required: true },  // 發出方（Firebase uid）
  toUserId:   { type: String, required: true },  // 接收方（Firebase uid）
  fromItemId: { type: String, required: true },  // A 的物品 _id（字串）
  toItemId:   { type: String, required: true },  // B 的物品 _id（字串）
  status:     { type: String, enum: ["pending", "accepted", "rejected"], default: "pending", index: true },
  createdAt:  { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model("Invite", InviteSchema);
