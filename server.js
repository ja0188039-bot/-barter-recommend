const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const User = require("./models/User");
const Item = require("./models/Item");
const Invite = require("./models/Invite");
const Chat = require("./models/Chat");
const morgan = require("morgan");        // ✅ 新增：請求日誌


const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan(':date[iso] :method :url :status :res[content-length] - :response-time ms'));  // ✅ 新增


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
// ✅ 評分（支援價格兩模式；沒距離時自動把距離權重視為 0 並正規化）
function evaluateDesire(user, targetItem, ownItem, userLocations, weights, opts = {}) {
  const targetLoc = userLocations[targetItem.userId];
  const hasDistance = !!(user?.gps && targetLoc);

  const distance = hasDistance ? haversineDistance(user.gps, targetLoc) : null;
  const distanceScore = hasDistance ? Math.exp(-distance / 10) : 0;

  const damageScore  = (targetItem.condition || 0) / 100;
  const ratingScore  = (targetItem.rating || 0) / 5;

  // 價格：兩種模式
  let priceScore = 0;
  if ((opts.priceMode || "diff") === "interval") {
    const PRICE_BANDS = [0, 500, 2000, 5000, 10000, Infinity];
    const idx = (p) => {
      for (let i = 0; i < PRICE_BANDS.length - 1; i++) {
        if (p >= PRICE_BANDS[i] && p < PRICE_BANDS[i + 1]) return i;
      }
      return 0;
    };
    const a = idx(ownItem.price || 0), b = idx(targetItem.price || 0);
    const maxDelta = Math.max(1, PRICE_BANDS.length - 2);
    priceScore = 1 - (Math.abs(a - b) / maxDelta);
  } else {
    const priceDiff = Math.abs((targetItem.price || 0) - (ownItem.price || 0));
    const maxPrice  = Math.max((targetItem.price || 0), (ownItem.price || 0));
    priceScore = maxPrice === 0 ? 0 : 1 - priceDiff / maxPrice;
  }

  // 沒距離資料：距離權重=0，並用有效權重總和正規化
  const w = {
    damage:   weights.damage,
    rating:   weights.rating,
    price:    weights.price,
    distance: hasDistance ? weights.distance : 0,
  };
  const sum = w.damage + w.rating + w.price + w.distance || 1;

  return (
    (w.damage   * damageScore) +
    (w.rating   * ratingScore) +
    (w.price    * priceScore)  +
    (w.distance * distanceScore)
  ) / sum;
}


// ✅ 雙向推薦
// ✅ 雙向推薦（支援依分類配對 + 將 opts 透傳進評分）
function recommendSwaps(currentUserId, users, items, userLocations, weights, opts = {}) {
  const result = [];
  const userA = users.find((u) => u.userId === currentUserId);
  if (!userA) return [];

  const itemsA = items.filter((i) => i.userId === currentUserId);

  for (const userB of users) {
    if (userB.userId === currentUserId) continue;
    const itemsB = items.filter((i) => i.userId === userB.userId);

    for (const itemA of itemsA) {
      for (const itemB of itemsB) {
        // 依分類配對（可選）
        if (opts.useCategory) {
          const catA = itemA.category ?? "other";
          const catB = itemB.category ?? "other";
          if (catA && catB && catA !== catB) continue;
        }

        const scoreA = evaluateDesire(userA, itemB, itemA, userLocations, weights, opts);
        const scoreB = evaluateDesire(userB, itemA, itemB, userLocations, weights, opts);
        const matchScore = (scoreA + scoreB) / 2;

        result.push({
          from: itemA,
          to:   itemB,
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

  const tagList = String(tags || "").split("#").map(t => t.trim()).filter(Boolean);
  const item = new Item({
    title,
    tags: tagList,
    condition: percent,
    price,
    userId,
    rating: 0,
    category:  inferCategory(title, tagList),         // 👈 自動類別
    priceBand: priceBandLabelByPrice(price || 0),     // 👈 價位區間
  });

  await item.save();
  res.send("OK");
});


app.get("/recommend", async (req, res) => {
  try {
    const { userId } = req.query;

    // 權重（修正 NaN 問題）
    const raw = {
      price:    numOr(req.query.w_price,    25),
      distance: numOr(req.query.w_distance, 25),
      rating:   numOr(req.query.w_rating,   25),
      damage:   numOr(req.query.w_damage,   25),
    };
    const sum = Object.values(raw).reduce((a,b)=>a+b,0) || 1;
    const weights = {
      price:    raw.price    / sum,
      distance: raw.distance / sum,
      rating:   raw.rating   / sum,
      damage:   raw.damage   / sum,
    };

    // 新增：價格模式 + 是否依分類配對
    const opts = {
      priceMode: (req.query.priceMode === "interval") ? "interval" : "diff",
      useCategory: req.query.useCategory === "1" || req.query.useCategory === "true",
    };

    const users = await User.find();
    const items = await Item.find();
    const userLocations = {};
    users.forEach(u => { userLocations[u.userId] = u.gps; });

    const swaps = recommendSwaps(userId, users, items, userLocations, weights, opts);
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

  const chats = await Chat.find({ members: userId })
    .sort({ "messages.createdAt": -1, createdAt: -1 });

  res.json(chats.map(c => ({
    _id: c._id,
    members: c.members,
    pair: c.pair,
    closed: c.closed,                                         // ✅ 新增欄位
    lastMessage: c.messages.length ? c.messages[c.messages.length - 1] : null
  })));
});


// 讀取聊天室訊息
app.get("/chats/:chatId/messages", async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  res.json({
    closed: chat.closed,                                      // ✅ 新增欄位
    doneConfirmations: chat.doneConfirmations || [],          // ✅ 新增欄位
    messages: chat.messages
  });
});


// 送訊息
app.post("/chats/:chatId/messages", async (req, res) => {
  const { senderId, text } = req.body;
  if (!senderId || !text) return res.status(400).json({ error: "缺少 senderId 或 text" });

  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  if (chat.closed) return res.status(403).json({ error: "聊天室已關閉" });   // ✅ 多這行

  chat.messages.push({ senderId, text, createdAt: new Date() });
  await chat.save();
  res.json({ ok: true });
});

app.post("/chats/:chatId/done", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "缺少 userId" });

  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  if (!chat.members.includes(userId)) return res.status(403).json({ error: "非聊天室成員" });

  if (!chat.doneConfirmations.includes(userId)) {
    chat.doneConfirmations.push(userId);
  }

  const bothConfirmed = chat.members.every(m => chat.doneConfirmations.includes(m));
  if (bothConfirmed) {
    chat.closed = true;
    chat.closedAt = new Date();
  }

  await chat.save();
  res.json({ ok: true, closed: chat.closed, doneConfirmations: chat.doneConfirmations });
});

// ===== 分類與價位區間 =====
const PRICE_BANDS = [0, 500, 2000, 5000, 10000, Infinity]; // 你可自由調整門檻
function priceBandIndex(price = 0) {
  for (let i = 0; i < PRICE_BANDS.length - 1; i++) {
    if (price >= PRICE_BANDS[i] && price < PRICE_BANDS[i + 1]) return i;
  }
  return 0;
}
function priceBandLabelByPrice(price = 0) {
  const i = priceBandIndex(price);
  const lo = PRICE_BANDS[i];
  const hi = PRICE_BANDS[i + 1];
  return hi === Infinity ? `${lo}+` : `${lo}-${hi - 1}`;
}

// 超簡易文字分類器（可依你品類再擴充）
const CATEGORY_KEYWORDS = {
  electronics: ["3c", "手機", "筆電", "電腦", "相機", "耳機", "充電", "螢幕", "主機"],
  appliance:   ["家電", "電鍋", "冰箱", "冷氣", "洗衣", "微波", "吸塵"],
  fashion:     ["衣", "褲", "鞋", "外套", "帽", "包"],
  book:        ["書", "小說", "漫畫", "教材"],
  sports:      ["運動", "健身", "球", "瑜伽", "單車", "登山"],
  furniture:   ["桌", "椅", "櫃", "床", "沙發"],
  toy:         ["玩具", "模型", "公仔", "積木"],
  kitchen:     ["鍋", "碗", "杯", "餐具", "刀", "廚"],
  beauty:      ["化妝", "保養", "香水"],
};
function inferCategory(title = "", tags = []) {
  const text = (title + " " + (tags || []).join(" ")).toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => text.includes(k))) return cat;
  }
  return "other";
}

// 解析數字參數（容錯：NaN 時用預設）
const numOr = (v, def) => {
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};



// ✅ 啟動
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});


