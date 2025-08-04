// ✅ 計算地球表面兩點距離（公里）
function haversineDistance(loc1, loc2) {
  const degToRad = deg => (deg * Math.PI) / 180;
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

// ✅ 單邊交換意願評分
function evaluateDesire(user, targetItem, ownItem, userLocations, preference = "") {
  const targetLoc = userLocations[targetItem.userId];
  if (!targetLoc) return 0;

  const distance = haversineDistance(user.location, targetLoc);
  const distanceScore = Math.exp(-distance / 10);

  const damageScore = (targetItem.condition || 0) / 100;
  const ratingScore = (targetItem.rating || 0) / 5;

  const matchedKeywords = new Set();
  (user.searchHistory || []).forEach(kw => {
    const matchTag = (targetItem.tags || []).some(tag => tag.includes(kw));
    const matchTitle = (targetItem.title || "").includes(kw);
    if (matchTag || matchTitle) matchedKeywords.add(kw);
  });

  const keywordBase = user.searchHistory?.length || 1;
  const keywordScore = matchedKeywords.size / keywordBase;

  const priceDiff = Math.abs(targetItem.price - ownItem.price);
  const maxPrice = Math.max(targetItem.price, ownItem.price);
  const priceScore = maxPrice === 0 ? 0 : 1 - priceDiff / maxPrice;

  const weights = { damage: 1, rating: 1, keyword: 1, price: 1, distance: 1 };
  if (preference && weights[preference]) weights[preference] = 2;

  const totalWeight = Object.values(weights).reduce((a, b) => a + b);
  const score =
    weights.damage * damageScore +
    weights.rating * ratingScore +
    weights.keyword * keywordScore +
    weights.price * priceScore +
    weights.distance * distanceScore;

  return score / totalWeight;
}

// ✅ 全配對：你每個物品對所有其他使用者物品配一次（不設門檻）
function recommendAllMatches(userId, users, items, userLocations, preference = "") {
  const result = [];

  const me = users.find(u => u.userId === userId);
  if (!me) throw new Error("找不到登入使用者");

  const myItems = items.filter(i => i.userId === userId);
  const otherUsers = users.filter(u => u.userId !== userId);

  for (const itemA of myItems) {
    for (const other of otherUsers) {
      const theirItems = items.filter(i => i.userId === other.userId);

      for (const itemB of theirItems) {
        const scoreA = evaluateDesire(me, itemB, itemA, userLocations, preference);
        const scoreB = evaluateDesire(other, itemA, itemB, userLocations, preference);
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

module.exports = recommendAllMatches;











