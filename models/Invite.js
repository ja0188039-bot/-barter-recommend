// models/Invite.js
const mongoose = require("mongoose");

const InviteSchema = new mongoose.Schema(
  {
    fromEmail: { type: String, required: true },  // 發出方（email）
    toEmail:   { type: String, required: true },  // 接收方（email）
    fromItemId: { type: String, required: true }, // A 的物品 _id（字串）
    toItemId:   { type: String, required: true }, // B 的物品 _id（字串）
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Invite", InviteSchema);



