require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const pool = require("./db");
const pLimit = require("p-limit");

const app = express();
app.use(cors());
app.use(express.json());

// ==================== 1. TOKEN MANAGEMENT WITH TTL CACHE ====================
let tokenCache = { token: null, expiresAt: 0 };

function isTokenValid() {
  return tokenCache.token && Date.now() < tokenCache.expiresAt;
}

function getToken() {
  if (!isTokenValid()) return null;
  return tokenCache.token;
}

// ==================== 2. LRU CACHE FOR REVISION LOOKUPS ====================
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    // Evict least recently used if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  clear() {
    this.cache.clear();
  }
}

const revisionCache = new LRUCache(500);
const revisionListCache = new LRUCache(200);


// ==================== DB INITIALIZATION WITH INDEXES ====================
async function initDB() {
  await pool.query(`DROP TABLE IF EXISTS revisions`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxies (
      id SERIAL PRIMARY KEY,
      proxy_name TEXT NOT NULL,
      revision_number TEXT NOT NULL,
      created_at TEXT,
      created_by TEXT,
      last_modified_at TEXT,
      last_modified_by TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_name, revision_number)
    )
  `);

  // 4. B-Tree indexes for fast lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name ON proxies (proxy_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name_rev ON proxies (proxy_name, revision_number)`);

  console.log("Database table and indexes initialized");
}

initDB().catch((err) => console.error("DB init failed:", err.message));

// ==================== 5. CONCURRENCY POOL (replaces parallelBatch) ====================
async function concurrentPool(items, concurrency, fn) {
  const limit = pLimit(concurrency);
  const results = await Promise.allSettled(
    items.map((item) => limit(() => fn(item)))
  );
  return results;
}

// ==================== POST /api/token ====================
app.post("/api/token", async (req, res) => {
  try {
    const basicAuth = Buffer.from(
      `${process.env.APIGEE_CLIENT_ID}:${process.env.APIGEE_CLIENT_SECRET}`
    ).toString("base64");

    const params = new URLSearchParams();
    params.append("grant_type", "password");
    params.append("response_type", "token");
    params.append("username", process.env.APIGEE_USERNAME);
    params.append("password", process.env.APIGEE_PASSWORD);

    const response = await axios.post(process.env.APIGEE_TOKEN_URL, params, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    // Store token with TTL (subtract 60s buffer for safety)
    const expiresIn = response.data.expires_in || 1799;
    tokenCache = {
      token: response.data.access_token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };

    res.json({
      success: true,
      message: "Token generated successfully",
      token_type: response.data.token_type,
      expires_in: response.data.expires_in,
    });
  } catch (error) {
    console.error("Token generation failed:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Failed to generate token",
      error: error.response?.data || error.message,
    });
  }
});

// ==================== GET /api/proxies — Fetch with concurrency pool ====================
app.get("/api/proxies", async (req, res) => {
  try {
    const token = getToken();
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No token available or token expired. Generate a token first.",
      });
    }

    const baseUrl = process.env.APIGEE_MGMT_API_URL;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

    console.time("TOTAL");

    // STEP 1: Get all proxy names (1 call)
    console.time("step1_proxy_names");
    const nameRes = await axios.get(baseUrl, { headers });
    const proxyNames = nameRes.data;
    console.timeEnd("step1_proxy_names");
    console.log(`Proxies: ${proxyNames.length}`);

    // STEP 2: Get revision lists — concurrency pool (always 100 in-flight)
    console.time("step2_revision_lists");
    const revListResults = await concurrentPool(proxyNames, 100, async (name) => {
      const r = await axios.get(
        `${baseUrl}/${encodeURIComponent(name)}/revisions`,
        { headers }
      );
      return { name, revisions: r.data };
    });

    const allRevisionPairs = [];
    for (const r of revListResults) {
      if (r.status === "fulfilled") {
        for (const rev of r.value.revisions) {
          allRevisionPairs.push({ name: r.value.name, rev });
        }
      }
    }
    console.timeEnd("step2_revision_lists");
    console.log(`Total revision pairs: ${allRevisionPairs.length}`);

    // STEP 3: Get revision details — concurrency pool (always 100 in-flight)
    console.time("step3_revision_details");
    const detailResults = await concurrentPool(allRevisionPairs, 100, async (pair) => {
      const r = await axios.get(
        `${baseUrl}/${encodeURIComponent(pair.name)}/revisions/${pair.rev}`,
        { headers }
      );
      return {
        proxy_name: pair.name,
        revision_number: String(pair.rev),
        created_at: String(r.data.createdAt || ""),
        created_by: r.data.createdBy || "",
        last_modified_at: String(r.data.lastModifiedAt || ""),
        last_modified_by: r.data.lastModifiedBy || "",
      };
    });
    console.timeEnd("step3_revision_details");

    const rows = [];
    for (const r of detailResults) {
      if (r.status === "fulfilled") rows.push(r.value);
    }
    console.log(`Successful details: ${rows.length}`);

    // STEP 4: Bulk insert with single transaction
    console.time("step4_db_save");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batchSize = 1000;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const values = [];
        const placeholders = [];
        let idx = 1;
        for (const row of batch) {
          placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5})`);
          values.push(row.proxy_name, row.revision_number, row.created_at, row.created_by, row.last_modified_at, row.last_modified_by);
          idx += 6;
        }
        await client.query(
          `INSERT INTO proxies (proxy_name, revision_number, created_at, created_by, last_modified_at, last_modified_by)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (proxy_name, revision_number) DO UPDATE SET
             created_at = EXCLUDED.created_at,
             created_by = EXCLUDED.created_by,
             last_modified_at = EXCLUDED.last_modified_at,
             last_modified_by = EXCLUDED.last_modified_by,
             timestamp = CURRENT_TIMESTAMP`,
          values
        );
      }
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
    console.timeEnd("step4_db_save");
    console.timeEnd("TOTAL");

    // Clear caches after fresh data
    revisionCache.clear();
    revisionListCache.clear();

    const countResult = await pool.query("SELECT COUNT(*) AS total FROM proxies");
    const totalRows = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      total_rows: totalRows,
    });
  } catch (error) {
    console.error("Proxy fetch failed:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch proxies",
      error: error.response?.data || error.message,
    });
  }
});

// ==================== GET /api/proxies/db — Cursor-based pagination ====================
app.get("/api/proxies/db", async (req, res) => {
  try {
    const cursor = parseInt(req.query.cursor) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);

    const result = await pool.query(
      "SELECT * FROM proxies WHERE id > $1 ORDER BY id ASC LIMIT $2",
      [cursor, limit]
    );

    const nextCursor = result.rows.length > 0
      ? result.rows[result.rows.length - 1].id
      : null;

    res.json({
      success: true,
      proxies: result.rows,
      next_cursor: nextCursor,
      has_more: result.rows.length === limit,
    });
  } catch (error) {
    console.error("DB fetch failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch from database",
      error: error.message,
    });
  }
});

// ==================== GET /api/proxies/count ====================
app.get("/api/proxies/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) AS total FROM proxies");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/proxy-list — With optional DB-level search ====================
app.get("/api/proxy-list", async (req, res) => {
  try {
    const search = req.query.search;

    let result;
    if (search) {
      // B-Tree index + ILIKE for server-side search — O(log n)
      result = await pool.query(`
        SELECT proxy_name, MIN(id) AS id, MIN(timestamp) AS timestamp
        FROM proxies
        WHERE proxy_name ILIKE $1
        GROUP BY proxy_name
        ORDER BY proxy_name ASC
      `, [`%${search}%`]);
    } else {
      result = await pool.query(`
        SELECT proxy_name, MIN(id) AS id, MIN(timestamp) AS timestamp
        FROM proxies
        GROUP BY proxy_name
        ORDER BY proxy_name ASC
      `);
    }

    res.json({ success: true, proxies: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/proxies/:proxyName/revisions — With LRU cache ====================
app.get("/api/proxies/:proxyName/revisions", async (req, res) => {
  try {
    const { proxyName } = req.params;

    // Check LRU cache first — O(1)
    const cached = revisionListCache.get(proxyName);
    if (cached) {
      return res.json({ success: true, revisions: cached, from_cache: true });
    }

    const result = await pool.query(
      "SELECT revision_number FROM proxies WHERE proxy_name = $1 ORDER BY revision_number::int ASC",
      [proxyName]
    );

    // Store in LRU cache
    revisionListCache.set(proxyName, result.rows);

    res.json({ success: true, revisions: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/proxies/:proxyName/revisions/:revNumber — With LRU cache ====================
app.get("/api/proxies/:proxyName/revisions/:revNumber", async (req, res) => {
  try {
    const { proxyName, revNumber } = req.params;
    const cacheKey = `${proxyName}::${revNumber}`;

    // Check LRU cache first — O(1)
    const cached = revisionCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, revision: cached, from_cache: true });
    }

    const result = await pool.query(
      "SELECT * FROM proxies WHERE proxy_name = $1 AND revision_number = $2",
      [proxyName, revNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Revision not found" });
    }

    // Store in LRU cache
    revisionCache.set(cacheKey, result.rows[0]);

    res.json({ success: true, revision: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
