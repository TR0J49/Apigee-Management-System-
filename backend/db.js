const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PG_HOST || "34.47.226.219",
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "provoapigee",
});

module.exports = pool;
