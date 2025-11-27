const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  senderEmail: { type: String, required: true },
  text:        { type: String, required: true },
  createdAt:   { type: Date,   default: Date.now },
}, { _id: false });

const ChatSchema = new mongoose.Schema({
  // 兩個成員的 email
  members: { type: [String], required: true, index: true }, // [userAEmail, userBEmail]

  pair: {
    fromItemId: String,
    toItemId:   String,
  },

  createdAt: { type: Date, default: Date.now },
  messages:  { type: [MessageSchema], default: [] },

  // 雙方確認完成 → 關閉聊天室
  doneConfirmations: { type: [String], default: [] }, // 已確認完成的成員 email
  closed:            { type: Boolean,  default: false },
  closedAt:          { type: Date },
}, { versionKey: false });

module.exports = mongoose.model("Chat", ChatSchema);


