require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./db");

// Utils
const initDB = require("./utils/initDB");

// Routes
const tokenRoutes = require("./routes/tokenRoutes");
const syncRoutes = require("./routes/syncRoutes");
const proxyRoutes = require("./routes/proxyRoutes");
const revisionRoutes = require("./routes/revisionRoutes");
const deploymentRoutes = require("./routes/deploymentRoutes");
const downloadRoutes = require("./routes/downloadRoutes");
// NEW: inventoryRoutes — fetches ZIP from Apigee, parses XML, saves inventory to DB
const inventoryRoutes = require("./routes/inventoryRoutes");

const app = express();
app.use(cors());
app.use(express.json());

// Initialize database tables, indexes, and stored procedures (must complete before routes are usable)
let dbReady = false;
initDB()
  .then(() => { dbReady = true; })
  .catch((err) => console.error("DB init failed:", err.message));

// Middleware: block requests until DB is initialized
app.use((req, res, next) => {
  if (!dbReady) {
    return res.status(503).json({ success: false, message: "Server is starting up, please wait..." });
  }
  next();
});

// Mount routes
app.use("/api/token", tokenRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/proxies", proxyRoutes);
app.use("/api/proxies", revisionRoutes);
app.use("/api/proxies", deploymentRoutes);
app.use("/api/proxies", downloadRoutes);
// NEW: Mount inventory route — GET /api/proxies/:name/revisions/:rev/inventory
app.use("/api/proxies", inventoryRoutes);

// GET /api/proxy-list
app.get("/api/proxy-list", async (req, res) => {
  try {
    const search = req.query.search || null;
    const result = await pool.query("SELECT * FROM sp_get_proxy_list($1)", [search]);
    res.json({ success: true, proxies: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/proxy-list/paginated — server-side paginated proxy list
app.get("/api/proxy-list/paginated", async (req, res) => {
  try {
    const search = req.query.search || null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const result = await pool.query(
      "SELECT * FROM sp_get_proxy_list_paginated($1, $2, $3)",
      [search, limit, offset]
    );

    const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
    const rows = result.rows.map(({ total_count, ...rest }) => rest);

    res.json({
      success: true,
      proxies: rows,
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error("GET /api/proxy-list/paginated failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/deployments/count
app.get("/api/deployments/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT sp_get_deployment_count() AS total");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/deployments/all — returns all deployed proxy+revision+environment (for auto-download)
app.get("/api/deployments/all", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.proxy_name, d.revision_number, d.environment
      FROM deployments d JOIN proxies p ON p.id = d.proxy_id
      ORDER BY p.proxy_name ASC, d.revision_number::int ASC, d.environment ASC
    `);

    // Group by proxy_name + revision_number, collect environments
    const map = {};
    for (const row of result.rows) {
      const key = `${row.proxy_name}::${row.revision_number}`;
      if (!map[key]) {
        map[key] = { proxy_name: row.proxy_name, revision_number: row.revision_number, environments: [] };
      }
      map[key].environments.push(row.environment);
    }

    res.json({ success: true, deployments: Object.values(map) });
  } catch (error) {
    console.error("GET /api/deployments/all failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/dashboard/stats — returns all dashboard stats in one call
app.get("/api/dashboard/stats", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sp_get_dashboard_stats()");
    const row = result.rows[0];
    res.json({
      success: true,
      proxies: parseInt(row.proxy_count),
      revisions: parseInt(row.revision_count),
      deployments: parseInt(row.deployment_count),
      deployed_revisions: parseInt(row.deployed_revision_count),
      api_count: parseInt(row.api_count),
      inventory_count: parseInt(row.inventory_count),
    });
  } catch (error) {
    console.error("GET /api/dashboard/stats failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/inventory/all — returns all inventory data for the Inventory tab (kept for export)
app.get("/api/inventory/all", async (req, res) => {
  try {
    const search = req.query.search || null;
    const result = await pool.query("SELECT * FROM sp_get_all_inventory($1)", [search]);
    res.json({ success: true, inventory: result.rows });
  } catch (error) {
    console.error("GET /api/inventory/all failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/inventory/paginated — server-side paginated flattened inventory
app.get("/api/inventory/paginated", async (req, res) => {
  try {
    const search = req.query.search || null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const result = await pool.query(
      "SELECT * FROM sp_get_inventory_paginated($1, $2, $3)",
      [search, limit, offset]
    );

    const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
    const rows = result.rows.map(({ total_count, ...rest }) => rest);

    res.json({
      success: true,
      rows,
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error("GET /api/inventory/paginated failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
