const axios = require("axios");

let tokenCache = { token: null, expiresAt: 0 };

function isTokenValid() {
  return tokenCache.token && Date.now() < tokenCache.expiresAt;
}

function getToken() {
  if (!isTokenValid()) return null;
  return tokenCache.token;
}

function setToken(token, expiresIn) {
  tokenCache = {
    token,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };
}

async function autoGenerateToken() {
  if (isTokenValid()) return;

  const basicAuth = Buffer.from(
    `${process.env.APIGEE_CLIENT_ID}:${process.env.APIGEE_CLIENT_SECRET}`
  ).toString("base64");

  const params = new URLSearchParams();
  params.append("grant_type", "password");
  params.append("response_type", "token");
  params.append("username", process.env.APIGEE_USERNAME);
  params.append("password", process.env.APIGEE_PASSWORD);

  const tokenRes = await axios.post(process.env.APIGEE_TOKEN_URL, params, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const expiresIn = tokenRes.data.expires_in || 1799;
  setToken(tokenRes.data.access_token, expiresIn);
  console.log("Token auto-generated");
}

module.exports = { isTokenValid, getToken, setToken, autoGenerateToken };
