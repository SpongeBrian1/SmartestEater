const http = require("http");
const https = require("https");
const fs = require("fs");
const url = require("url");
const zlib = require("zlib");

const CLIENT_ID = "smartesteater-bbcdpmkb";
const CLIENT_SECRET = "2iP92crreJ2FIrzOFUKxi7kkaim2c5Ai4r5eghlY";

let accessToken = null;
let tokenExpiry = 0;

// ─── Simple file-based history store ─────────────────────────────────────────
const HISTORY_FILE = __dirname + "/history.json";
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return []; }
}
function saveHistory(entry) {
  const history = loadHistory();
  history.push({ ...entry, timestamp: new Date().toISOString() });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ─── USDA FoodData Central (free, no key needed) ──────────────────────────────
async function getNutrition(ingredientName) {
  return new Promise((resolve) => {
    const path = `/fdc/v1/foods/search?query=${encodeURIComponent(ingredientName)}&pageSize=1&api_key=DEMO_KEY`;
    const req = https.request({
      hostname: "api.nal.usda.gov",
      path,
      method: "GET",
      headers: { Accept: "application/json" }
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const food = data.foods?.[0];
          if (!food) return resolve(null);
          const nutrients = {};
          for (const n of food.foodNutrients || []) {
            if (n.nutrientName === "Energy") nutrients.calories = n.value;
            if (n.nutrientName === "Protein") nutrients.protein = n.value;
            if (n.nutrientName === "Total lipid (fat)") nutrients.fat = n.value;
            if (n.nutrientName === "Carbohydrate, by difference") nutrients.carbs = n.value;
          }
          resolve({ name: food.description, ...nutrients });
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function decodeResponse(buffer, encoding) {
  if (encoding === "gzip") return zlib.gunzipSync(buffer).toString();
  if (encoding === "br") return zlib.brotliDecompressSync(buffer).toString();
  if (encoding === "deflate") return zlib.inflateSync(buffer).toString();
  return buffer.toString();
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          const text = decodeResponse(Buffer.concat(chunks), res.headers["content-encoding"]);
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, body: text }); }
        } catch (err) { reject(err); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = "grant_type=client_credentials&scope=product.compact";
  const res = await httpsRequest({
    hostname: "api.kroger.com",
    path: "/v1/connect/oauth2/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
      "Content-Length": Buffer.byteLength(body),
      Accept: "application/json",
      "Accept-Encoding": "identity",
    }
  }, body);
  if (!res.body.access_token) throw new Error("Token failed: " + JSON.stringify(res.body));
  accessToken = res.body.access_token;
  tokenExpiry = Date.now() + (res.body.expires_in - 60) * 1000;
  return accessToken;
}

// ─── Kroger helpers ───────────────────────────────────────────────────────────
async function getLocations(zip) {
  const token = await getToken();
  const res = await httpsRequest({
    hostname: "api.kroger.com",
    path: `/v1/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.radiusInMiles=20&filter.limit=5`,
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Encoding": "identity" }
  });
  return res.body;
}

async function searchProducts(term, locationId) {
  const token = await getToken();
  const res = await httpsRequest({
    hostname: "api.kroger.com",
    path: `/v1/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=10`,
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Encoding": "identity" }
  });
  return res.body;
}

function getCheapestProduct(data) {
  const valid = (data.data || []).filter(p => p.items?.[0]?.price?.regular);
  if (!valid.length) return null;
  return valid.sort((a, b) => a.items[0].price.regular - b.items[0].price.regular)[0];
}

// ─── Analytics engine ─────────────────────────────────────────────────────────
function computeAnalytics(ingredientResults, nutritionMap) {
  const found = ingredientResults.filter(i => i.found && i.price);
  const total = found.reduce((s, i) => s + i.price, 0);

  // Cost concentration
  const withShare = found.map(i => ({
    ...i,
    costShare: Number(((i.price / total) * 100).toFixed(1))
  })).sort((a, b) => b.costShare - a.costShare);

  const biggestCost = withShare[0];

  // Cost per nutrient — key analytical insight
  const efficiency = found.map(i => {
    const n = nutritionMap[i.query];
    if (!n) return { ingredient: i.query, price: i.price, note: "Nutrition unavailable" };
    const proteinPer10g = n.protein > 0 ? Number((i.price / (n.protein / 10)).toFixed(2)) : null;
    const costPerCalorie = n.calories > 0 ? Number((i.price / n.calories * 100).toFixed(3)) : null;
    const efficiencyScore = n.protein > 0 ? Number((n.protein / i.price).toFixed(2)) : 0;
    return {
      ingredient: i.query,
      price: i.price,
      protein_per_100g: n.protein || 0,
      calories_per_100g: n.calories || 0,
      cost_per_10g_protein: proteinPer10g,
      cost_per_100_calories: costPerCalorie,
      protein_per_dollar: efficiencyScore,
      rating: efficiencyScore > 10 ? "Excellent value" : efficiencyScore > 5 ? "Good value" : "Poor value"
    };
  });

  const withProtein = efficiency.filter(e => e.protein_per_dollar > 0).sort((a, b) => b.protein_per_dollar - a.protein_per_dollar);
  const bestProteinValue = withProtein[0];
  const worstProteinValue = withProtein[withProtein.length - 1];

  // Budget breakdown by macro
  const proteinCost = found.filter(i => (nutritionMap[i.query]?.protein || 0) > 10).reduce((s, i) => s + i.price, 0);
  const carbCost = found.filter(i => (nutritionMap[i.query]?.carbs || 0) > 20).reduce((s, i) => s + i.price, 0);
  const fatCost = found.filter(i => (nutritionMap[i.query]?.fat || 0) > 10).reduce((s, i) => s + i.price, 0);

  // Recommendations
  const recommendations = [];
  if (biggestCost && biggestCost.costShare > 35) {
    recommendations.push(`"${biggestCost.ingredient}" makes up ${biggestCost.costShare}% of your total — try a store-brand to save up to 20%`);
  }
  if (worstProteinValue && worstProteinValue !== bestProteinValue) {
    recommendations.push(`"${worstProteinValue.ingredient}" has the worst protein-per-dollar — swap for eggs or canned beans for cheaper protein`);
  }
  recommendations.push(`Cooking this 3x/week costs ~$${(total * 3 * 4).toFixed(2)}/month`);

  return {
    summary: {
      totalCost: Number(total.toFixed(2)),
      ingredientsFound: found.length,
      ingredientsMissing: ingredientResults.length - found.length,
      avgCostPerIngredient: Number((total / found.length).toFixed(2)),
      estimatedCostPerServing: Number((total / 4).toFixed(2)),
    },
    costConcentration: withShare.map(i => ({
      ingredient: i.ingredient || i.query,
      price: i.price,
      costShare: i.costShare,
      flag: i.costShare > 35 ? "HIGH" : i.costShare > 20 ? "MODERATE" : "LOW"
    })),
    nutritionEfficiency: efficiency,
    insights: {
      bestProteinValue: bestProteinValue ? `${bestProteinValue.ingredient} — ${bestProteinValue.protein_per_dollar}g protein/$` : null,
      worstProteinValue: worstProteinValue ? `${worstProteinValue.ingredient} — only ${worstProteinValue.protein_per_dollar}g protein/$` : null,
      biggestCostDriver: biggestCost ? `${biggestCost.ingredient || biggestCost.query} = ${biggestCost.costShare}% of spend` : null,
      budgetBreakdown: {
        highProteinIngredients: `$${proteinCost.toFixed(2)}`,
        highCarbIngredients: `$${carbCost.toFixed(2)}`,
        highFatIngredients: `$${fatCost.toFixed(2)}`,
      }
    },
    recommendations,
  };
}

// ─── Trends ───────────────────────────────────────────────────────────────────
function computeTrends() {
  const history = loadHistory();
  if (!history.length) return { message: "No history yet — analyze some recipes first!" };

  const allIngredients = {};
  for (const session of history) {
    for (const ing of session.ingredients || []) {
      if (!ing.found) continue;
      if (!allIngredients[ing.query]) allIngredients[ing.query] = { totalSpend: 0, count: 0 };
      allIngredients[ing.query].totalSpend += ing.price;
      allIngredients[ing.query].count += 1;
    }
  }

  const ranked = Object.entries(allIngredients).map(([name, data]) => ({
    ingredient: name,
    timesSearched: data.count,
    totalSpent: Number(data.totalSpend.toFixed(2)),
    avgPrice: Number((data.totalSpend / data.count).toFixed(2)),
  })).sort((a, b) => b.totalSpent - a.totalSpent);

  const totalAllTime = ranked.reduce((s, i) => s + i.totalSpent, 0);

  return {
    totalRecipesAnalyzed: history.length,
    totalAllTimeSpend: Number(totalAllTime.toFixed(2)),
    topIngredients: ranked.slice(0, 10),
    insight: ranked[0]
      ? `You spend the most on "${ranked[0].ingredient}" across all recipes ($${ranked[0].totalSpent.toFixed(2)} total)`
      : null,
  };
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  try {
    if (parsed.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.writeHead(200);
      res.end(fs.existsSync(__dirname + "/index.html")
        ? fs.readFileSync(__dirname + "/index.html")
        : "<h1>Smart Eater Analytics Running</h1>");
      return;
    }

    if (parsed.pathname === "/locations") {
      res.setHeader("Content-Type", "application/json");
      const data = await getLocations(parsed.query.zip || "85001");
      res.writeHead(200);
      res.end(JSON.stringify(data));
      return;
    }

    if (parsed.pathname === "/recipe") {
      res.setHeader("Content-Type", "application/json");
      const { locationId, ingredients: rawIngredients } = parsed.query;
      if (!rawIngredients || !locationId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "locationId and ingredients are required" }));
        return;
      }

      const ingredients = rawIngredients.split(",").map(s => s.trim()).filter(Boolean);

      // 1. Kroger prices
      const ingredientResults = [];
      for (const ing of ingredients) {
        const data = await searchProducts(ing, locationId);
        const best = getCheapestProduct(data);
        if (best) {
          ingredientResults.push({
            query: ing,
            found: true,
            product: best.description,
            brand: best.brand || "",
            size: best.items[0].size || "",
            price: best.items[0].price.regular,
            pricePromo: best.items[0].price.promo || null,
          });
        } else {
          ingredientResults.push({ query: ing, found: false });
        }
      }

      // 2. USDA nutrition
      const nutritionMap = {};
      await Promise.all(ingredients.map(async ing => {
        nutritionMap[ing] = await getNutrition(ing);
      }));

      // 3. Analytics
      const analytics = computeAnalytics(ingredientResults, nutritionMap);

      // 4. Save history
      saveHistory({ locationId, ingredients: ingredientResults });

      res.writeHead(200);
      res.end(JSON.stringify({ ingredients: ingredientResults, nutrition: nutritionMap, analytics }, null, 2));
      return;
    }

    if (parsed.pathname === "/trends") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify(computeTrends(), null, 2));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));

  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(3000, () => {
  console.log("Smart Eater Analytics running at http://localhost:3000");
  console.log("");
  console.log("Endpoints:");
  console.log("  GET /locations?zip=85001");
  console.log("  GET /recipe?locationId=STORE_ID&ingredients=eggs,pasta,parmesan");
  console.log("  GET /trends");
});