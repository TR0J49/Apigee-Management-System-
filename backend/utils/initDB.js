const pool = require("../db");

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxies (
      id SERIAL PRIMARY KEY,
      proxy_name TEXT NOT NULL UNIQUE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS revisions (
      id SERIAL PRIMARY KEY,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      revision_number TEXT NOT NULL,
      created_at TEXT,
      created_by TEXT,
      last_modified_at TEXT,
      last_modified_by TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_id, revision_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id SERIAL PRIMARY KEY,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      environment TEXT NOT NULL,
      revision_number TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_id, environment, revision_number)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name ON proxies (proxy_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id ON revisions (proxy_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id_num ON revisions (proxy_id, revision_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deploy_proxy_id ON deployments (proxy_id)`);

  console.log("Database tables and indexes initialized");
}

module.exports = initDB;
