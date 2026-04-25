const http = require("http");
const https = require("https");
const fs = require("fs");
const url = require("url");
const zlib = require("zlib");
require("dotenv").config();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

let accessToken = null;
let tokenExpiry = 0;

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const buffer = Buffer.concat(chunks);
          const text = decodeResponse(buffer, res.headers["content-encoding"]);
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, body: text });
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID or CLIENT_SECRET in .env");
  }

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "product.compact",
  }).toString();

  const response = await httpsRequest(
    {
      hostname: "api.kroger.com",
      path: "/v1/connect/oauth2/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${creds}`,
        "Content-Length": Buffer.byteLength(body),
        Accept: "application/json",
        "Accept-Encoding": "identity",
      },
    },
    body
  );

  if (!response.body.access_token) {
    throw new Error("Failed to get token: " + JSON.stringify(response.body));
  }

  accessToken = response.body.access_token;
  tokenExpiry = Date.now() + (response.body.expires_in - 60) * 1000;
  return accessToken;
}

// ─── Google helpers ──────────────────────────────────────────────────────────

async function geocodeAddress(address) {
  if (!GOOGLE_MAPS_API_KEY) return null;
  const response = await httpsRequest({
    hostname: "maps.googleapis.com",
    path: `/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`,
    method: "GET",
    headers: { Accept: "application/json", "Accept-Encoding": "identity" },
  });
  const result = response.body.results?.[0];
  if (!result) return null;
  const { lat, lng } = result.geometry.location;
  return { lat, lng };
}

// origin: address string OR { lat, lng }
async function getDistance(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) return { miles: null, minutes: null };

  let originField;
  if (typeof origin === "object" && origin.lat != null) {
    originField = { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } };
  } else {
    originField = { address: origin };
  }

  const body = JSON.stringify({
    origin: originField,
    destination: { address: destination },
    travelMode: "DRIVE",
    units: "IMPERIAL",
  });

  const response = await httpsRequest(
    {
      hostname: "routes.googleapis.com",
      path: "/directions/v2:computeRoutes",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
      },
    },
    body
  );

  const route = response.body.routes?.[0];
  if (!route) return { miles: null, minutes: null };

  const miles = route.distanceMeters / 1609.34;
  const seconds = parseInt(route.duration.replace("s", ""), 10);
  return { miles: Number(miles.toFixed(2)), minutes: Math.round(seconds / 60) };
}

// ─── Kroger helpers ──────────────────────────────────────────────────────────

// origin: ZIP string OR { lat, lng }
async function getLocations(origin) {
  const token = await getToken();

  let filterParam;
  if (typeof origin === "object" && origin.lat != null) {
    filterParam = `filter.latLong.near=${origin.lat},${origin.lng}`;
  } else {
    filterParam = `filter.zipCode.near=${encodeURIComponent(origin)}`;
  }

  const response = await httpsRequest({
    hostname: "api.kroger.com",
    path: `/v1/locations?${filterParam}&filter.radiusInMiles=20&filter.limit=10`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      Accept: "application/json",
      "Accept-Encoding": "identity",
    },
  });

  return response.body;
}

async function searchProducts(term, locationId) {
  const token = await getToken();
  const response = await httpsRequest({
    hostname: "api.kroger.com",
    path: `/v1/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=10`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Encoding": "identity",
    },
  });
  return response.body;
}

function getStoreAddress(store) {
  const a = store.address || {};
  return `${a.addressLine1 || ""}, ${a.city || ""}, ${a.state || ""} ${a.zipCode || ""}`;
}

function getLowestPricedProduct(products) {
  const valid = (products.data || []).filter((p) => p.items?.[0]?.price?.regular);
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.items[0].price.regular - b.items[0].price.regular);
  return valid[0];
}

// ─── Resolve origin ───────────────────────────────────────────────────────────

// Returns { lat, lng } or ZIP string, ready for Kroger + Routes APIs.
async function resolveOrigin(raw) {
  if (typeof raw === "object") return raw; // already { lat, lng }
  if (/^\d{5}$/.test(raw.trim())) return raw; // ZIP — pass through
  if (GOOGLE_MAPS_API_KEY) {
    const coords = await geocodeAddress(raw);
    if (coords) return coords;
  }
  return raw; // fall back to raw string
}

// ─── Single-item comparison ───────────────────────────────────────────────────

async function compareStores(origin, item) {
  const resolvedOrigin = await resolveOrigin(origin);
  const locations = await getLocations(resolvedOrigin);
  if (!locations.data?.length) return [];

  const results = [];

  for (const store of locations.data) {
    const productData = await searchProducts(item, store.locationId);
    const bestProduct = getLowestPricedProduct(productData);
    if (!bestProduct) continue;

    const price = bestProduct.items[0].price.regular;
    const address = getStoreAddress(store);
    const distance = await getDistance(resolvedOrigin, address);
    const dealScore = price + (distance.miles || 0) * 0.25;

    results.push({
      storeName: store.name,
      address,
      locationId: store.locationId,
      distanceMiles: distance.miles,
      driveMinutes: distance.minutes,
      product: bestProduct.description,
      brand: bestProduct.brand,
      size: bestProduct.items[0].size,
      price,
      stock: bestProduct.items[0].inventory?.stockLevel || "Unknown",
      dealScore: Number(dealScore.toFixed(2)),
    });
  }

  results.sort((a, b) => a.dealScore - b.dealScore);
  return results;
}

// ─── Recipe comparison ────────────────────────────────────────────────────────

/**
 * For every store nearby, search every ingredient and find the cheapest match.
 * Builds a stores × ingredients price matrix, then ranks stores by:
 *   totalCost + distanceMiles * DISTANCE_WEIGHT
 *
 * Also computes a "split shopping" result: the absolute cheapest option per
 * ingredient regardless of which store carries it.
 */
async function compareRecipe(origin, ingredients) {
  const DISTANCE_WEIGHT = 0.5; // $/mile penalty — tunable

  const resolvedOrigin = await resolveOrigin(origin);
  const locations = await getLocations(resolvedOrigin);
  if (!locations.data?.length) return { stores: [], splitBest: [] };

  // Build results for every store in parallel per-store (sequential across stores
  // to avoid hammering the Kroger API).
  const storeResults = [];

  for (const store of locations.data) {
    const address = getStoreAddress(store);
    const distance = await getDistance(resolvedOrigin, address);

    const ingredientResults = [];
    let totalPrice = 0;
    let missingCount = 0;

    for (const ingredient of ingredients) {
      const productData = await searchProducts(ingredient.trim(), store.locationId);
      const best = getLowestPricedProduct(productData);

      if (best) {
        const price = best.items[0].price.regular;
        totalPrice += price;
        ingredientResults.push({
          query: ingredient.trim(),
          found: true,
          product: best.description,
          brand: best.brand,
          size: best.items[0].size,
          price,
          stock: best.items[0].inventory?.stockLevel || "Unknown",
        });
      } else {
        missingCount++;
        ingredientResults.push({
          query: ingredient.trim(),
          found: false,
        });
      }
    }

    // Stores with missing ingredients rank last; among complete stores, rank by deal score.
    const dealScore =
      missingCount * 9999 +
      totalPrice +
      (distance.miles || 0) * DISTANCE_WEIGHT;

    storeResults.push({
      storeName: store.name,
      address,
      locationId: store.locationId,
      distanceMiles: distance.miles,
      driveMinutes: distance.minutes,
      totalPrice: Number(totalPrice.toFixed(2)),
      missingCount,
      dealScore: Number(dealScore.toFixed(2)),
      ingredients: ingredientResults,
    });
  }

  storeResults.sort((a, b) => a.dealScore - b.dealScore);

  // ── Split shopping: cheapest per ingredient across all stores ──
  const splitBest = ingredients.map((ingredient) => {
    const candidates = storeResults
      .map((store) => {
        const found = store.ingredients.find(
          (i) => i.query === ingredient.trim() && i.found
        );
        if (!found) return null;
        return {
          storeName: store.name,
          address: store.address,
          distanceMiles: store.distanceMiles,
          driveMinutes: store.driveMinutes,
          product: found.product,
          brand: found.brand,
          size: found.size,
          price: found.price,
          stock: found.stock,
        };
      })
      .filter(Boolean);

    candidates.sort((a, b) => a.price - b.price);

    return {
      ingredient: ingredient.trim(),
      cheapest: candidates[0] || null,
      allOptions: candidates,
    };
  });

  const splitTotal = splitBest.reduce(
    (sum, s) => sum + (s.cheapest?.price || 0),
    0
  );

  return {
    stores: storeResults,
    splitBest,
    splitTotal: Number(splitTotal.toFixed(2)),
    ingredientCount: ingredients.length,
  };
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  try {
    // ── Serve frontend ──
    if (parsed.pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.writeHead(200);
      if (fs.existsSync(__dirname + "/index.html")) {
        res.end(fs.readFileSync(__dirname + "/index.html"));
      } else {
        res.end("<h1>Smart Eater Running</h1>");
      }
      return;
    }

    // ── Single item ──
    if (parsed.pathname === "/compare") {
      res.setHeader("Content-Type", "application/json");
      const { lat, lng, address, zip, item = "milk" } = parsed.query;

      let origin;
      if (lat && lng) origin = { lat: parseFloat(lat), lng: parseFloat(lng) };
      else if (address) origin = address;
      else origin = zip || "85001";

      const results = await compareStores(origin, item);
      res.writeHead(200);
      res.end(JSON.stringify({ bestDeal: results[0] || null, stores: results }, null, 2));
      return;
    }

    // ── Recipe ──
    if (parsed.pathname === "/recipe") {
      res.setHeader("Content-Type", "application/json");
      const { lat, lng, address, zip } = parsed.query;

      // ingredients can be comma-separated or repeated: ?ingredients=milk,eggs
      let ingredientsRaw = parsed.query.ingredients || "";
      const ingredients = ingredientsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (ingredients.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "No ingredients provided." }));
        return;
      }

      let origin;
      if (lat && lng) origin = { lat: parseFloat(lat), lng: parseFloat(lng) };
      else if (address) origin = address;
      else origin = zip || "85001";

      const result = await compareRecipe(origin, ingredients);
      res.writeHead(200);
      res.end(JSON.stringify(result, null, 2));
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
  console.log("Smart Eater running at http://localhost:3000");
  console.log("Single item: /compare?zip=85001&item=milk");
  console.log("Recipe:      /recipe?zip=85001&ingredients=milk,eggs,butter,flour");
});
