import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon } from 'lucide-react';
import './LandingPage.css';

const LandingPage: React.FC = () => {
    const navigate = useNavigate();
    const [scrolled, setScrolled] = useState(false);
    const [activeFeature, setActiveFeature] = useState(0);
    const [isDark, setIsDark] = useState(() => {
        const saved = localStorage.getItem('lp-theme');
        return saved ? saved === 'dark' : true; // Default to dark
    });

    useEffect(() => {
        const handleScroll = () => {
            setScrolled(window.scrollY > 50);
        };
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    useEffect(() => {
        localStorage.setItem('lp-theme', isDark ? 'dark' : 'light');
        document.documentElement.setAttribute('data-lp-theme', isDark ? 'dark' : 'light');
    }, [isDark]);

    const features = [
        {
            id: 0,
            title: 'Visual Diagram Editor',
            desc: 'Drag and drop 50+ electrical components. Multi-sheet support with portal linking.',
            image: '/assets/landing/hero_workspace.gif'
        },
        {
            id: 1,
            title: 'Smart Layout Designer',
            desc: 'Upload floor plans, detect rooms automatically, and place equipment in a 2D/3D workspace.',
            image: '/assets/landing/layout_designer.webp'
        },
        {
            id: 2,
            title: 'Auto-Rating Engine',
            desc: 'Calculate load currents and auto-size MCBs, MCCBs, cables and wires instantly.',
            image: '/assets/landing/auto_rating_video.webp'
        },
        {
            id: 3,
            title: 'Bi-directional Magic Sync',
            desc: 'Seamlessly sync components between Single-Line Diagrams and architectural layouts.',
            image: '/assets/landing/magic_sync.webp'
        },
        {
            id: 4,
            title: 'AI Assistant',
            desc: 'Query the component database and get engineering help with natural language.',
            image: '/assets/landing/ai_chat_video.webp'
        }
    ];

    return (
        <div className={`lp ${isDark ? 'dark' : 'light'}`}>
            {/* Navigation */}
            <nav className={`lp-nav ${scrolled ? 'scrolled' : ''}`}>
                <div className="lp-logo">⚡ Sayanho</div>
                <div className="lp-nav-links">
                    <a href="#features">Features</a>
                    <a href="#specs">Specifications</a>
                </div>
                <div className="lp-nav-right">
                    <button
                        className="theme-toggle"
                        onClick={() => setIsDark(!isDark)}
                        title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                    >
                        {isDark ? <Sun size={18} /> : <Moon size={18} />}
                    </button>
                    <button className="lp-cta-btn" onClick={() => navigate('/design')}>
                        Open Designer
                    </button>
                </div>
            </nav>

            {/* Hero Section */}
            <header className="lp-hero">
                <div className="hero-text">
                    <h1>Sayanho: Intelligent Electrical Design Suite</h1>
                    <p>
                        Comprehensive tool for SLD design, architectural layouts, and automated engineering.
                        Calculate voltage drop, auto-rate switchgear, and sync designs across workspace views.
                    </p>
                    <div className="hero-btns">
                        <button className="btn-primary" onClick={() => navigate('/design')}>
                            Start Designing →
                        </button>
                    </div>
                </div>
                <div className="hero-media">
                    <img
                        src="/assets/landing/hero_video.webp"
                        alt="Sayanho Designer"
                        className="hero-video"
                    />
                </div>
            </header>

            {/* Interactive Features Section - Manual Tabs Only */}
            <section id="features" className="lp-features">
                <h2>Key Features</h2>
                <p className="section-subtitle">Intelligent tools for modern electrical engineering</p>

                <div className="features-showcase">
                    <div className="feature-tabs">
                        {features.map((f, i) => (
                            <button
                                key={f.id}
                                className={`feature-tab ${activeFeature === i ? 'active' : ''}`}
                                onClick={() => setActiveFeature(i)}
                            >
                                <span className="tab-number">{String(i + 1).padStart(2, '0')}</span>
                                <div className="tab-content">
                                    <strong>{f.title}</strong>
                                    <span>{f.desc}</span>
                                </div>
                            </button>
                        ))}
                    </div>

                    <div className="feature-preview">
                        <img
                            key={activeFeature} // Force re-render on change
                            src={features[activeFeature].image}
                            alt={features[activeFeature].title}
                        />
                        <div className="preview-label">{features[activeFeature].title}</div>
                    </div>
                </div>
            </section>

            {/* Specifications Grid */}
            <section id="specs" className="lp-specs">
                <h2>Technical Specifications</h2>

                <div className="specs-grid">
                    <div className="spec-card">
                        <h3>Layout Designer</h3>
                        <ul>
                            <li>AI-powered Room Detection</li>
                            <li>Architectural Wall/Door Drafting</li>
                            <li>3D Floor Plan Visualization</li>
                            <li>Scale Calibration & Measurements</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Distribution & Sync</h3>
                        <ul>
                            <li>Bi-directional Magic Sync (SLD ↔ Layout)</li>
                            <li>Multi-Sheet Portal Linking</li>
                            <li>LT Cubicle Panel Configuration</li>
                            <li>Real-time Constraint Validation</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Switchgear & Load</h3>
                        <ul>
                            <li>VTPN / HTPN / SPN DB support</li>
                            <li>MCB, MCCB, ACB, SFU Selection</li>
                            <li>Automated Cable Sizing</li>
                            <li>Custom Load Point Definitions</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Wiring & Analysis</h3>
                        <ul>
                            <li>Orthogonal (Manhattan) Wiring</li>
                            <li>AutoCAD-style Arc Routing</li>
                            <li>Automated Voltage Drop Analysis</li>
                            <li>Excel Cost Estimate Generation</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Modern Architecture</h3>
                        <ul>
                            <li>Fast Canvas Rendering (React Konva)</li>
                            <li>Zustand State Management</li>
                            <li>Dark/Light Mode Support</li>
                            <li>Local Persistent Project Storage</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Smart Features</h3>
                        <ul>
                            <li>LLM-Powered Technical Assistant</li>
                            <li>Smart Layout Recognition</li>
                            <li>Undo/Redo with History Snapshots</li>
                            <li>Mobile-responsive Viewer</li>
                        </ul>
                    </div>
                </div>
            </section>

            {/* CTA Section */}
            <section className="lp-cta">
                <h2>Ready to Design?</h2>
                <p>No account required. Start designing immediately.</p>
                <button className="btn-primary large" onClick={() => navigate('/design')}>
                    Launch Designer
                </button>
            </section>

            {/* Footer */}
            <footer className="lp-footer">
                <span>⚡ Sayanho</span>
                <span>© 2025 Sayanho Engineering</span>
            </footer>
        </div>
    );
};

export default LandingPage;
