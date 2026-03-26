import React, { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";

const API_BASE = "";
const PROXY_ROWS_PER_PAGE = 50;
const INV_ROWS_PER_PAGE = 50;

function formatEpoch(epoch) {
  if (!epoch) return "-";
  const num = Number(epoch);
  if (isNaN(num)) return epoch;
  return new Date(num).toLocaleString();
}

// ==================== INVENTORY TAB COMPONENT (Server-Side Pagination) ====================
function InventoryTab({
  inventoryRows, inventoryLoading, inventorySearch, setInventorySearch,
  inventoryPage, setInventoryPage, inventoryTotal, inventoryTotalPages,
  loadInventoryPage, exportToExcel, exporting, isSyncing,
}) {
  const tableScrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollButtons = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    updateScrollButtons();
    el.addEventListener("scroll", updateScrollButtons);
    const ro = new ResizeObserver(updateScrollButtons);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", updateScrollButtons); ro.disconnect(); };
  }, [updateScrollButtons, inventoryLoading]);

  const scrollTable = (direction) => {
    const el = tableScrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.6;
    el.scrollBy({ left: direction === "left" ? -amount : amount, behavior: "smooth" });
  };

  // Build page numbers with ellipsis for large page counts
  const getPageNumbers = () => {
    const tp = inventoryTotalPages;
    if (tp <= 7) return Array.from({ length: tp }, (_, i) => i + 1);
    const pages = [];
    if (inventoryPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i);
      pages.push("...");
      pages.push(tp);
    } else if (inventoryPage >= tp - 3) {
      pages.push(1);
      pages.push("...");
      for (let i = tp - 4; i <= tp; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push("...");
      for (let i = inventoryPage - 1; i <= inventoryPage + 1; i++) pages.push(i);
      pages.push("...");
      pages.push(tp);
    }
    return pages;
  };

  const handlePageChange = (newPage) => {
    setInventoryPage(newPage);
    loadInventoryPage(newPage, inventorySearch);
  };

  // Debounced search
  const searchTimerRef = useRef(null);
  const handleSearchChange = (e) => {
    const val = e.target.value;
    setInventorySearch(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setInventoryPage(1);
      loadInventoryPage(1, val);
    }, 400);
  };

  return (
    <>
      <div className="dashboard-header">
        <h1>Proxy Inventory</h1>
        <p className="dashboard-subtitle">All parsed proxy bundle data from database</p>
      </div>

      <div className="table-section">
        <div className="table-header">
          <h2>Inventory <span className="badge">{inventoryTotal}</span></h2>
          <div className="inventory-toolbar">
            <input
              type="text"
              className="search-input"
              placeholder="Search proxy name..."
              value={inventorySearch}
              onChange={handleSearchChange}
            />
            <button className="btn-refresh-inv" onClick={() => loadInventoryPage(inventoryPage, inventorySearch)} disabled={inventoryLoading}>
              {inventoryLoading ? (
                <span className="spinner-small"></span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
              )}
              Refresh
            </button>
            <button className="btn-export-excel" onClick={exportToExcel} disabled={exporting || inventoryTotal === 0}>
              {exporting ? (
                <span className="spinner-small"></span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              )}
              Export to Excel
            </button>
          </div>
        </div>

        {inventoryLoading ? (
          <div className="overlay-loading">
            <div className="spinner"></div>
            <p>Loading inventory data...</p>
          </div>
        ) : inventoryRows.length > 0 ? (
          <>
            <div className="table-slider-container">
              {canScrollLeft && (
                <button className="table-slider-btn table-slider-left" onClick={() => scrollTable("left")} title="Scroll left">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
              )}
              <div className="table-wrapper inventory-table-wrapper" ref={tableScrollRef}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Proxy Name</th>
                      <th>Revision</th>
                      <th>Endpoint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventoryRows.map((row, i) => (
                      <tr key={`${row.proxy_name}-${row.revision_number}-${i}`}>
                        <td style={{ color: "#aaa", fontSize: 12 }}>{(inventoryPage - 1) * INV_ROWS_PER_PAGE + i + 1}</td>
                        <td className="proxy-name-cell">{row.proxy_name}</td>
                        <td><span className="revision-badge-sm">Rev {row.revision_number}</span></td>
                        <td><code className="inv-code">{row.endpoint || "-"}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canScrollRight && (
                <button className="table-slider-btn table-slider-right" onClick={() => scrollTable("right")} title="Scroll right">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              )}
            </div>

            {inventoryTotalPages > 1 && (
              <div className="pagination">
                <button
                  className="pagination-btn"
                  onClick={() => handlePageChange(Math.max(1, inventoryPage - 1))}
                  disabled={inventoryPage === 1}
                >
                  Previous
                </button>
                <div className="pagination-pages">
                  {getPageNumbers().map((page, idx) =>
                    page === "..." ? (
                      <span key={`ellipsis-${idx}`} className="pagination-ellipsis">...</span>
                    ) : (
                      <button
                        key={page}
                        className={`pagination-page ${inventoryPage === page ? "pagination-active" : ""}`}
                        onClick={() => handlePageChange(page)}
                      >
                        {page}
                      </button>
                    )
                  )}
                </div>
                <button
                  className="pagination-btn"
                  onClick={() => handlePageChange(Math.min(inventoryTotalPages, inventoryPage + 1))}
                  disabled={inventoryPage === inventoryTotalPages}
                >
                  Next
                </button>
                <span className="pagination-info">
                  {(inventoryPage - 1) * INV_ROWS_PER_PAGE + 1}-{Math.min(inventoryPage * INV_ROWS_PER_PAGE, inventoryTotal)} of {inventoryTotal}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
            </div>
            <h3>No Inventory Data</h3>
            <p>{isSyncing ? "Sync in progress... inventory will be available shortly." : "Run a sync first, then inventory data will be parsed from proxy bundles."}</p>
          </div>
        )}
      </div>
    </>
  );
}

function Dashboard({ syncVersion, isSyncing, triggerSync }) {
  const [proxies, setProxies] = useState([]);
  const [proxyTotal, setProxyTotal] = useState(0);
  const [proxyTotalPages, setProxyTotalPages] = useState(0);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [loading, setLoading] = useState({ syncing: false, revisions: false, detail: false });
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState("");
  const [popup, setPopup] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const dataLoaded = useRef(false);

  // Revision page state
  const [revisionPage, setRevisionPage] = useState(null);
  const [detailPage, setDetailPage] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [inventorySource, setInventorySource] = useState(null);

  // Auto-download state
  const autoDownloadTriggered = useRef(false);

  const [downloading, setDownloading] = useState({});

  // Sidebar tab state
  const [activeTab, setActiveTab] = useState("dashboard");

  // Inventory tab state (server-side pagination)
  const [inventoryRows, setInventoryRows] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventoryPage, setInventoryPage] = useState(1);
  const [inventoryTotal, setInventoryTotal] = useState(0);
  const [inventoryTotalPages, setInventoryTotalPages] = useState(0);
  const [exporting, setExporting] = useState(false);

  // Dashboard tab state
  const [dashboardStats, setDashboardStats] = useState(null);
  const [allProxyNames, setAllProxyNames] = useState([]);

  // Load paginated proxy list from server
  const loadProxyPage = useCallback(async (page = 1, searchVal = "") => {
    setProxyLoading(true);
    try {
      const params = { page, limit: PROXY_ROWS_PER_PAGE };
      if (searchVal) params.search = searchVal;
      const res = await axios.get(`${API_BASE}/api/proxy-list/paginated`, { params });
      setProxies(res.data.proxies || []);
      setProxyTotal(res.data.total || 0);
      setProxyTotalPages(res.data.totalPages || 0);
    } catch (err) {
      console.error("Proxy list load failed:", err.message);
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const loadDashboardData = useCallback(async () => {
    try {
      const [statsRes, listRes] = await Promise.all([
        axios.get(`${API_BASE}/api/dashboard/stats`),
        axios.get(`${API_BASE}/api/proxy-list`),
      ]);
      if (statsRes.data.success) {
        setDashboardStats(statsRes.data);
        setStats({ total: statsRes.data.revisions });
      }
      setAllProxyNames(listRes.data.proxies || []);
    } catch (err) {}
  }, []);

  // Load inventory page from server (server-side pagination)
  const loadInventoryPage = useCallback(async (page = 1, search = "") => {
    setInventoryLoading(true);
    try {
      const params = { page, limit: INV_ROWS_PER_PAGE };
      if (search) params.search = search;
      const res = await axios.get(`${API_BASE}/api/inventory/paginated`, { params });
      setInventoryRows(res.data.rows || []);
      setInventoryTotal(res.data.total || 0);
      setInventoryTotalPages(res.data.totalPages || 0);
    } catch (err) {
      console.error("Inventory load failed:", err.message);
    } finally {
      setInventoryLoading(false);
    }
  }, []);

  // Flatten inventory rows for export only (table now uses server-side flattening)
  const flattenForExport = (rows) => {
    const flat = [];
    for (const row of rows) {
      const flows = row.flows || [];
      const basePaths = (row.base_paths || []).join(", ");
      if (flows.length > 0) {
        for (const f of flows) {
          flat.push({
            proxy_name: row.proxy_name,
            revision_number: row.revision_number,
            endpoint: f.fullPath || basePaths,
          });
        }
      } else {
        flat.push({
          proxy_name: row.proxy_name,
          revision_number: row.revision_number,
          endpoint: basePaths || "-",
        });
      }
    }
    return flat;
  };

  // Export inventory to Excel CSV (fetches ALL data from server for full export)
  const exportToExcel = async () => {
    setExporting(true);
    try {
      const res = await axios.get(`${API_BASE}/api/inventory/all`);
      const flat = flattenForExport(res.data.inventory || []);
      const headers = ["Proxy Name", "Revision", "Endpoint"];

      const escapeCSV = (val) => {
        const s = String(val || "");
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      };

      const csvRows = [headers.join(",")];
      for (const row of flat) {
        csvRows.push([
          row.proxy_name,
          row.revision_number,
          row.endpoint,
        ].map(escapeCSV).join(","));
      }

      const bom = "\uFEFF";
      const blob = new Blob([bom + csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `apigee_inventory_${new Date().toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err.message);
    } finally {
      setExporting(false);
    }
  };

  // Auto-sync on mount
  useEffect(() => {
    if (!dataLoaded.current) {
      dataLoaded.current = true;
      if (triggerSync) triggerSync();
      loadProxyPage(1, "");
      loadDashboardData();
    }
  }, [triggerSync, loadProxyPage, loadDashboardData]);

  // Auto-refresh when sync completes
  const syncRefresh = useCallback(() => {
    loadProxyPage(currentPage, search);
    loadDashboardData();
  }, [loadProxyPage, loadDashboardData, currentPage, search]);

  useEffect(() => {
    if (syncVersion > 0) {
      syncRefresh();
      if (activeTab === "inventory") loadInventoryPage(inventoryPage, inventorySearch);
    }
  }, [syncVersion, activeTab, syncRefresh, loadInventoryPage, inventoryPage, inventorySearch]);

  // Auto-refresh dashboard stats every 10s after sync until inventory data appears
  const autoRefreshRef = useRef(null);
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (syncVersion > 0) {
      autoRefreshRef.current = setInterval(() => {
        loadDashboardData();
      }, 10000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [syncVersion, loadDashboardData]);

  // Stop polling once inventory records are loaded
  useEffect(() => {
    if (dashboardStats && dashboardStats.inventory_count > 0 && autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
  }, [dashboardStats]);

  const showPopup = (type, title, message) => {
    setPopup({ type, title, message });
    setTimeout(() => setPopup(null), 5000);
  };

  // ==================== SINGLE ZIP DOWNLOAD ====================
  const downloadBundle = useCallback(async (proxyName, revNumber, envs) => {
    const key = `${proxyName}::${revNumber}`;
    setDownloading((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await axios.get(
        `${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions/${revNumber}/download`,
        { responseType: "blob" }
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const envSuffix = envs && envs.length > 0 ? `_${envs.join("_")}` : "";
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${proxyName}_rev${revNumber}${envSuffix}.zip`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      console.error(`Download failed: ${proxyName} rev${revNumber}:`, err.message);
      return false;
    } finally {
      setDownloading((prev) => { const n = { ...prev }; delete n[key]; return n; });
    }
  }, []);

  // ==================== AUTO-DOWNLOAD ALL DEPLOYED ZIPS ====================
  // Triggers automatically after sync completes — downloads all deployed revision ZIPs
  useEffect(() => {
    if (syncVersion === 0 || isSyncing) return;
    if (autoDownloadTriggered.current) return;
    autoDownloadTriggered.current = true;

    (async () => {
      try {
        // Step 1: Get all deployed revisions from DB
        const depRes = await axios.get(`${API_BASE}/api/deployments/all`);
        const deployments = depRes.data.deployments || [];

        if (deployments.length === 0) return;

        console.log(`Auto-download: starting ${deployments.length} deployed revision ZIP(s)...`);

        let downloaded = 0;
        let failed = 0;

        // Step 2: Download each ZIP sequentially (browser blocks parallel downloads)
        for (let i = 0; i < deployments.length; i++) {
          const dep = deployments[i];
          const success = await downloadBundle(dep.proxy_name, dep.revision_number, dep.environments);
          if (success) {
            downloaded++;
          } else {
            failed++;
          }

          // Small delay between downloads so browser doesn't block them
          if (i < deployments.length - 1) {
            await new Promise((r) => setTimeout(r, 800));
          }
        }

        console.log(`Auto-download complete: ${downloaded}/${deployments.length}${failed > 0 ? `, Failed: ${failed}` : ""}`);
      } catch (err) {
        console.error("Auto-download failed:", err.message);
      }
    })();
  }, [syncVersion, isSyncing, downloadBundle]);

  // ==================== PAGE NAVIGATION ====================
  const openRevisionPage = async (proxyName) => {
    setRevisionPage({ proxyName, revisions: [], deployments: {} });
    setDetailPage(null);
    setLoading((p) => ({ ...p, revisions: true }));
    try {
      const [revRes, depRes] = await Promise.all([
        axios.get(`${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions`),
        axios.get(`${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/deployments`),
      ]);

      const depMap = {};
      if (depRes.data.deployments) {
        for (const d of depRes.data.deployments) {
          if (!depMap[d.revision_number]) depMap[d.revision_number] = [];
          depMap[d.revision_number].push(d.environment);
        }
      }

      setRevisionPage({ proxyName, revisions: revRes.data.revisions, deployments: depMap });
    } catch (err) {
      showPopup("error", "Error", err.response?.data?.message || "Failed to fetch revisions");
    } finally {
      setLoading((p) => ({ ...p, revisions: false }));
    }
  };

  const openDetailPage = async (proxyName, revNumber) => {
    setLoading((p) => ({ ...p, detail: true }));
    setInventory(null);
    setInventorySource(null);
    try {
      const detailRes = await axios.get(
        `${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions/${revNumber}`
      );
      setDetailPage(detailRes.data.revision);

      try {
        const invRes = await axios.get(
          `${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions/${revNumber}/inventory`
        );
        if (invRes.data.success) {
          setInventory(invRes.data.inventory);
          setInventorySource(invRes.data.source || "db");
        }
      } catch (invErr) {
        console.error("Inventory fetch failed:", invErr.message);
      }
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
    setInventory(null);
    setInventorySource(null);
  };

  // Debounced search for proxies
  const proxySearchTimerRef = useRef(null);
  const handleProxySearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    if (proxySearchTimerRef.current) clearTimeout(proxySearchTimerRef.current);
    proxySearchTimerRef.current = setTimeout(() => {
      setCurrentPage(1);
      loadProxyPage(1, val);
    }, 400);
  };

  const handleProxyPageChange = (newPage) => {
    setCurrentPage(newPage);
    loadProxyPage(newPage, search);
  };

  // Build page numbers with ellipsis for proxy pages
  const getProxyPageNumbers = () => {
    const tp = proxyTotalPages;
    if (tp <= 7) return Array.from({ length: tp }, (_, i) => i + 1);
    const pages = [];
    if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i);
      pages.push("...");
      pages.push(tp);
    } else if (currentPage >= tp - 3) {
      pages.push(1);
      pages.push("...");
      for (let i = tp - 4; i <= tp; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push("...");
      for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
      pages.push("...");
      pages.push(tp);
    }
    return pages;
  };

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

          {inventory && (
            <div className="inventory-section">
              <h3 className="inventory-section-title">
                Proxy Bundle Inventory
                {inventorySource && (
                  <span className="inventory-source-tag">
                    {inventorySource === "db" ? "from DB" : inventorySource === "cache" ? "from Cache" : "saved to DB"}
                  </span>
                )}
              </h3>
              <div className="detail-grid-page" style={{ marginBottom: 24 }}>
                <div className="detail-card-page">
                  <span className="detail-label">Base Path</span>
                  <span className="detail-value" style={{ color: "#c0392b" }}>
                    {inventory.basePaths?.join(", ") || "-"}
                  </span>
                </div>
                <div className="detail-card-page">
                  <span className="detail-label">Virtual Hosts</span>
                  <div className="inventory-tags">
                    {(inventory.virtualHosts || []).map((vh) => (
                      <span className="env-tag" key={vh}>{vh}</span>
                    ))}
                    {(!inventory.virtualHosts || inventory.virtualHosts.length === 0) && <span className="detail-value">-</span>}
                  </div>
                </div>
                <div className="detail-card-page">
                  <span className="detail-label">Target Endpoints</span>
                  <div className="inventory-tags">
                    {(inventory.targetEndpoints || []).map((te) => (
                      <span className="inventory-tag" key={te}>{te}</span>
                    ))}
                    {(!inventory.targetEndpoints || inventory.targetEndpoints.length === 0) && <span className="detail-value">-</span>}
                  </div>
                </div>
                <div className="detail-card-page">
                  <span className="detail-label">Proxy Endpoints</span>
                  <div className="inventory-tags">
                    {(inventory.proxyEndpoints || []).map((pe) => (
                      <span className="inventory-tag" key={pe}>{pe}</span>
                    ))}
                    {(!inventory.proxyEndpoints || inventory.proxyEndpoints.length === 0) && <span className="detail-value">-</span>}
                  </div>
                </div>
              </div>

              {inventory.flows && inventory.flows.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <h3 className="inventory-section-title">
                    Flows <span className="badge">{inventory.flows.length}</span>
                  </h3>
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>Flow Name</th>
                          <th>Full Path</th>
                          <th>Path Suffix</th>
                          <th>Policies</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventory.flows.map((f, i) => (
                          <tr key={i}>
                            <td className="proxy-name-cell">{f.name || "-"}</td>
                            <td><code style={{ background: "#f5f5f5", padding: "2px 8px", borderRadius: 4, fontSize: 13 }}>{f.fullPath || "-"}</code></td>
                            <td>{f.hasPathSuffix === "y" ? <span className="env-tag">{f.pathSuffix}</span> : <span style={{ color: "#aaa" }}>none</span>}</td>
                            <td>
                              <div className="inventory-tags">
                                {(f.policies || []).map((p, j) => (
                                  <span className="inventory-tag-policy" key={j}>{p}</span>
                                ))}
                                {(!f.policies || f.policies.length === 0) && <span style={{ color: "#aaa" }}>-</span>}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {inventory.policies && inventory.policies.length > 0 && (
                <div>
                  <h3 className="inventory-section-title">
                    All Policies <span className="badge">{inventory.policies.length}</span>
                  </h3>
                  <div className="inventory-tags" style={{ gap: 8 }}>
                    {inventory.policies.map((p) => (
                      <span
                        className={inventory.usedPolicies?.includes(p) ? "inventory-tag-policy" : "inventory-tag-unused"}
                        key={p}
                        title={inventory.usedPolicies?.includes(p) ? "Used in flows" : "Not referenced in proxy flows"}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!inventory && !loading.detail && (
            <div style={{ textAlign: "center", padding: "20px 0", color: "#aaa", fontSize: 14 }}>
              Loading proxy bundle inventory...
            </div>
          )}
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
              {revisionPage.revisions.map((r) => {
                const envs = revisionPage.deployments[r.revision_number] || [];
                return (
                  <div className="revision-row" key={r.revision_number}>
                    <div className="revision-row-left">
                      <span className="revision-badge">Rev {r.revision_number}</span>
                      <span className="revision-row-label">Revision {r.revision_number}</span>
                      {envs.length > 0 && (
                        <div className="env-tags">
                          {envs.map((env) => (
                            <span className="env-tag" key={env}>{env}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="revision-row-actions">
                      {envs.length > 0 && (
                        <button
                          className="btn-download-bundle"
                          onClick={() => downloadBundle(revisionPage.proxyName, r.revision_number, envs)}
                          disabled={!!downloading[`${revisionPage.proxyName}::${r.revision_number}`]}
                          title="Download proxy bundle ZIP"
                        >
                          {downloading[`${revisionPage.proxyName}::${r.revision_number}`] ? (
                            <span className="spinner-small"></span>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          )}
                          Download
                        </button>
                      )}
                      <button
                        className="btn-see-more"
                        onClick={() => openDetailPage(revisionPage.proxyName, r.revision_number)}
                        disabled={loading.detail}
                      >
                        {loading.detail ? "Loading..." : "See More"}
                      </button>
                    </div>
                  </div>
                );
              })}
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
          <button className={`sidebar-btn ${activeTab === "dashboard" ? "sidebar-active" : ""}`} onClick={() => setActiveTab("dashboard")}>
            <span className="sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </span>
            Dashboard
          </button>
          <button className={`sidebar-btn ${activeTab === "proxies" ? "sidebar-active" : ""}`} onClick={() => setActiveTab("proxies")}>
            <span className="sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
            </span>
            Proxies
          </button>
          <button className={`sidebar-btn ${activeTab === "inventory" ? "sidebar-active" : ""}`} onClick={() => { setActiveTab("inventory"); if (inventoryRows.length === 0) loadInventoryPage(1, inventorySearch); }}>
            <span className="sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>
            </span>
            Inventory
          </button>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-label">STATUS</div>
          <div className="sidebar-status">
            <span className={`status-dot ${proxyTotal > 0 ? "dot-green" : "dot-gray"}`}></span>
            Proxies: {dashboardStats?.proxies ?? proxyTotal}
          </div>
          {dashboardStats && (
            <div className="sidebar-status">
              <span className="status-dot dot-green"></span>
              Revisions: {dashboardStats.revisions}
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="dashboard-main">
        {activeTab === "dashboard" && (
          <>
            <div className="dashboard-header">
              <h1>Dashboard</h1>
              <p className="dashboard-subtitle">Overview of your Apigee API proxy data</p>
            </div>

            <div className="dash-stats-grid">
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-proxies">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.proxies ?? "-"}</span>
                  <span className="dash-stat-label">Total Proxies</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-revisions">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.revisions ?? "-"}</span>
                  <span className="dash-stat-label">Total Revisions</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-api">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.api_count ?? "-"}</span>
                  <span className="dash-stat-label">API Count</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-deployed">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.deployed_revisions ?? "-"}</span>
                  <span className="dash-stat-label">Deployed Revisions</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-deployments">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.deployments ?? "-"}</span>
                  <span className="dash-stat-label">Deployments</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-inventory">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.inventory_count ?? "-"}</span>
                  <span className="dash-stat-label">Inventory Records</span>
                </div>
              </div>
            </div>

            {isSyncing && (
              <div className="dash-sync-banner">
                <span className="spinner-small"></span>
                Sync in progress...
              </div>
            )}

            {allProxyNames.length > 0 && (
              <div className="dash-quick-section">
                <h2 className="dash-quick-title">Proxies</h2>
                <div className="dash-proxy-chips">
                  {allProxyNames.map((p) => (
                    <button className="dash-proxy-chip" key={p.proxy_name} onClick={() => { setActiveTab("proxies"); setTimeout(() => openRevisionPage(p.proxy_name), 0); }}>
                      {p.proxy_name}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {allProxyNames.length === 0 && !isSyncing && (
              <div className="empty-state">
                <div className="empty-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                </div>
                <h3>No Data Yet</h3>
                <p>Click the settings icon in the navbar and use "Sync Now" to fetch proxy data from Apigee.</p>
              </div>
            )}
          </>
        )}

        {activeTab === "proxies" && (
          <>
            <div className="dashboard-header">
              <h1>API Proxies</h1>
              <p className="dashboard-subtitle"></p>
            </div>

            {error && (
              <div className="alert error">
                {error}
                <button className="alert-close" onClick={() => setError(null)}>x</button>
              </div>
            )}

            {proxyLoading ? (
              <div className="overlay-loading">
                <div className="spinner"></div>
                <p>Loading proxies...</p>
              </div>
            ) : proxies.length > 0 ? (
              <div className="table-section">
                <div className="table-header">
                  <h2>Proxies <span className="badge">{proxyTotal}</span></h2>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search proxy name..."
                    value={search}
                    onChange={handleProxySearchChange}
                  />
                </div>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Proxy Name</th>
                        <th>Timestamp</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proxies.map((p, i) => (
                        <tr key={p.proxy_name}>
                          <td style={{ color: "#aaa", fontSize: 12 }}>{(currentPage - 1) * PROXY_ROWS_PER_PAGE + i + 1}</td>
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

                {proxyTotalPages > 1 && (
                  <div className="pagination">
                    <button
                      className="pagination-btn"
                      onClick={() => handleProxyPageChange(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </button>
                    <div className="pagination-pages">
                      {getProxyPageNumbers().map((page, idx) =>
                        page === "..." ? (
                          <span key={`ellipsis-${idx}`} className="pagination-ellipsis">...</span>
                        ) : (
                          <button
                            key={page}
                            className={`pagination-page ${currentPage === page ? "pagination-active" : ""}`}
                            onClick={() => handleProxyPageChange(page)}
                          >
                            {page}
                          </button>
                        )
                      )}
                    </div>
                    <button
                      className="pagination-btn"
                      onClick={() => handleProxyPageChange(Math.min(proxyTotalPages, currentPage + 1))}
                      disabled={currentPage === proxyTotalPages}
                    >
                      Next
                    </button>
                    <span className="pagination-info">
                      {(currentPage - 1) * PROXY_ROWS_PER_PAGE + 1}-{Math.min(currentPage * PROXY_ROWS_PER_PAGE, proxyTotal)} of {proxyTotal}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                </div>
                <h3>No Data Found</h3>
                <p>{isSyncing ? "Sync in progress..." : "Click the settings icon in the navbar and use \"Sync Now\" to fetch proxy data from Apigee."}</p>
              </div>
            )}
          </>
        )}

        {activeTab === "inventory" && (
          <InventoryTab
            inventoryRows={inventoryRows}
            inventoryLoading={inventoryLoading}
            inventorySearch={inventorySearch}
            setInventorySearch={setInventorySearch}
            inventoryPage={inventoryPage}
            setInventoryPage={setInventoryPage}
            inventoryTotal={inventoryTotal}
            inventoryTotalPages={inventoryTotalPages}
            loadInventoryPage={loadInventoryPage}
            exportToExcel={exportToExcel}
            exporting={exporting}
            isSyncing={isSyncing}
          />
        )}
      </main>
    </div>
  );
}

export default Dashboard;
