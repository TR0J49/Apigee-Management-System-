const express = require("express");
const axios = require("axios");
const { getToken, autoGenerateToken } = require("../utils/token");

const router = express.Router();

// GET /api/proxies/:proxyName/revisions/:revNumber/download
router.get("/:proxyName/revisions/:revNumber/download", async (req, res) => {
  try {
    await autoGenerateToken();
    const token = getToken();
    if (!token) {
      return res.status(401).json({ success: false, message: "No Token Available" });
    }

    const { proxyName, revNumber } = req.params;
    const envName = req.query.env || "";
    const baseUrl = process.env.APIGEE_MGMT_API_URL;
    const url = `${baseUrl}/${encodeURIComponent(proxyName)}/revisions/${revNumber}?format=bundle`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/zip",
      },
      responseType: "arraybuffer",
    });

    const envSuffix = envName ? `_${envName}` : "";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${proxyName}_rev${revNumber}${envSuffix}.zip"`);
    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error("Download failed:", error.response?.status, error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({
        success: false,
        message: "Failed to download proxy bundle",
        error: error.message,
      });
    }
  }
});

module.exports = router;

