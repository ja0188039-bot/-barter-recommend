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
app.use(
  morgan(
    ':date[iso] :method :url :status :res[content-length] - :response-time ms'
  )
);

// --- DB connect ---
mongoose.connect(process.env.MONGODB_URI);

// --- Health & debug ---
app.get("/healthz", (req, res) => res.send("ok"));

app.get("/debug/counts", async (req, res) => {
  const u = await User.countDocuments();
  const i = await Item.countDocuments();
  const inv = await Invite.countDocuments();
  const c = await Chat.countDocuments();
  const ids = await Item.distinct("email");
  res.json({
    users: u,
    items: i,
    invites: inv,
    chats: c,
    distinctItemUsers: ids.length,
  });
});

app.get("/debug/sample", async (req, res) => {
  const users = await User.find().select("email gps -_id").limit(5);
  const items = await Item.find()
    .select("email title price condition category priceBand -_id")
    .limit(10);
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

// 由 title / tags 粗略推分類
function inferCategory(title, tags = []) {
  const t = `${title || ""} ${tags.join(" ")}`.toLowerCase();
  if (t.match(/衣|服|shirt|pants|coat|jacket/)) return "clothes";
  if (t.match(/書|book/)) return "book";
  if (t.match(/電腦|notebook|laptop|pc/)) return "computer";
  if (t.match(/手機|phone/)) return "phone";
  if (t.match(/家具|桌|椅|櫃|sofa|furniture/)) return "furniture";
  return "other";
}

// 依價格分價位帶
function priceBandLabelByPrice(p) {
  const price = Number(p) || 0;
  if (price < 500) return "0-499";
  if (price < 2000) return "500-1999";
  if (price < 5000) return "2000-4999";
  return "5000+";
}

// 評估「user 對 targetItem 的喜好分數」
function evaluateDesire(user, targetItem, ownItem, userLocations, weights, opts = {}) {
  // 損壞程度（完整度越高越好）
  const damageScore = (Number(targetItem.condition) || 0) / 100;

  // 目前尚未做評價 → ratingScore 先給 0.5 當中間值
  const ratingScore = 0.5;

  // 價格分數：依模式調整
  let priceScore = 0;
  const priceA = Number(targetItem.price) || 0;
  const priceB = Number(ownItem?.price) || 0;

  if (opts.priceMode === "tolerance") {
    const tol = Math.max(0, Number(opts.priceTol) || 0);
    const diff = Math.abs(priceA - priceB);
    priceScore = tol > 0 ? Math.max(0, 1 - diff / tol) : diff === 0 ? 1 : 0;
  } else {
    // diff 模式：越接近越高
    const diff = Math.abs(priceA - priceB);
    const maxP = Math.max(priceA, priceB);
    priceScore = maxP === 0 ? 0 : 1 - diff / maxP;
  }

  // 距離分數
  let distanceScore = 0;
  const userLoc = userLocations[user.email];
  const targetLoc = userLocations[targetItem.email];
  const hasDistance =
    userLoc && targetLoc && userLoc.lat != null && targetLoc.lat != null;

  if (hasDistance) {
    const km = haversineDistance(userLoc, targetLoc);
    // 0km → 1, 50km 以上 → 趨近 0
    const maxKm = 50;
    distanceScore = Math.max(0, 1 - km / maxKm);
  }

  // 沒距離：把距離權重設 0，並按有效權重重新正規化
  const w = {
    damage: weights.damage,
    rating: weights.rating,
    price: weights.price,
    distance: hasDistance ? weights.distance : 0,
  };
  const sum = w.damage + w.rating + w.price + w.distance || 1;

  return (
    (w.damage * damageScore +
      w.rating * ratingScore +
      w.price * priceScore +
      w.distance * distanceScore) / sum
  );
}

// 雙向配對：A 想要 B 的 + B 想要 A 的 → matchScore
function recommendSwaps(
  currentEmail,
  users,
  items,
  userLocations,
  weights,
  opts = {}
) {
  const result = [];

  const userA = users.find((u) => u.email === currentEmail);
  if (!userA) return [];

  const itemsA = items.filter((i) => i.email === currentEmail);
  if (itemsA.length === 0) return [];

  for (const userB of users) {
    if (userB.email === currentEmail) continue;
    const itemsB = items.filter((i) => i.email === userB.email);
    if (itemsB.length === 0) continue;

    for (const itemA of itemsA) {
      for (const itemB of itemsB) {
        // 類別限制（如果有開啟）
        if (opts.useCategory) {
          const catA = itemA.category ?? inferCategory(itemA.title, itemA.tags);
          const catB = itemB.category ?? inferCategory(itemB.title, itemB.tags);
          if (catA && catB && catA !== catB) continue;
        }

        // 價格容忍模式：超出 ±tol 直接略過
        if (opts.priceMode === "tolerance") {
          const tol = Math.max(0, Number(opts.priceTol) || 0);
          const diff = Math.abs((itemA.price || 0) - (itemB.price || 0));
          if (diff > tol) continue;
        }

        const scoreA = evaluateDesire(
          userA,
          itemB,
          itemA,
          userLocations,
          weights,
          opts
        );
        const scoreB = evaluateDesire(
          userB,
          itemA,
          itemB,
          userLocations,
          weights,
          opts
        );
        const matchScore = (scoreA + scoreB) / 2;

        result.push({
          fromUser: userA.email,
          toUser: userB.email,
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

// ===== Routes =====

// 註冊/更新使用者（GPS）
app.post("/registerUser", async (req, res) => {
  const { email, gps, displayName } = req.body;
  if (!email || !gps)
    return res.status(400).json({ error: "缺少 email 或 gps" });

  const $set = { gps, updatedAt: new Date() };
  $setset.email = email;
  if (displayName !== undefined) $set.displayName = displayName;

  await User.updateOne({ email }, { $set }, { upsert: true });
  res.send("OK");
});

// 上傳物品（自動分類 + 價位區間）
app.post("/upload", async (req, res) => {
  try {
    const { title, category, percent, price, email, tags } = req.body;
    if (!email) return res.status(400).json({ error: "缺少 email" });
    if (!title) return res.status(400).json({ error: "缺少 title" });

    // 先確認該 email 是否存在於 Users
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "未知的 email，請先登入/註冊（/registerUser）" });
    }

    const it = await Item.create({
      title,
      tags: Array.isArray(tags) ? tags : [],
      condition: Number.isFinite(percent) ? Number(percent) : 0,
      price: Number.isFinite(price) ? Number(price) : 0,
      email,                       // ✅ 改成 email
      category: category || "other",
      priceBand: (() => {
        const p = Number(price) || 0;
        if (p < 500) return "0-499";
        if (p < 2000) return "500-1999";
        if (p < 5000) return "2000-4999";
        return "5000+";
      })(),
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
    const { q = "", email } = req.query;
    const keyword = String(q || "").trim();

    if (!keyword) {
      return res.json([]); // 空字串就回空陣列
    }

    const regex = new RegExp(keyword, "i");
    const cond = {
      $or: [{ title: regex }, { tags: regex }],
    };

    // 有帶 email 就不要把自己的物品也搜出來
    if (email) {
      cond.email = { $ne: email };
    }

    const items = await Item.find(cond).limit(50);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});

// 推薦（支援 price 容忍 + 依分類）
app.get("/recommend", async (req, res) => {
  try {
    const { email } = req.query;

    const raw = {
      price: numOr(req.query.w_price, 25),
      distance: numOr(req.query.w_distance, 25),
      rating: numOr(req.query.w_rating, 25),
      damage: numOr(req.query.w_damage, 25),
    };
    const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const weights = {
      price: raw.price / sum,
      distance: raw.distance / sum,
      rating: raw.rating / sum,
      damage: raw.damage / sum,
    };

    const tol = numOr(req.query.priceTol, 0);
    const opts = {
      priceMode: "tolerance",
      priceTol: Math.max(0, tol),
      useCategory:
        req.query.useCategory === "1" || req.query.useCategory === "true",
    };

    const users = await User.find();
    const items = await Item.find();
    const userLocations = {};
    users.forEach((u) => {
      userLocations[u.email] = u.gps;
    });

    const swaps = recommendSwaps(email, users, items, userLocations, weights, opts);
    res.json(swaps);
  } catch (e) {
    console.error("雙向推薦失敗:", e);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// ===== Invites & Chats =====

// 送出邀請
app.post("/invite", async (req, res) => {
  const { fromEmail, toEmail, fromItemId, toItemId } = req.body;
  if (!fromEmail || !toEmail || !fromItemId || !toItemId) {
    return res.status(400).json({ error: "參數不足" });
  }

  const exists = await Invite.findOne({
    fromEmail,
    toEmail,
    fromItemId,
    toItemId,
    status: "pending",
  });
  if (exists) return res.json({ ok: true, inviteId: exists._id });

  const inv = await Invite.create({ fromEmail, toEmail, fromItemId, toItemId });
  res.json({ ok: true, inviteId: inv._id });
});

// 查詢邀請（收到/送出）
app.get("/invites", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "缺少 email" });

  const received = await Invite.find({ toEmail: email }).sort({
    createdAt: -1,
  });
  const sent = await Invite.find({ fromEmail: email }).sort({ createdAt: -1 });
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
  if (inv.status !== "pending") return res.json({ ok: true });

  inv.status = "accepted";
  await inv.save();

  const members = [inv.fromEmail, inv.toEmail].sort();
  let chat = await Chat.findOne({
    members: { $all: members },
    "pair.fromItemId": inv.fromItemId,
    "pair.toItemId": inv.toItemId,
  });
  if (!chat) {
    chat = await Chat.create({
      members,
      pair: { fromItemId: inv.fromItemId, toItemId: inv.toItemId },
      messages: [],
    });
  }

  res.json({ ok: true, chatId: chat._id });
});

// 取得使用者的聊天室列表
app.get("/chats", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "缺少 email" });

  const chats = await Chat.find({ members: email }).sort({
    "messages.createdAt": -1,
    createdAt: -1,
  });

  res.json(
    chats.map((c) => ({
      _id: c._id,
      members: c.members,
      pair: c.pair,
      closed: c.closed,
      closedAt: c.closedAt,
      lastMessage:
        c.messages.length > 0
          ? c.messages[c.messages.length - 1]
          : null,
    }))
  );
});

// 取得單一聊天室訊息
app.get("/chats/:chatId/messages", async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });

  res.json({
    closed: chat.closed,
    doneConfirmations: chat.doneConfirmations || [],
    messages: chat.messages,
  });
});

// 送訊息（已關閉禁止）
app.post("/chats/:chatId/messages", async (req, res) => {
  const { senderEmail, text } = req.body;
  if (!senderEmail || !text)
    return res.status(400).json({ error: "缺少 senderEmail 或 text" });

  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  if (chat.closed)
    return res.status(403).json({ error: "聊天室已關閉" });

  chat.messages.push({ senderEmail, text, createdAt: new Date() });
  await chat.save();
  res.json({ ok: true });
});

// 交易完成確認（雙方都按 → 關閉聊天室）
app.post("/chats/:chatId/done", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "缺少 email" });

  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).json({ error: "找不到聊天室" });
  if (!chat.members.includes(email))
    return res.status(403).json({ error: "非聊天室成員" });

  if (!chat.doneConfirmations.includes(email)) {
    chat.doneConfirmations.push(email);
  }

  const bothConfirmed = chat.members.every((m) =>
    chat.doneConfirmations.includes(m)
  );
  if (bothConfirmed) {
    chat.closed = true;
    chat.closedAt = new Date();
  }

  await chat.save();
  res.json({
    ok: true,
    closed: chat.closed,
    doneConfirmations: chat.doneConfirmations,
  });
});

// 回填舊資料缺的 category / priceBand
app.post("/debug/backfill-item-fields", async (req, res) => {
  const items = await Item.find();
  let updated = 0;

  for (const it of items) {
    const tags = it.tags || [];
    const need = !it.category || !it.priceBand;
    if (need) {
      it.category = it.category || inferCategory(it.title, tags);
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


