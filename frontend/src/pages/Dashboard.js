import React, { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";

const API_BASE = "";

// Map Apigee policy type to icon file in /public
const POLICY_ICON_MAP = {
  verifyapikey: "/VerifyAPIKey.png",
  spikearrest: "/SpikeArrest.png",
  raisefault: "/RaiseFault.png",
  oauthv2: "/OAuthV2.png",
  keyvaluemapoperations: "/KeyValueMapOperations.png",
  javascript: "/JavaScript.png",
  javacallout: "/JavaCallout.png",
  generatejwt: "/GenerateJWT.png",
  extractvariables: "/ExtractVariables.png",
  assignmessage: "/AssignMessage.png",
  accessentity: "/AccessEntity.png",
  flowcallout: "/FlowCallout.png",
  accesscontrol: "/AccessControl.png",
};
// Prefix/keyword aliases commonly used in Apigee policy filenames
const POLICY_NAME_ALIASES = [
  { match: ["assignmessage", "am", "assign"], icon: "/AssignMessage.png" },
  { match: ["generatejwt", "jwt", "genjwt", "generatejwttoken"], icon: "/GenerateJWT.png" },
  { match: ["verifyapikey", "vk", "verifykey", "apikey"], icon: "/VerifyAPIKey.png" },
  { match: ["spikearrest", "sa", "spike"], icon: "/SpikeArrest.png" },
  { match: ["raisefault", "rf", "fault"], icon: "/RaiseFault.png" },
  { match: ["oauthv2", "oauth"], icon: "/OAuthV2.png" },
  { match: ["keyvaluemapoperations", "kvm", "kvmops"], icon: "/KeyValueMapOperations.png" },
  { match: ["javascript", "js"], icon: "/JavaScript.png" },
  { match: ["javacallout", "jc", "java"], icon: "/JavaCallout.png" },
  { match: ["extractvariables", "ev", "extract"], icon: "/ExtractVariables.png" },
  { match: ["accessentity", "ae"], icon: "/AccessEntity.png" },
  { match: ["flowcallout", "fc", "flow"], icon: "/FlowCallout.png" },
  { match: ["accesscontrol", "ac"], icon: "/AccessControl.png" },
];
function getPolicyIcon(policyType, policyName) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s_-]/g, "");
  const typeKey = norm(policyType);
  if (POLICY_ICON_MAP[typeKey]) return POLICY_ICON_MAP[typeKey];
  const nameKey = norm(policyName);
  // Token-based match for prefixes like "AM-Foo" / "JWT-Generate"
  const tokens = String(policyName || "").toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
  for (const a of POLICY_NAME_ALIASES) {
    if (tokens.some((t) => a.match.includes(t))) return a.icon;
    if (a.match.some((m) => nameKey.includes(m))) return a.icon;
  }
  return null;
}
// All policy icons available in /public
const ALL_POLICY_ICONS = [
  { name: "AssignMessage", icon: "/AssignMessage.png" },
  { name: "AccessControl", icon: "/AccessControl.png" },
  { name: "BasicAuthentication", icon: "/BasicAuthentication.png" },
  { name: "AccessEntity", icon: "/AccessEntity.png" },
  { name: "ExtractVariables", icon: "/ExtractVariables.png" },
  { name: "FlowCallout", icon: "/FlowCallout.png" },
  { name: "GenerateJWT", icon: "/GenerateJWT.png" },
  { name: "JavaCallout", icon: "/JavaCallout.png" },
  { name: "JavaScript", icon: "/JavaScript.png" },
  { name: "JSONToXML", icon: "/JSONToXML.png" },
  { name: "KeyValueMapOperations", icon: "/KeyValueMapOperations.png" },
  { name: "MessageLogging", icon: "/MessageLogging.png" },
  { name: "OAuthV2", icon: "/OAuthV2.png" },
  { name: "Quota", icon: "/Quota.png" },
  { name: "RaiseFault", icon: "/RaiseFault.png" },
  { name: "Script", icon: "/Script.png" },
  { name: "ServiceCallout", icon: "/ServiceCallout.png" },
  { name: "SpikeArrest", icon: "/SpikeArrest.png" },
  { name: "StatisticsCollector", icon: "/StatisticsCollector.png" },
  { name: "VerifyAPIKey", icon: "/VerifyAPIKey.png" },
  { name: "XMLToJSON", icon: "/XMLToJSON.png" },
];

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
        <p className="dashboard-subtitle"></p>
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
  const [revListPage, setRevListPage] = useState(1);
  const [revListTotal, setRevListTotal] = useState(0);
  const [revListTotalPages, setRevListTotalPages] = useState(0);
  const [revListLoading, setRevListLoading] = useState(false);
  const [detailPage, setDetailPage] = useState(null);
  const [inventory, setInventory] = useState(null);
  const [inventorySource, setInventorySource] = useState(null);

  const [downloading, setDownloading] = useState({});

  // Policy icon click state
  const [selectedPolicyType, setSelectedPolicyType] = useState(null);
  const [proxyPolicies, setProxyPolicies] = useState([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);

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

  // SharedFlows state (used on dashboard stats + sharedflows tab)
  const [sharedflows, setSharedflows] = useState([]);
  const [sfRevisionPage, setSfRevisionPage] = useState(null); // { sfName, revisions, deployments }
  const [sfPolicyPage, setSfPolicyPage] = useState(null); // { sfName, revNumber, policies }
  const [sfLoading, setSfLoading] = useState({ revisions: false, policies: false });

  // Abort controllers to prevent duplicate API calls
  const proxyAbortRef = useRef(null);
  const inventoryAbortRef = useRef(null);
  const revAbortRef = useRef(null);

  // Load paginated proxy list from server
  const loadProxyPage = useCallback(async (page = 1, searchVal = "") => {
    if (proxyAbortRef.current) proxyAbortRef.current.abort();
    const controller = new AbortController();
    proxyAbortRef.current = controller;
    setProxyLoading(true);
    try {
      const params = { page, limit: PROXY_ROWS_PER_PAGE };
      if (searchVal) params.search = searchVal;
      const res = await axios.get(`${API_BASE}/api/proxy-list/paginated`, { params, signal: controller.signal });
      setProxies(res.data.proxies || []);
      setProxyTotal(res.data.total || 0);
      setProxyTotalPages(res.data.totalPages || 0);
    } catch (err) {
      if (axios.isCancel(err)) return;
      console.error("Proxy list load failed:", err.message);
    } finally {
      setProxyLoading(false);
    }
  }, []);

  const loadDashboardData = useCallback(async () => {
    try {
      const [statsRes, listRes, sfRes] = await Promise.all([
        axios.get(`${API_BASE}/api/dashboard/stats`),
        axios.get(`${API_BASE}/api/proxy-list`),
        axios.get(`${API_BASE}/api/sharedflows`),
      ]);
      if (statsRes.data.success) {
        setDashboardStats(statsRes.data);
        setStats({ total: statsRes.data.revisions });
      }
      setAllProxyNames(listRes.data.proxies || []);
      setSharedflows(sfRes.data.sharedflows || []);
    } catch (err) {}
  }, []);

  // Load inventory page from server (server-side pagination)
  const loadInventoryPage = useCallback(async (page = 1, search = "") => {
    if (inventoryAbortRef.current) inventoryAbortRef.current.abort();
    const controller = new AbortController();
    inventoryAbortRef.current = controller;
    setInventoryLoading(true);
    try {
      const params = { page, limit: INV_ROWS_PER_PAGE };
      if (search) params.search = search;
      const res = await axios.get(`${API_BASE}/api/inventory/paginated`, { params, signal: controller.signal });
      setInventoryRows(res.data.rows || []);
      setInventoryTotal(res.data.total || 0);
      setInventoryTotalPages(res.data.totalPages || 0);
    } catch (err) {
      if (axios.isCancel(err)) return;
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
      loadInventoryPage(1, inventorySearch);
    }
  }, [syncVersion]); // eslint-disable-line

  // ==================== AUTO-REFRESH (all tabs, every 10s after sync) ====================
  const autoRefreshRef = useRef(null);
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (syncVersion > 0) {
      autoRefreshRef.current = setInterval(() => {
        // Always refresh dashboard stats
        loadDashboardData();
        // Refresh active tab data
        if (activeTab === "proxies") {
          loadProxyPage(currentPage, search);
        } else if (activeTab === "inventory") {
          loadInventoryPage(inventoryPage, inventorySearch);
        }
      }, 10000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [syncVersion, activeTab, currentPage, search, inventoryPage, inventorySearch, loadDashboardData, loadProxyPage, loadInventoryPage]);

  // Stop polling once all background data is populated and sync is done
  useEffect(() => {
    if (
      !isSyncing &&
      dashboardStats &&
      dashboardStats.inventory_count > 0 &&
      dashboardStats.sharedflow_count > 0 &&
      autoRefreshRef.current
    ) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
  }, [isSyncing, dashboardStats]);

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

  // ==================== PAGE NAVIGATION ====================
  const REV_PER_PAGE = 20;

  const loadRevisionPage = useCallback(async (proxyName, page = 1) => {
    if (revAbortRef.current) revAbortRef.current.abort();
    const controller = new AbortController();
    revAbortRef.current = controller;
    setRevListLoading(true);
    try {
      const [revRes, depRes] = await Promise.all([
        axios.get(`${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/revisions/paginated`, {
          params: { page, limit: REV_PER_PAGE },
          signal: controller.signal,
        }),
        axios.get(`${API_BASE}/api/proxies/${encodeURIComponent(proxyName)}/deployments`, {
          signal: controller.signal,
        }),
      ]);

      const depMap = {};
      if (depRes.data.deployments) {
        for (const d of depRes.data.deployments) {
          if (!depMap[d.revision_number]) depMap[d.revision_number] = [];
          depMap[d.revision_number].push(d.environment);
        }
      }

      setRevisionPage({ proxyName, revisions: revRes.data.revisions || [], deployments: depMap });
      setRevListTotal(revRes.data.total || 0);
      setRevListTotalPages(revRes.data.totalPages || 0);
    } catch (err) {
      if (axios.isCancel(err)) return;
      showPopup("error", "Error", err.response?.data?.message || "Failed to fetch revisions");
    } finally {
      setRevListLoading(false);
    }
  }, []);

  const openRevisionPage = async (proxyName) => {
    setRevisionPage({ proxyName, revisions: [], deployments: {} });
    setRevListPage(1);
    setRevListTotal(0);
    setRevListTotalPages(0);
    setDetailPage(null);
    setLoading((p) => ({ ...p, revisions: true }));
    await loadRevisionPage(proxyName, 1);
    setLoading((p) => ({ ...p, revisions: false }));
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
    setSelectedPolicyType(null);
    setProxyPolicies([]);
  };

  const handlePolicyIconClick = async (policyTypeName) => {
    if (!revisionPage || !detailPage) return;
    const isSame = selectedPolicyType === policyTypeName;
    if (isSame) {
      setSelectedPolicyType(null);
      setProxyPolicies([]);
      return;
    }
    setSelectedPolicyType(policyTypeName);
    setPoliciesLoading(true);
    try {
      const res = await axios.get(
        `${API_BASE}/api/proxies/${encodeURIComponent(revisionPage.proxyName)}/revisions/${detailPage.revision_number}/policies`
      );
      const all = res.data.policies || [];
      const filtered = all.filter(
        (p) => p.policy_type.toLowerCase().replace(/[\s_-]/g, "") === policyTypeName.toLowerCase().replace(/[\s_-]/g, "")
      );
      setProxyPolicies(filtered);
    } catch (err) {
      console.error("Failed to fetch proxy policies:", err.message);
      setProxyPolicies([]);
    } finally {
      setPoliciesLoading(false);
    }
  };

  // ==================== SHARED FLOW PAGE NAVIGATION ====================
  const openSfRevisionPage = async (sfName) => {
    setSfRevisionPage({ sfName, revisions: [], deployments: {} });
    setSfPolicyPage(null);
    setSfLoading((p) => ({ ...p, revisions: true }));
    try {
      const [revRes, depRes] = await Promise.all([
        axios.get(`${API_BASE}/api/sharedflows/${encodeURIComponent(sfName)}/revisions`),
        axios.get(`${API_BASE}/api/sharedflows/${encodeURIComponent(sfName)}/deployments`),
      ]);
      const depMap = {};
      if (depRes.data.deployments) {
        for (const d of depRes.data.deployments) {
          if (!depMap[d.revision_number]) depMap[d.revision_number] = [];
          depMap[d.revision_number].push(d.environment);
        }
      }
      setSfRevisionPage({ sfName, revisions: revRes.data.revisions || [], deployments: depMap });
    } catch (err) {
      showPopup("error", "Error", err.response?.data?.message || "Failed to fetch sharedflow revisions");
    } finally {
      setSfLoading((p) => ({ ...p, revisions: false }));
    }
  };

  const openSfPolicyPage = async (sfName, revNumber) => {
    setSfLoading((p) => ({ ...p, policies: true }));
    setSfPolicyPage(null);
    try {
      const res = await axios.get(`${API_BASE}/api/sharedflows/${encodeURIComponent(sfName)}/revisions/${revNumber}/policies`);
      setSfPolicyPage({ sfName, revNumber, policies: res.data.policies || [] });
    } catch (err) {
      showPopup("error", "Error", err.response?.data?.message || "Failed to fetch sharedflow policies");
    } finally {
      setSfLoading((p) => ({ ...p, policies: false }));
    }
  };

  const closeSfRevisionPage = () => {
    setSfRevisionPage(null);
    setSfPolicyPage(null);
  };

  const closeSfPolicyPage = () => {
    setSfPolicyPage(null);
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
        <div className="overlay-container" style={{ maxWidth: 900 }}>
          <div className="overlay-header">
            <div>
              <h1 className="overlay-title">Revision Detail</h1>
              <p className="overlay-subtitle">
                {revisionPage?.proxyName} &middot; Revision {detailPage.revision_number}
              </p>
            </div>
            <button className="btn-back" onClick={closeDetailPage}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
          </div>

          <div className="revision-detail-grid">
            <div className="revision-detail-card">
              <div className="revision-detail-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4-4v2"/><circle cx="12" cy="7" r="4"/></svg>
              </div>
              <div className="revision-detail-content">
                <span className="revision-detail-label">Created By</span>
                <span className="revision-detail-value">{detailPage.created_by || "-"}</span>
              </div>
            </div>
            <div className="revision-detail-card">
              <div className="revision-detail-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div className="revision-detail-content">
                <span className="revision-detail-label">Created At</span>
                <span className="revision-detail-value">{formatEpoch(detailPage.created_at)}</span>
              </div>
            </div>
            <div className="revision-detail-card">
              <div className="revision-detail-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <div className="revision-detail-content">
                <span className="revision-detail-label">Last Modified By</span>
                <span className="revision-detail-value">{detailPage.last_modified_by || "-"}</span>
              </div>
            </div>
            <div className="revision-detail-card">
              <div className="revision-detail-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c0392b" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div className="revision-detail-content">
                <span className="revision-detail-label">Last Modified At</span>
                <span className="revision-detail-value">{formatEpoch(detailPage.last_modified_at)}</span>
              </div>
            </div>
          </div>

          <div className="policy-icons-section">
            <h3 className="policy-icons-title">Policies</h3>
            <div className="policy-icons-slider">
              <button
                className="policy-slider-btn policy-slider-left"
                onClick={() => {
                  const el = document.querySelector(".policy-icons-row");
                  if (el) el.scrollBy({ left: -200, behavior: "smooth" });
                }}
                title="Scroll left"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <div className="policy-icons-row">
                {ALL_POLICY_ICONS.map((p) => (
                  <button
                    className={`policy-icon-btn${selectedPolicyType === p.name ? " policy-icon-btn-active" : ""}`}
                    key={p.name}
                    title={p.name}
                    onClick={() => handlePolicyIconClick(p.name)}
                  >
                    <img src={p.icon} alt={p.name} />
                  </button>
                ))}
              </div>
              <button
                className="policy-slider-btn policy-slider-right"
                onClick={() => {
                  const el = document.querySelector(".policy-icons-row");
                  if (el) el.scrollBy({ left: 200, behavior: "smooth" });
                }}
                title="Scroll right"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          </div>

          <div className="apigee-flow-section">
            <div className="apigee-flow-bar apigee-flow-request">
              <div className="apigee-flow-line">
                <div className="apigee-flow-line-inner"></div>
                <span className="apigee-flow-center-label apigee-flow-center-request">
                  {selectedPolicyType && policiesLoading && (
                    <img className="apigee-flow-icon" src={ALL_POLICY_ICONS.find(p => p.name === selectedPolicyType)?.icon} alt="" />
                  )}
                  Request
                </span>
                <div className="apigee-flow-line-inner"></div>
                <svg className="apigee-flow-arrow" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
              </div>
            </div>
            <div className="apigee-flow-bar apigee-flow-response">
              <div className="apigee-flow-line">
                <svg className="apigee-flow-arrow" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 12H5M11 19l-7-7 7-7"/></svg>
                <div className="apigee-flow-line-inner"></div>
                <span className="apigee-flow-center-label apigee-flow-center-response">
                  Response
                  {selectedPolicyType && !policiesLoading && proxyPolicies.length >= 0 && (
                    <img className="apigee-flow-icon" src={ALL_POLICY_ICONS.find(p => p.name === selectedPolicyType)?.icon} alt="" />
                  )}
                </span>
                <div className="apigee-flow-line-inner"></div>
              </div>
            </div>
            {selectedPolicyType && !policiesLoading && (
              <div className="apigee-flow-response-icon">
                <img src={ALL_POLICY_ICONS.find(p => p.name === selectedPolicyType)?.icon} alt={selectedPolicyType} />
                <span>{selectedPolicyType}</span>
                <span className="apigee-flow-response-count">{proxyPolicies.length} found</span>
              </div>
            )}
          </div>

          {selectedPolicyType && (
            <div className="policy-results-section">
              <div className="policy-results-header">
                <h3 className="policy-results-title">
                  {selectedPolicyType}
                  <span className="badge">{proxyPolicies.length}</span>
                </h3>
                <button className="policy-results-close" onClick={() => { setSelectedPolicyType(null); setProxyPolicies([]); }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              {policiesLoading ? (
                <div style={{ textAlign: "center", padding: "24px 0", color: "#888" }}>
                  <div className="spinner"></div>
                  <p style={{ marginTop: 8 }}>Loading policies...</p>
                </div>
              ) : proxyPolicies.length > 0 ? (
                <div className="policy-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Policy Name</th>
                        <th>Policy Type</th>
                        <th>SharedFlowBundle</th>
                        <th>ClassName</th>
                        <th>ResourceURL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proxyPolicies.map((p, i) => (
                        <tr key={p.policy_name}>
                          <td style={{ color: "#aaa", fontSize: 12 }}>{i + 1}</td>
                          <td className="proxy-name-cell">{p.policy_name}</td>
                          <td><span className="inventory-tag-policy">{p.policy_type || "-"}</span></td>
                          <td>{p.shared_flow_bundle || <span style={{ color: "#ccc" }}>-</span>}</td>
                          <td>{p.class_name || <span style={{ color: "#ccc" }}>-</span>}</td>
                          <td>{p.resource_url || <span style={{ color: "#ccc" }}>-</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "24px 0", color: "#aaa", fontSize: 14 }}>
                  No {selectedPolicyType} policies found for this revision.
                </div>
              )}
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

          {(loading.revisions || revListLoading) ? (
            <div className="overlay-loading">
              <div className="spinner"></div>
              <p>Loading revisions...</p>
            </div>
          ) : revisionPage.revisions.length > 0 ? (
            (() => {
              const handleRevPageChange = (newPage) => {
                setRevListPage(newPage);
                loadRevisionPage(revisionPage.proxyName, newPage);
              };

              const getRevPageNumbers = () => {
                if (revListTotalPages <= 7) return Array.from({ length: revListTotalPages }, (_, i) => i + 1);
                const pages = [];
                if (revListPage <= 4) {
                  for (let i = 1; i <= 5; i++) pages.push(i);
                  pages.push("...");
                  pages.push(revListTotalPages);
                } else if (revListPage >= revListTotalPages - 3) {
                  pages.push(1);
                  pages.push("...");
                  for (let i = revListTotalPages - 4; i <= revListTotalPages; i++) pages.push(i);
                } else {
                  pages.push(1);
                  pages.push("...");
                  for (let i = revListPage - 1; i <= revListPage + 1; i++) pages.push(i);
                  pages.push("...");
                  pages.push(revListTotalPages);
                }
                return pages;
              };

              return (
                <>
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

                  {revListTotalPages > 1 && (
                    <div className="pagination">
                      <button
                        className="pagination-btn"
                        onClick={() => handleRevPageChange(Math.max(1, revListPage - 1))}
                        disabled={revListPage === 1}
                      >
                        Previous
                      </button>
                      <div className="pagination-pages">
                        {getRevPageNumbers().map((page, idx) =>
                          page === "..." ? (
                            <span key={`ellipsis-${idx}`} className="pagination-ellipsis">...</span>
                          ) : (
                            <button
                              key={page}
                              className={`pagination-page ${revListPage === page ? "pagination-active" : ""}`}
                              onClick={() => handleRevPageChange(page)}
                            >
                              {page}
                            </button>
                          )
                        )}
                      </div>
                      <button
                        className="pagination-btn"
                        onClick={() => handleRevPageChange(Math.min(revListTotalPages, revListPage + 1))}
                        disabled={revListPage === revListTotalPages}
                      >
                        Next
                      </button>
                      <span className="pagination-info">
                        {(revListPage - 1) * REV_PER_PAGE + 1}-{Math.min(revListPage * REV_PER_PAGE, revListTotal)} of {revListTotal}
                      </span>
                    </div>
                  )}
                </>
              );
            })()
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
          <button className={`sidebar-btn ${activeTab === "sharedflows" ? "sidebar-active" : ""}`} onClick={() => { setActiveTab("sharedflows"); setSfRevisionPage(null); setSfPolicyPage(null); }}>
            <span className="sidebar-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/></svg>
            </span>
            Shared Flows
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
              <p className="dashboard-subtitle"></p>
            </div>

            {isSyncing && (
              <div className="dash-sync-banner">
                <span className="spinner-small"></span>
                Sync in progress...
              </div>
            )}

            {/* ===== PROXY SECTION ===== */}
            <h2 className="dash-section-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
              API Proxies
            </h2>
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
                <div className="dash-stat-icon dash-stat-icon-api">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.api_count ?? "-"}</span>
                  <span className="dash-stat-label">API Count</span>
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
              <div className="dash-stat-card">
                <div className="dash-stat-icon dash-stat-icon-policies">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.policy_count ?? "-"}</span>
                  <span className="dash-stat-label">Policies</span>
                </div>
              </div>
            </div>

            {allProxyNames.length > 0 && (
              <div className="dash-quick-section">
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

            {/* ===== SHARED FLOWS SECTION ===== */}
            <h2 className="dash-section-title" style={{ marginTop: 32 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/></svg>
              Shared Flows
            </h2>
            <div className="dash-stats-grid">
              <div className="dash-stat-card">
                <div className="dash-stat-icon" style={{ background: "#ede9fe", color: "#5b21b6" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.sharedflow_count ?? "-"}</span>
                  <span className="dash-stat-label">Total Shared Flows</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon" style={{ background: "#ede9fe", color: "#5b21b6" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.sf_revision_count ?? "-"}</span>
                  <span className="dash-stat-label">Total Revisions</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon" style={{ background: "#ede9fe", color: "#5b21b6" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.sf_deployed_revision_count ?? "-"}</span>
                  <span className="dash-stat-label">Deployed Revisions</span>
                </div>
              </div>
              <div className="dash-stat-card">
                <div className="dash-stat-icon" style={{ background: "#ede9fe", color: "#5b21b6" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div className="dash-stat-info">
                  <span className="dash-stat-number">{dashboardStats?.sf_policy_count ?? "-"}</span>
                  <span className="dash-stat-label">Policies</span>
                </div>
              </div>
            </div>

            {sharedflows.length > 0 && (
              <div className="dash-quick-section">
                <div className="dash-proxy-chips">
                  {sharedflows.map((sf) => (
                    <span className="dash-proxy-chip" key={sf.sharedflow_name} style={{ cursor: "default" }}>
                      {sf.sharedflow_name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {allProxyNames.length === 0 && sharedflows.length === 0 && !isSyncing && (
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
                          <td style={{ color: "#aaa", fontSize: 12 }}>{p.id}</td>
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

        {activeTab === "sharedflows" && (
          <>
            {/* Sharedflow Policy Detail Page */}
            {sfPolicyPage ? (
              <>
                <div className="dashboard-header">
                  <h1>Policies</h1>
                  <p className="dashboard-subtitle">{sfPolicyPage.sfName} - Revision {sfPolicyPage.revNumber}</p>
                </div>
                <button className="btn-back" style={{ marginBottom: 20 }} onClick={closeSfPolicyPage}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
                  Back to Revisions
                </button>
                {sfPolicyPage.policies.length > 0 ? (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Policy Name</th>
                          <th>Type</th>
                          <th>Async</th>
                          <th>Continue On Error</th>
                          <th>Enabled</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sfPolicyPage.policies.map((p, i) => (
                          <tr key={p.policy_name}>
                            <td style={{ color: "#aaa", fontSize: 12 }}>{i + 1}</td>
                            <td className="proxy-name-cell">
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div
                                  style={{
                                    width: 28,
                                    height: 28,
                                    flexShrink: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    background: "#fff",
                                    borderRadius: 6,
                                    border: "1px solid #e0e0e0",
                                    padding: 3,
                                    boxSizing: "border-box",
                                  }}
                                >
                                  {getPolicyIcon(p.policy_type, p.policy_name) && (
                                    <img
                                      src={getPolicyIcon(p.policy_type, p.policy_name)}
                                      alt={p.policy_type || ""}
                                      style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
                                    />
                                  )}
                                </div>
                                <span>{p.policy_name}</span>
                              </div>
                            </td>
                            <td><span className="inventory-tag-policy">{p.policy_type || "-"}</span></td>
                            <td>{p.async === "true" ? <span className="env-tag">true</span> : <span style={{ color: "#aaa" }}>false</span>}</td>
                            <td>{p.continue_on_error === "true" ? <span className="env-tag">true</span> : <span style={{ color: "#aaa" }}>false</span>}</td>
                            <td>{p.enabled === "true" ? <span className="env-tag">true</span> : <span style={{ color: "#c0392b" }}>false</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-state">
                    <h3>No Policies Found</h3>
                    <p>No policies were found for this sharedflow revision.</p>
                  </div>
                )}
              </>

            /* Sharedflow Revision List Page */
            ) : sfRevisionPage ? (
              <>
                <div className="dashboard-header">
                  <h1>Revisions</h1>
                  <p className="dashboard-subtitle">{sfRevisionPage.sfName}</p>
                </div>
                <button className="btn-back" style={{ marginBottom: 20 }} onClick={closeSfRevisionPage}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
                  Back to Shared Flows
                </button>
                {sfLoading.revisions ? (
                  <div className="overlay-loading">
                    <div className="spinner"></div>
                    <p>Loading revisions...</p>
                  </div>
                ) : sfRevisionPage.revisions.length > 0 ? (
                  <div className="revision-list">
                    {sfRevisionPage.revisions.map((r) => {
                      const envs = sfRevisionPage.deployments[r.revision_number] || [];
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
                                className="btn-see-more"
                                onClick={() => openSfPolicyPage(sfRevisionPage.sfName, r.revision_number)}
                                disabled={sfLoading.policies}
                              >
                                {sfLoading.policies ? "Loading..." : "View Policies"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">
                    <h3>No Revisions Found</h3>
                    <p>No revisions found for this sharedflow.</p>
                  </div>
                )}
              </>

            /* Sharedflow List (main view) */
            ) : (
              <>
                <div className="dashboard-header">
                  <h1>Shared Flows</h1>
                  <p className="dashboard-subtitle">All synced shared flows from Apigee</p>
                </div>
                {sharedflows.length > 0 ? (
                  <div className="table-section">
                    <div className="table-header">
                      <h2>Shared Flows <span className="badge">{sharedflows.length}</span></h2>
                    </div>
                    <div className="table-wrapper">
                      <table>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Shared Flow Name</th>
                            <th>Synced At</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sharedflows.map((sf, i) => (
                            <tr key={sf.sharedflow_name}>
                              <td style={{ color: "#aaa", fontSize: 12 }}>{i + 1}</td>
                              <td className="proxy-name-cell">{sf.sharedflow_name}</td>
                              <td>{sf.timestamp ? new Date(sf.timestamp).toLocaleString() : "-"}</td>
                              <td>
                                <button
                                  className="btn-check-revision"
                                  onClick={() => openSfRevisionPage(sf.sharedflow_name)}
                                >
                                  Check Revisions
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M11 18H8a2 2 0 01-2-2V9"/></svg>
                    </div>
                    <h3>No Shared Flows</h3>
                    <p>{isSyncing ? "Sync in progress..." : "Run a sync to fetch shared flows from Apigee."}</p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default Dashboard;
