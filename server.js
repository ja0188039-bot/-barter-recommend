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
function evaluateDesire(user, targetItem, ownItem, userLocations, weights) {
  const targetLoc = userLocations[targetItem.userId];
  if (!targetLoc || !user.gps) return 0;

  const distance = haversineDistance(user.gps, targetLoc);
  const distanceScore = Math.exp(-distance / 10);     // 0~1

  const damageScore  = (targetItem.condition || 0) / 100;
  const ratingScore  = (targetItem.rating || 0) / 5;

  // 關鍵字分數移除（你的需求是拿掉關鍵字）
  const keywordScore = 0;

  const priceDiff = Math.abs(targetItem.price - ownItem.price);
  const maxPrice  = Math.max(targetItem.price, ownItem.price);
  const priceScore = maxPrice === 0 ? 0 : 1 - priceDiff / maxPrice;

  // 依自訂權重加總
  const score =
    weights.damage   * damageScore  +
    weights.rating   * ratingScore  +
    weights.price    * priceScore   +
    weights.distance * distanceScore;

  return score; // 已經是 0~1 之間
}

// ✅ 雙向推薦主函式
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


// ✅ API 路由
app.get("/recommend", async (req, res) => {
  try {
    const { userId } = req.query;

    // 讀取權重（預設 25）
    const raw = {
      price:    Number(req.query.w_price)    || 25,
      distance: Number(req.query.w_distance) || 25,
      rating:   Number(req.query.w_rating)   || 25,
      damage:   Number(req.query.w_damage)   || 25,
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

