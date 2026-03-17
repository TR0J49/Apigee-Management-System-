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

const app = express();
app.use(cors());
app.use(express.json());

// Initialize database tables and indexes
initDB().catch((err) => console.error("DB init failed:", err.message));

// Mount routes
app.use("/api/token", tokenRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/proxies", proxyRoutes);       // GET /api/proxies, GET /api/proxies/count
app.use("/api/proxies", revisionRoutes);     // GET /api/proxies/:name/revisions, GET /api/proxies/:name/revisions/:rev
app.use("/api/proxies", deploymentRoutes);   // GET /api/proxies/:name/deployments

// GET /api/proxy-list
app.get("/api/proxy-list", async (req, res) => {
  try {
    const search = req.query.search;
    let result;
    if (search) {
      result = await pool.query(
        `SELECT id, proxy_name, timestamp FROM proxies WHERE proxy_name ILIKE $1 ORDER BY proxy_name ASC`,
        [`%${search}%`]
      );
    } else {
      result = await pool.query(
        `SELECT id, proxy_name, timestamp FROM proxies ORDER BY proxy_name ASC`
      );
    }
    res.json({ success: true, proxies: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/deployments/count
app.get("/api/deployments/count", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*) AS total FROM deployments");
    res.json({ success: true, total: parseInt(result.rows[0].total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
