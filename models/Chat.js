const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
  senderId:  { type: String, required: true },
  text:      { type: String, required: true },
  createdAt: { type: Date,   default: Date.now }
}, { _id: false });

const ChatSchema = new mongoose.Schema({
  members: { type: [String], required: true, index: true }, // [userA, userB]
  pair: {
    fromItemId: String,
    toItemId:   String
  },
  createdAt: { type: Date, default: Date.now },
  messages:  { type: [MessageSchema], default: [] }
}, { versionKey: false });

module.exports = mongoose.model("Chat", ChatSchema);
