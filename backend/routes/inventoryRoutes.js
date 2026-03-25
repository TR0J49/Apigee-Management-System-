const express = require("express");
const axios = require("axios");
const pool = require("../db");
const { getToken, autoGenerateToken } = require("../utils/token");
const { inventoryCache } = require("../utils/cache");
const { parseProxyBundle } = require("../utils/proxyParser");

const router = express.Router();

// Helper: read inventory from DB and format for response
function formatInventoryRow(row) {
  return {
    basePaths: row.base_paths,
    virtualHosts: row.virtual_hosts,
    flows: row.flows,
    policies: row.policies,
    usedPolicies: row.used_policies,
    targetEndpoints: row.target_endpoints,
    proxyEndpoints: row.proxy_endpoints,
    parsedAt: row.parsed_at,
  };
}

// GET /api/proxies/:proxyName/revisions/:revNumber/inventory
// Flow: Check cache → Check DB → Fetch ZIP from Apigee → Parse → Save to DB → Read from DB → Return
router.get("/:proxyName/revisions/:revNumber/inventory", async (req, res) => {
  try {
    const { proxyName, revNumber } = req.params;
    const cacheKey = `${proxyName}::${revNumber}`;

    // --- Step 1: Check LRU in-memory cache ---
    const cached = inventoryCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, inventory: cached, source: "cache" });
    }

    // --- Step 2: Check DB ---
    const dbResult = await pool.query(
      "SELECT * FROM sp_get_proxy_inventory($1, $2)",
      [proxyName, revNumber]
    );

    if (dbResult.rows.length > 0) {
      const inventory = formatInventoryRow(dbResult.rows[0]);
      inventoryCache.set(cacheKey, inventory);
      return res.json({ success: true, inventory, source: "db" });
    }

    // --- Step 3: Not in DB — fetch ZIP from Apigee, parse, save to DB ---
    await autoGenerateToken();
    const token = getToken();
    if (!token) {
      return res.status(401).json({ success: false, message: "No token available" });
    }

    const baseUrl = process.env.APIGEE_MGMT_API_URL;
    const zipUrl = `${baseUrl}/${encodeURIComponent(proxyName)}/revisions/${revNumber}?format=bundle`;

    const zipResponse = await axios.get(zipUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/zip",
      },
      responseType: "arraybuffer",
    });

    // --- Step 4: Parse ZIP ---
    const zipBuffer = Buffer.from(zipResponse.data);
    console.log(`Inventory: downloaded ZIP for ${proxyName} rev${revNumber}, size: ${zipBuffer.length} bytes`);
    const parsed = parseProxyBundle(zipBuffer);
    console.log(`Inventory: parsed ${proxyName} rev${revNumber} — ${parsed.flows.length} flows, ${parsed.policies.length} policies`);

    // --- Step 4.5: Verify proxy exists in DB ---
    const proxyCheck = await pool.query("SELECT id FROM proxies WHERE proxy_name = $1", [proxyName]);
    if (proxyCheck.rows.length === 0) {
      console.error(`Inventory: proxy "${proxyName}" not found in proxies table`);
      return res.status(404).json({ success: false, message: `Proxy "${proxyName}" not found. Run sync first.` });
    }

    // --- Step 5: Save to DB ---
    await pool.query(
      "SELECT sp_upsert_proxy_inventory($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        proxyName,
        revNumber,
        JSON.stringify(parsed.basePaths),
        JSON.stringify(parsed.virtualHosts),
        JSON.stringify(parsed.flows),
        JSON.stringify(parsed.policies),
        JSON.stringify(parsed.usedPolicies),
        JSON.stringify(parsed.targetEndpoints),
        JSON.stringify(parsed.proxyEndpoints),
      ]
    );

    // --- Step 6: Read back from DB to confirm save ---
    const savedResult = await pool.query(
      "SELECT * FROM sp_get_proxy_inventory($1, $2)",
      [proxyName, revNumber]
    );

    if (savedResult.rows.length === 0) {
      console.error(`Inventory save verification failed: ${proxyName} rev${revNumber} — not found in DB after insert`);
      return res.status(500).json({
        success: false,
        message: "Inventory parsed but failed to save to database",
      });
    }

    const inventory = formatInventoryRow(savedResult.rows[0]);
    inventoryCache.set(cacheKey, inventory);
    console.log(`Inventory saved to DB: ${proxyName} rev${revNumber} — ${parsed.flows.length} flows, ${parsed.policies.length} policies`);

    res.json({ success: true, inventory, source: "apigee_to_db" });
  } catch (error) {
    console.error("Inventory fetch failed:", error.response?.status, error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch proxy inventory",
      error: error.message,
    });
  }
});

module.exports = router;
