const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const User = require("./models/User");
const Item = require("./models/Item");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ 連接 MongoDB（預設本地端，Render 時會用環境變數）
mongoose.connect(process.env.MONGODB_URI);

// ✅ Haversine 距離計算
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

// ✅ 評分函式
function evaluateDesire(user, targetItem, ownItem, userLocations, preference = "") {
  const targetLoc = userLocations[targetItem.userId];
  if (!targetLoc) return 0;

  const distance = haversineDistance(user.location, targetLoc);
  const distanceScore = Math.exp(-distance / 10);

  const damageScore = (targetItem.condition || 0) / 100;
  const ratingScore = (targetItem.rating || 0) / 5;

  const matchedKeywords = new Set();
  (user.searchHistory || []).forEach((kw) => {
    const matchTag = (targetItem.tags || []).some((tag) => tag.includes(kw));
    const matchTitle = (targetItem.title || "").includes(kw);
    if (matchTag || matchTitle) matchedKeywords.add(kw);
  });

  const keywordBase = user.searchHistory?.length || 1;
  const keywordScore = matchedKeywords.size / keywordBase;

  const priceDiff = Math.abs(targetItem.price - ownItem.price);
  const maxPrice = Math.max(targetItem.price, ownItem.price);
  const priceScore = maxPrice === 0 ? 0 : 1 - priceDiff / maxPrice;

  const weights = { damage: 1, rating: 1, keyword: 1, price: 1, distance: 1 };
  if (preference) weights[preference] = 2;

  const totalWeight = Object.values(weights).reduce((a, b) => a + b);

  const score =
    weights.damage * damageScore +
    weights.rating * ratingScore +
    weights.keyword * keywordScore +
    weights.price * priceScore +
    weights.distance * distanceScore;

  return score / totalWeight;
}

// ✅ 雙向推薦主函式
function recommendSwaps(currentUserId, users, items, userLocations, preference = "") {
  const result = [];

  const userA = users.find((u) => u.userId === currentUserId);
  if (!userA) return [];

  const itemsA = items.filter((i) => i.userId === currentUserId);

  for (const userB of users) {
    if (userB.userId === currentUserId) continue;

    const itemsB = items.filter((i) => i.userId === userB.userId);

    for (const itemA of itemsA) {
      for (const itemB of itemsB) {
        const scoreA = evaluateDesire(userA, itemB, itemA, userLocations, preference);
        const scoreB = evaluateDesire(userB, itemA, itemB, userLocations, preference);
        const matchScore = (scoreA + scoreB) / 2;

        result.push({
          from: itemA,
          to: itemB,
          scoreA: parseFloat(scoreA.toFixed(3)),
          scoreB: parseFloat(scoreB.toFixed(3)),
          matchScore: parseFloat(matchScore.toFixed(3)),
        });
      }
    }
  }

  return result.sort((a, b) => b.matchScore - a.matchScore);
}

// ✅ API 路由
app.get("/recommend", async (req, res) => {
  try {
    const { userId, preference } = req.query;

    const users = await User.find();
    const items = await Item.find();

    const userLocations = {};
    users.forEach((u) => {
      userLocations[u.userId] = u.gps;
    });

    const swaps = recommendSwaps(userId, users, items, userLocations, preference || "");
    res.json(swaps);
  } catch (error) {
    console.error("雙向推薦失敗:", error);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// ✅ 啟動 Server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
// ✅ 註冊或更新使用者 GPS
app.post("/registerUser", async (req, res) => {
  const { userId, gps } = req.body;

  if (!userId || !gps) {
    return res.status(400).json({ error: "缺少 userId 或 gps" });
  }

  await User.updateOne(
    { userId },
    { $set: { gps } },
    { upsert: true }
  );

  res.send("OK");
});

// ✅ 上傳物品資料
app.post("/upload", async (req, res) => {
  const { title, tags, percent, price, userId } = req.body;

  if (!userId || !title) {
    return res.status(400).json({ error: "缺少 userId 或 title" });
  }

  const item = new Item({
    title,
    tags: tags.split("#").filter((t) => t.trim() !== ""),
    condition: percent,
    price,
    userId,
    rating: 0, // 你可以改成其他預設評價
  });

  await item.save();
  res.send("OK");
});

