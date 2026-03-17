const express = require("express");
const axios = require("axios");
const pool = require("../db");
const { getToken, autoGenerateToken } = require("../utils/token");
const { isAllowedProxy } = require("../utils/helpers");
const { revisionCache, revisionListCache } = require("../utils/cache");

const router = express.Router();

// POST /api/sync
router.post("/", async (req, res) => {
  try {
    // Step 1: Auto-generate token if expired
    await autoGenerateToken();

    const token = getToken();
    const baseUrl = process.env.APIGEE_MGMT_API_URL;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

    console.time("SYNC_TOTAL");

    // Get proxy names
    console.time("step1_names");
    const nameRes = await axios.get(baseUrl, { headers });
    const proxyNames = nameRes.data.filter(isAllowedProxy);
    console.timeEnd("step1_names");
    console.log(`Sync - Filtered proxies: ${proxyNames.length}`);

    // Revision lists + Deployments + Delta check — ALL IN PARALLEL
    console.time("step2_parallel");
    const [revListResults, deployResults, existingResult] = await Promise.all([
      Promise.allSettled(
        proxyNames.map((name) =>
          axios.get(`${baseUrl}/${encodeURIComponent(name)}/revisions`, { headers })
            .then((r) => ({ name, revisions: r.data }))
        )
      ),
      Promise.allSettled(
        proxyNames.map((name) =>
          axios.get(`${baseUrl}/${encodeURIComponent(name)}/deployments`, { headers })
            .then((r) => ({ name, data: r.data }))
        )
      ),
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

    // No revision detail API calls — details are lazy-loaded on-demand
    const rows = newPairs.map((pair) => ({
      proxy_name: pair.name,
      revision_number: String(pair.rev),
    }));
    console.log(`Sync - Rows to insert: ${rows.length}`);

    // DB save — proxies first, then revisions + deployments in parallel
    console.time("step3_db");
    const allNames = [...new Set([
      ...rows.map((r) => r.proxy_name),
      ...deployRows.map((r) => r.proxy_name),
    ])];

    if (allNames.length > 0) {
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

      const idResult = await pool.query(
        `SELECT id, proxy_name FROM proxies WHERE proxy_name = ANY($1)`,
        [allNames]
      );
      const proxyIdMap = {};
      for (const row of idResult.rows) proxyIdMap[row.proxy_name] = row.id;

      // Save revisions + deployments IN PARALLEL
      await Promise.all([
        // Revisions (only proxy_id + revision_number)
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
    console.timeEnd("step3_db");

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

module.exports = router;
