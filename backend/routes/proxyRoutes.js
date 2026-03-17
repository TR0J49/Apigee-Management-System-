const express = require("express");
const axios = require("axios");
const pool = require("../db");
const { getToken } = require("../utils/token");
const { isAllowedProxy, concurrentPool } = require("../utils/helpers");
const { revisionCache, revisionListCache } = require("../utils/cache");

const router = express.Router();

// GET /api/proxies — Fetch from Apigee & save to DB
router.get("/", async (req, res) => {
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

// GET /api/proxies/count
router.get("/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) AS total FROM revisions");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
