// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // 以 email 當成唯一識別（不再用 Firebase uid 當主 key）
  email:       { type: String, required: true, unique: true, index: true },
  firebaseUid: { type: String, default: null },   // 可選：如果你還想存 uid 就放這裡
  displayName: { type: String, default: null },
  gps:         { lat: Number, lng: Number },
  updatedAt:   { type: Date, default: Date.now },
}, { versionKey: false });

module.exports = mongoose.model('User', userSchema);

