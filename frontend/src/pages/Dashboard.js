import React, { useState, useEffect, useRef } from "react";
import axios from "axios";

const API_BASE = "http://localhost:5000";
const ROWS_PER_PAGE = 1000;

function formatEpoch(epoch) {
  if (!epoch) return "-";
  const num = Number(epoch);
  if (isNaN(num)) return epoch;
  return new Date(num).toLocaleString();
}

function Dashboard() {
  const [tokenStatus, setTokenStatus] = useState(null);
  const [proxies, setProxies] = useState([]);
  const [loading, setLoading] = useState({ token: false, proxy: false, revisions: false, detail: false });
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState("");
  const [popup, setPopup] = useState(null);
  const [activeView, setActiveView] = useState("actions");
  const [currentPage, setCurrentPage] = useState(1);
  const dataLoaded = useRef(false);

  // Revision page state
  const [revisionPage, setRevisionPage] = useState(null); // { proxyName, revisions[] }
  const [detailPage, setDetailPage] = useState(null);     // { revision object }

  // Load data from DB once on mount
  useEffect(() => {
    if (!dataLoaded.current) {
      dataLoaded.current = true;
      axios.get(`${API_BASE}/api/proxy-list`)
        .then((res) => setProxies(res.data.proxies))
        .catch(() => {});
      axios.get(`${API_BASE}/api/proxies/count`)
        .then((res) => {
          if (res.data.total > 0) {
            setStats({ total: res.data.total, time: null });
          }
        })
        .catch(() => {});
    }
  }, []);

  const showPopup = (type, title, message) => {
    setPopup({ type, title, message });
    setTimeout(() => setPopup(null), 4000);
  };

  const generateToken = async () => {
    setLoading((p) => ({ ...p, token: true }));
    setError(null);
    try {
      const res = await axios.post(`${API_BASE}/api/token`);
      setTokenStatus(res.data);
      showPopup("success", "Token Generated", `Token active - expires in ${res.data.expires_in}s`);
    } catch (err) {
      const msg = err.response?.data?.message || "Failed to generate token";
      setError(msg);
      showPopup("error", "Token Failed", msg);
    } finally {
      setLoading((p) => ({ ...p, token: false }));
    }
  };

  const generateProxies = async () => {
    setLoading((p) => ({ ...p, proxy: true }));
    setError(null);
    setStats(null);
    try {
      const start = Date.now();
      const res = await axios.get(`${API_BASE}/api/proxies`, { timeout: 0 });
      const time = ((Date.now() - start) / 1000).toFixed(1);
      setStats({ total: res.data.total_rows, time });
      const listRes = await axios.get(`${API_BASE}/api/proxy-list`);
      setProxies(listRes.data.proxies);
      showPopup("success", "Proxies Fetched", `${res.data.total_rows} rows saved in ${time}s`);
      setActiveView("proxies");
    } catch (err) {
      const msg = err.response?.data?.message || "Failed to fetch proxies";
      setError(msg);
      showPopup("error", "Fetch Failed", msg);
    } finally {
      setLoading((p) => ({ ...p, proxy: false }));
    }
  };

  const showProxiesView = () => {
    setActiveView("proxies");
    setCurrentPage(1);
  };

  const openRevisionPage = async (proxyName) => {
    setRevisionPage({ proxyName, revisions: [] });
    setDetailPage(null);
    setLoading((p) => ({ ...p, revisions: true }));
    try {
      const res = await axios.get(`${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions`);
      setRevisionPage({ proxyName, revisions: res.data.revisions });
    } catch (err) {
      showPopup("error", "Error", err.response?.data?.message || "Failed to fetch revisions");
    } finally {
      setLoading((p) => ({ ...p, revisions: false }));
    }
  };

  const openDetailPage = async (proxyName, revNumber) => {
    setLoading((p) => ({ ...p, detail: true }));
    try {
      const res = await axios.get(`${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions/${revNumber}`);
      setDetailPage(res.data.revision);
    } catch (err) {
      showPopup("error", "Error", err.response?.data?.message || "Failed to fetch revision detail");
    } finally {
      setLoading((p) => ({ ...p, detail: false }));
    }
  };

  const closeRevisionPage = () => {
    setRevisionPage(null);
    setDetailPage(null);
  };

  const closeDetailPage = () => {
    setDetailPage(null);
  };

  const filteredProxies = proxies.filter((p) =>
    p.proxy_name.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.ceil(filteredProxies.length / ROWS_PER_PAGE);
  const paginatedProxies = filteredProxies.slice(
    (currentPage - 1) * ROWS_PER_PAGE,
    currentPage * ROWS_PER_PAGE
  );

  // ==================== REVISION DETAIL PAGE ====================
  if (detailPage) {
    return (
      <div className="overlay-page">
        <div className="overlay-container">
          <div className="overlay-header">
            <div>
              <h1 className="overlay-title">Revision Detail</h1>
              <p className="overlay-subtitle">
                {revisionPage?.proxyName} - Revision {detailPage.revision_number}
              </p>
            </div>
            <button className="btn-back" onClick={closeDetailPage}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
          </div>

          <div className="detail-grid-page">
            <div className="detail-card-page">
              <div className="detail-card-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2"/><circle cx="9" cy="7" r="4"/></svg>
              </div>
              <span className="detail-label">Created By</span>
              <span className="detail-value">{detailPage.created_by || "-"}</span>
            </div>
            <div className="detail-card-page">
              <div className="detail-card-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <span className="detail-label">Created At</span>
              <span className="detail-value">{formatEpoch(detailPage.created_at)}</span>
            </div>
            <div className="detail-card-page">
              <div className="detail-card-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <span className="detail-label">Last Modified By</span>
              <span className="detail-value">{detailPage.last_modified_by || "-"}</span>
            </div>
            <div className="detail-card-page">
              <div className="detail-card-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <span className="detail-label">Last Modified At</span>
              <span className="detail-value">{formatEpoch(detailPage.last_modified_at)}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==================== REVISION LIST PAGE ====================
  if (revisionPage) {
    return (
      <div className="overlay-page">
        <div className="overlay-container">
          <div className="overlay-header">
            <div>
              <h1 className="overlay-title">Revisions</h1>
              <p className="overlay-subtitle">{revisionPage.proxyName}</p>
            </div>
            <button className="btn-back" onClick={closeRevisionPage}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
          </div>

          {loading.revisions ? (
            <div className="overlay-loading">
              <div className="spinner"></div>
              <p>Loading revisions...</p>
            </div>
          ) : revisionPage.revisions.length > 0 ? (
            <div className="revision-list">
              {revisionPage.revisions.map((r) => (
                <div className="revision-row" key={r.revision_number}>
                  <div className="revision-row-left">
                    <span className="revision-badge">Rev {r.revision_number}</span>
                    <span className="revision-row-label">Revision {r.revision_number}</span>
                  </div>
                  <button
                    className="btn-see-more"
                    onClick={() => openDetailPage(revisionPage.proxyName, r.revision_number)}
                    disabled={loading.detail}
                  >
                    {loading.detail ? "Loading..." : "See More"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="overlay-loading">
              <p>No revisions found for this proxy.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== MAIN DASHBOARD ====================
  return (
    <div className="dashboard-layout">
      {/* Popup Notification */}
      {popup && (
        <div className={`popup popup-${popup.type}`}>
          <div className="popup-icon">{popup.type === "success" ? String.fromCharCode(10003) : "!"}</div>
          <div>
            <div className="popup-title">{popup.title}</div>
            <div className="popup-message">{popup.message}</div>
          </div>
          <button className="popup-close" onClick={() => setPopup(null)}>x</button>
        </div>
      )}

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-section">
          <div className="sidebar-label">MENU</div>
          <button
            className={`sidebar-btn ${activeView === "actions" ? "sidebar-active" : ""}`}
            onClick={() => setActiveView("actions")}
          >
            <span className="sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </span>
            Dashboard
          </button>
          <button
            className={`sidebar-btn ${activeView === "proxies" ? "sidebar-active" : ""}`}
            onClick={showProxiesView}
          >
            <span className="sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
            </span>
            Proxies
          </button>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-label">STATUS</div>
          <div className="sidebar-status">
            <span className={`status-dot ${tokenStatus?.success ? "dot-green" : "dot-gray"}`}></span>
            Token: {tokenStatus?.success ? "Active" : "Inactive"}
          </div>
          <div className="sidebar-status">
            <span className={`status-dot ${proxies.length > 0 ? "dot-green" : "dot-gray"}`}></span>
            Proxies: {proxies.length || 0}
          </div>
          {stats && (
            <div className="sidebar-status">
              <span className="status-dot dot-green"></span>
              Revisions: {stats.total}
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="dashboard-main">
        {/* Actions View */}
        {activeView === "actions" && (
          <>
            {/* Loader - only on actions view */}
            {(loading.token || loading.proxy) && (
              <div className="main-loader">
                <div className="loader-content">
                  <div className="spinner"></div>
                  <p className="loader-title">
                    {loading.token ? "Generating Token..." : "Fetching Proxies & Revisions..."}
                  </p>
                  <p className="loader-sub">
                    {loading.token
                      ? "Authenticating with Apigee OAuth"
                      : "This may take a couple of minutes. Please wait."}
                  </p>
                </div>
              </div>
            )}

            <div className="dashboard-header">
              <h1>Dashboard</h1>
              <p className="dashboard-subtitle">Manage your Apigee API proxies and revisions</p>
            </div>

            <div className="action-cards">
              <div className="action-card">
                <div className="action-card-header">
                  <span className="action-step">Step 1</span>
                  <h3>Authentication</h3>
                </div>
                <p>Generate OAuth token to access Apigee Management API</p>
                <button className="btn-action" onClick={generateToken} disabled={loading.token}>
                  Generate Token
                </button>
                {tokenStatus?.success && (
                  <div className="action-status success">
                    Token active - expires in {tokenStatus.expires_in}s
                  </div>
                )}
              </div>

              <div className="action-card">
                <div className="action-card-header">
                  <span className="action-step">Step 2</span>
                  <h3>Fetch Data</h3>
                </div>
                <p>Fetch all proxies and revision details from Apigee</p>
                <button className="btn-action" onClick={generateProxies} disabled={loading.proxy || !tokenStatus?.success}>
                  Generate Proxies
                </button>
                {stats && (
                  <div className="action-status success">
                    {stats.total} rows saved{stats.time ? ` in ${stats.time}s` : ""}
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="alert error">
                {error}
                <button className="alert-close" onClick={() => setError(null)}>x</button>
              </div>
            )}
          </>
        )}

        {/* Proxies View */}
        {activeView === "proxies" && (
          <>
            <div className="dashboard-header">
              <h1>API Proxies</h1>
              <p className="dashboard-subtitle">Browse proxies and explore revision details from database</p>
            </div>

            {error && (
              <div className="alert error">
                {error}
                <button className="alert-close" onClick={() => setError(null)}>x</button>
              </div>
            )}

            {proxies.length > 0 && (
              <div className="table-section">
                <div className="table-header">
                  <h2>Proxies <span className="badge">{filteredProxies.length}</span></h2>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search proxy name..."
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }}
                  />
                </div>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Proxy Name</th>
                        <th>Timestamp</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedProxies.map((p) => (
                        <tr key={p.proxy_name}>
                          <td>{p.id}</td>
                          <td className="proxy-name-cell">{p.proxy_name}</td>
                          <td>{new Date(p.timestamp).toLocaleString()}</td>
                          <td>
                            <button
                              className="btn-check-revision"
                              onClick={() => openRevisionPage(p.proxy_name)}
                            >
                              Check Revision
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="pagination">
                    <button
                      className="pagination-btn"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </button>
                    <div className="pagination-pages">
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                        <button
                          key={page}
                          className={`pagination-page ${currentPage === page ? "pagination-active" : ""}`}
                          onClick={() => setCurrentPage(page)}
                        >
                          {page}
                        </button>
                      ))}
                    </div>
                    <button
                      className="pagination-btn"
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next
                    </button>
                    <span className="pagination-info">
                      {(currentPage - 1) * ROWS_PER_PAGE + 1}–{Math.min(currentPage * ROWS_PER_PAGE, filteredProxies.length)} of {filteredProxies.length}
                    </span>
                  </div>
                )}
              </div>
            )}

            {proxies.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                </div>
                <h3>No Data Found</h3>
                <p>Go to Dashboard and generate proxies first, or data will load automatically if already saved.</p>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default Dashboard;
