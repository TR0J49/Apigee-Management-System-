import React, { useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE = "http://localhost:5000";

function App() {
  const [tokenStatus, setTokenStatus] = useState(null);
  const [proxies, setProxies] = useState([]);
  const [loading, setLoading] = useState({ token: false, proxy: false });
  const [error, setError] = useState(null);

  const generateToken = async () => {
    setLoading((prev) => ({ ...prev, token: true }));
    setError(null);
    try {
      const res = await axios.post(`${API_BASE}/api/token`);
      setTokenStatus(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to generate token");
    } finally {
      setLoading((prev) => ({ ...prev, token: false }));
    }
  };

  const generateProxies = async () => {
    setLoading((prev) => ({ ...prev, proxy: true }));
    setError(null);
    try {
      const res = await axios.get(`${API_BASE}/api/proxies`);
      setProxies(res.data.proxies);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to fetch proxies");
    } finally {
      setLoading((prev) => ({ ...prev, proxy: false }));
    }
  };

  return (
    <div className="app">
      <h1>Apigee Inventory Management</h1>

      <div className="actions">
        <button onClick={generateToken} disabled={loading.token}>
          {loading.token ? "Generating..." : "Generate Token"}
        </button>

        <button
          onClick={generateProxies}
          disabled={loading.proxy || !tokenStatus?.success}
        >
          {loading.proxy ? "Fetching..." : "Generate Proxies"}
        </button>
      </div>

      {tokenStatus?.success && (
        <div className="status success">
          Token generated — expires in {tokenStatus.expires_in}s
        </div>
      )}

      {error && <div className="status error">{error}</div>}

      {proxies.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Proxy Name</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {proxies.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.proxy_name}</td>
                <td>{p.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default App;
