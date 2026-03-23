const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");
const pool = require("../db");
const { getToken, autoGenerateToken } = require("../utils/token");
const { ALLOWED_PROXIES } = require("../utils/helpers");
const { revisionCache, revisionListCache } = require("../utils/cache");

const router = express.Router();

const api = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  timeout: 15000,
});

// Background: fetch revision details and update DB (fire-and-forget)
async function fillRevisionDetails(baseUrl, headers) {
  try {
    const result = await pool.query("SELECT * FROM sp_get_unfilled_revisions()");
    if (result.rows.length === 0) return;

    const updates = await Promise.allSettled(
      result.rows.map((row) =>
        api.get(`${baseUrl}/${encodeURIComponent(row.proxy_name)}/revisions/${row.revision_number}`, { headers })
          .then((r) => ({
            id: row.id,
            created_at: String(r.data.createdAt || ""),
            created_by: r.data.createdBy || "",
            last_modified_at: String(r.data.lastModifiedAt || ""),
            last_modified_by: r.data.lastModifiedBy || "",
          }))
      )
    );

    const fulfilled = updates.filter((u) => u.status === "fulfilled").map((u) => u.value);
    if (fulfilled.length === 0) return;

    await pool.query("SELECT sp_bulk_update_revision_details($1, $2, $3, $4, $5)", [
      fulfilled.map((f) => f.id),
      fulfilled.map((f) => f.created_at),
      fulfilled.map((f) => f.created_by),
      fulfilled.map((f) => f.last_modified_at),
      fulfilled.map((f) => f.last_modified_by),
    ]);

    revisionCache.clear();
    console.log(`Background: updated ${fulfilled.length} revision details`);
  } catch (err) {
    console.error("Background detail fill failed:", err.message);
  }
}

// POST /api/sync
router.post("/", async (req, res) => {
  try {
    await autoGenerateToken();

    const token = getToken();
    const baseUrl = process.env.APIGEE_MGMT_API_URL;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

    console.time("SYNC_TOTAL");

    // PHASE 1: Truncate + fetch rev lists + deployments for all 5 proxies IN PARALLEL
    const [, ...proxyResults] = await Promise.all([
      pool.query("SELECT sp_truncate_all()"),
      ...ALLOWED_PROXIES.map(async (name) => {
        const encoded = encodeURIComponent(name);
        const [revRes, depRes] = await Promise.all([
          api.get(`${baseUrl}/${encoded}/revisions`, { headers }).catch(() => ({ data: [] })),
          api.get(`${baseUrl}/${encoded}/deployments`, { headers }).catch(() => ({ data: {} })),
        ]);

        const revisions = (revRes.data || []).map((rev) => ({ proxy_name: name, revision_number: String(rev) }));

        const deployRows = [];
        if (depRes.data.environment) {
          for (const env of depRes.data.environment) {
            if (env.revision) {
              for (const rev of env.revision) {
                deployRows.push({ proxy_name: name, environment: env.name, revision_number: String(rev.name) });
              }
            }
          }
        }

        return { revisions, deployRows };
      }),
    ]);

    // Flatten
    const rows = [];
    const deployRows = [];
    for (const p of proxyResults) {
      rows.push(...p.revisions);
      deployRows.push(...p.deployRows);
    }

    // DB save using stored procedures
    const allNames = [...new Set([...rows.map((r) => r.proxy_name), ...deployRows.map((r) => r.proxy_name)])];

    if (allNames.length > 0) {
      const idResult = await pool.query("SELECT * FROM sp_upsert_proxies($1)", [allNames]);
      const proxyIdMap = {};
      for (const row of idResult.rows) proxyIdMap[row.out_proxy_name] = row.out_id;

      await Promise.all([
        rows.length > 0
          ? pool.query("SELECT sp_insert_revisions($1, $2)", [
              rows.map((r) => proxyIdMap[r.proxy_name]),
              rows.map((r) => r.revision_number),
            ])
          : Promise.resolve(),
        deployRows.length > 0
          ? pool.query("SELECT sp_insert_deployments($1, $2, $3)", [
              deployRows.map((d) => proxyIdMap[d.proxy_name]).filter(Boolean),
              deployRows.filter((d) => proxyIdMap[d.proxy_name]).map((d) => d.environment),
              deployRows.filter((d) => proxyIdMap[d.proxy_name]).map((d) => d.revision_number),
            ])
          : Promise.resolve(),
      ]);
    }

    console.timeEnd("SYNC_TOTAL");
    revisionCache.clear();
    revisionListCache.clear();

    // Respond IMMEDIATELY
    const counts = await pool.query("SELECT * FROM sp_get_counts()");

    res.json({
      success: true,
      message: "Sync completed",
      proxies: parseInt(counts.rows[0].proxy_count),
      revisions: parseInt(counts.rows[0].revision_count),
      deployments: parseInt(counts.rows[0].deployment_count),
    });

    // PHASE 2: Background — fill revision details (fire-and-forget)
    fillRevisionDetails(baseUrl, headers);

  } catch (error) {
    console.error("Sync failed:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Sync failed",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
