const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/proxies/:proxyName/deployments
router.get("/:proxyName/deployments", async (req, res) => {
  try {
    const { proxyName } = req.params;

    const result = await pool.query(
      `SELECT d.id, d.environment, d.revision_number, d.timestamp
       FROM deployments d
       JOIN proxies p ON p.id = d.proxy_id
       WHERE p.proxy_name = $1
       ORDER BY d.environment ASC, d.revision_number::int ASC`,
      [proxyName]
    );

    res.json({ success: true, deployments: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
