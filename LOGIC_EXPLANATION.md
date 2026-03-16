# Apigee Inventory Management — Logic Explanation (Hinglish)

---

## Overall Flow (Poora Kaam Kaise Hota Hai)

```
User Browser                    Backend Server                          Apigee Cloud
    |                               |                                       |
    |  1. "Generate Token" click    |                                       |
    | ---POST /api/token----------> |                                       |
    |                               | ---POST /oauth/token----------------> |
    |                               | <--access_token return--------------  |
    | <--token mil gaya------------ |                                       |
    |                               |                                       |
    |  2. "Generate Proxies" click  |                                       |
    | ---GET /api/proxies---------> |                                       |
    |                               |                                       |
    |                               |  STEP 1: proxy names (1 API call)     |
    |                               | ---GET .../apis--------------------->  |
    |                               | <--["2way","my-api",...] (4013)------  |
    |                               |                                       |
    |                               |  STEP 2: revision lists (100 parallel)|
    |                               | ---GET .../apis/2way/revisions------>  |
    |                               | ---GET .../apis/my-api/revisions---->  |
    |                               | ---...(100 at a time)...              |
    |                               | <--["1","2","3"] for each proxy-----  |
    |                               |                                       |
    |                               |  STEP 3: revision details (100 parallel)
    |                               | ---GET .../apis/2way/revisions/1---->  |
    |                               | ---GET .../apis/2way/revisions/2---->  |
    |                               | ---...(100 at a time)...              |
    |                               | <--{createdAt, createdBy, ...}------  |
    |                               |                                       |
    |                               |  STEP 4: Bulk INSERT to PostgreSQL    |
    |                               |  (1000 rows per batch)                |
    |                               |                                       |
    | <--proxies + stats return---- |                                       |
```

---

## Database Structure (Single Table)

Purana approach mein 2 tables thi (`proxies` + `revisions`). Ab **sirf 1 table** hai — `proxies`:

```sql
CREATE TABLE proxies (
    id               SERIAL PRIMARY KEY,
    proxy_name       TEXT NOT NULL,          -- proxy ka naam (e.g. "2way")
    revision_number  TEXT NOT NULL,          -- revision number ("1", "2", "3")
    created_at       TEXT,                   -- revision kab bani (epoch ms)
    created_by       TEXT,                   -- kisne banai
    last_modified_at TEXT,                   -- kab modify hui (epoch ms)
    last_modified_by TEXT,                   -- kisne modify ki
    timestamp        TIMESTAMP DEFAULT NOW(),-- humne kab save kiya
    UNIQUE(proxy_name, revision_number)      -- same proxy + revision duplicate nahi hogi
);
```

### Example Data (pgAdmin mein aisa dikhega):

```
| id | proxy_name | revision_number | created_at    | created_by                    | last_modified_at | last_modified_by              | timestamp           |
|----|------------|-----------------|---------------|-------------------------------|------------------|-------------------------------|---------------------|
| 1  | 2way       | 1               | 1644227475688 | ban309438@ext.icicibank.com   | 1644236188794    | ban309438@ext.icicibank.com   | 2026-03-13 16:22:00 |
| 2  | 2way       | 2               | 1764335702315 | papul.khapekar@ext.icici...   | 1764335702315    | papul.khapekar@ext.icici...   | 2026-03-13 16:22:00 |
| 3  | 2way       | 3               | 1764762317340 | apigeesaas.nonprod@icici...   | 1764762317340    | apigeesaas.nonprod@icici...   | 2026-03-13 16:22:00 |
| 4  | my-api     | 1               | 1613388583895 | defaultUser                   | 1613390079528    | defaultUser                   | 2026-03-13 16:22:00 |
```

**Samjho:** Ek proxy ki multiple rows hain — har revision ki ek row. `UNIQUE(proxy_name, revision_number)` ensure karta hai ki duplicate na ho.

---

## Step-by-Step Code Explanation

---

### Step 0: Server Start — Table Banao

```js
async function initDB() {
  // Purana revisions table delete karo (ab zarurat nahi)
  await pool.query(`DROP TABLE IF EXISTS revisions`);

  // Single proxies table banao with all columns
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proxies (
      id SERIAL PRIMARY KEY,
      proxy_name TEXT NOT NULL,
      revision_number TEXT NOT NULL,
      created_at TEXT,
      created_by TEXT,
      last_modified_at TEXT,
      last_modified_by TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proxy_name, revision_number)
    )
  `);
}
initDB();
```

**Samjho:** `IF NOT EXISTS` = pehli baar banao, baad mein skip. `DROP TABLE IF EXISTS revisions` = purani revisions table hata do.

---

### Step 1: Token Generate (POST /api/token)

Apigee se baat karne ke liye OAuth token chahiye:

```js
app.post("/api/token", async (req, res) => {
  // Client ID + Secret → Base64 encode
  const basicAuth = Buffer.from("edgecli:edgeclisecret").toString("base64");

  // Username + Password bhejo
  const params = new URLSearchParams();
  params.append("grant_type", "password");
  params.append("username", "readonly@ext.icici.bank.in");
  params.append("password", "Apigee@2028");

  // Apigee OAuth endpoint pe POST
  const response = await axios.post(APIGEE_TOKEN_URL, params, {
    headers: { Authorization: `Basic ${basicAuth}` },
  });

  // Token memory mein save (server band hone tak rehta hai)
  cachedToken = response.data.access_token;
});
```

---

### Step 2: Main Logic — Generate Proxies (GET /api/proxies)

Ye sabse important part hai. **Ek button click mein sab hota hai.**

#### parallelBatch() — Speed Ka Secret

```js
async function parallelBatch(items, concurrency, fn) {
  const results = [];
  // items ko concurrency size ke batches mein process karo
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    // Ek batch ke saare items ek saath run hote hain
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
```

**Samjho:**
```
items = [proxy1, proxy2, proxy3, ..., proxy4013]
concurrency = 100

Batch 1: [proxy1 ... proxy100]   → sab ek saath API call → done
Batch 2: [proxy101 ... proxy200] → sab ek saath API call → done
...
Batch 41: [proxy4001 ... proxy4013] → done

Promise.allSettled = agar koi fail ho toh bhi baaki continue
```

---

#### STEP 1: Proxy Names Fetch (1 API Call)

```js
// Ek single API call — saare proxy names aa jaate hain
const nameRes = await axios.get(baseUrl, { headers });
const proxyNames = nameRes.data;
// proxyNames = ["2way", "my-api", "payment-proxy", ...] (4013 names)
```

**Time: ~1 second**

---

#### STEP 2: Revision Lists Fetch (100 Parallel)

```js
// Har proxy ke liye revision numbers fetch karo — 100 ek saath
const revListResults = await parallelBatch(proxyNames, 100, async (name) => {
  const r = await axios.get(`${baseUrl}/${name}/revisions`, { headers });
  return { name, revisions: r.data };
  // r.data = ["1", "2", "3"] — revision numbers
});

// Flatten: har proxy ki har revision ko alag pair banao
const allRevisionPairs = [];
for (const r of revListResults) {
  if (r.status === "fulfilled") {
    for (const rev of r.value.revisions) {
      allRevisionPairs.push({ name: r.value.name, rev });
    }
  }
}
// allRevisionPairs = [
//   { name: "2way", rev: "1" },
//   { name: "2way", rev: "2" },
//   { name: "my-api", rev: "1" },
//   ...  (~33,575 pairs)
// ]
```

**Time: ~12-15 seconds** (4013 calls / 100 parallel = ~40 batches)

---

#### STEP 3: Revision Details Fetch (100 Parallel)

```js
// Har revision ka detail lao — 100 ek saath
const detailResults = await parallelBatch(allRevisionPairs, 100, async (pair) => {
  const r = await axios.get(
    `${baseUrl}/${pair.name}/revisions/${pair.rev}`,
    { headers }
  );
  // Apigee response:
  // {
  //   revision: "1",
  //   createdAt: 1644227475688,
  //   createdBy: "ban309438@ext.icicibank.com",
  //   lastModifiedAt: 1644236188794,
  //   lastModifiedBy: "ban309438@ext.icicibank.com"
  // }
  return {
    proxy_name: pair.name,
    revision_number: String(pair.rev),
    created_at: String(r.data.createdAt || ""),
    created_by: r.data.createdBy || "",
    last_modified_at: String(r.data.lastModifiedAt || ""),
    last_modified_by: r.data.lastModifiedBy || "",
  };
});
```

**Time: ~100 seconds** (33,575 calls / 100 parallel = ~336 batches)

---

#### STEP 4: Bulk DB Insert (1000 Rows Per Batch)

```js
const batchSize = 1000;
for (let i = 0; i < rows.length; i += batchSize) {
  const batch = rows.slice(i, i + batchSize);

  // Dynamic placeholders banao: ($1,$2,$3,$4,$5,$6), ($7,$8,...), ...
  const placeholders = [];
  const values = [];
  let idx = 1;
  for (const row of batch) {
    placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5})`);
    values.push(row.proxy_name, row.revision_number, row.created_at,
                row.created_by, row.last_modified_at, row.last_modified_by);
    idx += 6;
  }

  // Bulk insert — 1000 rows ek query mein
  await pool.query(
    `INSERT INTO proxies (proxy_name, revision_number, created_at, created_by, last_modified_at, last_modified_by)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (proxy_name, revision_number) DO UPDATE SET
       created_at = EXCLUDED.created_at,
       created_by = EXCLUDED.created_by,
       last_modified_at = EXCLUDED.last_modified_at,
       last_modified_by = EXCLUDED.last_modified_by,
       timestamp = CURRENT_TIMESTAMP`,
    values
  );
}
```

**Samjho:** Ek ek row insert karne se bahut slow hota. Bulk insert (1000 rows ek query mein) bahut fast hai.

**`ON CONFLICT DO UPDATE`** = agar same proxy + revision pehle se hai toh overwrite karo (UPSERT pattern). Duplicate kabhi nahi banega.

**Time: ~3-5 seconds**

---

## Speed Comparison

```
APPROACH 1 (Purana — Sequential):
  Proxy 1 → rev list → rev details → save → done
  Proxy 2 → rev list → rev details → save → done   ← ek ek karke
  ...
  TIME: 30-60 minutes

APPROACH 2 (10 Parallel):
  [Proxy 1-10] → rev list + details → save → done
  [Proxy 11-20] → ...                              ← 10 ek saath
  ...
  TIME: ~10-15 minutes

APPROACH 3 (Current — 100 Parallel + Bulk Insert):
  STEP 1: 1 call for all proxy names                ← 1 second
  STEP 2: [100 proxies] → rev lists → done          ← 12-15 seconds
  STEP 3: [100 revisions] → details → done           ← ~100 seconds
  STEP 4: Bulk insert 1000 rows/query               ← 3-5 seconds
  TIME: ~2 minutes
```

**Kyun 15 seconds mein nahi ho sakta?**
- 33,575 API calls required hain (Apigee ka `expand=true` kaam nahi karta is instance pe)
- 100 parallel = ~336 batches × ~0.3s per batch = ~100 seconds minimum
- Ye Apigee API ki limitation hai, humari code ki nahi

---

## Apigee API URLs

| Step | URL | Returns |
|------|-----|---------|
| Token | `POST https://icici-bank-azure-test.login.apigee.com/oauth/token` | access_token |
| All proxy names | `GET .../v1/organizations/icici-nonprod/apis` | `["2way", "my-api", ...]` |
| Revision list | `GET .../apis/{proxy_name}/revisions` | `["1", "2", "3"]` |
| Revision detail | `GET .../apis/{proxy_name}/revisions/{rev}` | `{createdAt, createdBy, lastModifiedAt, lastModifiedBy, ...}` |

---

## Frontend Flow

1. **"Generate Token" button** → token ban jaata hai → green message
2. **"Generate Proxies" button** → blue loading message
   - Backend mein 4 steps automatic chalte hain
   - Jab done: green stats dikhte hain (total rows + time taken)
3. **Table** mein directly sab data dikhta hai:
   - ID, Proxy Name, Revision, Created By, Created At, Last Modified By, Last Modified At, Timestamp

---

## pgAdmin Mein Data Dekhne Ki Queries

```sql
-- Saara data dekho
SELECT * FROM proxies ORDER BY id ASC;

-- Total rows count
SELECT COUNT(*) FROM proxies;

-- Ek specific proxy ki revisions
SELECT * FROM proxies WHERE proxy_name = '2way' ORDER BY revision_number::int ASC;

-- Har proxy ki kitni revisions hain
SELECT proxy_name, COUNT(*) AS total_revisions
FROM proxies
GROUP BY proxy_name
ORDER BY total_revisions DESC;

-- Kisne sabse zyada proxies banaye
SELECT created_by, COUNT(*) AS total
FROM proxies
GROUP BY created_by
ORDER BY total DESC;
```
