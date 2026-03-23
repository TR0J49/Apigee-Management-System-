const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/proxies/:proxyName/deployments
router.get("/:proxyName/deployments", async (req, res) => {
  try {
    const { proxyName } = req.params;
    const result = await pool.query("SELECT * FROM sp_get_deployments($1)", [proxyName]);
    res.json({ success: true, deployments: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
