const express = require("express");
const axios = require("axios");
const { setToken } = require("../utils/token");

const router = express.Router();

// POST /api/token
router.post("/", async (req, res) => {
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

    const expiresIn = response.data.expires_in || 1799;
    setToken(response.data.access_token, expiresIn);

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

module.exports = router;
