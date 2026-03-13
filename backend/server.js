require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const pool = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

let cachedToken = null;

// POST /api/token — Generate OAuth token from Apigee
app.post("/api/token", async (req, res) => {
  try {
    const basicAuth = Buffer.from(
      `${process.env.APIGEE_CLIENT_ID}:${process.env.APIGEE_CLIENT_SECRET}`
    ).toString("base64");

    const params = new URLSearchParams();
    params.append("grant_type", "password");
    params.append("response_type", "token");
    params.append("username", process.env.APIGEE_USERNAME);
    params.append("password", process.env.APIGEE_PASSWORD);

    const response = await axios.post(process.env.APIGEE_TOKEN_URL, params, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    cachedToken = response.data.access_token;

    res.json({
      success: true,
      message: "Token generated successfully",
      token_type: response.data.token_type,
      expires_in: response.data.expires_in,
    });
  } catch (error) {
    console.error("Token generation failed:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Failed to generate token",
      error: error.response?.data || error.message,
    });
  }
});

// GET /api/proxies — Fetch proxies from Apigee and save to DB
app.get("/api/proxies", async (req, res) => {
  try {
    if (!cachedToken) {
      return res.status(401).json({
        success: false,
        message: "No token available. Generate a token first.",
      });
    }

    const response = await axios.get(process.env.APIGEE_MGMT_API_URL, {
      headers: {
        Authorization: `Bearer ${cachedToken}`,
        Accept: "application/json",
      },
    });

    // Apigee returns an array of proxy names
    const proxyNames = response.data;

    // Insert proxies into database (skip duplicates)
    for (const name of proxyNames) {
      await pool.query(
        "INSERT INTO proxies (proxy_name) VALUES ($1) ON CONFLICT (proxy_name) DO NOTHING",
        [name]
      );
    }

    // Fetch all proxies from DB
    const result = await pool.query("SELECT * FROM proxies ORDER BY id ASC");

    res.json({ success: true, proxies: result.rows });
  } catch (error) {
    console.error("Proxy fetch failed:");
    console.error("Status:", error.response?.status);
    console.error("Data:", JSON.stringify(error.response?.data, null, 2));
    console.error("Message:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch proxies",
      error: error.response?.data || error.message,
    });
  }
});

// GET /api/proxies/db — Fetch proxies only from local DB
app.get("/api/proxies/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM proxies ORDER BY id ASC");
    res.json({ success: true, proxies: result.rows });
  } catch (error) {
    console.error("DB fetch failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch from database",
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
