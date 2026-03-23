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

const app = express();
app.use(cors());
app.use(express.json());

// Initialize database tables, indexes, and stored procedures
initDB().catch((err) => console.error("DB init failed:", err.message));

// Mount routes
app.use("/api/token", tokenRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/proxies", proxyRoutes);
app.use("/api/proxies", revisionRoutes);
app.use("/api/proxies", deploymentRoutes);
app.use("/api/proxies", downloadRoutes);

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

// GET /api/deployments/count
app.get("/api/deployments/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT sp_get_deployment_count() AS total");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
