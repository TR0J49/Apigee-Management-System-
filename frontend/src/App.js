import React, { useState, useCallback, useRef } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import axios from "axios";
import Navbar from "./components/Navbar";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import "./App.css";

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return localStorage.getItem("apigee_logged_in") === "true";
  });
  const [syncVersion, setSyncVersion] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncInProgress = useRef(false);

  const handleLogin = () => {
    localStorage.setItem("apigee_logged_in", "true");
    setIsLoggedIn(true);
  };

  const handleLogout = () => {
    localStorage.removeItem("apigee_logged_in");
    setIsLoggedIn(false);
  };

  const handleSyncComplete = () => {
    setSyncVersion((v) => v + 1);
  };

  // Shared sync trigger — used by Navbar and Dashboard auto-sync
  const triggerSync = useCallback(() => {
    if (syncInProgress.current) return;
    syncInProgress.current = true;
    setIsSyncing(true);
    axios.post("/api/sync", {}, { timeout: 0 })
      .then(() => {
        setSyncVersion((v) => v + 1);
      })
      .catch(() => {})
      .finally(() => {
        setIsSyncing(false);
        syncInProgress.current = false;
      });
  }, []);

  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Navbar isLoggedIn={isLoggedIn} onLogin={handleLogin} onLogout={handleLogout} onSyncComplete={handleSyncComplete} onSyncStart={() => setIsSyncing(true)} onSyncEnd={() => setIsSyncing(false)} />
      <Routes>
        <Route path="/" element={<Home isLoggedIn={isLoggedIn} />} />
        <Route
          path="/dashboard"
          element={isLoggedIn ? <Dashboard syncVersion={syncVersion} isSyncing={isSyncing} triggerSync={triggerSync} /> : <Navigate to="/" replace />}
        />
      </Routes>
    </Router>
  );
}

export default App;
