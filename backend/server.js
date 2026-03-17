require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const pool = require("./db");
const pLimit = require("p-limit");

const app = express();
app.use(cors());
app.use(express.json());

// ==================== PROXY NAME FILTER ====================
const ALLOWED_KEYWORDS = ["EazyPay", "composite", "CIB", "NPCI","D365"];

function isAllowedProxy(name) {
  const lower = name.toLowerCase();
  return ALLOWED_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

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
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
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

// ==================== DB INITIALIZATION — TWO RELATIONAL TABLES ====================
async function initDB() {
  // Proxies table — stores unique proxy names
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxies (
      id SERIAL PRIMARY KEY,
      proxy_name TEXT NOT NULL UNIQUE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Revisions table — stores revision details, FK to proxies
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revisions (
      id SERIAL PRIMARY KEY,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      revision_number TEXT NOT NULL,
      created_at TEXT,
      created_by TEXT,
      last_modified_at TEXT,
      last_modified_by TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_id, revision_number)
    )
  `);

  // Deployments table — stores which revision is deployed in which environment
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id SERIAL PRIMARY KEY,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      environment TEXT NOT NULL,
      revision_number TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_id, environment, revision_number)
    )
  `);

  // B-Tree indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name ON proxies (proxy_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id ON revisions (proxy_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id_num ON revisions (proxy_id, revision_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deploy_proxy_id ON deployments (proxy_id)`);

  console.log("Database tables and indexes initialized");
}

initDB().catch((err) => console.error("DB init failed:", err.message));

// ==================== CONCURRENCY POOL ====================
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

// ==================== GET /api/proxies — Fetch from Apigee & save to DB ====================
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

    const nameRes = await axios.get(baseUrl, { headers });
    const proxyNames = nameRes.data.filter(isAllowedProxy);

    const revListResults = await Promise.allSettled(
      proxyNames.map((name) =>
        axios.get(`${baseUrl}/${encodeURIComponent(name)}/revisions`, { headers })
          .then((r) => ({ name, revisions: r.data }))
      )
    );

    const allRevisionPairs = [];
    for (const r of revListResults) {
      if (r.status === "fulfilled") {
        for (const rev of r.value.revisions) {
          allRevisionPairs.push({ name: r.value.name, rev });
        }
      }
    }

    // Delta sync
    const existingResult = await pool.query(
      `SELECT p.proxy_name, r.revision_number FROM revisions r JOIN proxies p ON p.id = r.proxy_id`
    );
    const existingSet = new Set(existingResult.rows.map((r) => `${r.proxy_name}::${r.revision_number}`));
    const newPairs = allRevisionPairs.filter((pair) => !existingSet.has(`${pair.name}::${pair.rev}`));

    let rows = [];
    if (newPairs.length > 0) {
      const detailResults = await concurrentPool(newPairs, 200, async (pair) => {
        const r = await axios.get(`${baseUrl}/${encodeURIComponent(pair.name)}/revisions/${pair.rev}`, { headers });
        return {
          proxy_name: pair.name,
          revision_number: String(pair.rev),
          created_at: String(r.data.createdAt || ""),
          created_by: r.data.createdBy || "",
          last_modified_at: String(r.data.lastModifiedAt || ""),
          last_modified_by: r.data.lastModifiedBy || "",
        };
      });
      for (const r of detailResults) {
        if (r.status === "fulfilled") rows.push(r.value);
      }
    }

    if (rows.length > 0) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const uniqueNames = [...new Set(rows.map((r) => r.proxy_name))];
        const nameValues = [];
        const namePlaceholders = [];
        uniqueNames.forEach((name, i) => {
          namePlaceholders.push(`($${i + 1})`);
          nameValues.push(name);
        });
        await client.query(
          `INSERT INTO proxies (proxy_name) VALUES ${namePlaceholders.join(", ")}
           ON CONFLICT (proxy_name) DO UPDATE SET timestamp = CURRENT_TIMESTAMP`,
          nameValues
        );

        const idResult = await client.query(
          `SELECT id, proxy_name FROM proxies WHERE proxy_name = ANY($1)`,
          [uniqueNames]
        );
        const proxyIdMap = {};
        for (const row of idResult.rows) proxyIdMap[row.proxy_name] = row.id;

        const batchSize = 1000;
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const values = [];
          const placeholders = [];
          let idx = 1;
          for (const rev of batch) {
            placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5})`);
            values.push(proxyIdMap[rev.proxy_name], rev.revision_number, rev.created_at, rev.created_by, rev.last_modified_at, rev.last_modified_by);
            idx += 6;
          }
          await client.query(
            `INSERT INTO revisions (proxy_id, revision_number, created_at, created_by, last_modified_at, last_modified_by)
             VALUES ${placeholders.join(", ")}
             ON CONFLICT (proxy_id, revision_number) DO UPDATE SET
               created_at = EXCLUDED.created_at, created_by = EXCLUDED.created_by,
               last_modified_at = EXCLUDED.last_modified_at, last_modified_by = EXCLUDED.last_modified_by,
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
    }
    console.timeEnd("TOTAL");

    // Clear caches
    revisionCache.clear();
    revisionListCache.clear();

    const countResult = await pool.query("SELECT COUNT(*) AS total FROM revisions");
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

// ==================== POST /api/sync — Auto token + fetch proxies in one call ====================
app.post("/api/sync", async (req, res) => {
  try {
    // Step 1: Auto-generate token if expired
    if (!isTokenValid()) {
      const basicAuth = Buffer.from(
        `${process.env.APIGEE_CLIENT_ID}:${process.env.APIGEE_CLIENT_SECRET}`
      ).toString("base64");

      const params = new URLSearchParams();
      params.append("grant_type", "password");
      params.append("response_type", "token");
      params.append("username", process.env.APIGEE_USERNAME);
      params.append("password", process.env.APIGEE_PASSWORD);

      const tokenRes = await axios.post(process.env.APIGEE_TOKEN_URL, params, {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const expiresIn = tokenRes.data.expires_in || 1799;
      tokenCache = {
        token: tokenRes.data.access_token,
        expiresAt: Date.now() + (expiresIn - 60) * 1000,
      };
      console.log("Token auto-generated for sync");
    }

    // Step 2: Fetch proxies from Apigee
    const token = getToken();
    const baseUrl = process.env.APIGEE_MGMT_API_URL;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

    console.time("SYNC_TOTAL");

    // Step 1: Get proxy names + revision lists in PARALLEL (single round trip)
    console.time("step1_names");
    const nameRes = await axios.get(baseUrl, { headers });
    const proxyNames = nameRes.data.filter(isAllowedProxy);
    console.timeEnd("step1_names");
    console.log(`Sync - Filtered proxies: ${proxyNames.length}`);

    // Step 2: Revision lists + Deployments + Delta check — ALL IN PARALLEL
    console.time("step2_parallel");
    const [revListResults, deployResults, existingResult] = await Promise.all([
      // Revision lists for all proxies
      Promise.allSettled(
        proxyNames.map((name) =>
          axios.get(`${baseUrl}/${encodeURIComponent(name)}/revisions`, { headers })
            .then((r) => ({ name, revisions: r.data }))
        )
      ),
      // Deployments for all proxies
      Promise.allSettled(
        proxyNames.map((name) =>
          axios.get(`${baseUrl}/${encodeURIComponent(name)}/deployments`, { headers })
            .then((r) => ({ name, data: r.data }))
        )
      ),
      // Existing revisions from DB (for delta)
      pool.query(`SELECT p.proxy_name, r.revision_number FROM revisions r JOIN proxies p ON p.id = r.proxy_id`),
    ]);
    console.timeEnd("step2_parallel");

    // Build revision pairs
    const allRevisionPairs = [];
    for (const r of revListResults) {
      if (r.status === "fulfilled") {
        for (const rev of r.value.revisions) {
          allRevisionPairs.push({ name: r.value.name, rev });
        }
      }
    }

    // Build deployment rows
    const deployRows = [];
    for (const r of deployResults) {
      if (r.status === "fulfilled" && r.value.data.environment) {
        for (const env of r.value.data.environment) {
          if (env.revision) {
            for (const rev of env.revision) {
              deployRows.push({
                proxy_name: r.value.name,
                environment: env.name,
                revision_number: String(rev.name),
              });
            }
          }
        }
      }
    }

    // Delta sync: only store revisions NOT already in DB
    const existingSet = new Set(
      existingResult.rows.map((r) => `${r.proxy_name}::${r.revision_number}`)
    );
    const newPairs = allRevisionPairs.filter(
      (pair) => !existingSet.has(`${pair.name}::${pair.rev}`)
    );
    console.log(`Sync - Total: ${allRevisionPairs.length}, New: ${newPairs.length}, Deployments: ${deployRows.length}`);

    // Step 3 REMOVED: No more individual revision detail API calls during sync.
    // Revision details (created_by, created_at, etc.) are fetched on-demand when user clicks "See More".
    const rows = newPairs.map((pair) => ({
      proxy_name: pair.name,
      revision_number: String(pair.rev),
    }));
    console.log(`Sync - Rows to insert: ${rows.length}`);

    // Step 4: DB save — proxies first, then revisions + deployments in parallel
    console.time("step4_db");
    const allNames = [...new Set([
      ...rows.map((r) => r.proxy_name),
      ...deployRows.map((r) => r.proxy_name),
    ])];

    if (allNames.length > 0) {
      // Upsert all proxy names
      const nameValues = [];
      const namePlaceholders = [];
      allNames.forEach((name, i) => {
        namePlaceholders.push(`($${i + 1})`);
        nameValues.push(name);
      });
      await pool.query(
        `INSERT INTO proxies (proxy_name) VALUES ${namePlaceholders.join(", ")}
         ON CONFLICT (proxy_name) DO UPDATE SET timestamp = CURRENT_TIMESTAMP`,
        nameValues
      );

      // Get all proxy IDs in one query
      const idResult = await pool.query(
        `SELECT id, proxy_name FROM proxies WHERE proxy_name = ANY($1)`,
        [allNames]
      );
      const proxyIdMap = {};
      for (const row of idResult.rows) proxyIdMap[row.proxy_name] = row.id;

      // Save revisions + deployments IN PARALLEL
      await Promise.all([
        // Revisions (only proxy_id + revision_number, details fetched on-demand)
        (async () => {
          if (rows.length === 0) return;
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const batchSize = 1000;
            for (let i = 0; i < rows.length; i += batchSize) {
              const batch = rows.slice(i, i + batchSize);
              const values = [];
              const placeholders = [];
              let idx = 1;
              for (const rev of batch) {
                placeholders.push(`($${idx}, $${idx+1})`);
                values.push(proxyIdMap[rev.proxy_name], rev.revision_number);
                idx += 2;
              }
              await client.query(
                `INSERT INTO revisions (proxy_id, revision_number)
                 VALUES ${placeholders.join(", ")}
                 ON CONFLICT (proxy_id, revision_number) DO NOTHING`,
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
        })(),
        // Deployments
        (async () => {
          if (deployRows.length === 0) return;
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const proxyIds = [...new Set(deployRows.map((d) => proxyIdMap[d.proxy_name]).filter(Boolean))];
            if (proxyIds.length > 0) {
              await client.query(`DELETE FROM deployments WHERE proxy_id = ANY($1)`, [proxyIds]);
            }
            const batchSize = 1000;
            for (let i = 0; i < deployRows.length; i += batchSize) {
              const batch = deployRows.slice(i, i + batchSize);
              const values = [];
              const placeholders = [];
              let idx = 1;
              for (const dep of batch) {
                const pid = proxyIdMap[dep.proxy_name];
                if (pid) {
                  placeholders.push(`($${idx}, $${idx+1}, $${idx+2})`);
                  values.push(pid, dep.environment, dep.revision_number);
                  idx += 3;
                }
              }
              if (placeholders.length > 0) {
                await client.query(
                  `INSERT INTO deployments (proxy_id, environment, revision_number)
                   VALUES ${placeholders.join(", ")}
                   ON CONFLICT (proxy_id, environment, revision_number) DO NOTHING`,
                  values
                );
              }
            }
            await client.query("COMMIT");
          } catch (txErr) {
            await client.query("ROLLBACK");
            throw txErr;
          } finally {
            client.release();
          }
        })(),
      ]);
    }
    console.timeEnd("step4_db");

    console.timeEnd("SYNC_TOTAL");
    revisionCache.clear();
    revisionListCache.clear();

    const countResult = await pool.query("SELECT COUNT(*) AS total FROM revisions");
    const proxyCount = await pool.query("SELECT COUNT(*) AS total FROM proxies");
    const deployCount = await pool.query("SELECT COUNT(*) AS total FROM deployments");

    res.json({
      success: true,
      message: "Sync completed",
      proxies: parseInt(proxyCount.rows[0].total),
      revisions: parseInt(countResult.rows[0].total),
      deployments: parseInt(deployCount.rows[0].total),
    });
  } catch (error) {
    console.error("Sync failed:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Sync failed",
      error: error.response?.data || error.message,
    });
  }
});

// ==================== GET /api/proxies/count — Total revisions count ====================
app.get("/api/proxies/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) AS total FROM revisions");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/proxy-list — All proxies from proxies table ====================
app.get("/api/proxy-list", async (req, res) => {
  try {
    const search = req.query.search;

    let result;
    if (search) {
      result = await pool.query(
        `SELECT id, proxy_name, timestamp FROM proxies WHERE proxy_name ILIKE $1 ORDER BY proxy_name ASC`,
        [`%${search}%`]
      );
    } else {
      result = await pool.query(
        `SELECT id, proxy_name, timestamp FROM proxies ORDER BY proxy_name ASC`
      );
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

    const cached = revisionListCache.get(proxyName);
    if (cached) {
      return res.json({ success: true, revisions: cached, from_cache: true });
    }

    const result = await pool.query(
      `SELECT r.revision_number
       FROM revisions r
       JOIN proxies p ON p.id = r.proxy_id
       WHERE p.proxy_name = $1
       ORDER BY r.revision_number::int ASC`,
      [proxyName]
    );

    revisionListCache.set(proxyName, result.rows);
    res.json({ success: true, revisions: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/proxies/:proxyName/revisions/:revNumber — Lazy load from Apigee ====================
app.get("/api/proxies/:proxyName/revisions/:revNumber", async (req, res) => {
  try {
    const { proxyName, revNumber } = req.params;
    const cacheKey = `${proxyName}::${revNumber}`;

    const cached = revisionCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, revision: cached, from_cache: true });
    }

    const result = await pool.query(
      `SELECT r.id, p.proxy_name, r.revision_number, r.created_at, r.created_by,
              r.last_modified_at, r.last_modified_by, r.timestamp
       FROM revisions r
       JOIN proxies p ON p.id = r.proxy_id
       WHERE p.proxy_name = $1 AND r.revision_number = $2`,
      [proxyName, revNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Revision not found" });
    }

    const row = result.rows[0];

    // Lazy load: if detail fields are empty, fetch from Apigee and cache in DB
    if (!row.created_at && !row.created_by) {
      const token = getToken();
      if (token) {
        try {
          const baseUrl = process.env.APIGEE_MGMT_API_URL;
          const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
          const apiRes = await axios.get(
            `${baseUrl}/${encodeURIComponent(proxyName)}/revisions/${revNumber}`,
            { headers }
          );

          const detail = {
            created_at: String(apiRes.data.createdAt || ""),
            created_by: apiRes.data.createdBy || "",
            last_modified_at: String(apiRes.data.lastModifiedAt || ""),
            last_modified_by: apiRes.data.lastModifiedBy || "",
          };

          // Update DB with fetched details
          await pool.query(
            `UPDATE revisions SET created_at = $1, created_by = $2, last_modified_at = $3, last_modified_by = $4
             WHERE id = $5`,
            [detail.created_at, detail.created_by, detail.last_modified_at, detail.last_modified_by, row.id]
          );

          row.created_at = detail.created_at;
          row.created_by = detail.created_by;
          row.last_modified_at = detail.last_modified_at;
          row.last_modified_by = detail.last_modified_by;
        } catch (apiErr) {
          console.error("Lazy load revision detail failed:", apiErr.message);
        }
      }
    }

    revisionCache.set(cacheKey, row);
    res.json({ success: true, revision: row });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/proxies/:proxyName/deployments — Deployment info ====================
app.get("/api/proxies/:proxyName/deployments", async (req, res) => {
  try {
    const { proxyName } = req.params;

    const result = await pool.query(
      `SELECT d.id, d.environment, d.revision_number, d.timestamp
       FROM deployments d
       JOIN proxies p ON p.id = d.proxy_id
       WHERE p.proxy_name = $1
       ORDER BY d.environment ASC, d.revision_number::int ASC`,
      [proxyName]
    );

    res.json({ success: true, deployments: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/deployments/count — Total deployments count ====================
app.get("/api/deployments/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) AS total FROM deployments");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
