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
  const
