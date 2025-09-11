const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const User = require("./models/User");
const Item = require("./models/Item");
const Invite = require("./models/Invite");
const Chat = require("./models/Chat");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ 連接 MongoDB（Render 用環境變數）
mongoose.connect(process.env.MONGODB_URI);

// ✅ 距離
function haversineDistance(loc1, loc2) {
  const degToRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = degToRad(loc2.lat - loc1.lat);
  const dLng = degToRad(loc2.lng - loc1.lng);
  const lat1 = degToRad(loc1.lat);
  const lat2 = degToRad(loc2.lat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ✅ 評分
function evaluateDesire(user, targetItem, ownItem, userLocations, weights) {
  const targetLoc = userLocations[targetItem.userId];
  if (!targetLoc || !user.gps) return 0;
  const distance = haversineDistance(user.gps, targetLoc);
  const distanceScore = Math.exp(-distance / 10);
  const damageScore  = (targetItem.condition || 0) / 100;
  const ratingScore  = (targetItem.rating || 0) / 5;

  const priceDiff = Math.abs((targetItem.price||0) - (ownItem.price||0));
  const maxPrice  = Math.max((targetItem.price||0), (ownItem.price||0));
  const priceScore = maxPrice === 0 ? 0 : 1 - priceDiff / maxPrice;

  return (
    weights.damage   * damageScore  +
    weights.rating   * ratingScore  +
    weights.price    * priceScore   +
    weights.distance * distanceScore
  );
}

// ✅ 雙向推薦
function recommendSwaps(currentUserId, users, items, userLocations, weights) {
  const result = [];
  const userA = users.find((u) => u.userId === currentUserId);
  if (!userA) return [];

  const itemsA = items.filter((i) => i.userId === currentUserId);

  for (const userB of users) {
    if (userB.userId === currentUserId) continue;
    const itemsB = items.filter((i) => i.userId === userB.userId);

    for (const itemA of itemsA) {
      for (const itemB of itemsB) {
        const scoreA = evaluateDesire(userA, itemB, itemA, userLocations, weights);
        const scoreB = evaluateDesire(userB, itemA, itemB, userLocations, weights);
        const matchScore = (scoreA + scoreB) / 2;

        result.push({
          from: itemA,
          to: itemB,
          scoreA: +scoreA.toFixed(3),
          scoreB: +scoreB.toFixed(3),
          matchScore: +matchScore.toFixed(3),
        });
      }
    }
  }
  return result.sort((a, b) => b.matchScore - a.matchScore);
}

// ---------- 既有 API（保留你原本的） ----------
app.post("/registerUser", async (req, res) => {
  const { userId, gps } = req.body;
  if (!userId || !gps) return res.status(400).json({ error: "缺少 userId 或 gps" });
  await User.updateOne({ userId }, { $set: { gps } }, { upsert: true });
  res.send("OK");
});

app.post("/upload", async (req, res) => {
  const { title, tags, percent, price, userId } = req.body;
  if (!userId || !title) return res.status(400).json({ error: "缺少 userId 或 title" });

  const item = new Item({
    title,
    tags: String(tags||"").split("#").filter((t) => t.trim() !== ""),
    condition: percent,
    price,
    userId,
    rating: 0,
  });
  await item.save();
  res.send("OK");
});

app.get("/recommend", async (req, res) => {
  try {
    const { userId } = req.query;
    const raw = {
      price:    Number(req.query.w_price)    ?? 25,
      distance: Number(req.query.w_distance) ?? 25,
      rating:   Number(req.query.w_rating)   ?? 25,
      damage:   Number(req.query.w_damage)   ?? 25,
    };
    const sum = Object.values(raw).reduce((a,b)=>a+b,0) || 1;
    const weights = {
      price:    raw.price    / sum,
      distance: raw.distance / sum,
      rating:   raw.rating   / sum,
      damage:   raw.damage   / sum,
    };

    const users = await User.find();
    const items = await Item.find();
    const userLocations = {};
    users.forEach(u => { userLocations[u.userId] = u.gps; });

    const swaps = recommendSwaps(userId, users, items, userLocations, weights);
    res.json(swaps);
  } catch (e) {
    console.error("雙向推薦失敗:", e);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// ---------- 新增：交易邀請 & 聊天室 ----------

// 送出邀請
app.post("/invite", async (req, res) => {
  const { fromUserId, toUserId, fromItemId, toItemId } = req.body;
  if (!fromUserId || !toUserId || !fromItemId || !toItemId) {
    return res.status(400).json({ error: "參數不足" });
  }
  // 避免同組合重複 pending
  const exists = await Invite.findOne({ fromUserId, toUserId, fromItemId, toItemId, status: "pending" });
  if (exists) return res.json({ ok: true, inviteId: exists._id });

  const inv = await Invite.create({ fromUserId, toUserId, fromItemId, toItemId });
  res.json({ ok: true, inviteId: inv._id });
});

// 查詢邀請（收到/送出）
app.get("/invites", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const received = await Invite.find({ toUserId: userId }).sort({ createdAt: -1 });
  const sent     = await Invite.find({ fromUserId: userId }).sort({ createdAt: -1 });
  res.json({ received, sent });
});

// 拒絕邀請
app.post("/invites/:id/reject", async (req, res) => {
  const inv = await Invite.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: "找不到邀請" });
  if (inv.status !== "pending") return res.json({ ok: true });
  inv.status = "rejected";
  await inv.save();
  res.json({ ok: true });
});

// 同意邀請 → 建立聊天室
app.post("/invites/:id/accept", async (req, res) => {
  const inv = await Invite.findById(req.params.id);
  if (!inv) return res.status(404).json({ error: "找不到邀請" });
  if (inv.status === "accepted") {
    const chat = await Chat.findOne({ members: { $all: [inv.fromUserId, inv.toUserId] }, "pair.fromItemId": inv.fromItemId, "pair.toItemId": inv.toItemId });
    return res.json({ ok: true, chatId: chat?._id });
  }

  inv.status = "accepted";
  await inv.save();

  // 建立（或取得）聊天室
  const members = [inv.fromUserId, inv.toUserId].sort();
  let chat = await Chat.findOne({ members: { $all: members }, "pair.fromItemId": inv.fromItemId, "pair.toItemId": inv.toItemId });
  if (!chat) {
    chat = await Chat.create({
      members,
      pair: { fromItemId: inv.fromItemId, toItemId: inv.toItemId },
      messages: []
    });
  }
  res.json({ ok: true, chatId: chat._id });
});

// 取得使用者的聊天室列表
app.get("/chats", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const chats = await Chat.find({ members: userId }).sort({ "messages.createdAt": -1, createdAt: -1 });
  res.json(chats.map(c => ({
    _id: c._id,
    members: c.members,
    pair: c.pair,
    lastMessage: c.messages.length ? c.messages[c.messages.length - 1] : null
  })));
});

// 讀取聊天室訊息
app.get("/chats/:chatId/messages", async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  res.json(chat.messages);
});

// 送訊息
app.post("/chats/:chatId/messages", async (req, res) => {
  const { senderId, text } = req.body;
  if (!senderId || !text) return res.status(400).json({ error: "缺少 senderId 或 text" });
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  chat.messages.push({ senderId, text, createdAt: new Date() });
  await chat.save();
  res.json({ ok: true });
});

// ✅ 啟動
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});


