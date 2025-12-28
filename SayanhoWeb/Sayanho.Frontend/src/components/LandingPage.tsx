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
            title: 'Auto-Rating Engine',
            desc: 'Calculate load currents and auto-size MCBs, MCCBs, cables and wires.',
            image: '/assets/landing/auto_rating_video.webp'
        },
        {
            id: 2,
            title: 'LT Panel Designer',
            desc: 'Configure cubicle panels with up to 3 incomers, bus couplers, and outgoings.',
            image: '/assets/landing/cubicle_panel.webp'
        },
        {
            id: 3,
            title: 'AI Assistant',
            desc: 'Query the component database and get help with natural language.',
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
                    <h1>Electrical Single-Line Diagram Designer</h1>
                    <p>
                        Professional tool for designing distribution systems. Auto-rate components,
                        calculate voltage drop, generate cost estimates, and design LT panels.
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
                <p className="section-subtitle">Click on each feature to explore</p>

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
                        <h3>Distribution Equipment</h3>
                        <ul>
                            <li>VTPN / HTPN Distribution Boards</li>
                            <li>SPN DB with configurable ways</li>
                            <li>LT Cubicle Panels (ACB/MCCB/SFU)</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Switchgear</h3>
                        <ul>
                            <li>Main Switch (TPN SFU)</li>
                            <li>Change Over Switch (Open/Enclosed)</li>
                            <li>MCB, MCCB, MCB Isolator</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Cables & Wiring</h3>
                        <ul>
                            <li>FR / FRLS / ZHFR types</li>
                            <li>Copper and Aluminum conductors</li>
                            <li>Various laying methods</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Load Points</h3>
                        <ul>
                            <li>Lights, Fans, AC Points</li>
                            <li>Switch boards (5A/15A)</li>
                            <li>Socket outlets</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Analysis Tools</h3>
                        <ul>
                            <li>Network current calculation</li>
                            <li>Voltage drop analysis (PDF)</li>
                            <li>Cost estimation (Excel)</li>
                        </ul>
                    </div>

                    <div className="spec-card">
                        <h3>Project Features</h3>
                        <ul>
                            <li>Save/Load projects</li>
                            <li>Multi-sheet diagrams</li>
                            <li>Undo/Redo support</li>
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
