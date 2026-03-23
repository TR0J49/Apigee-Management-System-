const pool = require("../db");

async function initDB() {
  // ========== TABLES ==========
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

  // ========== INDEXES ==========
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name ON proxies (proxy_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id ON revisions (proxy_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id_num ON revisions (proxy_id, revision_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deploy_proxy_id ON deployments (proxy_id)`);

  // ========== STORED PROCEDURES ==========

  // 1. Truncate all tables
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_truncate_all()
    RETURNS VOID AS $$
    BEGIN
      TRUNCATE TABLE deployments, revisions, proxies RESTART IDENTITY CASCADE;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 2. Upsert proxy names — accepts array of names
  await pool.query(`DROP FUNCTION IF EXISTS sp_upsert_proxies(TEXT[]) CASCADE`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_upsert_proxies(p_names TEXT[])
    RETURNS TABLE(out_id INT, out_proxy_name TEXT) AS $$
    BEGIN
      INSERT INTO proxies (proxy_name)
      SELECT unnest(p_names)
      ON CONFLICT (proxy_name) DO UPDATE SET "timestamp" = CURRENT_TIMESTAMP;

      RETURN QUERY
      SELECT p.id, p.proxy_name FROM proxies p WHERE p.proxy_name = ANY(p_names);
    END;
    $$ LANGUAGE plpgsql
  `);

  // 3. Bulk insert revisions — accepts parallel arrays
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_insert_revisions(p_proxy_ids INT[], p_rev_numbers TEXT[])
    RETURNS VOID AS $$
    BEGIN
      INSERT INTO revisions (proxy_id, revision_number)
      SELECT unnest(p_proxy_ids), unnest(p_rev_numbers)
      ON CONFLICT (proxy_id, revision_number) DO NOTHING;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 4. Bulk insert deployments — accepts parallel arrays
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_insert_deployments(p_proxy_ids INT[], p_environments TEXT[], p_rev_numbers TEXT[])
    RETURNS VOID AS $$
    BEGIN
      INSERT INTO deployments (proxy_id, environment, revision_number)
      SELECT unnest(p_proxy_ids), unnest(p_environments), unnest(p_rev_numbers)
      ON CONFLICT (proxy_id, environment, revision_number) DO NOTHING;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 5. Get all counts in one call
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_counts()
    RETURNS TABLE(proxy_count BIGINT, revision_count BIGINT, deployment_count BIGINT) AS $$
    BEGIN
      RETURN QUERY
      SELECT
        (SELECT COUNT(*) FROM proxies),
        (SELECT COUNT(*) FROM revisions),
        (SELECT COUNT(*) FROM deployments);
    END;
    $$ LANGUAGE plpgsql
  `);

  // 6. Get proxy list with optional search
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_proxy_list(p_search TEXT DEFAULT NULL)
    RETURNS TABLE(id INT, proxy_name TEXT, "timestamp" TIMESTAMP) AS $$
    BEGIN
      IF p_search IS NOT NULL THEN
        RETURN QUERY
        SELECT p.id, p.proxy_name, p.timestamp FROM proxies p
        WHERE p.proxy_name ILIKE '%' || p_search || '%'
        ORDER BY p.proxy_name ASC;
      ELSE
        RETURN QUERY
        SELECT p.id, p.proxy_name, p.timestamp FROM proxies p
        ORDER BY p.proxy_name ASC;
      END IF;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 7. Get revision count
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_revision_count()
    RETURNS BIGINT AS $$
      SELECT COUNT(*) FROM revisions;
    $$ LANGUAGE sql
  `);

  // 8. Get deployment count
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_deployment_count()
    RETURNS BIGINT AS $$
      SELECT COUNT(*) FROM deployments;
    $$ LANGUAGE sql
  `);

  // 9. Get revisions for a proxy
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_revisions(p_proxy_name TEXT)
    RETURNS TABLE(revision_number TEXT) AS $$
    BEGIN
      RETURN QUERY
      SELECT r.revision_number
      FROM revisions r JOIN proxies p ON p.id = r.proxy_id
      WHERE p.proxy_name = p_proxy_name
      ORDER BY r.revision_number::int ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 10. Get revision detail
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_revision_detail(p_proxy_name TEXT, p_rev_number TEXT)
    RETURNS TABLE(id INT, proxy_name TEXT, revision_number TEXT, created_at TEXT,
                  created_by TEXT, last_modified_at TEXT, last_modified_by TEXT, "timestamp" TIMESTAMP) AS $$
    BEGIN
      RETURN QUERY
      SELECT r.id, p.proxy_name, r.revision_number, r.created_at, r.created_by,
             r.last_modified_at, r.last_modified_by, r.timestamp
      FROM revisions r JOIN proxies p ON p.id = r.proxy_id
      WHERE p.proxy_name = p_proxy_name AND r.revision_number = p_rev_number;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 11. Update revision detail (lazy load)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_update_revision_detail(
      p_id INT, p_created_at TEXT, p_created_by TEXT, p_last_modified_at TEXT, p_last_modified_by TEXT
    ) RETURNS VOID AS $$
    BEGIN
      UPDATE revisions SET created_at = p_created_at, created_by = p_created_by,
        last_modified_at = p_last_modified_at, last_modified_by = p_last_modified_by
      WHERE id = p_id;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 12. Get deployments for a proxy
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_deployments(p_proxy_name TEXT)
    RETURNS TABLE(id INT, environment TEXT, revision_number TEXT, "timestamp" TIMESTAMP) AS $$
    BEGIN
      RETURN QUERY
      SELECT d.id, d.environment, d.revision_number, d.timestamp
      FROM deployments d JOIN proxies p ON p.id = d.proxy_id
      WHERE p.proxy_name = p_proxy_name
      ORDER BY d.environment ASC, d.revision_number::int ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 13. Get revisions with NULL details (for background fill)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_unfilled_revisions()
    RETURNS TABLE(id INT, proxy_name TEXT, revision_number TEXT) AS $$
    BEGIN
      RETURN QUERY
      SELECT r.id, p.proxy_name, r.revision_number
      FROM revisions r JOIN proxies p ON p.id = r.proxy_id
      WHERE r.created_by IS NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 14. Bulk update revision details
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_bulk_update_revision_details(
      p_ids INT[], p_created_ats TEXT[], p_created_bys TEXT[], p_modified_ats TEXT[], p_modified_bys TEXT[]
    ) RETURNS VOID AS $$
    BEGIN
      UPDATE revisions SET
        created_at = data.created_at,
        created_by = data.created_by,
        last_modified_at = data.last_modified_at,
        last_modified_by = data.last_modified_by
      FROM (SELECT unnest(p_ids) AS id, unnest(p_created_ats) AS created_at,
              unnest(p_created_bys) AS created_by, unnest(p_modified_ats) AS last_modified_at,
              unnest(p_modified_bys) AS last_modified_by) AS data
      WHERE revisions.id = data.id;
    END;
    $$ LANGUAGE plpgsql
  `);

  console.log("Database tables, indexes, and stored procedures initialized");
}

module.exports = initDB;
