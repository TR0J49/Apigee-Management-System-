const { Pool, types } = require("pg");

// Return TIMESTAMP values as raw strings so the pg driver does not convert to UTC
types.setTypeParser(1114, (str) => str); // TIMESTAMP WITHOUT TIME ZONE
types.setTypeParser(1184, (str) => str); // TIMESTAMP WITH TIME ZONE

const pool = new Pool({
  host: process.env.PG_HOST || "34.47.226.219",
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "provoapigee",
  options: "-c timezone=Asia/Kolkata",
});

module.exports = pool;
