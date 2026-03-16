import React from "react";
import { Link, useLocation } from "react-router-dom";

function Navbar() {
  const location = useLocation();

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/" className="navbar-logo">
          <span className="logo-icon">A</span>
          <span className="logo-text">Apigee Inventory</span>
        </Link>
        <div className="navbar-links">
          <Link to="/" className={`nav-link ${location.pathname === "/" ? "active" : ""}`}>
            Home
          </Link>
          <Link to="/dashboard" className={`nav-link ${location.pathname === "/dashboard" ? "active" : ""}`}>
            Dashboard
          </Link>
        </div>
      </div>
    </nav>
  );
}

export default Navbar;
