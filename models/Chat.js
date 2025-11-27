// models/Chat.js
const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    senderEmail: { type: String, required: true },
    text:        { type: String, required: true },
    createdAt:   { type: Date, default: Date.now },
  },
  { _id: false }
);

const ChatSchema = new mongoose.Schema(
  {
    members: { type: [String], required: true, index: true }, // [userAEmail, userBEmail]
    pair: {
      fromItemId: String,
      toItemId:   String,
    },
    createdAt: { type: Date, default: Date.now },
    messages:  { type: [MessageSchema], default: [] },

    doneConfirmations: { type: [String], default: [] }, // 已按下完成的 email
    closed:            { type: Boolean, default: false },
    closedAt:          { type: Date },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Chat", ChatSchema);



