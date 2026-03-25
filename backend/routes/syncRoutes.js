const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");
const pLimit = require("p-limit");
const pool = require("../db");
const { getToken, autoGenerateToken } = require("../utils/token");
const { ALLOWED_PROXIES } = require("../utils/helpers");
const { revisionCache, revisionListCache, inventoryCache } = require("../utils/cache");
const { parseProxyBundle } = require("../utils/proxyParser");

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

// Background: fetch ZIP bundles for deployed revisions, parse XML, save inventory to DB
async function fillDeployedInventory(baseUrl, headers, deployRows) {
  try {
    // Get unique proxy+revision pairs that are deployed
    const seen = new Set();
    const pairs = [];
    for (const d of deployRows) {
      const key = `${d.proxy_name}::${d.revision_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ proxyName: d.proxy_name, revNumber: d.revision_number });
    }

    if (pairs.length === 0) {
      console.log("Background inventory: no deployed revisions to process");
      return;
    }

    // Check which ones already have inventory in DB (batch check)
    const toFetch = [];
    for (const pair of pairs) {
      try {
        const existing = await pool.query(
          "SELECT id FROM sp_get_proxy_inventory($1, $2)",
          [pair.proxyName, pair.revNumber]
        );
        if (existing.rows.length === 0) {
          toFetch.push(pair);
        }
      } catch (checkErr) {
        console.error(`Background inventory: DB check failed for ${pair.proxyName} rev${pair.revNumber}:`, checkErr.message);
        toFetch.push(pair);
      }
    }

    if (toFetch.length === 0) {
      console.log("Background inventory: all deployed revisions already in DB");
      return;
    }

    console.log(`Background inventory: fetching ${toFetch.length} deployed revision(s)...`);

    // Limit concurrency to 3 at a time to avoid timeouts and API rate limits
    const limit = pLimit(3);
    const results = await Promise.allSettled(
      toFetch.map((pair) => limit(async () => {
        const zipUrl = `${baseUrl}/${encodeURIComponent(pair.proxyName)}/revisions/${pair.revNumber}?format=bundle`;
        console.log(`Background inventory: downloading ZIP for ${pair.proxyName} rev${pair.revNumber}...`);

        const zipRes = await api.get(zipUrl, {
          headers: { ...headers, Accept: "application/zip" },
          responseType: "arraybuffer",
          timeout: 60000,
        });

        const zipBuffer = Buffer.from(zipRes.data);
        if (zipBuffer.length === 0) {
          throw new Error(`Empty ZIP response for ${pair.proxyName} rev${pair.revNumber}`);
        }

        const parsed = parseProxyBundle(zipBuffer);
        console.log(`Background inventory: parsed ${pair.proxyName} rev${pair.revNumber} — ${parsed.flows.length} flows, ${parsed.policies.length} policies`);

        // Verify proxy exists in DB before inserting inventory
        const proxyCheck = await pool.query("SELECT id FROM proxies WHERE proxy_name = $1", [pair.proxyName]);
        if (proxyCheck.rows.length === 0) {
          throw new Error(`Proxy "${pair.proxyName}" not found in proxies table — cannot save inventory`);
        }

        await pool.query(
          "SELECT sp_upsert_proxy_inventory($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [
            pair.proxyName,
            pair.revNumber,
            JSON.stringify(parsed.basePaths),
            JSON.stringify(parsed.virtualHosts),
            JSON.stringify(parsed.flows),
            JSON.stringify(parsed.policies),
            JSON.stringify(parsed.usedPolicies),
            JSON.stringify(parsed.targetEndpoints),
            JSON.stringify(parsed.proxyEndpoints),
          ]
        );

        // Verify the save actually worked
        const verify = await pool.query(
          "SELECT id FROM sp_get_proxy_inventory($1, $2)",
          [pair.proxyName, pair.revNumber]
        );
        if (verify.rows.length === 0) {
          throw new Error(`Inventory save FAILED for ${pair.proxyName} rev${pair.revNumber} — not found in DB after insert`);
        }

        console.log(`Background inventory: SAVED ${pair.proxyName} rev${pair.revNumber}`);
        return pair;
      }))
    );

    const saved = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");
    inventoryCache.clear();
    console.log(`Background inventory: completed ${saved}/${toFetch.length} deployed revision inventories`);
    if (failed.length > 0) {
      console.error(`Background inventory: ${failed.length} FAILED:`);
      for (const f of failed) {
        console.error("  ->", f.reason?.message || f.reason);
      }
    }
  } catch (err) {
    console.error("Background inventory fill CRASHED:", err.message, err.stack);
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

    // PHASE 1: Truncate revisions+deployments + fetch rev lists + deployments for all 5 proxies IN PARALLEL
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
    inventoryCache.clear();

    // Respond IMMEDIATELY
    const counts = await pool.query("SELECT * FROM sp_get_counts()");

    res.json({
      success: true,
      message: "Sync completed",
      proxies: parseInt(counts.rows[0].proxy_count),
      revisions: parseInt(counts.rows[0].revision_count),
      deployments: parseInt(counts.rows[0].deployment_count),
    });

    // PHASE 2: Background — fill revision details + inventory for deployed revisions (fire-and-forget)
    fillRevisionDetails(baseUrl, headers);
    fillDeployedInventory(baseUrl, headers, deployRows);

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
