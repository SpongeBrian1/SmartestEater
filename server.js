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

async function getLocations(zipCode) {
  const token = await getToken();

  const path =
    `/v1/locations?filter.zipCode.near=${encodeURIComponent(zipCode)}` +
    `&filter.radiusInMiles=20` +
    `&filter.limit=10`;

  const response = await httpsRequest({
    hostname: "api.kroger.com",
    path,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Encoding": "identity",
    },
  });

  return response.body;
}

async function searchProducts(term, locationId) {
  const token = await getToken();

  const path =
    `/v1/products?filter.term=${encodeURIComponent(term)}` +
    `&filter.locationId=${encodeURIComponent(locationId)}` +
    `&filter.limit=10`;

  const response = await httpsRequest({
    hostname: "api.kroger.com",
    path,
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

async function getDistance(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { miles: null, minutes: null };
  }

  const body = JSON.stringify({
    origin: { address: origin },
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

  return {
    miles: Number(miles.toFixed(2)),
    minutes: Math.round(seconds / 60),
  };
}

function getLowestPricedProduct(products) {
  const valid = (products.data || []).filter(
    (p) => p.items?.[0]?.price?.regular
  );

  if (valid.length === 0) return null;

  valid.sort((a, b) => a.items[0].price.regular - b.items[0].price.regular);
  return valid[0];
}

async function compareStores(zip, item) {
  const locations = await getLocations(zip);

  if (!locations.data || locations.data.length === 0) {
    return [];
  }

  const results = [];

  for (const store of locations.data) {
    const locationId = store.locationId;

    const productData = await searchProducts(item, locationId);
    const bestProduct = getLowestPricedProduct(productData);

    if (!bestProduct) continue;

    const price = bestProduct.items[0].price.regular;
    const address = getStoreAddress(store);
    const distance = await getDistance(zip, address);

    const dealScore = price + (distance.miles || 0) * 0.25;

    results.push({
      storeName: store.name,
      address,
      locationId,
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

    if (parsed.pathname === "/compare") {
      res.setHeader("Content-Type", "application/json");

      const zip = parsed.query.zip || "85001";
      const item = parsed.query.item || "milk";

      const results = await compareStores(zip, item);

      res.writeHead(200);
      res.end(
        JSON.stringify(
          {
            bestDeal: results[0] || null,
            stores: results,
          },
          null,
          2
        )
      );
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(3000, () => {
  console.log("Smart Eater running at http://localhost:3000");
  console.log("Try: http://localhost:3000/compare?zip=85001&item=milk");
});
