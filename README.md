# Apigee Inventory Management

A full-stack application to manage Apigee API proxy inventory. It syncs API proxies, revisions, and deployments from the Apigee platform, stores them in PostgreSQL, and displays them in a React dashboard with authentication.

---

## Tech Stack

| Layer      | Technology                          |
| ---------- | ----------------------------------- |
| Frontend   | React 18 + React Router 6          |
| Backend    | Node.js + Express                   |
| Database   | PostgreSQL 16 (3 relational tables) |
| HTTP       | Axios + p-limit (200 concurrent)    |
| DevOps     | Docker + Docker Compose             |

---

## Quick Start (Docker)

```bash
# Clone the repo
git clone https://github.com/TR0J49/Apigee-Management-System-.git
cd "Apigee Inventory management"

# Build and start all containers
docker-compose up --build -d

# Open in browser
http://localhost:3000

# Stop all containers
docker-compose down
```

No need to install Node.js, npm, or PostgreSQL — Docker handles everything.

---

## Quick Start (Local Development)

### Prerequisites

- Node.js v18+
- PostgreSQL 16
- npm

### Setup

```bash
# 1. Create database
psql -U postgres -c "CREATE DATABASE proxy;"

# 2. Start backend (port 5000)
cd backend
npm install
npm run dev

# 3. Start frontend (port 3000) — in a new terminal
cd frontend
npm install
npm start
```

The app opens at **http://localhost:3000**

---

## Login Credentials

| Field    | Value                        |
| -------- | ---------------------------- |
| Email    | readonly@ext.icici.bank.in   |
| Password | Apigee@2028                  |

Credentials are pre-filled in the login form. Just click **Login**.

---

## How to Use

1. Click the **Settings (gear) icon** in the navbar to open the login form
2. Click **Login** — authenticates and triggers a background sync from Apigee (popup notification shows progress)
3. Dashboard auto-refreshes with proxy data after sync completes
4. Click **"Get Started"** on the Home page to go directly to the Dashboard (loads from database)
5. Click **"Check Revision"** on any proxy to see its revision list with deployment environment tags
6. Click **"See More"** on any revision to view creator/modifier details (lazy-loaded from Apigee on first click, cached after)

---

## Project Structure

```
Apigee Inventory management/
├── backend/
│   ├── .env                       # Apigee + DB credentials
│   ├── db.js                      # PostgreSQL connection pool
│   ├── server.js                  # Express server entry point
│   ├── Dockerfile                 # Backend Docker image
│   ├── routes/
│   │   ├── tokenRoutes.js         # POST /api/token
│   │   ├── syncRoutes.js          # POST /api/sync
│   │   ├── proxyRoutes.js         # GET /api/proxies, /api/proxies/count
│   │   ├── revisionRoutes.js      # GET /api/proxies/:name/revisions[/:rev]
│   │   └── deploymentRoutes.js    # GET /api/proxies/:name/deployments
│   ├── utils/
│   │   ├── token.js               # TTL token cache + auto-generation
│   │   ├── cache.js               # LRU cache for revisions
│   │   ├── helpers.js             # Proxy keyword filter + concurrency pool
│   │   └── initDB.js              # Table creation + B-tree indexes
│   └── package.json
├── frontend/
│   ├── public/
│   │   └── index.html
│   ├── src/
│   │   ├── App.js                 # Router + auth state management
│   │   ├── App.css                # All styling
│   │   ├── index.js               # React DOM entry
│   │   ├── components/
│   │   │   └── Navbar.js          # Nav bar + login + background sync
│   │   └── pages/
│   │       ├── Home.js            # Landing page
│   │       └── Dashboard.js       # Proxy list + revision drill-down
│   ├── Dockerfile                 # Multi-stage build (React + nginx)
│   ├── nginx.conf                 # Reverse proxy for /api
│   └── package.json
├── docker-compose.yml             # PostgreSQL + Backend + Frontend
├── .gitignore
├── LOGIC_EXPLANATION.md
├── WORK_AND_LOGIN.md
└── README.md
```

---

## Application Flow

```
User Browser                     Backend Server                      Apigee Cloud
    |                                |                                    |
    |  1. User clicks "Login"        |                                    |
    |  (credentials pre-filled)      |                                    |
    |                                |                                    |
    |  2. Background Sync triggers   |                                    |
    | ──── POST /api/sync ─────────► |                                    |
    |                                | Auto-generate OAuth token          |
    |                                | ──── POST /oauth/token ──────────► |
    |                                | ◄──── access_token ──────────────  |
    |                                |                                    |
    |                                | Fetch proxy names (filtered)       |
    |                                | ──── GET .../apis ───────────────► |
    |                                | ◄──── proxy list ────────────────  |
    |                                |                                    |
    |                                | IN PARALLEL:                       |
    |                                |   Fetch revision lists (200x)      |
    |                                |   Fetch deployments (200x)         |
    |                                |   Delta check existing DB data     |
    |                                |                                    |
    |                                | Bulk INSERT new revisions          |
    |                                | Save deployments                   |
    |                                |                                    |
    | ◄── popup: "Sync Complete" ──  |                                    |
    |                                |                                    |
    |  3. Dashboard auto-refreshes   |                                    |
    | ──── GET /api/proxy-list ────► |                                    |
    | ◄── proxies from DB ─────────  |                                    |
    |                                |                                    |
    |  4. Click "Check Revision"     |                                    |
    | ──── GET .../revisions ──────► |                                    |
    | ◄── revision list from DB ───  |                                    |
    |                                |                                    |
    |  5. Click "See More" (lazy)    |                                    |
    | ──── GET .../revisions/3 ────► |                                    |
    |                                | (if not cached) fetch from Apigee  |
    |                                | ──── GET .../revisions/3 ────────► |
    |                                | ◄──── detail data ───────────────  |
    |                                | Save to DB (cached for next time)  |
    | ◄── revision detail ─────────  |                                    |
```

---

## API Endpoints

| Method | Endpoint                              | Description                                |
| ------ | ------------------------------------- | ------------------------------------------ |
| POST   | `/api/token`                          | Generate OAuth token from Apigee           |
| POST   | `/api/sync`                           | Auto token + fetch proxies + revisions + deployments |
| GET    | `/api/proxy-list`                     | List all proxies from DB                   |
| GET    | `/api/proxies/count`                  | Total revisions count                      |
| GET    | `/api/proxies/:name/revisions`        | Revision list for a proxy                  |
| GET    | `/api/proxies/:name/revisions/:rev`   | Revision detail (lazy loads from Apigee)   |
| GET    | `/api/proxies/:name/deployments`      | Deployment info for a proxy                |
| GET    | `/api/deployments/count`              | Total deployments count                    |

---

## Database Schema (3 Tables)

```sql
-- 1. Proxies table
proxies (
  id SERIAL PRIMARY KEY,
  proxy_name TEXT NOT NULL UNIQUE,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)

-- 2. Revisions table (FK to proxies)
revisions (
  id SERIAL PRIMARY KEY,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE CASCADE,
  revision_number TEXT NOT NULL,
  created_at TEXT,
  created_by TEXT,
  last_modified_at TEXT,
  last_modified_by TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proxy_id, revision_number)
)

-- 3. Deployments table (FK to proxies)
deployments (
  id SERIAL PRIMARY KEY,
  proxy_id INTEGER REFERENCES proxies(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  revision_number TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(proxy_id, environment, revision_number)
)
```

---

## Proxy Filter

Only proxies matching these keywords are synced:
- **EazyPay**
- **composite**
- **CIB**
- **NPCI**
- **D365**

---

## Performance Optimizations

| Technique              | Where                    | Purpose                                    |
| ---------------------- | ------------------------ | ------------------------------------------ |
| HashSet (delta sync)   | Sync Step 3              | O(1) lookup to skip existing revisions     |
| LRU Cache              | Revision detail + list   | Avoid repeated DB queries                  |
| TTL Token Cache        | Token management         | Auto-reject expired tokens                 |
| B-Tree Indexes         | PostgreSQL               | Fast lookups on proxy_name, proxy_id       |
| p-limit (200 parallel) | API calls during sync    | 200 concurrent HTTP requests               |
| Bulk Insert (1000/batch)| DB save during sync     | Minimize DB round trips                    |
| Lazy Loading           | Revision detail          | Fetch details on-demand, not during sync   |
| Promise.all parallel   | Sync Step 2              | Rev lists + deployments + delta check      |

---

## Docker Setup

| Service    | Image              | Port          |
| ---------- | ------------------ | ------------- |
| postgres   | postgres:16-alpine | 5432          |
| backend    | node:18-alpine     | 5000          |
| frontend   | nginx:1.25-alpine  | 3000 → 80     |

### Docker Commands

```bash
# Build and start
docker-compose up --build -d

# Stop
docker-compose down

# View logs
docker-compose logs -f

# Rebuild after code changes
docker-compose up --build -d

# Stop and delete database data
docker-compose down -v
```

---

## Environment Variables

All variables are configured in `docker-compose.yml` (for Docker) or `backend/.env` (for local dev):

| Variable               | Description                                   |
| ---------------------- | --------------------------------------------- |
| `PORT`                 | Backend server port (default: 5000)           |
| `APIGEE_TOKEN_URL`     | Apigee OAuth token endpoint                   |
| `APIGEE_CLIENT_ID`     | OAuth client ID                               |
| `APIGEE_CLIENT_SECRET` | OAuth client secret                           |
| `APIGEE_USERNAME`      | Apigee username                               |
| `APIGEE_PASSWORD`      | Apigee password                               |
| `APIGEE_MGMT_API_URL`  | Apigee Management API URL                     |
| `PG_HOST`              | PostgreSQL host (default: localhost)           |
| `PG_PORT`              | PostgreSQL port (default: 5432)               |
| `PG_USER`              | PostgreSQL username (default: postgres)        |
| `PG_PASSWORD`          | PostgreSQL password                           |
| `PG_DATABASE`          | PostgreSQL database name (default: proxy)      |

---

## Authentication

- Login form is in the navbar (Settings gear icon)
- Credentials are hardcoded and pre-filled
- Auth state persists in `localStorage` across page refreshes
- Dashboard route is protected — redirects to Home if not logged in
- On login, background sync runs automatically with popup notifications
- Dashboard auto-refreshes when sync completes
