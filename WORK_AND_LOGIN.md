# Work Summary & Login Details

---

## Admin Login Credentials

| Field    | Value              |
| -------- | ------------------ |
| Email    | admin@apigee.com   |
| Password | admin123           |

**How to login:** Click the Settings (gear) icon in the top-right corner of the navbar. Enter the credentials above and click "Login".

---

## Current Architecture

### Tech Stack

| Layer    | Technology                |
| -------- | ------------------------- |
| Frontend | React 18 + React Router   |
| Backend  | Node.js + Express         |
| Database | PostgreSQL (3 tables)     |
| HTTP     | Axios + p-limit (200 concurrent) |

### Database Schema (3 Relational Tables)

```sql
-- 1. Proxies table (stores unique proxy names)
proxies (
  id SERIAL PRIMARY KEY,
  proxy_name TEXT NOT NULL UNIQUE,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

-- 2. Revisions table (FK to proxies, stores revision numbers)
revisions (
  id SERIAL PRIMARY KEY,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE CASCADE,
  revision_number TEXT NOT NULL,
  created_at TEXT,          -- Lazy loaded from Apigee on-demand
  created_by TEXT,          -- Lazy loaded from Apigee on-demand
  last_modified_at TEXT,    -- Lazy loaded from Apigee on-demand
  last_modified_by TEXT,    -- Lazy loaded from Apigee on-demand
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proxy_id, revision_number)
)

-- 3. Deployments table (FK to proxies, stores environment deployments)
deployments (
  id SERIAL PRIMARY KEY,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  revision_number TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proxy_id, environment, revision_number)
)
```

### Proxy Filter

Only proxies matching these keywords are stored:
- **EazyPay**
- **composite**
- **CIB**
- **NPCI**
- **D365**

---

## Application Flow

### 1. User clicks "Get Started" on Home page
- Redirects to `/dashboard?sync=true`
- Dashboard detects `?sync=true` and auto-triggers sync

### 2. Sync Process (POST /api/sync) — ~3-5 seconds
```
Step 1: Auto-generate OAuth token (if expired)
Step 2: Fetch proxy names → Filter by keywords
Step 3: IN PARALLEL:
  - Fetch revision lists for all proxies (200 concurrent)
  - Fetch deployment info for all proxies (200 concurrent)
  - Query DB for existing revisions (delta check)
Step 4: Insert only NEW revisions (proxy_id + revision_number only)
Step 5: Save deployments (DELETE old + INSERT fresh)
```

**Key optimization:** Revision details (created_by, created_at, etc.) are NOT fetched during sync. They are lazy-loaded on-demand when user clicks "See More" on a specific revision.

### 3. Dashboard shows proxy list from DB
- Search/filter by proxy name
- Pagination (1000 rows per page)
- Click "Check Revision" to see all revisions for a proxy

### 4. Revision List page
- Shows all revision numbers for selected proxy
- Green environment tags show where each revision is deployed
- Click "See More" to view revision detail

### 5. Revision Detail page (Lazy Loading)
- When clicked, backend checks if detail fields exist in DB
- If empty → fetches from Apigee API → saves to DB → returns data
- Next click uses cached DB data (instant)

---

## API Endpoints

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| POST | `/api/token` | Generate OAuth token from Apigee |
| POST | `/api/sync` | Auto token + fetch proxies + revisions + deployments |
| GET | `/api/proxy-list` | List all proxies from DB |
| GET | `/api/proxies/count` | Total revisions count |
| GET | `/api/proxies/:name/revisions` | Revision list for a proxy |
| GET | `/api/proxies/:name/revisions/:rev` | Revision detail (lazy loads from Apigee) |
| GET | `/api/proxies/:name/deployments` | Deployment info for a proxy |
| GET | `/api/deployments/count` | Total deployments count |

---

## DSA & Optimization Techniques Used

| Technique | Where | Purpose |
| --------- | ----- | ------- |
| HashSet (delta sync) | Sync Step 3 | O(1) lookup to skip already-stored revisions |
| LRU Cache | Revision detail + list endpoints | Avoid repeated DB queries |
| TTL Token Cache | Token management | Auto-reject expired tokens |
| B-Tree Indexes | PostgreSQL indexes on proxy_name, proxy_id, revision_number | Fast lookups |
| Concurrency Pool (p-limit) | API calls during sync | 200 parallel HTTP requests |
| Bulk Insert (1000/batch) | DB save during sync | Minimize DB round trips |
| Lazy Loading | Revision detail endpoint | Fetch details on-demand, not during sync |
| Promise.all parallel | Sync Step 2 | Rev lists + deployments + delta check simultaneously |

---

## Project Structure

```
Apigee Inventory management/
├── backend/
│   ├── .env                    # Apigee + DB credentials
│   ├── db.js                   # PostgreSQL connection pool
│   ├── server.js               # Express server (all API routes + sync logic)
│   └── package.json
├── frontend/
│   ├── public/
│   │   ├── index.html
│   │   ├── favicon.png
│   │   └── image.png
│   ├── src/
│   │   ├── App.js              # Router setup (Home + Dashboard)
│   │   ├── App.css             # All styling
│   │   ├── index.js
│   │   ├── components/
│   │   │   └── Navbar.js       # Nav bar with admin login dropdown
│   │   └── pages/
│   │       ├── Home.js         # Landing page with "Get Started"
│   │       └── Dashboard.js    # Proxy list + revision drill-down
│   └── package.json
├── LOGIC_EXPLANATION.md
├── README.md
└── WORK_AND_LOGIN.md
```

---

## Work Done (Changelog)

### Phase 1: Basic Setup
- Express backend with Apigee token generation and proxy fetching
- React frontend with table display
- PostgreSQL single table for proxy data

### Phase 2: Relational Database Redesign
- Split into 3 tables: `proxies`, `revisions`, `deployments`
- Added foreign keys and unique constraints
- Proxy name filter (EazyPay, composite, CIB, NPCI, D365)

### Phase 3: Performance Optimization
- Added `p-limit` for 200 concurrent API calls
- Delta sync with HashSet — skip already-stored revisions
- LRU cache for revision lookups
- TTL token cache with auto-expiry
- B-Tree indexes on PostgreSQL
- Bulk insert (1000 rows/batch) in single transaction

### Phase 4: UI/UX Improvements
- Home page with "Get Started" button (auto-sync)
- Dashboard with sidebar, search, pagination
- Revision list page with environment deployment tags
- Revision detail page with creator/modifier info
- Admin login via settings gear icon in navbar
- Sync loader overlay on dashboard

### Phase 5: Lazy Loading Optimization
- Removed revision detail API calls from sync entirely
- Sync now only stores proxy_id + revision_number (no detail fields)
- Revision details fetched on-demand from Apigee when user clicks "See More"
- Details cached in DB after first fetch — subsequent clicks are instant
- **Sync time reduced from ~12s to ~3-5s**

---

## Setup & Run

### Prerequisites
- Node.js v18+
- PostgreSQL 16
- npm

### Quick Start

```bash
# 1. Create database
psql -U postgres -c "CREATE DATABASE proxy;"

# 2. Start backend (port 5000)
cd backend
npm install
npm run dev

# 3. Start frontend (port 3000)
cd frontend
npm install
npm start
```

### Environment Variables (backend/.env)

| Variable | Description |
| -------- | ----------- |
| PORT | Server port (default: 5000) |
| APIGEE_TOKEN_URL | Apigee OAuth endpoint |
| APIGEE_CLIENT_ID | OAuth client ID |
| APIGEE_CLIENT_SECRET | OAuth client secret |
| APIGEE_USERNAME | Apigee username |
| APIGEE_PASSWORD | Apigee password |
| APIGEE_MGMT_API_URL | Apigee Management API URL |
| PG_HOST | PostgreSQL host (default: localhost) |
| PG_PORT | PostgreSQL port (default: 5432) |
| PG_USER | PostgreSQL user (default: postgres) |
| PG_PASSWORD | PostgreSQL password |
| PG_DATABASE | Database name (default: proxy) |
