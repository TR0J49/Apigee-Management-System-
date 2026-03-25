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

  // ========== NEW TABLE: proxy_inventory (stores parsed ZIP/XML data) ==========
  // This table stores the extracted inventory from apiproxy/proxies/*.xml
  // Data is populated when user clicks "See More" on a revision (lazy-load)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxy_inventory (
      id SERIAL PRIMARY KEY,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      revision_number TEXT NOT NULL,
      base_paths JSONB DEFAULT '[]',
      virtual_hosts JSONB DEFAULT '[]',
      flows JSONB DEFAULT '[]',
      policies JSONB DEFAULT '[]',
      used_policies JSONB DEFAULT '[]',
      target_endpoints JSONB DEFAULT '[]',
      proxy_endpoints JSONB DEFAULT '[]',
      parsed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_id, revision_number)
    )
  `);

  // ========== INDEXES ==========
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name ON proxies (proxy_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id ON revisions (proxy_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id_num ON revisions (proxy_id, revision_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deploy_proxy_id ON deployments (proxy_id)`);
  // NEW: Index for proxy_inventory lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_proxy_rev ON proxy_inventory (proxy_id, revision_number)`);

  // ========== STORED PROCEDURES ==========

  // 1. Truncate sync tables (preserve proxies, clear everything else for fresh sync)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_truncate_all()
    RETURNS VOID AS $$
    BEGIN
      TRUNCATE TABLE proxy_inventory, deployments, revisions RESTART IDENTITY;
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

  // 6b. Get proxy list with server-side pagination
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_proxy_list_paginated(
      p_search TEXT DEFAULT NULL,
      p_limit INT DEFAULT 50,
      p_offset INT DEFAULT 0
    )
    RETURNS TABLE(id INT, proxy_name TEXT, "timestamp" TIMESTAMP, total_count BIGINT) AS $$
    BEGIN
      RETURN QUERY
      WITH filtered AS (
        SELECT p.id, p.proxy_name, p.timestamp
        FROM proxies p
        WHERE (p_search IS NULL OR p.proxy_name ILIKE '%' || p_search || '%')
      ),
      counted AS (
        SELECT COUNT(*) AS cnt FROM filtered
      )
      SELECT f.id, f.proxy_name, f.timestamp, c.cnt AS total_count
      FROM filtered f, counted c
      ORDER BY f.proxy_name ASC
      LIMIT p_limit OFFSET p_offset;
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

  // ========== NEW STORED PROCEDURES: proxy_inventory ==========

  // 15. Upsert proxy inventory (called after ZIP parse)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_upsert_proxy_inventory(
      p_proxy_name TEXT, p_rev_number TEXT, p_base_paths JSONB,
      p_virtual_hosts JSONB, p_flows JSONB, p_policies JSONB,
      p_used_policies JSONB, p_target_endpoints JSONB, p_proxy_endpoints JSONB
    ) RETURNS VOID AS $$
    DECLARE
      v_proxy_id INT;
    BEGIN
      SELECT id INTO v_proxy_id FROM proxies WHERE proxy_name = p_proxy_name;
      IF v_proxy_id IS NULL THEN
        RAISE EXCEPTION 'Proxy "%" not found in proxies table', p_proxy_name;
      END IF;

      INSERT INTO proxy_inventory (proxy_id, revision_number, base_paths, virtual_hosts, flows, policies, used_policies, target_endpoints, proxy_endpoints)
      VALUES (v_proxy_id, p_rev_number, p_base_paths, p_virtual_hosts, p_flows, p_policies, p_used_policies, p_target_endpoints, p_proxy_endpoints)
      ON CONFLICT (proxy_id, revision_number) DO UPDATE SET
        base_paths = EXCLUDED.base_paths, virtual_hosts = EXCLUDED.virtual_hosts,
        flows = EXCLUDED.flows, policies = EXCLUDED.policies,
        used_policies = EXCLUDED.used_policies,
        target_endpoints = EXCLUDED.target_endpoints, proxy_endpoints = EXCLUDED.proxy_endpoints,
        parsed_at = CURRENT_TIMESTAMP;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 16. Get proxy inventory for a specific revision
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_proxy_inventory(p_proxy_name TEXT, p_rev_number TEXT)
    RETURNS TABLE(id INT, base_paths JSONB, virtual_hosts JSONB, flows JSONB, policies JSONB,
                  used_policies JSONB, target_endpoints JSONB, proxy_endpoints JSONB, parsed_at TIMESTAMP) AS $$
    BEGIN
      RETURN QUERY
      SELECT pi.id, pi.base_paths, pi.virtual_hosts, pi.flows, pi.policies,
             pi.used_policies, pi.target_endpoints, pi.proxy_endpoints, pi.parsed_at
      FROM proxy_inventory pi JOIN proxies p ON p.id = pi.proxy_id
      WHERE p.proxy_name = p_proxy_name AND pi.revision_number = p_rev_number;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 17. Get all inventory rows (flattened for table display)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_all_inventory(p_search TEXT DEFAULT NULL)
    RETURNS TABLE(
      id INT, proxy_name TEXT, revision_number TEXT,
      base_paths JSONB, virtual_hosts JSONB, flows JSONB,
      policies JSONB, used_policies JSONB,
      target_endpoints JSONB, proxy_endpoints JSONB,
      parsed_at TIMESTAMP
    ) AS $$
    BEGIN
      IF p_search IS NOT NULL THEN
        RETURN QUERY
        SELECT pi.id, p.proxy_name, pi.revision_number,
               pi.base_paths, pi.virtual_hosts, pi.flows,
               pi.policies, pi.used_policies,
               pi.target_endpoints, pi.proxy_endpoints,
               pi.parsed_at
        FROM proxy_inventory pi JOIN proxies p ON p.id = pi.proxy_id
        WHERE p.proxy_name ILIKE '%' || p_search || '%'
        ORDER BY p.proxy_name ASC, pi.revision_number::int ASC;
      ELSE
        RETURN QUERY
        SELECT pi.id, p.proxy_name, pi.revision_number,
               pi.base_paths, pi.virtual_hosts, pi.flows,
               pi.policies, pi.used_policies,
               pi.target_endpoints, pi.proxy_endpoints,
               pi.parsed_at
        FROM proxy_inventory pi JOIN proxies p ON p.id = pi.proxy_id
        ORDER BY p.proxy_name ASC, pi.revision_number::int ASC;
      END IF;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 18. Get dashboard stats in one call (proxies, revisions, deployments, deployed revisions, API/flow count, inventory count)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_dashboard_stats()
    RETURNS TABLE(
      proxy_count BIGINT, revision_count BIGINT, deployment_count BIGINT,
      deployed_revision_count BIGINT, api_count BIGINT, inventory_count BIGINT
    ) AS $$
    BEGIN
      RETURN QUERY
      SELECT
        (SELECT COUNT(*) FROM proxies),
        (SELECT COUNT(*) FROM revisions),
        (SELECT COUNT(*) FROM deployments),
        (SELECT COUNT(DISTINCT (proxy_id, revision_number)) FROM deployments),
        (SELECT COALESCE(SUM(jsonb_array_length(flows)), 0) FROM proxy_inventory),
        (SELECT COUNT(*) FROM proxy_inventory);
    END;
    $$ LANGUAGE plpgsql
  `);

  // 19. Get flattened inventory with server-side pagination (one row per flow)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_inventory_paginated(
      p_search TEXT DEFAULT NULL,
      p_limit INT DEFAULT 50,
      p_offset INT DEFAULT 0
    )
    RETURNS TABLE(
      proxy_name TEXT, revision_number TEXT, endpoint TEXT, total_count BIGINT
    ) AS $$
    BEGIN
      RETURN QUERY
      WITH flattened AS (
        SELECT
          p.proxy_name,
          pi.revision_number,
          COALESCE(
            f->>'fullPath',
            (SELECT string_agg(bp::text, ', ') FROM jsonb_array_elements_text(pi.base_paths) bp),
            '-'
          ) AS endpoint
        FROM proxy_inventory pi
        JOIN proxies p ON p.id = pi.proxy_id
        CROSS JOIN LATERAL (
          SELECT f FROM jsonb_array_elements(
            CASE WHEN jsonb_array_length(pi.flows) > 0 THEN pi.flows ELSE '[null]'::jsonb END
          ) AS f
        ) flows(f)
        WHERE (p_search IS NULL OR p.proxy_name ILIKE '%' || p_search || '%')
      ),
      counted AS (
        SELECT COUNT(*) AS cnt FROM flattened
      )
      SELECT fl.proxy_name, fl.revision_number, fl.endpoint,
             c.cnt AS total_count
      FROM flattened fl, counted c
      ORDER BY fl.proxy_name ASC, fl.revision_number::int ASC
      LIMIT p_limit OFFSET p_offset;
    END;
    $$ LANGUAGE plpgsql
  `);

  console.log("Database tables, indexes, and stored procedures initialized");
}

module.exports = initDB;
