// --- Imports ---
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");

const User = require("./models/User");
const Item = require("./models/Item");
const Invite = require("./models/Invite");
const Chat = require("./models/Chat");

// --- App & middleware ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan(':date[iso] :method :url :status :res[content-length] - :response-time ms'));

// --- DB connect ---
mongoose.connect(process.env.MONGODB_URI);

// --- Health & debug ---
app.get("/healthz", (req, res) => res.send("ok"));
app.get("/debug/counts", async (req, res) => {
  const u = await User.countDocuments();
  const i = await Item.countDocuments();
  const inv = await Invite.countDocuments();
  const c = await Chat.countDocuments();
  const ids = await Item.distinct("userId");
  res.json({ users: u, items: i, invites: inv, chats: c, distinctItemUsers: ids.length });
});
app.get("/debug/sample", async (req, res) => {
  const users = await User.find().select("userId gps -_id").limit(5);
  const items = await Item.find().select("userId title price condition category priceBand -_id").limit(10);
  res.json({ users, items });
});

// ===== Helpers =====

// 安全數值解析（避免 NaN）
const numOr = (v, def) => {
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// Haversine 距離（公里）
function haversineDistance(loc1, loc2) {
  const degToRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = degToRad((loc2.lat || 0) - (loc1.lat || 0));
  const dLng = degToRad((loc2.lng || 0) - (loc1.lng || 0));
  const lat1 = degToRad(loc1.lat || 0);
  const lat2 = degToRad(loc2.lat || 0);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 價位區間切點（可自行調整）
const PRICE_BANDS = [0, 500, 2000, 5000, 10000, Infinity];
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

// 超簡易文字分類器（依需求擴充）
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

// ===== Scoring =====

// 評分（支援：diff / interval / tolerance；無距離→距離權重=0並重新正規化）
function evaluateDesire(user, targetItem, ownItem, userLocations, weights, opts = {}) {
  const targetLoc = userLocations[targetItem.userId];
  const hasDistance = !!(user?.gps && targetLoc);

  const distance = hasDistance ? haversineDistance(user.gps, targetLoc) : null;
  const distanceScore = hasDistance ? Math.exp(-distance / 10) : 0;

  const damageScore  = (targetItem.condition || 0) / 100;
  const ratingScore  = (targetItem.rating || 0) / 5;

  // 價格分數（模式三選一）
  let priceScore = 0;
  const mode = (opts.priceMode || "diff");

  if (mode === "interval") {
    const a = priceBandIndex(ownItem.price || 0);
    const b = priceBandIndex(targetItem.price || 0);
    const maxDelta = Math.max(1, PRICE_BANDS.length - 2);
    priceScore = 1 - (Math.abs(a - b) / maxDelta);
  } else if (mode === "tolerance") {
    const tol = Math.max(0, Number(opts.priceTol) || 0);
    const diff = Math.abs((targetItem.price || 0) - (ownItem.price || 0));
    priceScore = tol > 0 ? Math.max(0, 1 - diff / tol) : (diff === 0 ? 1 : 0);
  } else {
    // diff
    const priceDiff = Math.abs((targetItem.price || 0) - (ownItem.price || 0));
    const maxPrice  = Math.max((targetItem.price || 0), (ownItem.price || 0));
    priceScore = maxPrice === 0 ? 0 : 1 - priceDiff / maxPrice;
  }

  // 沒距離：把距離權重設 0，並按有效權重重新正規化
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

// 雙向推薦（支援依分類配對、價格容忍過濾）
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
          const catA = itemA.category ?? inferCategory(itemA.title, itemA.tags);
          const catB = itemB.category ?? inferCategory(itemB.title, itemB.tags);
          if (catA && catB && catA !== catB) continue;
        }
        // 自訂價格容忍（可選）：超出 ±tol 直接略過
        // 自訂價格容忍（可選）：超出 ±tol 直接略過
        if (opts.priceMode === "tolerance") {
          const tol = Math.max(0, Number(opts.priceTol) || 0);
          const diff = Math.abs((itemA.price || 0) - (itemB.price || 0));
          if (diff > tol) continue;   // 👈 超過容忍 → 不回傳
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

// ===== Routes =====

// 註冊/更新使用者（GPS）
app.post("/registerUser", async (req, res) => {
  const { userId, gps, email, displayName } = req.body;
  if (!userId || !gps) return res.status(400).json({ error: "缺少 userId 或 gps" });

  const $set = { gps, updatedAt: new Date() };
  if (email !== undefined) $set.email = email;
  if (displayName !== undefined) $set.displayName = displayName;

  await User.updateOne({ userId }, { $set }, { upsert: true });
  res.send("OK");
});


// 上傳物品（自動分類 + 價位區間）
app.post("/upload", async (req, res) => {
  try {
    const { title, category, percent, price, userId, tags } = req.body;
    if (!userId) return res.status(400).json({ error: "缺少 userId" });
    if (!title)  return res.status(400).json({ error: "缺少 title" });

    // ✅ 先確認該 userId 是否存在於 Users
    const user = await User.findOne({ userId });
    if (!user) {
      return res.status(400).json({ error: "未知的 userId，請先登入/註冊（/registerUser）" });
    }

    // 建立 Item（欄位名稱對應前端）
    const it = await Item.create({
      title,
      tags: Array.isArray(tags) ? tags : [],
      condition: Number.isFinite(percent) ? Number(percent) : 0,
      price: Number.isFinite(price) ? Number(price) : 0,
      userId,                        // ✅ 與 Users.userId 一致
      category: category || "other",
      priceBand: (() => {
        const p = Number(price) || 0;
        if (p < 500) return "0-499";
        if (p < 2000) return "500-1999";
        if (p < 5000) return "2000-4999";
        return "5000+";
      })()
    });

    res.json({ ok: true, itemId: it._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});
// 物品查詢：依關鍵字搜尋 title / tags
app.get("/items/search", async (req, res) => {
  try {
    const { q = "", userId } = req.query;
    const keyword = String(q || "").trim();

    if (!keyword) {
      return res.json([]); // 空字串就回空陣列
    }

    const regex = new RegExp(keyword, "i");
    const cond = {
      $or: [
        { title: regex },
        { tags: regex },
      ],
    };

    // 如果有帶 userId，就不要把自己的物品也搜出來
    if (userId) {
      cond.userId = { $ne: userId };
    }

    const items = await Item.find(cond).limit(50);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});


// 推薦（支援 diff / interval / tolerance + 依分類）
app.get("/recommend", async (req, res) => {
  try {
    const { userId } = req.query;

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

    // ✅ 只用容忍模式；沒帶就當 0（表示只允許同價）
    const tol = numOr(req.query.priceTol, 0);
    const opts = {
      priceMode: "tolerance",
      priceTol: Math.max(0, tol),
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


// ===== Invites & Chats =====

// 送出邀請
app.post("/invite", async (req, res) => {
  const { fromUserId, toUserId, fromItemId, toItemId } = req.body;
  if (!fromUserId || !toUserId || !fromItemId || !toItemId) {
    return res.status(400).json({ error: "參數不足" });
  }
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
    const chat = await Chat.findOne({
      members: { $all: [inv.fromUserId, inv.toUserId] },
      "pair.fromItemId": inv.fromItemId,
      "pair.toItemId": inv.toItemId
    });
    return res.json({ ok: true, chatId: chat?._id });
  }

  inv.status = "accepted";
  await inv.save();

  const members = [inv.fromUserId, inv.toUserId].sort();
  let chat = await Chat.findOne({
    members: { $all: members },
    "pair.fromItemId": inv.fromItemId,
    "pair.toItemId": inv.toItemId
  });
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
    closed: c.closed,
    lastMessage: c.messages.length ? c.messages[c.messages.length - 1] : null
  })));
});

// 讀取聊天室訊息（含 meta）
app.get("/chats/:chatId/messages", async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  res.json({
    closed: chat.closed,
    doneConfirmations: chat.doneConfirmations || [],
    messages: chat.messages
  });
});

// 送訊息（已關閉禁止）
app.post("/chats/:chatId/messages", async (req, res) => {
  const { senderId, text } = req.body;
  if (!senderId || !text) return res.status(400).json({ error: "缺少 senderId 或 text" });

  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  if (chat.closed) return res.status(403).json({ error: "聊天室已關閉" });

  chat.messages.push({ senderId, text, createdAt: new Date() });
  await chat.save();
  res.json({ ok: true });
});

// 交易完成確認（雙方都按 → 關閉聊天室）
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

// （可選）回填舊資料缺的 category / priceBand
app.post("/debug/backfill-item-fields", async (req, res) => {
  const items = await Item.find();
  let updated = 0;
  for (const it of items) {
    const tags = it.tags || [];
    const need = !it.category || !it.priceBand;
    if (need) {
      it.category  = it.category  || inferCategory(it.title, tags);
      it.priceBand = it.priceBand || priceBandLabelByPrice(it.price || 0);
      await it.save();
      updated++;
    }
  }
  res.json({ ok: true, updated });
});

// --- Start ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});


