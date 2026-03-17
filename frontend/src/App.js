import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Navbar from "./components/Navbar";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import "./App.css";

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return localStorage.getItem("apigee_logged_in") === "true";
  });
  const [syncVersion, setSyncVersion] = useState(0);

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

  return (
    <Router>
      <Navbar isLoggedIn={isLoggedIn} onLogin={handleLogin} onLogout={handleLogout} onSyncComplete={handleSyncComplete} />
      <Routes>
        <Route path="/" element={<Home isLoggedIn={isLoggedIn} />} />
        <Route
          path="/dashboard"
          element={isLoggedIn ? <Dashboard syncVersion={syncVersion} /> : <Navigate to="/" replace />}
        />
      </Routes>
    </Router>
  );
}

export default App;
