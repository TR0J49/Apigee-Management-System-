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
    

    const revListResults = await Promise.allsettled(
      proxyNames.map((name) =>
        axios.get(`${baseUrl}/${encodeURIComponent(name)}/revision`, { headers })
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

    let rows = [];
    if (allRevisionPairs.length > 0) {
      const detailResults = await concurrentPool(allRevisionPairs, 200, async (pair) => {
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
      const uniqueNames = [...new Set(rows.map((r) => r.proxy_name))];
      const idResult = await pool.query("SELECT * FROM sp_upsert_proxies($1)", [uniqueNames]);
      const proxyIdMap = {};
      for (const row of idResult.rows) proxyIdMap[row.out_proxy_name] = row.out_id;

      const proxyIds = rows.map((r) => proxyIdMap[r.proxy_name]);
      const revNumbers = rows.map((r) => r.revision_number);
      await pool.query("SELECT sp_insert_revisions($1, $2)", [proxyIds, revNumbers]);
    }
    console.timeEnd("TOTAL");

    revisionCache.clear();
    revisionListCache.clear();

    const result = await pool.query("SELECT sp_get_revision_count() AS total");
    res.json({ success: true, total_rows: parseInt(result.rows[0].total) });
  } catch (error) {
    console.error("Proxy fetch failed:", error.message);
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
    const result = await pool.query("SELECT sp_get_revision_count() AS total");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
