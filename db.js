const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "price_history.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS price_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    searched_at   INTEGER NOT NULL,
    day_of_week   INTEGER NOT NULL,
    date_str      TEXT    NOT NULL,
    search_type   TEXT    NOT NULL,
    query         TEXT    NOT NULL,
    store_name    TEXT    NOT NULL,
    store_address TEXT,
    location_id   TEXT,
    product       TEXT,
    brand         TEXT,
    size          TEXT,
    price         REAL    NOT NULL,
    distance_miles REAL,
    drive_minutes  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_query      ON price_log(query);
  CREATE INDEX IF NOT EXISTS idx_date       ON price_log(date_str);
  CREATE INDEX IF NOT EXISTS idx_dow        ON price_log(day_of_week);
  CREATE INDEX IF NOT EXISTS idx_store_query ON price_log(store_name, query);
`);

const insertRow = db.prepare(`
  INSERT INTO price_log
    (searched_at, day_of_week, date_str, search_type, query,
     store_name, store_address, location_id, product, brand, size,
     price, distance_miles, drive_minutes)
  VALUES
    (@searched_at, @day_of_week, @date_str, @search_type, @query,
     @store_name, @store_address, @location_id, @product, @brand, @size,
     @price, @distance_miles, @drive_minutes)
`);

const insertMany = db.transaction((rows) => {
  for (const row of rows) insertRow.run(row);
});

function buildBaseRow(searchType, query, store, now) {
  const d = new Date(now);
  return {
    searched_at:   now,
    day_of_week:   d.getDay(),
    date_str:      d.toISOString().slice(0, 10),
    search_type:   searchType,
    query:         query.toLowerCase().trim(),
    store_name:    store.storeName,
    store_address: store.address || null,
    location_id:   store.locationId || null,
    distance_miles: store.distanceMiles ?? null,
    drive_minutes:  store.driveMinutes ?? null,
  };
}

// Log results from /compare (single item)
function logSingleItem(item, stores) {
  if (!stores?.length) return;
  const now = Date.now();
  const rows = stores.map((store) => ({
    ...buildBaseRow("single", item, store, now),
    product: store.product || null,
    brand:   store.brand   || null,
    size:    store.size    || null,
    price:   store.price,
  }));
  insertMany(rows);
}

// Log results from /recipe (multiple ingredients × multiple stores)
function logRecipe(storeResults) {
  if (!storeResults?.length) return;
  const now = Date.now();
  const rows = [];

  for (const store of storeResults) {
    for (const ing of store.ingredients) {
      if (!ing.found) continue;
      rows.push({
        ...buildBaseRow("recipe", ing.query, store, now),
        product: ing.product || null,
        brand:   ing.brand   || null,
        size:    ing.size    || null,
        price:   ing.price,
      });
    }
  }

  if (rows.length) insertMany(rows);
}

// Recent rows for an item (used by /history)
function getHistory(item, days = 30) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT date_str, store_name, product, brand, size,
           price, distance_miles, drive_minutes, searched_at
    FROM price_log
    WHERE query = ? AND searched_at >= ?
    ORDER BY searched_at DESC
    LIMIT 500
  `).all(item.toLowerCase().trim(), since);
}

// Average price per calendar date (used by /trends)
function getPriceOverTime(item, days = 90) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return db.prepare(`
    SELECT date_str,
           ROUND(AVG(price), 2) AS avg_price,
           ROUND(MIN(price), 2) AS min_price,
           ROUND(MAX(price), 2) AS max_price,
           COUNT(*) AS samples
    FROM price_log
    WHERE query = ? AND searched_at >= ?
    GROUP BY date_str
    ORDER BY date_str ASC
  `).all(item.toLowerCase().trim(), since);
}

// Average price per day of week (used by /trends)
function getPriceByDayOfWeek(item) {
  const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const rows = db.prepare(`
    SELECT day_of_week,
           ROUND(AVG(price), 2) AS avg_price,
           ROUND(MIN(price), 2) AS min_price,
           ROUND(MAX(price), 2) AS max_price,
           COUNT(*) AS samples
    FROM price_log
    WHERE query = ?
    GROUP BY day_of_week
    ORDER BY day_of_week ASC
  `).all(item.toLowerCase().trim());
  return rows.map((r) => ({ ...r, day_name: DAY_NAMES[r.day_of_week] }));
}

// Average price per store (used by /trends)
function getPriceByStore(item) {
  return db.prepare(`
    SELECT store_name, store_address,
           ROUND(AVG(price), 2) AS avg_price,
           ROUND(MIN(price), 2) AS min_price,
           ROUND(MAX(price), 2) AS max_price,
           COUNT(*) AS samples,
           MAX(date_str) AS last_seen
    FROM price_log
    WHERE query = ?
    GROUP BY store_name
    ORDER BY avg_price ASC
  `).all(item.toLowerCase().trim());
}

// All distinct queried items (for autocomplete / dropdown)
function getAllItems() {
  return db.prepare(`
    SELECT query, COUNT(*) AS samples, MAX(date_str) AS last_seen
    FROM price_log
    GROUP BY query
    ORDER BY samples DESC
  `).all();
}

module.exports = {
  logSingleItem,
  logRecipe,
  getHistory,
  getPriceOverTime,
  getPriceByDayOfWeek,
  getPriceByStore,
  getAllItems,
};
