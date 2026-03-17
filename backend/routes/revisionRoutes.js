const express = require("express");
const axios = require("axios");
const pool = require("../db");
const { getToken } = require("../utils/token");
const { revisionCache, revisionListCache } = require("../utils/cache");

const router = express.Router();

// GET /api/proxies/:proxyName/revisions
router.get("/:proxyName/revisions", async (req, res) => {
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

// GET /api/proxies/:proxyName/revisions/:revNumber — Lazy load from Apigee
router.get("/:proxyName/revisions/:revNumber", async (req, res) => {
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

module.exports = router;
