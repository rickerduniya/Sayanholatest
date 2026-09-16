import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Layout,
    Zap,
    FileText,
    Calculator,
    MessageSquare,
    Download,
    Layers,
    ArrowRight,
    Grid3X3,
    Cpu,
    Moon,
    Sun,
    Save,
    CheckCircle2,
    Code2,
    Database,
    ShieldCheck,
    HelpCircle,
    ChevronDown
} from 'lucide-react';
import './LandingPage.css';

const LandingPage: React.FC = () => {
    const navigate = useNavigate();
    const [openFaq, setOpenFaq] = React.useState<number | null>(null);

    const scrollToFeatures = () => {
        document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
    };

    const toggleFaq = (index: number) => {
        setOpenFaq(openFaq === index ? null : index);
    };

    return (
        <div className="landing-container">
            {/* Navbar */}
            <nav className="lp-nav">
                <div className="lp-logo">
                    <span className="logo-icon">⚡</span>
                    SAYANHO
                </div>
                <div className="lp-nav-links">
                    <span onClick={scrollToFeatures} className="lp-nav-link">Features</span>
                    <span onClick={() => document.getElementById('specs')?.scrollIntoView({ behavior: 'smooth' })} className="lp-nav-link">Specs</span>
                    <span onClick={() => document.getElementById('faq')?.scrollIntoView({ behavior: 'smooth' })} className="lp-nav-link">FAQ</span>
                    <button onClick={() => navigate('/design')} className="btn-primary-sm">
                        Launch Designer
                        <ArrowRight size={16} />
                    </button>
                </div>
            </nav>

            {/* Hero Section */}
            <section className="hero">
                <div className="hero-glow"></div>
                <div className="hero-content">
                    <div className="hero-badge">
                        <Zap size={14} />
                        Sayanho v1.2 — Now with AI Assistant
                    </div>
                    <h1>
                        Professional Electrical<br />
                        <span className="gradient-text">Distribution Design</span>
                    </h1>
                    <p className="hero-subtitle">
                        The complete web-based tool for electrical engineers.
                        Create single-line diagrams, configure panels, calculate ratings, and export professional
                        documentation — all in your browser.
                    </p>
                    <div className="hero-ctas">
                        <button onClick={() => navigate('/design')} className="btn-primary">
                            Start Designing Free
                            <ArrowRight size={18} />
                        </button>
                        <button onClick={scrollToFeatures} className="btn-secondary">
                            Explore Features
                        </button>
                    </div>
                    <div className="hero-stats">
                        <div className="stat">
                            <span className="stat-value">50+</span>
                            <span className="stat-label">Components</span>
                        </div>
                        <div className="stat-divider"></div>
                        <div className="stat">
                            <span className="stat-value">10</span>
                            <span className="stat-label">Categories</span>
                        </div>
                        <div className="stat-divider"></div>
                        <div className="stat">
                            <span className="stat-value">100%</span>
                            <span className="stat-label">Free</span>
                        </div>
                    </div>
                </div>

                <div className="hero-visual">
                    <div className="hero-visual-glow"></div>
                    <video
                        autoPlay
                        loop
                        muted
                        playsInline
                        poster="/assets/landing/hero_workspace.png"
                    >
                        <source src="/assets/landing/hero_video.webp" type="video/webp" />
                    </video>
                </div>
            </section>

            {/* Features Bento Grid */}
            <section id="features" className="features-section">
                <div className="section-header">
                    <span className="section-badge">FEATURES</span>
                    <h2>Everything you need for<br /><span className="gradient-text">electrical distribution</span></h2>
                </div>

                <div className="bento-grid">
                    {/* Large Card: Diagram Designer */}
                    <div className="bento-card bento-large">
                        <div className="bento-icon"><Layout size={28} /></div>
                        <h3>Diagram Designer</h3>
                        <p>
                            Professional Konva-based canvas with drag-and-drop components,
                            smart connections, multi-select, pan/zoom, and context menus.
                        </p>
                        <div className="bento-visual">
                            <img src="/assets/landing/component_library.png" alt="Component Library" />
                        </div>
                    </div>

                    {/* Large Card: Cubicle Panel Designer */}
                    <div className="bento-card bento-large featured">
                        <div className="featured-badge">NEW</div>
                        <div className="bento-icon"><Grid3X3 size={28} /></div>
                        <h3>LT Cubicle Panel Designer</h3>
                        <p>
                            Visual designer for LT panels with incomers, busbars, and outgoings.
                            Configure MCCB/MCB ratings, copy/paste slots, and see real-time previews.
                        </p>
                        <div className="bento-visual">
                            <img src="/assets/landing/cubicle_panel_new.png" alt="Cubicle Panel Designer" />
                        </div>
                    </div>

                    {/* Medium Cards Row */}
                    <div className="bento-card bento-medium">
                        <div className="bento-icon"><Zap size={24} /></div>
                        <h3>Auto-Rating Engine</h3>
                        <p>
                            One-click network analysis. Automatically select cable sizes,
                            MCCB ratings, and generate comprehensive PDF reports.
                        </p>
                    </div>

                    <div className="bento-card bento-medium">
                        <div className="bento-icon"><MessageSquare size={24} /></div>
                        <h3>AI Diagram Assistant</h3>
                        <p>
                            Natural language interface. Ask the AI to add components,
                            analyze loads, or query your project database.
                        </p>
                    </div>

                    <div className="bento-card bento-medium">
                        <div className="bento-icon"><Layers size={24} /></div>
                        <h3>Multi-Canvas Sheets</h3>
                        <p>
                            Organize complex projects with tabbed canvases.
                            Rename, reorder, and link sheets with portals.
                        </p>
                    </div>

                    <div className="bento-card bento-medium">
                        <div className="bento-icon"><Calculator size={24} /></div>
                        <h3>Voltage Drop Calculator</h3>
                        <p>
                            Precision engineering tool for single and 3-phase networks.
                            Verify compliance with local standards.
                        </p>
                    </div>
                </div>
            </section>

            {/* Deep Dive: Cubicle Panel */}
            <section className="deep-dive">
                <div className="deep-dive-content">
                    <span className="section-badge">SPOTLIGHT</span>
                    <h2>Visual Panel<br /><span className="gradient-text">Configuration</span></h2>
                    <p>
                        The LT Cubicle Panel Designer provides a real-time visual representation
                        of your electrical panel. Configure incomers with ACB/MCCB devices,
                        set busbar materials (Copper/Aluminium), and add outgoing circuits
                        with proper ratings — all through an intuitive visual interface.
                    </p>
                    <ul className="feature-list">
                        <li><CheckCircle2 size={18} /> Visual incomer and outgoing slot configuration</li>
                        <li><CheckCircle2 size={18} /> Real-time panel layout preview</li>
                        <li><CheckCircle2 size={18} /> Copy/paste device configurations</li>
                        <li><CheckCircle2 size={18} /> Multi-section panel support</li>
                    </ul>
                    <button onClick={() => navigate('/design')} className="btn-primary">
                        Try It Now
                        <ArrowRight size={18} />
                    </button>
                </div>
                <div className="deep-dive-visual">
                    <div className="visual-glow"></div>
                    <video
                        autoPlay
                        loop
                        muted
                        playsInline
                        poster="/assets/landing/cubicle_panel_new.png"
                    >
                        <source src="/assets/landing/cubicle_panel.webp" type="video/webp" />
                    </video>
                </div>
            </section>

            {/* Deep Dive: AI Assistant */}
            <section className="deep-dive reverse">
                <div className="deep-dive-visual">
                    <div className="visual-glow"></div>
                    <video
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="rounded-lg border border-white/10 shadow-2xl"
                    >
                        <source src="/assets/landing/ai_chat_video.webp" type="video/webp" />
                    </video>
                </div>
                <div className="deep-dive-content">
                    <span className="section-badge">AI-POWERED</span>
                    <h2>Intelligent Design<br /><span className="gradient-text">Assistant</span></h2>
                    <p>
                        The AI Diagram Assistant understands your project context.
                        Ask it to analyze loads, suggest cable sizes, add components to
                        specific distribution boards, or query your project database
                        using natural language.
                    </p>
                    <ul className="feature-list">
                        <li><Cpu size={18} /> Context-aware diagram manipulation</li>
                        <li><Database size={18} /> Database query mode for specifications</li>
                        <li><MessageSquare size={18} /> Add selection to chat for analysis</li>
                        <li><Zap size={18} /> Execute design tools via commands</li>
                    </ul>
                </div>
            </section>

            {/* Deep Dive: Auto-Rating */}
            <section className="deep-dive">
                <div className="deep-dive-content">
                    <span className="section-badge">AUTOMATION</span>
                    <h2>Smart Rating<br /><span className="gradient-text">& Compliance</span></h2>
                    <p>
                        Run network analysis with a single click. The auto-rating engine
                        traverses your entire electrical network, calculating loads and
                        selecting appropriate ratings for MCCBs, cables, and protective devices.
                    </p>
                    <ul className="feature-list">
                        <li><ShieldCheck size={18} /> IEC-compliant rating calculations</li>
                        <li><FileText size={18} /> Detailed process logs for transparency</li>
                        <li><Download size={18} /> Downloadable PDF reports</li>
                        <li><Zap size={18} /> Dynamic property updates</li>
                    </ul>
                </div>
                <div className="deep-dive-visual">
                    <div className="visual-glow"></div>
                    <img
                        src="/assets/landing/autorating_result.png"
                        alt="Auto Rating Result"
                        className="rounded-lg border border-white/10 shadow-2xl w-full"
                    />
                </div>
            </section>

            {/* Technical Specs Section (New) */}
            <section id="specs" className="specs-section">
                <div className="section-header">
                    <span className="section-badge">BUILT FOR PERFORMANCE</span>
                    <h2>Technical<br /><span className="gradient-text">Specifications</span></h2>
                </div>
                <div className="specs-grid">
                    <div className="spec-item">
                        <Code2 size={24} className="spec-icon" />
                        <div>
                            <h4>React & TypeScript</h4>
                            <p>Built with modern web technologies for maximum performance and type safety.</p>
                        </div>
                    </div>
                    <div className="spec-item">
                        <Zap size={24} className="spec-icon" />
                        <div>
                            <h4>Canvas Rendering</h4>
                            <p>High-performance canvas rendering engine capable of handling thousands of components.</p>
                        </div>
                    </div>
                    <div className="spec-item">
                        <Database size={24} className="spec-icon" />
                        <div>
                            <h4>Local Storage</h4>
                            <p>Auto-save functionality ensures your work is never lost, even if browsing is interrupted.</p>
                        </div>
                    </div>
                    <div className="spec-item">
                        <ShieldCheck size={24} className="spec-icon" />
                        <div>
                            <h4>Client-Side Processing</h4>
                            <p>Most calculations happen directly in your browser for instant feedback.</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* Export Options */}
            <section className="export-section">
                <div className="section-header">
                    <span className="section-badge">EXPORT</span>
                    <h2>Professional<br /><span className="gradient-text">Documentation</span></h2>
                </div>
                <div className="export-grid">
                    <div className="export-card">
                        <div className="export-icon"><FileText size={32} /></div>
                        <h4>Excel BOQ</h4>
                        <p>Generate detailed Bill of Quantities with item specifications</p>
                    </div>
                    <div className="export-card">
                        <div className="export-icon"><Download size={32} /></div>
                        <h4>PDF Reports</h4>
                        <p>Comprehensive auto-rating reports with calculations</p>
                    </div>
                    <div className="export-card">
                        <div className="export-icon"><Save size={32} /></div>
                        <h4>PNG Diagrams</h4>
                        <p>High-resolution diagram exports for documentation</p>
                    </div>
                </div>
            </section>

            {/* FAQ Section (New) */}
            <section id="faq" className="faq-section">
                <div className="section-header">
                    <span className="section-badge">FAQ</span>
                    <h2>Common<br /><span className="gradient-text">Questions</span></h2>
                </div>
                <div className="faq-container">
                    {[
                        { q: "Is Sayanho free to use?", a: "Yes, Sayanho is currently 100% free for all users. You can access all features including the AI assistant without any cost." },
                        { q: "Can I export my designs?", a: "Absolutely. You can export your diagrams as high-quality PNG images, and your bill of quantities (BOQ) as Excel files." },
                        { q: "Does it work offline?", a: "Sayanho requires an internet connection for initial load and AI features, but many design functions work locally in your browser." },
                        { q: "Is my data secure?", a: "Your project data is stored locally in your browser's storage by default. We prioritize your privacy and data security." }
                    ].map((item, index) => (
                        <div key={index} className={`faq-item ${openFaq === index ? 'open' : ''}`} onClick={() => toggleFaq(index)}>
                            <div className="faq-question">
                                <span>{item.q}</span>
                                <ChevronDown size={20} className={`faq-icon ${openFaq === index ? 'rotate' : ''}`} />
                            </div>
                            <div className="faq-answer">
                                <p>{item.a}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Final CTA */}
            <section className="final-cta">
                <div className="cta-glow"></div>
                <h2>Ready to design<br /><span className="gradient-text">smarter?</span></h2>
                <p>Join engineers worldwide using Sayanho for professional electrical design</p>
                <button onClick={() => navigate('/design')} className="btn-primary btn-large">
                    Launch Sayanho Designer
                    <ArrowRight size={20} />
                </button>
            </section>

            {/* Footer */}
            <footer className="lp-footer">
                <p>Sayanho Web v1.2 — Built for electrical engineers</p>
            </footer>
        </div>
    );
};

export default LandingPage;
