// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true
  },
  gps: {
    lat: Number,
    lng: Number
  }
});

module.exports = mongoose.model('User', userSchema);