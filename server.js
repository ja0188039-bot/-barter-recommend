// --- Imports ---
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");


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
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/barter";
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("MongoDB connect error", err));
// ⭐ Flask 伺服器位置
const FLASK_BASE =
  process.env.FLASK_BASE_URL || "https://fal-tripo3d.onrender.com";

// Health check
app.get("/healthz", (req, res) => res.send("ok"));

// ===== Helper functions =====
const numOr = (v, def) => {
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

function haversineDistance(loc1, loc2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad((loc2.lat || 0) - (loc1.lat || 0));
  const dLng = toRad((loc2.lng || 0) - (loc1.lng || 0));
  const lat1 = toRad(loc1.lat || 0);
  const lat2 = toRad(loc2.lat || 0);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function inferCategory(title, tags = []) {
  const t = `${title || ""} ${tags.join(" ")}`.toLowerCase();
  if (/衣|服|shirt|pants|coat|jacket/.test(t)) return "clothes";
  if (/書|book/.test(t)) return "book";
  if (/電腦|notebook|laptop|pc/.test(t)) return "computer";
  if (/手機|phone/.test(t)) return "phone";
  if (/家具|桌|椅|櫃|sofa|furniture/.test(t)) return "furniture";
  return "other";
}

function priceBandLabelByPrice(price) {
  const p = Number(price) || 0;
  if (p < 500) return "0-499";
  if (p < 2000) return "500-1999";
  if (p < 5000) return "2000-4999";
  return "5000+";
}

function evaluateDesire(
  user,
  targetItem,
  ownItem,
  userLocations,
  weights,
  opts = {}
) {
  const damageScore = (Number(targetItem.condition) || 0) / 100;
  const ratingScore = 0.5; // 暫時寫死，未來可接 Rating collection

  const priceA = Number(targetItem.price) || 0;
  const priceB = Number(ownItem?.price) || 0;
  let priceScore = 0;

  if (opts.priceMode === "tolerance") {
    const tol = Math.max(0, Number(opts.priceTol) || 0);
    const diff = Math.abs(priceA - priceB);
    priceScore = tol > 0 ? Math.max(0, 1 - diff / tol) : diff === 0 ? 1 : 0;
  } else {
    const diff = Math.abs(priceA - priceB);
    const maxP = Math.max(priceA, priceB);
    priceScore = maxP === 0 ? 0 : 1 - diff / maxP;
  }

  let distanceScore = 0;
  const userLoc = userLocations[user.email];
  const targetLoc = userLocations[targetItem.email];
  const hasDistance =
    userLoc && targetLoc && userLoc.lat != null && targetLoc.lat != null;

  if (hasDistance) {
    const km = haversineDistance(userLoc, targetLoc);
    const maxKm = 50;
    distanceScore = Math.max(0, 1 - km / maxKm);
  }

  const w = {
    damage: weights.damage,
    rating: weights.rating,
    price: weights.price,
    distance: hasDistance ? weights.distance : 0, // 沒距離就不算權重
  };
  const sum = w.damage + w.rating + w.price + w.distance || 1;

  return (
    (w.damage * damageScore +
      w.rating * ratingScore +
      w.price * priceScore +
      w.distance * distanceScore) / sum
  );
}

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
        // 類別檢查
        if (opts.useCategory) {
          const catA = itemA.category || inferCategory(itemA.title, itemA.tags);
          const catB = itemB.category || inferCategory(itemB.title, itemB.tags);
          if (catA && catB && catA !== catB) continue;
        }

        // 價格容忍度
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
  try {
    const { email, gps, displayName } = req.body;
    if (!email || !gps) {
      return res.status(400).json({ error: "缺少 email 或 gps" });
    }

    const $set = { gps, updatedAt: new Date() };
    $set.email = email;
    if (displayName !== undefined) $set.displayName = displayName;

    await User.updateOne({ email }, { $set }, { upsert: true });
    res.send("OK");
  } catch (err) {
    console.error("registerUser error", err);
    res.status(500).json({ error: "registerUser failed" });
  }
});

// 上傳物品
app.post("/upload", async (req, res) => {
  try {
    const { title, category, percent, price, email, tags, imageUrl} = req.body;
    if (!email) return res.status(400).json({ error: "缺少 email" });
    if (!title) return res.status(400).json({ error: "缺少 title" });

    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(400)
        .json({ error: "未知的 email，請先登入/註冊（/registerUser）" });
    }

    const it = await Item.create({
      title,
      tags: Array.isArray(tags) ? tags : [],
      condition: Number.isFinite(percent) ? Number(percent) : 0,
      price: Number.isFinite(price) ? Number(price) : 0,
      email,
      imageUrl: typeof imageUrl === "string" ? imageUrl : null,
      category: category || "other",
      priceBand: priceBandLabelByPrice(price),
    });

    res.json({ ok: true, itemId: it._id });
  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// 物品搜尋
app.get("/items/search", async (req, res) => {
  try {
    const { q = "", email } = req.query;
    const keyword = String(q || "").trim();
    if (!keyword) return res.json([]);

    const regex = new RegExp(keyword, "i");
    const cond = {
      $or: [{ title: regex }, { tags: regex }],
    };
    if (email) {
      cond.email = { $ne: email };
    }

    const items = await Item.find(cond).limit(50);
    res.json(items);
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// 推薦
app.get("/recommend", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "缺少 email" });

    const raw = {
      price: numOr(req.query.w_price, 25),
      distance: numOr(req.query.w_distance, 25),
      rating: numOr(req.query.w_rating, 25),
      damage: numOr(req.query.w_damage, 25),
    };
    const sum = raw.price + raw.distance + raw.rating + raw.damage || 1;
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
      if (u.gps) userLocations[u.email] = u.gps;
    });

    const swaps = recommendSwaps(
      email,
      users,
      items,
      userLocations,
      weights,
      opts
    );
    res.json(swaps);
  } catch (err) {
    console.error("recommend error", err);
    res.status(500).json({ error: "recommend failed" });
  }
});

// 送出邀請
app.post("/invite", async (req, res) => {
  try {
    const { fromEmail, toEmail, fromItemId, toItemId } = req.body;
    if (!fromEmail || !toEmail || !fromItemId || !toItemId) {
      return res.status(400).json({ error: "缺少必要欄位" });
    }

    const exists = await Invite.findOne({
      fromEmail,
      toEmail,
      fromItemId,
      toItemId,
      status: "pending",
    });
    if (exists) return res.json({ ok: true, inviteId: exists._id });

    const inv = await Invite.create({
      fromEmail,
      toEmail,
      fromItemId,
      toItemId,
    });
    res.json({ ok: true, inviteId: inv._id });
  } catch (err) {
    console.error("invite error", err);
    res.status(500).json({ error: "invite failed" });
  }
});

// 查詢邀請
app.get("/invites", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "缺少 email" });

    const received = await Invite.find({ toEmail: email }).sort({
      createdAt: -1,
    });
    const sent = await Invite.find({ fromEmail: email }).sort({
      createdAt: -1,
    });
    res.json({ received, sent });
  } catch (err) {
    console.error("invites error", err);
    res.status(500).json({ error: "invites failed" });
  }
});

// 拒絕邀請
app.post("/invites/:id/reject", async (req, res) => {
  try {
    const inv = await Invite.findById(req.params.id);
    if (!inv) return res.status(404).json({ error: "找不到邀請" });
    if (inv.status !== "pending") return res.json({ ok: true });

    inv.status = "rejected";
    await inv.save();
    res.json({ ok: true });
  } catch (err) {
    console.error("reject invite error", err);
    res.status(500).json({ error: "reject failed" });
  }
});

// 同意邀請 → 建立聊天室
app.post("/invites/:id/accept", async (req, res) => {
  try {
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
  } catch (err) {
    console.error("accept invite error", err);
    res.status(500).json({ error: "accept failed" });
  }
});

// 聊天室列表
app.get("/chats", async (req, res) => {
  try {
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
          c.messages.length > 0 ? c.messages[c.messages.length - 1] : null,
      }))
    );
  } catch (err) {
    console.error("chats list error", err);
    res.status(500).json({ error: "chats list failed" });
  }
});

// 取得聊天室訊息
app.get("/chats/:chatId/messages", async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ error: "找不到聊天室" });

    res.json({
      closed: chat.closed,
      doneConfirmations: chat.doneConfirmations || [],
      messages: chat.messages,
    });
  } catch (err) {
    console.error("get messages error", err);
    res.status(500).json({ error: "get messages failed" });
  }
});

// 送出訊息
app.post("/chats/:chatId/messages", async (req, res) => {
  try {
    const { senderEmail, text } = req.body;
    if (!senderEmail || !text) {
      return res.status(400).json({ error: "缺少 senderEmail 或 text" });
    }

    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ error: "找不到聊天室" });
    if (chat.closed) {
      return res.status(403).json({ error: "聊天室已關閉" });
    }

    chat.messages.push({ senderEmail, text, createdAt: new Date() });
    await chat.save();
    res.json({ ok: true });
  } catch (err) {
    console.error("send message error", err);
    res.status(500).json({ error: "send message failed" });
  }
});

// 交易完成確認
app.post("/chats/:chatId/done", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "缺少 email" });

    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).json({ error: "找不到聊天室" });
    if (!chat.members.includes(email)) {
      return res.status(403).json({ error: "非聊天室成員" });
    }

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
  } catch (err) {
    console.error("done error", err);
    res.status(500).json({ error: "done failed" });
  }
});

// ========= Tripo3D：轉呼叫 Flask /generate =========
app.post("/tripo3d/fromUrl", async (req, res) => {
  try {
    const { imageUrl } = req.body;

    // 基本檢查：理論上有圖片才會到這裡，
    // 但保留這個防呆沒壞處
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(400).json({
        ok: false,
        error: "缺少 imageUrl",
      });
    }

    // 呼叫你在 Render 上的 Flask /generate
    const resp = await axios.post(
      `${FLASK_BASE}/generate`,
      { image_url: imageUrl },       // ⭐ Flask 端參數名稱是 image_url
      { timeout: 1000 * 60 * 5 }    // 最多等 5 分鐘（Tripo3D 有時候會慢）
    );

    const data = resp.data;

    // 期待 Flask 回傳：
    // { "success": true, "modelUrl": "https://...glb", ... }
    if (!data || data.success !== true || !data.modelUrl) {
      return res.status(500).json({
        ok: false,
        error:
          (data && data.error) ||
          "Flask 回傳格式錯誤或缺少 modelUrl",
      });
    }

    // 對齊 Flutter ArPreviewPage 期待的格式
    return res.json({
      ok: true,
      glbUrl: data.modelUrl,
    });
  } catch (err) {
    console.error(
      "tripo3d/fromUrl error",
      err?.response?.data || err
    );
    return res.status(500).json({
      ok: false,
      error: "Node 端呼叫 Flask 失敗",
      detail: err?.response?.data || String(err),
    });
  }
});


// --- Start ---
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});




