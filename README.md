# Apigee Inventory Management

A full-stack application to manage Apigee API proxy inventory. It generates OAuth tokens from the Apigee platform, fetches all API proxies, displays them in a table, and stores them in a PostgreSQL database.

---

## Tech Stack

| Layer    | Technology          |
| -------- | ------------------- |
| Frontend | React 18            |
| Backend  | Node.js + Express   |
| Database | PostgreSQL (via pg) |
| HTTP     | Axios               |

---

## Project Structure

```
Apigee Inventory management/
├── backend/
│   ├── .env                   # Environment variables (Apigee + DB credentials)
│   ├── db.js                  # PostgreSQL connection pool setup
│   ├── server.js              # Express server with API routes
│   └── package.json           # Backend dependencies
├── frontend/
│   ├── public/
│   │   └── index.html         # HTML entry point
│   ├── src/
│   │   ├── App.js             # Main React component (UI + API calls)
│   │   ├── App.css            # Styling
│   │   └── index.js           # React DOM entry point
│   └── package.json           # Frontend dependencies
├── .gitignore
└── README.md
```

---

## Application Flow

```
[Frontend]                    [Backend]                      [Apigee Cloud]
    │                             │                               │
    │  1. Click "Generate Token"  │                               │
    │ ──── POST /api/token ─────► │                               │
    │                             │  POST /oauth/token            │
    │                             │  (Basic Auth + credentials)   │
    │                             │ ────────────────────────────► │
    │                             │ ◄──── access_token ────────── │
    │ ◄── token status ────────── │                               │
    │                             │                               │
    │  2. Click "Generate Proxies"│                               │
    │ ──── GET /api/proxies ────► │                               │
    │                             │  GET /v1/organizations/       │
    │                             │    icici-nonprod/apis         │
    │                             │  (Bearer token)               │
    │                             │ ────────────────────────────► │
    │                             │ ◄──── proxy list ───────────  │
    │                             │                               │
    │                             │  Save to PostgreSQL           │
    │                             │  (INSERT ON CONFLICT DO NOTHING)│
    │ ◄── proxies array ──────── │                               │
    │                             │                               │
    │  3. Display in table        │                               │
    │  (ID, Proxy Name, Timestamp)│                               │
```

---

## API Endpoints

### 1. Generate Token

```
POST /api/token
```

- Calls Apigee OAuth endpoint with Basic Auth credentials
- Basic Auth header is Base64 of `APIGEE_CLIENT_ID:APIGEE_CLIENT_SECRET` → `edgecli:edgeclisecret`
- Sends `grant_type=password`, `response_type=token`, `username`, and `password` as form data
- Caches the `access_token` in memory for subsequent API calls

**Response:**
```json
{
  "success": true,
  "message": "Token generated successfully",
  "token_type": "BearerToken",
  "expires_in": 1799
}
```

### 2. Generate Proxies (Fetch from Apigee + Save to DB)

```
GET /api/proxies
```

- Requires a token to be generated first (returns 401 otherwise)
- Calls Apigee Management API with `Bearer <token>` authorization
- Apigee returns an array of proxy names
- Each proxy is inserted into the PostgreSQL `proxies` table (duplicates are skipped via `ON CONFLICT DO NOTHING`)
- Returns all proxies from the database

**Response:**
```json
{
  "success": true,
  "proxies": [
    { "id": 1, "proxy_name": "my-api-proxy", "created_at": "2026-03-13T10:30:00.000Z" },
    { "id": 2, "proxy_name": "another-proxy", "created_at": "2026-03-13T10:30:00.000Z" }
  ]
}
```

### 3. Get Proxies from Database Only

```
GET /api/proxies/db
```

- Fetches proxies stored in the local PostgreSQL database (no Apigee call)
- Useful for viewing previously fetched proxy data without a valid token

---

## Database

### Setup

```sql
-- Create the database
CREATE DATABASE proxy;

-- Connect to the database and create the table
\c proxy

CREATE TABLE proxies (
  id SERIAL PRIMARY KEY,
  proxy_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Schema: `proxies` table

| Column      | Type      | Description                            |
| ----------- | --------- | -------------------------------------- |
| id          | SERIAL    | Auto-incrementing primary key          |
| proxy_name  | TEXT      | Unique proxy name from Apigee          |
| created_at  | TIMESTAMP | Timestamp of when the record was saved |

---

## Environment Variables

All variables are stored in `backend/.env`:

| Variable               | Description                                   |
| ---------------------- | --------------------------------------------- |
| `PORT`                 | Backend server port (default: 5000)           |
| `APIGEE_TOKEN_URL`     | Apigee OAuth token endpoint                   |
| `APIGEE_CLIENT_ID`     | OAuth client ID (`edgecli`)                   |
| `APIGEE_CLIENT_SECRET` | OAuth client secret (`edgeclisecret`)         |
| `APIGEE_USERNAME`      | Apigee user for password grant                |
| `APIGEE_PASSWORD`      | Apigee user password                          |
| `APIGEE_MGMT_API_URL`  | Apigee Management API URL for listing proxies |
| `PG_HOST`              | PostgreSQL host (default: localhost)          |
| `PG_PORT`              | PostgreSQL port (default: 5432)               |
| `PG_USER`              | PostgreSQL username (default: postgres)       |
| `PG_PASSWORD`          | PostgreSQL password                           |
| `PG_DATABASE`          | PostgreSQL database name (default: proxy)     |

---

## Setup & Run

### Prerequisites

- Node.js v18 or later
- npm
- PostgreSQL 16 (running locally)

### Database Setup

```bash
# Create the database and table
psql -U postgres -c "CREATE DATABASE proxy;"
psql -U postgres -d proxy -c "
CREATE TABLE proxies (
  id SERIAL PRIMARY KEY,
  proxy_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);"
```

### Installation

```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Configuration

Update `backend/.env` with your PostgreSQL password:

```
PG_PASSWORD=your_postgres_password
```

### Running the Application

Open two terminals:

**Terminal 1 — Backend (port 5000):**
```bash
cd backend
npm run dev
```

**Terminal 2 — Frontend (port 3000):**
```bash
cd frontend
npm start
```

The app opens at **http://localhost:3000**.

---

## How to Use

1. Click **"Generate Token"** — authenticates with Apigee and generates an OAuth access token
2. Click **"Generate Proxies"** — fetches all API proxies from the Apigee organization, saves them to PostgreSQL, and displays them in a table
3. The table shows **ID**, **Proxy Name**, and **Timestamp** for each proxy

---

## Key Implementation Details

- **Token caching:** The OAuth token is stored in server memory (`cachedToken`) and reused for proxy API calls until the server restarts
- **Duplicate handling:** Proxies are inserted with `ON CONFLICT (proxy_name) DO NOTHING` so re-fetching won't create duplicate entries
- **CORS enabled:** The backend allows cross-origin requests from the React dev server
- **Connection pooling:** Uses `pg.Pool` for efficient PostgreSQL connection management
