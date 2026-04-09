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

  // ========== NEW TABLE: proxy_policies (stores parsed policy attributes from ZIP) ==========
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxy_policies (
      id SERIAL PRIMARY KEY,
      proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
      revision_number TEXT NOT NULL,
      policy_name TEXT NOT NULL,
      policy_type TEXT DEFAULT '',
      async TEXT DEFAULT 'false',
      continue_on_error TEXT DEFAULT 'false',
      enabled TEXT DEFAULT 'true',
      UNIQUE(proxy_id, revision_number, policy_name)
    )
  `);

  // ========== NEW TABLE: sharedflows ==========
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sharedflows (
      id SERIAL PRIMARY KEY,
      sharedflow_name TEXT NOT NULL UNIQUE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ========== NEW TABLE: sharedflow_revisions ==========
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sharedflow_revisions (
      id SERIAL PRIMARY KEY,
      sharedflow_id INTEGER NOT NULL REFERENCES sharedflows(id) ON DELETE CASCADE,
      revision_number TEXT NOT NULL,
      created_at TEXT,
      created_by TEXT,
      last_modified_at TEXT,
      last_modified_by TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sharedflow_id, revision_number)
    )
  `);

  // ========== NEW TABLE: sharedflow_deployments ==========
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sharedflow_deployments (
      id SERIAL PRIMARY KEY,
      sharedflow_id INTEGER NOT NULL REFERENCES sharedflows(id) ON DELETE CASCADE,
      environment TEXT NOT NULL,
      revision_number TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sharedflow_id, environment, revision_number)
    )
  `);

  // ========== NEW TABLE: sharedflow_policies ==========
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sharedflow_policies (
      id SERIAL PRIMARY KEY,
      sharedflow_id INTEGER NOT NULL REFERENCES sharedflows(id) ON DELETE CASCADE,
      revision_number TEXT NOT NULL,
      policy_name TEXT NOT NULL,
      policy_type TEXT DEFAULT '',
      async TEXT DEFAULT 'false',
      continue_on_error TEXT DEFAULT 'false',
      enabled TEXT DEFAULT 'true',
      UNIQUE(sharedflow_id, revision_number, policy_name)
    )
  `);

  // ========== MIGRATIONS (add columns to existing tables) ==========
  await pool.query(`ALTER TABLE proxy_policies ADD COLUMN IF NOT EXISTS policy_type TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE proxy_policies ADD COLUMN IF NOT EXISTS shared_flow_bundle TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE proxy_policies ADD COLUMN IF NOT EXISTS class_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE proxy_policies ADD COLUMN IF NOT EXISTS resource_url TEXT DEFAULT ''`);

  // ========== INDEXES ==========
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_proxy_name ON proxies (proxy_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id ON revisions (proxy_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rev_proxy_id_num ON revisions (proxy_id, revision_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deploy_proxy_id ON deployments (proxy_id)`);
  // NEW: Index for sharedflows lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sharedflow_name ON sharedflows (sharedflow_name)`);
  // NEW: Index for sharedflow_revisions lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sf_rev_sharedflow_id ON sharedflow_revisions (sharedflow_id)`);
  // NEW: Index for sharedflow_deployments lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sf_deploy_sharedflow_id ON sharedflow_deployments (sharedflow_id)`);
  // NEW: Index for sharedflow_policies lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sf_policies_sf_rev ON sharedflow_policies (sharedflow_id, revision_number)`);
  // NEW: Index for proxy_inventory lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_proxy_rev ON proxy_inventory (proxy_id, revision_number)`);
  // NEW: Index for proxy_policies lookups
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_policies_proxy_rev ON proxy_policies (proxy_id, revision_number)`);

  // ========== STORED PROCEDURES ==========

  // 1. Truncate sync tables (preserve proxies, clear everything else for fresh sync)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_truncate_all()
    RETURNS VOID AS $$
    BEGIN
      TRUNCATE TABLE proxy_policies, proxy_inventory, deployments, revisions, sharedflow_policies, sharedflow_deployments, sharedflow_revisions, sharedflows RESTART IDENTITY;
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
        ORDER BY p.id ASC;
      ELSE
        RETURN QUERY
        SELECT p.id, p.proxy_name, p.timestamp FROM proxies p
        ORDER BY p.id ASC;
      END IF;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 6b. Get proxy list with server-side pagination
  await pool.query(`DROP FUNCTION IF EXISTS sp_get_proxy_list_paginated(TEXT, INT, INT)`);
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
      ORDER BY f.id ASC
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
    DROP FUNCTION IF EXISTS sp_get_dashboard_stats();
    CREATE OR REPLACE FUNCTION sp_get_dashboard_stats()
    RETURNS TABLE(
      proxy_count BIGINT, revision_count BIGINT, deployment_count BIGINT,
      deployed_revision_count BIGINT, api_count BIGINT, inventory_count BIGINT,
      policy_count BIGINT, sharedflow_count BIGINT,
      sf_revision_count BIGINT, sf_deployed_revision_count BIGINT,
      sf_policy_count BIGINT
    ) AS $$
    BEGIN
      RETURN QUERY
      SELECT
        (SELECT COUNT(*) FROM proxies),
        (SELECT COUNT(*) FROM revisions),
        (SELECT COUNT(*) FROM deployments),
        (SELECT COUNT(DISTINCT (proxy_id, revision_number)) FROM deployments),
        (SELECT COALESCE(SUM(jsonb_array_length(flows)), 0) FROM proxy_inventory),
        (SELECT COUNT(*) FROM proxy_inventory),
        (SELECT COUNT(*) FROM proxy_policies),
        (SELECT COUNT(*) FROM sharedflows),
        (SELECT COUNT(*) FROM sharedflow_revisions),
        (SELECT COUNT(DISTINCT (sharedflow_id, revision_number)) FROM sharedflow_deployments),
        (SELECT COUNT(*) FROM sharedflow_policies);
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

  // ========== STORED PROCEDURES: sharedflows ==========

  // 22. Upsert shared flow names — accepts array of names
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_upsert_sharedflows(p_names TEXT[])
    RETURNS TABLE(out_id INT, out_sharedflow_name TEXT) AS $$
    BEGIN
      INSERT INTO sharedflows (sharedflow_name)
      SELECT unnest(p_names)
      ON CONFLICT (sharedflow_name) DO UPDATE SET "timestamp" = CURRENT_TIMESTAMP;

      RETURN QUERY
      SELECT s.id, s.sharedflow_name FROM sharedflows s WHERE s.sharedflow_name = ANY(p_names);
    END;
    $$ LANGUAGE plpgsql
  `);

  // 23. Get all shared flows
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_sharedflows()
    RETURNS TABLE(id INT, sharedflow_name TEXT, "timestamp" TIMESTAMP) AS $$
    BEGIN
      RETURN QUERY
      SELECT s.id, s.sharedflow_name, s.timestamp FROM sharedflows s
      ORDER BY s.sharedflow_name ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 24. Get shared flow count
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_sharedflow_count()
    RETURNS BIGINT AS $$
      SELECT COUNT(*) FROM sharedflows;
    $$ LANGUAGE sql
  `);

  // 25. Bulk insert sharedflow revisions (revision_number only, details filled later)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_insert_sharedflow_revisions(p_sf_ids INT[], p_rev_numbers TEXT[])
    RETURNS VOID AS $$
    BEGIN
      INSERT INTO sharedflow_revisions (sharedflow_id, revision_number)
      SELECT unnest(p_sf_ids), unnest(p_rev_numbers)
      ON CONFLICT (sharedflow_id, revision_number) DO NOTHING;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 26. Bulk update sharedflow revision details
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_bulk_update_sf_revision_details(
      p_ids INT[], p_created_ats TEXT[], p_created_bys TEXT[], p_modified_ats TEXT[], p_modified_bys TEXT[]
    ) RETURNS VOID AS $$
    BEGIN
      UPDATE sharedflow_revisions SET
        created_at = data.created_at,
        created_by = data.created_by,
        last_modified_at = data.last_modified_at,
        last_modified_by = data.last_modified_by
      FROM (SELECT unnest(p_ids) AS id, unnest(p_created_ats) AS created_at,
              unnest(p_created_bys) AS created_by, unnest(p_modified_ats) AS last_modified_at,
              unnest(p_modified_bys) AS last_modified_by) AS data
      WHERE sharedflow_revisions.id = data.id;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 27. Get revisions for a shared flow
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_sharedflow_revisions(p_sf_name TEXT)
    RETURNS TABLE(id INT, revision_number TEXT, created_at TEXT, created_by TEXT,
                  last_modified_at TEXT, last_modified_by TEXT, "timestamp" TIMESTAMP) AS $$
    BEGIN
      RETURN QUERY
      SELECT sr.id, sr.revision_number, sr.created_at, sr.created_by,
             sr.last_modified_at, sr.last_modified_by, sr.timestamp
      FROM sharedflow_revisions sr JOIN sharedflows s ON s.id = sr.sharedflow_id
      WHERE s.sharedflow_name = p_sf_name
      ORDER BY sr.revision_number::int ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 28. Get unfilled sharedflow revisions (for background detail fill)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_unfilled_sf_revisions()
    RETURNS TABLE(id INT, sharedflow_name TEXT, revision_number TEXT) AS $$
    BEGIN
      RETURN QUERY
      SELECT sr.id, s.sharedflow_name, sr.revision_number
      FROM sharedflow_revisions sr JOIN sharedflows s ON s.id = sr.sharedflow_id
      WHERE sr.created_by IS NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 29. Bulk insert sharedflow deployments
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_insert_sharedflow_deployments(p_sf_ids INT[], p_environments TEXT[], p_rev_numbers TEXT[])
    RETURNS VOID AS $$
    BEGIN
      INSERT INTO sharedflow_deployments (sharedflow_id, environment, revision_number)
      SELECT unnest(p_sf_ids), unnest(p_environments), unnest(p_rev_numbers)
      ON CONFLICT (sharedflow_id, environment, revision_number) DO NOTHING;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 30. Get deployments for a shared flow
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_sharedflow_deployments(p_sf_name TEXT)
    RETURNS TABLE(id INT, environment TEXT, revision_number TEXT, "timestamp" TIMESTAMP) AS $$
    BEGIN
      RETURN QUERY
      SELECT sd.id, sd.environment, sd.revision_number, sd.timestamp
      FROM sharedflow_deployments sd JOIN sharedflows s ON s.id = sd.sharedflow_id
      WHERE s.sharedflow_name = p_sf_name
      ORDER BY sd.environment ASC, sd.revision_number::int ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  // ========== STORED PROCEDURES: sharedflow_policies ==========

  // 31. Bulk upsert sharedflow policies (called after ZIP parse)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_upsert_sharedflow_policies(
      p_sf_name TEXT, p_rev_number TEXT,
      p_policy_names TEXT[], p_policy_types TEXT[], p_asyncs TEXT[], p_continue_on_errors TEXT[], p_enableds TEXT[]
    ) RETURNS VOID AS $$
    DECLARE
      v_sf_id INT;
    BEGIN
      SELECT id INTO v_sf_id FROM sharedflows WHERE sharedflow_name = p_sf_name;
      IF v_sf_id IS NULL THEN
        RAISE EXCEPTION 'SharedFlow "%" not found in sharedflows table', p_sf_name;
      END IF;

      INSERT INTO sharedflow_policies (sharedflow_id, revision_number, policy_name, policy_type, async, continue_on_error, enabled)
      SELECT v_sf_id, p_rev_number, unnest(p_policy_names), unnest(p_policy_types), unnest(p_asyncs), unnest(p_continue_on_errors), unnest(p_enableds)
      ON CONFLICT (sharedflow_id, revision_number, policy_name) DO UPDATE SET
        policy_type = EXCLUDED.policy_type,
        async = EXCLUDED.async,
        continue_on_error = EXCLUDED.continue_on_error,
        enabled = EXCLUDED.enabled;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 32. Get policies for a specific sharedflow revision
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_sharedflow_policies(p_sf_name TEXT, p_rev_number TEXT)
    RETURNS TABLE(policy_name TEXT, policy_type TEXT, async TEXT, continue_on_error TEXT, enabled TEXT) AS $$
    BEGIN
      RETURN QUERY
      SELECT sp.policy_name, sp.policy_type, sp.async, sp.continue_on_error, sp.enabled
      FROM sharedflow_policies sp JOIN sharedflows s ON s.id = sp.sharedflow_id
      WHERE s.sharedflow_name = p_sf_name AND sp.revision_number = p_rev_number
      ORDER BY sp.policy_name ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  // ========== STORED PROCEDURES: proxy_policies ==========

  // Drop old signatures before recreating with new columns
  await pool.query(`DROP FUNCTION IF EXISTS sp_upsert_proxy_policies(TEXT, TEXT, TEXT[], TEXT[], TEXT[], TEXT[])`);
  await pool.query(`DROP FUNCTION IF EXISTS sp_upsert_proxy_policies(TEXT, TEXT, TEXT[], TEXT[], TEXT[], TEXT[], TEXT[])`);
  await pool.query(`DROP FUNCTION IF EXISTS sp_get_proxy_policies(TEXT, TEXT)`);

  // 20. Bulk upsert proxy policies (called after ZIP parse)
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_upsert_proxy_policies(
      p_proxy_name TEXT, p_rev_number TEXT,
      p_policy_names TEXT[], p_policy_types TEXT[], p_asyncs TEXT[], p_continue_on_errors TEXT[], p_enableds TEXT[],
      p_shared_flow_bundles TEXT[], p_class_names TEXT[], p_resource_urls TEXT[]
    ) RETURNS VOID AS $$
    DECLARE
      v_proxy_id INT;
    BEGIN
      SELECT id INTO v_proxy_id FROM proxies WHERE proxy_name = p_proxy_name;
      IF v_proxy_id IS NULL THEN
        RAISE EXCEPTION 'Proxy "%" not found in proxies table', p_proxy_name;
      END IF;

      INSERT INTO proxy_policies (proxy_id, revision_number, policy_name, policy_type, async, continue_on_error, enabled, shared_flow_bundle, class_name, resource_url)
      SELECT v_proxy_id, p_rev_number, unnest(p_policy_names), unnest(p_policy_types), unnest(p_asyncs), unnest(p_continue_on_errors), unnest(p_enableds), unnest(p_shared_flow_bundles), unnest(p_class_names), unnest(p_resource_urls)
      ON CONFLICT (proxy_id, revision_number, policy_name) DO UPDATE SET
        policy_type = EXCLUDED.policy_type,
        async = EXCLUDED.async,
        continue_on_error = EXCLUDED.continue_on_error,
        enabled = EXCLUDED.enabled,
        shared_flow_bundle = EXCLUDED.shared_flow_bundle,
        class_name = EXCLUDED.class_name,
        resource_url = EXCLUDED.resource_url;
    END;
    $$ LANGUAGE plpgsql
  `);

  // 21. Get policies for a specific proxy revision
  await pool.query(`
    CREATE OR REPLACE FUNCTION sp_get_proxy_policies(p_proxy_name TEXT, p_rev_number TEXT)
    RETURNS TABLE(policy_name TEXT, policy_type TEXT, async TEXT, continue_on_error TEXT, enabled TEXT, shared_flow_bundle TEXT, class_name TEXT, resource_url TEXT) AS $$
    BEGIN
      RETURN QUERY
      SELECT pp.policy_name, pp.policy_type, pp.async, pp.continue_on_error, pp.enabled, pp.shared_flow_bundle, pp.class_name, pp.resource_url
      FROM proxy_policies pp JOIN proxies p ON p.id = pp.proxy_id
      WHERE p.proxy_name = p_proxy_name AND pp.revision_number = p_rev_number
      ORDER BY pp.policy_name ASC;
    END;
    $$ LANGUAGE plpgsql
  `);

  console.log("Database tables, indexes, and stored procedures initialized");
}

module.exports = initDB;
