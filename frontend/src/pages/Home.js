import React from "react";
import { useNavigate } from "react-router-dom";

function Home() {
  const navigate = useNavigate();

  return (
    <div className="home">
      <div className="hero">
        <div className="hero-content">
          <h1 className="hero-title">
            Apigee API Proxy<br />
            <span className="hero-highlight">Inventory Management</span>
          </h1>
          <p className="hero-subtitle">
            Manage and monitor all your Apigee API proxies, revisions, and metadata in one centralized dashboard. Generate tokens, fetch proxies, and explore revision details instantly.
          </p>
          <div className="hero-stats">
            <div className="stat-item">
              <span className="stat-number">4000+</span>
              <span className="stat-label">API Proxies</span>
            </div>
            <div className="stat-item">
              <span className="stat-number">33K+</span>
              <span className="stat-label">Revisions</span>
            </div>
            <div className="stat-item">
              <span className="stat-number">100x</span>
              <span className="stat-label">Parallel Fetch</span>
            </div>
          </div>
          <button
            className="btn-get-started"
            onClick={() => navigate("/dashboard?sync=true")}
          >
            Get Started
          </button>
        </div>
        <div className="hero-visual">
          <div className="visual-card">
            <div className="card-header-visual">
              <span className="dot red"></span>
              <span className="dot yellow"></span>
              <span className="dot green"></span>
            </div>
            <div className="card-body-visual">
              <div className="code-line"><span className="code-key">proxy</span>: "payment-api"</div>
              <div className="code-line"><span className="code-key">revision</span>: "3"</div>
              <div className="code-line"><span className="code-key">createdBy</span>: "admin@icici"</div>
              <div className="code-line"><span className="code-key">status</span>: <span className="code-val">deployed</span></div>
            </div>
          </div>
        </div>
      </div>

      <div className="features">
        <div className="feature-card">
          <div className="feature-icon">01</div>
          <h3>Auto Sync</h3>
          <p>One click to auto-authenticate, fetch all proxies and revisions from Apigee.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">02</div>
          <h3>Filtered Data</h3>
          <p>Only stores relevant proxies - EazyPay, composite, CIB, NPCI, D365.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">03</div>
          <h3>Explore Revisions</h3>
          <p>Drill into each proxy to see revision history, creators, and modification details.</p>
        </div>
      </div>
    </div>
  );
}

export default Home;
