// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId:      { type: String, required: true, unique: true, index: true }, // 唯一鍵
  email:       { type: String, default: null },
  displayName: { type: String, default: null },
  gps:         { lat: Number, lng: Number },
  updatedAt:   { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('User', userSchema);
