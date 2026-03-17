import React, { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";

const API_BASE = "http://localhost:5000";

const VALID_EMAIL = "readonly@ext.icici.bank.in";
const VALID_PASSWORD = "Apigee@2028";

function Navbar({ isLoggedIn, onLogin, onLogout, onSyncComplete }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [showDropdown, setShowDropdown] = useState(false);
  const [email, setEmail] = useState(VALID_EMAIL);
  const [password, setPassword] = useState(VALID_PASSWORD);
  const [loginError, setLoginError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [popup, setPopup] = useState(null);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const showPopup = (type, title, message) => {
    setPopup({ type, title, message });
    setTimeout(() => setPopup(null), 4000);
  };

  const handleLogin = (e) => {
    e.preventDefault();
    setLoginError("");

    if (email === VALID_EMAIL && password === VALID_PASSWORD) {
      onLogin();
      setShowDropdown(false);
      setLoginError("");

      // Background sync - no loader, only popup notification
      setSyncing(true);
      showPopup("success", "Login Successful", "Syncing data from Apigee in background...");

      axios.post(`${API_BASE}/api/sync`, {}, { timeout: 0 })
        .then((res) => {
          showPopup("success", "Sync Complete", `Proxies: ${res.data.proxies}, Revisions: ${res.data.revisions}, Deployments: ${res.data.deployments}`);
          if (onSyncComplete) onSyncComplete();
        })
        .catch(() => {
          showPopup("error", "Sync Failed", "Background sync failed. Data may still be available from database.");
        })
        .finally(() => setSyncing(false));

      navigate("/dashboard");
    } else {
      setLoginError("Invalid email or password");
    }
  };

  const handleLogout = () => {
    onLogout();
    setEmail("");
    setPassword("");
    setLoginError("");
    setShowDropdown(false);
    navigate("/");
  };

  return (
    <>
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

      <nav className="navbar">
        <div className="navbar-container">
          <Link to="/" className="navbar-logo">
            <span className="logo-icon">A</span>
            <span className="logo-text">Apigee Inventory</span>
          </Link>
          <div className="navbar-right">
            <div className="navbar-links">
              <Link to="/" className={`nav-link ${location.pathname === "/" ? "active" : ""}`}>
                Home
              </Link>
              {isLoggedIn && (
                <Link to="/dashboard" className={`nav-link ${location.pathname === "/dashboard" ? "active" : ""}`}>
                  Dashboard
                </Link>
              )}
            </div>

            {/* Settings Icon */}
            <div className="settings-wrapper" ref={dropdownRef}>
              <button
                className="settings-btn"
                onClick={() => setShowDropdown(!showDropdown)}
                title="Settings"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
                </svg>
              </button>

              {showDropdown && (
                <div className="admin-dropdown">
                  <div className="admin-dropdown-header">
                    {isLoggedIn ? "Admin Panel" : "Login"}
                  </div>
                  <div className="admin-dropdown-body">
                    {!isLoggedIn ? (
                      <form onSubmit={handleLogin}>
                        <div className="admin-field">
                          <label className="admin-label">Email</label>
                          <input
                            type="email"
                            className="admin-input"
                            placeholder="Enter email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                          />
                        </div>
                        <div className="admin-field">
                          <label className="admin-label">Password</label>
                          <input
                            type="password"
                            className="admin-input"
                            placeholder="Enter password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                          />
                        </div>
                        {loginError && (
                          <div className="admin-result admin-result-error">{loginError}</div>
                        )}
                        <button type="submit" className="admin-sync-btn" disabled={syncing}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/>
                            <polyline points="10 17 15 12 10 7"/>
                            <line x1="15" y1="12" x2="3" y2="12"/>
                          </svg>
                          Login
                        </button>
                      </form>
                    ) : (
                      <div>
                        <div className="admin-welcome">
                          <div className="admin-avatar">
                            {email ? email.charAt(0).toUpperCase() : "U"}
                          </div>
                          <div>
                            <div className="admin-name">Admin</div>
                            <div className="admin-email">{email || VALID_EMAIL}</div>
                          </div>
                        </div>
                        <button className="admin-logout-btn" onClick={handleLogout}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                            <polyline points="16 17 21 12 16 7"/>
                            <line x1="21" y1="12" x2="9" y2="12"/>
                          </svg>
                          Logout
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}

export default Navbar;
