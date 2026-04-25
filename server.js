const http = require("http");
const https = require("https");
const fs = require("fs");
const url = require("url");
const zlib = require("zlib");
require("dotenv").config();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

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
          const encoding = res.headers["content-encoding"];
          const text = decodeResponse(buffer, encoding);

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
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing CLIENT_ID or CLIENT_SECRET in .env file");
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
    `&filter.radiusInMiles=10&filter.limit=5`;

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
        res.end("<h1>Smart Eater Backend Running</h1>");
      }

      return;
    }

    if (parsed.pathname === "/locations") {
      res.setHeader("Content-Type", "application/json");

      const zip = parsed.query.zip || "85001";
      const data = await getLocations(zip);

      res.writeHead(200);
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    if (parsed.pathname === "/products") {
      res.setHeader("Content-Type", "application/json");

      const { term, locationId } = parsed.query;

      if (!term || !locationId) {
        res.writeHead(400);
        res.end(
          JSON.stringify(
            { error: "term and locationId are required" },
            null,
            2
          )
        );
        return;
      }

      const data = await searchProducts(term, locationId);

      res.writeHead(200);
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    if (parsed.pathname === "/search") {
      res.setHeader("Content-Type", "application/json");

      const zip = parsed.query.zip || "85001";
      const item = parsed.query.item || "milk";

      const locations = await getLocations(zip);

      if (!locations.data || locations.data.length === 0) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "No stores found" }, null, 2));
        return;
      }

      const locationId = locations.data[0].locationId;
      const products = await searchProducts(item, locationId);

      res.writeHead(200);
      res.end(
        JSON.stringify(
          {
            zip,
            item,
            locationId,
            store: locations.data[0].name,
            products: products.data || [],
          },
          null,
          2
        )
      );
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }, null, 2));
  } catch (err) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }, null, 2));
  }
});

server.listen(3000, () => {
  console.log("Smart Eater running at http://localhost:3000");
  console.log("Try: http://localhost:3000/search?zip=85001&item=milk");
});