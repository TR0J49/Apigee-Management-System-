const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit");
const pool = require("../db");
const { getToken, autoGenerateToken } = require("../utils/token");
const { ALLOWED_PROXIES, ALLOWED_SHAREDFLOWS } = require("../utils/helpers");
const { revisionCache, revisionListCache, inventoryCache } = require("../utils/cache");
const { parseProxyBundle, parseSharedflowPolicies } = require("../utils/proxyParser");

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

// Background: fetch sharedflow revision details and update DB (fire-and-forget)
async function fillSharedflowRevisionDetails(sfBaseUrl, headers) {
  try {
    const result = await pool.query("SELECT * FROM sp_get_unfilled_sf_revisions()");
    if (result.rows.length === 0) return;

    const updates = await Promise.allSettled(
      result.rows.map((row) =>
        api.get(`${sfBaseUrl}/${encodeURIComponent(row.sharedflow_name)}/revisions/${row.revision_number}`, { headers })
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

    await pool.query("SELECT sp_bulk_update_sf_revision_details($1, $2, $3, $4, $5)", [
      fulfilled.map((f) => f.id),
      fulfilled.map((f) => f.created_at),
      fulfilled.map((f) => f.created_by),
      fulfilled.map((f) => f.last_modified_at),
      fulfilled.map((f) => f.last_modified_by),
    ]);

    console.log(`Background: updated ${fulfilled.length} sharedflow revision details`);
  } catch (err) {
    console.error("Background sharedflow detail fill failed:", err.message);
  }
}

// Helper: get fresh headers (re-generates token if expired)
async function getFreshHeaders() {
  await autoGenerateToken();
  const token = getToken();
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// Background: auto-download sharedflow bundles as ZIP to disk (deployed + latest for non-deployed)
async function downloadDeployedSharedflowBundles(sfBaseUrl, headers, sfDeployRows, allSfRevRows) {
  try {
    // Deduplicate deployed by sfName + revNumber + environment
    const seen = new Set();
    const pairs = [];
    for (const d of sfDeployRows) {
      const key = `${d.sfName}::${d.revNumber}::${d.environment}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(d);
    }

    // For sharedflows with NO deployment, add their latest revision
    const deployedSfNames = new Set(sfDeployRows.map((d) => d.sfName));
    if (allSfRevRows && allSfRevRows.length > 0) {
      const latestBySf = {};
      for (const r of allSfRevRows) {
        const revNum = parseInt(r.revNumber);
        if (!latestBySf[r.sfName] || revNum > parseInt(latestBySf[r.sfName].revNumber)) {
          latestBySf[r.sfName] = r;
        }
      }
      for (const [sfName, rev] of Object.entries(latestBySf)) {
        if (!deployedSfNames.has(sfName)) {
          const key = `${sfName}::${rev.revNumber}::latest`;
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ sfId: rev.sfId, sfName, revNumber: rev.revNumber, environment: "latest" });
            console.log(`Background SF download: ${sfName} has no deployment, using latest rev ${rev.revNumber}`);
          }
        }
      }
    }

    if (pairs.length === 0) {
      console.log("Background SF download: no sharedflow revisions to download");
      return;
    }

    // Create downloads/sharedflows directory
    const downloadDir = path.join(__dirname, "..", "downloads", "sharedflows");
    fs.mkdirSync(downloadDir, { recursive: true });

    console.log(`Background SF download: downloading ${pairs.length} sharedflow bundle(s) in parallel...`);

    const limit = pLimit(5);
    const results = await Promise.allSettled(
      pairs.map((p) => limit(async () => {
        const fileName = `${p.sfName}_rev${p.revNumber}_${p.environment}.zip`;
        const zipUrl = `${sfBaseUrl}/${encodeURIComponent(p.sfName)}/revisions/${p.revNumber}?format=bundle`;
        console.log(`Background SF download: fetching ${fileName}...`);
        const freshHeaders = await getFreshHeaders();
        const zipRes = await api.get(zipUrl, {
          headers: { ...freshHeaders, Accept: "application/zip" },
          responseType: "arraybuffer",
          timeout: 120000,
        });

        const zipBuffer = Buffer.from(zipRes.data);
        if (zipBuffer.length === 0) {
          throw new Error(`Empty ZIP for ${p.sfName} rev${p.revNumber}`);
        }

        fs.writeFileSync(path.join(downloadDir, fileName), zipBuffer);
        console.log(`Background SF download: saved ${fileName} (${zipBuffer.length} bytes)`);

        // Parse policies from ZIP and save to DB
        try {
          const policyDetails = parseSharedflowPolicies(zipBuffer);
          if (policyDetails.length > 0) {
            await pool.query(
              "SELECT sp_upsert_sharedflow_policies($1, $2, $3, $4, $5, $6, $7)",
              [
                p.sfName,
                p.revNumber,
                policyDetails.map((pd) => pd.policy_name),
                policyDetails.map((pd) => pd.policy_type),
                policyDetails.map((pd) => pd.async),
                policyDetails.map((pd) => pd.continue_on_error),
                policyDetails.map((pd) => pd.enabled),
              ]
            );
            console.log(`Background SF download: saved ${policyDetails.length} policies for ${p.sfName} rev${p.revNumber}`);
          }
        } catch (parseErr) {
          console.error(`Background SF download: policy parse failed for ${fileName}:`, parseErr.message);
        }

        return fileName;
      }))
    );

    const saved = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");
    console.log(`Background SF download: completed ${saved}/${pairs.length}`);
    if (failed.length > 0) {
      for (const f of failed) console.error("  -> SF download FAILED:", f.reason?.message || f.reason);
    }
  } catch (err) {
    console.error("Background SF download CRASHED:", err.message);
  }
}

// Background: fetch ZIP bundles for all proxies, parse XML, save inventory to DB, save ZIP to disk
async function fillDeployedInventory(baseUrl, headers, deployRows, allRevisionRows) {
  try {
    // Collect all deployed proxy+revision+environment combos for saving ZIPs
    const allDeployPairs = [];
    const seenDeploy = new Set();
    for (const d of deployRows) {
      const key = `${d.proxy_name}::${d.revision_number}::${d.environment}`;
      if (seenDeploy.has(key)) continue;
      seenDeploy.add(key);
      allDeployPairs.push({ proxyName: d.proxy_name, revNumber: d.revision_number, environment: d.environment });
    }

    // Build pairs: deployed revisions + latest revision for non-deployed proxies
    const seen = new Set();
    const pairs = [];

    // 1. Add all deployed proxy+revision pairs
    for (const d of deployRows) {
      const key = `${d.proxy_name}::${d.revision_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ proxyName: d.proxy_name, revNumber: d.revision_number });
    }

    // 2. For proxies that have NO deployment, add their latest revision
    const deployedProxyNames = new Set(deployRows.map((d) => d.proxy_name));
    if (allRevisionRows && allRevisionRows.length > 0) {
      const latestByProxy = {};
      for (const r of allRevisionRows) {
        const revNum = parseInt(r.revision_number);
        if (!latestByProxy[r.proxy_name] || revNum > parseInt(latestByProxy[r.proxy_name])) {
          latestByProxy[r.proxy_name] = r.revision_number;
        }
      }
      for (const [proxyName, revNumber] of Object.entries(latestByProxy)) {
        if (!deployedProxyNames.has(proxyName)) {
          const key = `${proxyName}::${revNumber}`;
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ proxyName, revNumber });
            // Also add to allDeployPairs so ZIP gets saved (with "latest" as env label)
            allDeployPairs.push({ proxyName, revNumber, environment: "latest" });
            console.log(`Background inventory: proxy ${proxyName} has no deployment, using latest rev ${revNumber}`);
          }
        }
      }
    }

    if (pairs.length === 0) {
      console.log("Background inventory: no revisions to process");
      return;
    }

    console.log(`Background inventory: ${pairs.length} proxy revision(s) to process (${deployRows.length} deployed + ${pairs.length - new Set(deployRows.map(d => d.proxy_name + "::" + d.revision_number)).size} non-deployed)`);

    // Create downloads/proxies directory
    const downloadDir = path.join(__dirname, "..", "downloads", "proxies");
    fs.mkdirSync(downloadDir, { recursive: true });

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

    console.log(`Background inventory: fetching ${toFetch.length} revision(s) in parallel...`);

    const limit = pLimit(5);
    const results = await Promise.allSettled(
      toFetch.map((pair) => limit(async () => {
        const zipUrl = `${baseUrl}/${encodeURIComponent(pair.proxyName)}/revisions/${pair.revNumber}?format=bundle`;
        console.log(`Background inventory: downloading ZIP for ${pair.proxyName} rev${pair.revNumber}...`);

        const freshHeaders = await getFreshHeaders();
        const zipRes = await api.get(zipUrl, {
          headers: { ...freshHeaders, Accept: "application/zip" },
          responseType: "arraybuffer",
          timeout: 120000,
        });

        const zipBuffer = Buffer.from(zipRes.data);
        if (zipBuffer.length === 0) {
          throw new Error(`Empty ZIP response for ${pair.proxyName} rev${pair.revNumber}`);
        }

        // Save ZIP file(s) to disk — one per environment this revision is deployed on
        const envs = allDeployPairs.filter((d) => d.proxyName === pair.proxyName && d.revNumber === pair.revNumber);
        for (const dep of envs) {
          const fileName = `${dep.proxyName}_rev${dep.revNumber}_${dep.environment}.zip`;
          fs.writeFileSync(path.join(downloadDir, fileName), zipBuffer);
          console.log(`Background inventory: saved ${fileName} (${zipBuffer.length} bytes)`);
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

        // Save policy details to proxy_policies table
        if (parsed.policyDetails && parsed.policyDetails.length > 0) {
          await pool.query(
            "SELECT sp_upsert_proxy_policies($1, $2, $3, $4, $5, $6, $7)",
            [
              pair.proxyName,
              pair.revNumber,
              parsed.policyDetails.map((p) => p.policy_name),
              parsed.policyDetails.map((p) => p.policy_type),
              parsed.policyDetails.map((p) => p.async),
              parsed.policyDetails.map((p) => p.continue_on_error),
              parsed.policyDetails.map((p) => p.enabled),
            ]
          );
        }

        console.log(`Background inventory: SAVED ${pair.proxyName} rev${pair.revNumber} (${parsed.policyDetails?.length || 0} policies)`);
        return pair;
      }))
    );

    const saved = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");
    inventoryCache.clear();
    console.log(`Background inventory: completed ${saved}/${toFetch.length}`);
    if (failed.length > 0) {
      for (const f of failed) console.error("  -> inventory FAILED:", f.reason?.message || f.reason);
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

    // Clean old proxy downloads (DB was truncated, re-download fresh)
    const proxyDownloadDir = path.join(__dirname, "..", "downloads", "proxies");
    if (fs.existsSync(proxyDownloadDir)) {
      const oldProxyFiles = fs.readdirSync(proxyDownloadDir).filter((f) => f.endsWith(".zip"));
      for (const f of oldProxyFiles) fs.unlinkSync(path.join(proxyDownloadDir, f));
      if (oldProxyFiles.length > 0) console.log(`Cleaned ${oldProxyFiles.length} old proxy ZIPs`);
    }

    // Clean old sharedflow downloads (DB was truncated, re-download fresh)
    const sfDownloadDir = path.join(__dirname, "..", "downloads", "sharedflows");
    if (fs.existsSync(sfDownloadDir)) {
      const oldFiles = fs.readdirSync(sfDownloadDir).filter((f) => f.endsWith(".zip"));
      for (const f of oldFiles) fs.unlinkSync(path.join(sfDownloadDir, f));
      if (oldFiles.length > 0) console.log(`Cleaned ${oldFiles.length} old sharedflow ZIPs`);
    }

    // PHASE 1b: Sync shared flows — upsert names, fetch revision lists + deployments, save to DB
    const sfBaseUrl = baseUrl.replace(/\/apis$/, "/sharedflows");
    let sfDeployRows = [];
    let sfRevRows = [];
    if (ALLOWED_SHAREDFLOWS.length > 0) {
      const sfIdResult = await pool.query("SELECT * FROM sp_upsert_sharedflows($1)", [ALLOWED_SHAREDFLOWS]);
      const sfIdMap = {};
      for (const row of sfIdResult.rows) sfIdMap[row.out_sharedflow_name] = row.out_id;

      // Fetch revision lists + deployments for all 5 sharedflows in parallel
      const sfResults = await Promise.allSettled(
        ALLOWED_SHAREDFLOWS.map(async (name) => {
          const encoded = encodeURIComponent(name);
          const [revRes, depRes] = await Promise.all([
            api.get(`${sfBaseUrl}/${encoded}/revisions`, { headers }).catch(() => ({ data: [] })),
            api.get(`${sfBaseUrl}/${encoded}/deployments`, { headers }).catch(() => ({ data: {} })),
          ]);

          const revisions = (revRes.data || []).map((rev) => String(rev));

          const deployRows = [];
          const depData = depRes.data;
          console.log(`SharedFlow ${name} deployments response:`, JSON.stringify(depData).substring(0, 500));

          // Format 1: { environment: [ { name, revision: [ { name } ] } ] }
          if (depData.environment) {
            for (const env of depData.environment) {
              if (env.revision) {
                for (const rev of env.revision) {
                  deployRows.push({ environment: env.name, revision_number: String(rev.name) });
                }
              }
            }
          }

          // Format 2: { aPIProxy: [...], environment: [...] } or nested differently
          // Some Apigee orgs return: { environment: [ { name: "test", revision: [ { name: "1", state: "deployed" } ] } ] }
          // Already handled above

          // Format 3: Array of { environment, revision, ... }
          if (Array.isArray(depData)) {
            for (const item of depData) {
              if (item.environment && item.revision) {
                const revs = Array.isArray(item.revision) ? item.revision : [item.revision];
                for (const rev of revs) {
                  const revNum = typeof rev === "object" ? String(rev.name) : String(rev);
                  deployRows.push({ environment: item.environment, revision_number: revNum });
                }
              }
            }
          }

          console.log(`SharedFlow ${name}: ${revisions.length} revisions, ${deployRows.length} deployments`);
          return { name, revisions, deployRows };
        })
      );

      for (const r of sfResults) {
        if (r.status === "fulfilled" && sfIdMap[r.value.name]) {
          const sfId = sfIdMap[r.value.name];
          for (const rev of r.value.revisions) {
            sfRevRows.push({ sfId, sfName: r.value.name, revNumber: rev });
          }
          for (const dep of r.value.deployRows) {
            sfDeployRows.push({ sfId, sfName: r.value.name, environment: dep.environment, revNumber: dep.revision_number });
          }
        }
      }

      if (sfRevRows.length > 0) {
        await pool.query("SELECT sp_insert_sharedflow_revisions($1, $2)", [
          sfRevRows.map((r) => r.sfId),
          sfRevRows.map((r) => r.revNumber),
        ]);
      }

      if (sfDeployRows.length > 0) {
        await pool.query("SELECT sp_insert_sharedflow_deployments($1, $2, $3)", [
          sfDeployRows.map((d) => d.sfId),
          sfDeployRows.map((d) => d.environment),
          sfDeployRows.map((d) => d.revNumber),
        ]);
      }

      console.log(`Synced ${ALLOWED_SHAREDFLOWS.length} shared flows, ${sfRevRows.length} revisions, ${sfDeployRows.length} deployments`);
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

    // PHASE 2: Background — fill revision details + inventory + downloads (fire-and-forget)
    fillRevisionDetails(baseUrl, headers);
    fillDeployedInventory(baseUrl, headers, deployRows, rows);
    fillSharedflowRevisionDetails(sfBaseUrl, headers);
    downloadDeployedSharedflowBundles(sfBaseUrl, headers, sfDeployRows, sfRevRows);

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
