import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Zap,
    ArrowRight,
    Terminal,
    Cpu,
    Activity,
    Layout,
    Grid3X3,
    MessageSquare,
    Shield,
    Database,
    Code2,
    CheckCircle2,
    ChevronDown,
    Play
} from 'lucide-react';
import './LandingPage.css';

const LandingPage: React.FC = () => {
    const navigate = useNavigate();
    const [scrolled, setScrolled] = useState(false);
    const [activeFaq, setActiveFaq] = useState<number | null>(null);

    // Parallax effect on scroll
    useEffect(() => {
        const handleScroll = () => {
            setScrolled(window.scrollY > 50);
        };
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const toggleFaq = (index: number) => {
        setActiveFaq(activeFaq === index ? null : index);
    };

    return (
        <div className="command-center">
            {/* Navbar */}
            <nav className={`cc-nav ${scrolled ? 'scrolled' : ''}`}>
                <div className="cc-logo">
                    <div className="logo-symbol">
                        <Zap size={20} fill="currentColor" />
                    </div>
                    <span className="logo-text">SAYANHO</span>
                    <span className="logo-version">v1.2</span>
                </div>
                <div className="cc-nav-links">
                    <a href="#features">Platform</a>
                    <a href="#specs">Specs</a>
                    <a href="#faq">FAQ</a>
                </div>
                <button className="cc-btn-primary small" onClick={() => navigate('/design')}>
                    <Terminal size={16} />
                    <span>Launch Console</span>
                </button>
            </nav>

            {/* Immersive Hero */}
            <section className="cc-hero">
                <div className="cc-video-bg">
                    <video autoPlay loop muted playsInline poster="/assets/landing/hero_workspace.png">
                        <source src="/assets/landing/hero_video.webp" type="video/webp" />
                    </video>
                    <div className="cc-overlay"></div>
                </div>

                <div className="cc-hero-content">
                    <div className="status-pill">
                        <span className="dot pulse"></span>
                        System Operational
                    </div>
                    <h1 className="glitch-text" data-text="ELECTRICAL ENGINEERING REIMAGINED">
                        ELECTRICAL ENGINEERING <br />
                        <span className="text-highlight">REIMAGINED</span>
                    </h1>
                    <p className="cc-subtitle">
                        The world's first web-native electrical CAD platform. <br />
                        Design, Analyze, and Document in one unified workspace.
                    </p>
                    <div className="cc-cta-group">
                        <button className="cc-btn-primary large" onClick={() => navigate('/design')}>
                            Start Building
                            <ArrowRight size={20} />
                        </button>
                        <button className="cc-btn-secondary large" onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}>
                            View Capabilities
                        </button>
                    </div>
                </div>
            </section>

            {/* Live Bento Grid - The "Command Center" Interface */}
            <section id="features" className="cc-features">
                <div className="section-title">
                    <Activity size={24} className="accent-icon" />
                    <h2>CORE CAPABILITIES</h2>
                </div>

                <div className="cc-bento-grid">
                    {/* Main Feature: Cubicle Panel - Video Card */}
                    <div className="bento-card large video-card">
                        <div className="card-header">
                            <Grid3X3 size={20} />
                            <h3>Visual Cubicle Designer</h3>
                            <span className="beta-tag">NEW</span>
                        </div>
                        <div className="video-container">
                            <video autoPlay loop muted playsInline>
                                <source src="/assets/landing/cubicle_panel.webp" type="video/webp" />
                            </video>
                        </div>
                        <div className="card-footer">
                            <p>Real-time visual configuration of LT panels. Drag, drop, and configure incomers and busbars instantly.</p>
                        </div>
                    </div>

                    {/* Feature: AI Assistant - Video Card */}
                    <div className="bento-card medium video-card">
                        <div className="card-header">
                            <MessageSquare size={20} />
                            <h3>AI Copilot</h3>
                        </div>
                        <div className="video-container">
                            <video autoPlay loop muted playsInline>
                                <source src="/assets/landing/ai_chat_video.webp" type="video/webp" />
                            </video>
                        </div>
                        <div className="card-footer">
                            <p>Natural language design commands and technical queries.</p>
                        </div>
                    </div>

                    {/* Feature: Auto-Rating - Video Card */}
                    <div className="bento-card medium video-card">
                        <div className="card-header">
                            <Cpu size={20} />
                            <h3>Auto-Rating Engine</h3>
                        </div>
                        <div className="video-container">
                            <video autoPlay loop muted playsInline>
                                <source src="/assets/landing/auto_rating_video.webp" type="video/webp" />
                            </video>
                        </div>
                        <div className="card-footer">
                            <p>One-click network traversing analysis and sizing.</p>
                        </div>
                    </div>

                    {/* Feature: Diagram Canvas - Static Fallback if no video dedicated */}
                    <div className="bento-card large static-card">
                        <div className="card-header">
                            <Layout size={20} />
                            <h3>Advanced Schematic Canvas</h3>
                        </div>
                        <div className="img-container">
                            <img src="/assets/landing/hero_workspace.png" alt="Canvas" />
                            <div className="img-overlay"></div>
                        </div>
                        <div className="card-footer">
                            <p>Infinite canvas with smart connectors, multi-sheet portals, and SVG-based component rendering.</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Terminal Specs Section */}
            <section id="specs" className="cc-specs">
                <div className="section-title">
                    <Code2 size={24} className="accent-icon" />
                    <h2>SYSTEM ARCHITECTURE</h2>
                </div>

                <div className="terminal-window">
                    <div className="terminal-header">
                        <div className="traffic-lights">
                            <div className="light red"></div>
                            <div className="light yellow"></div>
                            <div className="light green"></div>
                        </div>
                        <span className="terminal-title">~/sayanho-core/specs.json</span>
                    </div>
                    <div className="terminal-body">
                        <div className="code-line">
                            <span className="var">const</span> <span className="name">infrastructure</span> = {'{'}
                        </div>
                        <div className="code-line indent">
                            <span className="prop">frontend</span>: <span className="string">"React 18 + TypeScript"</span>,
                        </div>
                        <div className="code-line indent">
                            <span className="prop">rendering</span>: <span className="string">"HTML5 Canvas API"</span>,
                        </div>
                        <div className="code-line indent">
                            <span className="prop">state_management</span>: <span className="string">"Zustand + Immer"</span>,
                        </div>
                        <div className="code-line indent">
                            <span className="prop">persistence</span>: <span className="string">"Local First (IndexedDB)"</span>
                        </div>
                        <div className="code-line">{'}'};</div>
                        <br />
                        <div className="code-line">
                            <span className="var">export</span> <span className="func">function</span> <span className="name">getCapabilities</span>() {'{'}
                        </div>
                        <div className="code-line indent">
                            <span className="keyword">return</span> [
                        </div>
                        <div className="code-line double-indent">
                            <span className="string">"IEC_60947_2_Compliant"</span>,
                        </div>
                        <div className="code-line double-indent">
                            <span className="string">"Real_Time_Validation"</span>,
                        </div>
                        <div className="code-line double-indent">
                            <span className="string">"Zero_Latency_Interaction"</span>
                        </div>
                        <div className="code-line indent">
                            ];
                        </div>
                        <div className="code-line">{'}'}</div>
                        <div className="cursor-line">
                            <span className="prompt">root@sayanho:~$</span> <span className="cursor">█</span>
                        </div>
                    </div>
                </div>
            </section>

            {/* Premium FAQ */}
            <section id="faq" className="cc-faq">
                <div className="section-title">
                    <Shield size={24} className="accent-icon" />
                    <h2>KNOWLEDGE_BASE</h2>
                </div>

                <div className="faq-grid">
                    {[
                        { q: "Is the platform strictly for Panel Design?", a: "No. Sayanho is a comprehensive electrical design platform. While it features a dedicated LT Cubicle Panel Designer, its core is a powerful Single Line Diagram (SLD) and wiring schematic engine suitable for complex building electrification." },
                        { q: "How does the AI Assistant integration work?", a: "The AI Copilot has read/write access to the canvas state via a secure API bridge. It can semantically understand your circuit topology to answer questions like 'What is the total connected load on DB-1?' or execute actions like 'Add a 63A MCB'." },
                        { q: "Can I export data for external cost estimation?", a: "Yes. The platform generates structured BOQ (Bill of Quantities) exports in Excel format, including granular metadata for every component, cable length, and rating, ready for estimation software." },
                        { q: "Does it support offline operation?", a: "Sayanho follows a 'Local-First' architecture. Once loaded, the core design engine runs entirely in your browser memory, ensuring zero latency and allowing you to continue working even if your connection drops." }
                    ].map((item, i) => (
                        <div key={i} className={`faq-item ${activeFaq === i ? 'active' : ''}`} onClick={() => toggleFaq(i)}>
                            <div className="faq-head">
                                <span className="q-text">{item.q}</span>
                                <ChevronDown className="chevron" size={20} />
                            </div>
                            <div className="faq-body">
                                <p>{item.a}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Footer */}
            <footer className="cc-footer">
                <div className="footer-content">
                    <div className="footer-col">
                        <h4>SAYANHO</h4>
                        <p>© 2025 Engineering Corp</p>
                    </div>
                    <div className="footer-col">
                        <a href="#">Documentation</a>
                        <a href="#">API Status</a>
                        <a href="#">Privacy Protocol</a>
                    </div>
                </div>
            </footer>
        </div>
    );
};

export default LandingPage;
