import React, { useEffect, useState, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { Canvas, CanvasRef } from './components/Canvas';
import { PropertiesPanel } from './components/PropertiesPanel';
import { MenuBar } from './components/MenuBar';
import { Toolbar } from './components/Toolbar';
import { CanvasTabs } from './components/CanvasTabs';
import { SettingsDialog } from './components/SettingsDialog';
import { VoltageDropCalculatorDialog } from './components/VoltageDropCalculatorDialog';
import { MobileDetector } from './components/MobileDetector';
import { ChatPanel } from './components/ChatPanel';
import { AutoRatingResultDialog } from './components/AutoRatingResultDialog';

import { SaveProjectDialog } from './components/SaveProjectDialog';
import { NetworkMonitor } from './components/NetworkMonitor';

// Layout Designer imports
import { LayoutDesigner, LayoutDesignerRef } from './components/LayoutDesigner';
import { ViewModeToggle } from './components/ViewModeToggle';
import { useLayoutStore } from './store/useLayoutStore';

import { api } from './services/api';
import { useStore } from './store/useStore';
import { useTheme } from './context/ThemeContext';
import { apiTracer } from './utils/apiTracer';
import { updateItemVisuals } from './utils/SvgUpdater';
import { Toast } from './components/Toast';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import LandingPage from './components/LandingPage';

function DesignerApp() {
    const navigate = useNavigate();
    const { getCurrentSheet, setSheet, updateSheet, sheets, setSheets, applyAutoRatingResults, undo, redo, calculateNetwork, addItem, selectItem, showCurrentValues, toggleShowCurrentValues, isPropertiesPanelOpen, isChatOpen, toggleChat } = useStore();
    const currentSheet = getCurrentSheet();
    const { colors, theme } = useTheme();

    // Layout store - for view mode toggle
    const { activeView } = useLayoutStore();

    // UI State
    const [showLeftPanel, setShowLeftPanel] = useState(true);
    const [showMenu, setShowMenu] = useState(true); // Toggle MenuBar visibility
    const [scale, setScale] = useState(1);
    const [panMode, setPanMode] = useState(false);
    const [isAddTextMode, setIsAddTextMode] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    const [showVoltageDropDialog, setShowVoltageDropDialog] = useState(false);
    const [showNetworkMonitor, setShowNetworkMonitor] = useState(false);
    const [showAutoRatingResult, setShowAutoRatingResult] = useState(false);
    const [autoRatingSuccess, setAutoRatingSuccess] = useState(false);
    const [autoRatingMessage, setAutoRatingMessage] = useState('');
    const [autoRatingLog, setAutoRatingLog] = useState('');

    // Dialog State
    const [showOpen, setShowOpen] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
    const [diagrams, setDiagrams] = useState<{ id: string; name: string }[]>([]);
    const [searchQuery, setSearchQuery] = useState('');

    // Toast State
    const [toastMessage, setToastMessage] = useState<string | null>(null);
    const [toastType, setToastType] = useState<'success' | 'error' | 'info'>('success');

    const canvasRef = useRef<CanvasRef>(null);
    const layoutRef = useRef<LayoutDesignerRef>(null);

    // Set CSS custom property for mobile viewport height
    useEffect(() => {
        const setAppHeight = () => {
            const doc = document.documentElement;
            doc.style.setProperty('--app-height', `${window.innerHeight}px`);
        };

        setAppHeight();
        window.addEventListener('resize', setAppHeight);
        window.addEventListener('orientationchange', setAppHeight);

        return () => {
            window.removeEventListener('resize', setAppHeight);
            window.removeEventListener('orientationchange', setAppHeight);
        };
    }, []);

    // Wake-up Backend Check
    useEffect(() => {
        const wakeUpBackend = async () => {
            const startTime = Date.now();
            let notified = false;

            // Initial check - if it takes long, show toast
            const timer = setTimeout(() => {
                setToastMessage('Waking up backend server... this may take up to 30 seconds.');
                setToastType('info');
                notified = true;
            }, 2000);

            try {
                await api.checkHealth();
                clearTimeout(timer);
                if (notified) {
                    setToastMessage('Backend is ready!');
                    setToastType('success');
                }
            } catch (e) {
                console.error("Backend validation failed", e);
            }
        };

        wakeUpBackend();
    }, []);

    // Keyboard Shortcuts for Undo/Redo
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    if (activeView === 'layout') useLayoutStore.getState().redo();
                    else redo();
                } else {
                    if (activeView === 'layout') useLayoutStore.getState().undo();
                    else undo();
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
                e.preventDefault();
                if (activeView === 'layout') useLayoutStore.getState().redo();
                else redo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeView, undo, redo]);

    // Quick Save: If we know the project ID, overwrite it. If not, open dialog.
    const handleSave = async () => {
        if (sheets.length === 0) return;

        if (currentProjectId) {
            // Overwrite existing project
            try {
                const currentName = diagrams.find(d => d.id === currentProjectId)?.name || sheets[0]?.name || 'Untitled Project';
                await api.saveDiagram(sheets, currentName, currentProjectId);

                setToastMessage(`Project "${currentName}" saved successfully!`);
                setToastType('success');

                // Refresh list and ensure name consistency (optional, but good practice)
                const list = await api.getDiagrams();
                setDiagrams(list || []);
            } catch (error) {
                console.error('Save failed:', error);
                setToastMessage('Save failed. Check console for details.');
                setToastType('error');
            }
        } else {
            // Treat as "Save As" (new project)
            handleSaveAs();
        }
    };

    // Save As: Always open dialog to pick a name. Use null ID to force creation.
    const handleSaveAs = async () => {
        if (sheets.length === 0) return;
        try {
            const list = await api.getDiagrams();
            setDiagrams(list || []);
            setShowSaveDialog(true);
        } catch (error) {
            console.error('Failed to fetch diagrams:', error);
            setDiagrams([]);
            setShowSaveDialog(true);
        }
    };

    // Callback from Dialog
    const handleConfirmSave = async (projectName: string) => {
        if (sheets.length === 0) return;
        try {
            // NOTE: "Save As" logic implies creating a NEW project or overwriting a DIFFERENT one selected by name.
            // Since SaveProjectDialog currently enforces unique names (or effectively selects existing via name match),
            // we check if the name matches an existing project to get its ID, or pass null for a new one.
            // If the user picked a name that exists, we overwrite THAT project.
            // If the user picked a new name, we create a NEW project.

            const existing = diagrams.find(d => d.name.toLowerCase() === projectName.toLowerCase());
            const targetProjectId = existing ? existing.id : null;

            // API Call
            await api.saveDiagram(sheets, projectName, targetProjectId);

            setShowSaveDialog(false);
            setToastMessage(`Project "${projectName}" saved successfully!`);
            setToastType('success');

            // Refresh list
            const list = await api.getDiagrams();
            setDiagrams(list || []);

            // IMPORTANT: If we just saved successfully, this should become the "Current Project"
            // We need to find the ID of the project we just saved.
            if (targetProjectId) {
                setCurrentProjectId(targetProjectId);
            } else {
                // We created a new project. The API doesn't return the ID directly in all cases,
                // but we can find it by name in the refreshed list.
                const newList = list || [];
                const newProj = newList.find((d: { id: string; name: string }) => d.name.toLowerCase() === projectName.toLowerCase());
                if (newProj) {
                    setCurrentProjectId(newProj.id);
                }
            }

        } catch (error) {
            console.error('Save failed:', error);
            setToastMessage('Save failed. Check console for details.');
            setToastType('error');
        }
    };

    const handleOpen = async () => {
        try {
            const list = await api.getDiagrams();
            setDiagrams(list || []);
            setSearchQuery(''); // Reset search when opening
            setShowOpen(true);
        } catch (e) {
            console.error('Failed to list diagrams', e);
        }
    };

    const loadDiagram = async (id: string) => {
        try {
            const loadedSheets = await api.getDiagram(id);

            // Restore SVG content for all items
            const restoredSheets = await Promise.all(loadedSheets.map(async (sheet) => {
                const restoredItems = await Promise.all(sheet.canvasItems.map(async (item) => {
                    if (item.name === 'Portal' && !item.svgContent) {
                        // Regenerate Portal SVG based on properties
                        const meta = (item.properties?.[0] || {}) as Record<string, string>;
                        const dir = (meta['Direction'] || meta['direction'] || 'out').toLowerCase();

                        const w = item.size?.width || 60;
                        const h = item.size?.height || 40;

                        const arrow = dir === 'in'
                            ? `<path d="M ${w / 2} ${h * 0.7} L ${w / 2} ${h * 0.3} M ${w / 2} ${h * 0.3} L ${(w / 2) - 6} ${h * 0.3 + 6} M ${w / 2} ${h * 0.3} L ${(w / 2) + 6} ${h * 0.3 + 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
                            : `<path d="M ${w / 2} ${h * 0.3} L ${w / 2} ${h * 0.7} M ${w / 2} ${h * 0.7} L ${(w / 2) - 6} ${h * 0.7 - 6} M ${w / 2} ${h * 0.7} L ${(w / 2) + 6} ${h * 0.7 - 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

                        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="6" ry="6" fill="#fff" stroke="#111" stroke-width="2"/>
  ${arrow}
</svg>`;
                        return { ...item, svgContent: svg };
                    }

                    // If svgContent is missing but iconPath exists, fetch the SVG
                    if (!item.svgContent && item.iconPath) {
                        try {
                            const iconName = item.iconPath.split('/').pop();
                            if (iconName) {
                                const url = encodeURI(api.getIconUrl(iconName));
                                const response = await fetch(url);
                                if (response.ok) {
                                    let svg = await response.text();

                                    // Apply visual updates if properties exist
                                    if (item.properties && item.properties[0]) {
                                        const { updateItemVisuals } = await import('./utils/SvgUpdater');
                                        const updatedSvg = updateItemVisuals({ ...item, svgContent: svg });
                                        if (updatedSvg) svg = updatedSvg;
                                    }

                                    return { ...item, svgContent: svg };
                                }
                            }
                        } catch (error) {
                            console.error('[loadDiagram] Failed to fetch SVG for', item.name, error);
                        }
                    }
                    return item;
                }));

                return {
                    ...sheet,
                    canvasItems: restoredItems
                };
            }));

            setSheets(restoredSheets);
            setCurrentProjectId(id); // Set current project ID
            setShowOpen(false);

            // Trigger network analysis to regenerate currentValues
            // (currentValues are stripped from saved data to reduce payload size)
            setTimeout(() => {
                console.log('[loadDiagram] Regenerating network analysis...');
                calculateNetwork();
            }, 500); // Small delay to ensure sheets are loaded
        } catch (e) {
            console.error('Failed to load diagram', e);
        }
    };

    const handleGenerateEstimate = async () => {
        try {
            // Show loading state if needed
            const blob = await api.generateEstimate(sheets);

            // Create download link
            const url = window.URL.createObjectURL(new Blob([blob]));
            const link = document.createElement('a');
            link.href = url;
            const date = new Date().toISOString().split('T')[0];
            link.setAttribute('download', `Estimate_${date}.xlsx`);
            document.body.appendChild(link);
            link.click();
            link.parentNode?.removeChild(link);
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error generating estimate:', error);
            alert('Failed to generate estimate. Please try again.');
        }
    };

    const handleCopyTrace = async () => {
        try {
            await apiTracer.copyToClipboard();
            alert('API trace copied to clipboard! You can now paste it for debugging.');
        } catch (error) {
            console.error('Failed to copy trace:', error);
            alert('Failed to copy trace to clipboard. Check console for details.');
        }
    };

    const handleDownloadReport = async () => {
        try {
            const blob = await api.downloadVoltageDropReport(sheets);
            const url = window.URL.createObjectURL(new Blob([blob]));
            const link = document.createElement('a');
            link.href = url;
            const date = new Date().toISOString().split('T')[0];
            link.setAttribute('download', `VoltageDropReport_${date}.pdf`);
            document.body.appendChild(link);
            link.click();
            link.parentNode?.removeChild(link);
            window.URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error downloading report:', error);
            alert('Failed to download report.');
        }
    };

    const handleAutoRate = async () => {
        try {
            console.log('Starting auto-rating...');
            const response = await api.autoRate(sheets);
            const { sheets: updatedSheets, log, success, message } = response;

            setAutoRatingLog(log);

            if (!success) {
                setAutoRatingSuccess(false);
                setAutoRatingMessage(message || 'Auto-rating validation failed.');
                setShowAutoRatingResult(true);
                return;
            }

            // Restore svgContent from original sheets (backend doesn't return it)
            updatedSheets.forEach((updatedSheet, sheetIndex) => {
                const originalSheet = sheets[sheetIndex];
                if (originalSheet) {
                    updatedSheet.canvasItems.forEach(updatedItem => {
                        if (!updatedItem.svgContent) {
                            const originalItem = originalSheet.canvasItems.find(
                                orig => orig.uniqueID === updatedItem.uniqueID
                            );
                            if (originalItem?.svgContent) {
                                updatedItem.svgContent = originalItem.svgContent;
                            }
                        }
                    });
                }
            });

            // Update visuals for all items in the returned sheets
            updatedSheets.forEach(sheet => {
                sheet.canvasItems.forEach(item => {
                    const newSvg = updateItemVisuals(item);
                    if (newSvg) {
                        item.svgContent = newSvg;
                    }
                });
            });

            // USE NEW STORE ACTION TO PRESERVE UNDO HISTORY
            applyAutoRatingResults(updatedSheets);

            // calculateNetwork is called inside applyAutoRatingResults, but calling again doesn't hurt if logic differs.
            // The logic in applyAutoRatingResults calls calculateNetwork.

            setAutoRatingSuccess(true);
            setAutoRatingMessage(message || 'Component ratings have been successfully updated based on network analysis.');
            setShowAutoRatingResult(true);
        } catch (error: any) {
            console.error('Auto-rating failed:', error);
            const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
            const errorLog = error.response?.data?.log || '';
            setAutoRatingSuccess(false);
            setAutoRatingMessage(`Auto-rating failed: ${errorMsg}\n\nPlease ensure:\n1. Network analysis has been run\n2. Electrical components are connected\n3. Database is accessible`);
            setAutoRatingLog(errorLog);
            setShowAutoRatingResult(true);
        }
    };

    // Toolbar Handlers
    const handleZoomIn = () => canvasRef.current?.zoomIn();
    const handleZoomOut = () => canvasRef.current?.zoomOut();
    const handleSetZoom = (newScale: number) => canvasRef.current?.setZoom(newScale);
    const handleResetZoom = () => {
        if (canvasRef.current) {
            canvasRef.current.resetZoom();
        }
    };
    const handleFitContent = () => {
        if (canvasRef.current) {
            // @ts-ignore - fitView is newly added
            canvasRef.current.fitView();
        }
    };
    const handleSaveImage = () => {
        if (activeView === 'layout') {
            layoutRef.current?.saveImage();
            return;
        }
        canvasRef.current?.saveImage();
    };

    return (
        <div className="flex flex-col h-screen overflow-hidden select-none bg-background text-foreground relative">
            <MobileDetector />

            {/* Full Screen Canvas - Conditional based on view mode */}
            {activeView === 'layout' ? (
                <LayoutDesigner ref={layoutRef} showLeftPanel={showLeftPanel} />
            ) : (
                <div className="absolute inset-0 z-0">
                    <Canvas
                        ref={canvasRef}
                        onScaleChange={setScale}
                        panMode={panMode}
                        isAddTextMode={isAddTextMode}
                        onAddTextComplete={() => setIsAddTextMode(false)}
                    />
                </div>
            )}

            {/* Top Bar Area - Menu & Toolbar */}
            <div className="absolute top-0 left-0 right-0 z-50 p-2 pointer-events-none flex justify-between items-start">
                {/* Branding - in toolbar */}
                <div className="absolute left-1/2 transform -translate-x-1/2 -top-1 pointer-events-none z-50">
                    <h1 className="text-lg font-bold tracking-widest uppercase opacity-70" style={{ color: theme === 'dark' ? '#fff' : '#333' }}>Sayanho <span className="text-xs font-normal opacity-60">V1.2</span></h1>
                </div>

                {/* Menu Bar */}
                {showMenu && (
                    <div className="premium-glass rounded-full px-3 py-1 z-50 pointer-events-auto" style={{ backgroundColor: colors.menuBackground }}>
                        <MenuBar
                            onLoad={handleOpen}
                            onSave={handleSave}
                            onSaveAs={handleSaveAs}
                            onSaveImage={handleSaveImage}
                            onSettings={() => setShowSettings(true)}
                            onGenerateEstimate={handleGenerateEstimate}

                            onOpenVoltageDrop={() => setShowVoltageDropDialog(true)}
                            onOpenNetworkMonitor={() => setShowNetworkMonitor(true)}
                        />
                    </div>
                )}

                {/* View Mode Toggle (SLD/Layout) */}
                <div className="premium-glass rounded-full px-2 py-1 z-50 pointer-events-auto" style={{ backgroundColor: colors.menuBackground }}>
                    <ViewModeToggle />
                </div>

                {/* Toolbar - Centered (SLD mode only) */}
                {activeView === 'sld' && (
                    <div className="absolute left-1/2 transform -translate-x-1/2 top-0 pointer-events-auto">
                        <div className="premium-glass rounded-xl p-1.5 flex items-center h-[36px]">
                            <Toolbar
                                onLoad={handleOpen}
                                onZoomIn={handleZoomIn}
                                onZoomOut={handleZoomOut}
                                onSetZoom={handleSetZoom}
                                onResetZoom={handleResetZoom}
                                onFitContent={handleFitContent}
                                scale={scale}
                                showLeftPanel={showLeftPanel}
                                onToggleLeftPanel={() => setShowLeftPanel(!showLeftPanel)}
                                showMenu={showMenu}
                                onToggleMenu={() => setShowMenu(!showMenu)}
                                showChat={isChatOpen}
                                onToggleChat={toggleChat}
                                onAutoRate={handleAutoRate}
                                onAddText={() => setIsAddTextMode(!isAddTextMode)}
                                isAddTextMode={isAddTextMode}
                                onUndo={undo}
                                onRedo={redo}
                                panMode={panMode}
                                onSetPanMode={setPanMode}
                                onCalculate={calculateNetwork}
                                onCopyTrace={handleCopyTrace}
                                showCurrentValues={showCurrentValues}
                                onToggleShowCurrentValues={toggleShowCurrentValues}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Left Sidebar (SLD mode only) */}
            {activeView === 'sld' && showLeftPanel && (
                <div className="absolute left-4 top-12 bottom-4 w-56 z-40 premium-glass rounded-xl overflow-hidden flex flex-col transition-all duration-300 animate-slide-in-left">
                    <Sidebar />
                </div>
            )}

            {/* Right Properties Panel (SLD mode only) */}
            {activeView === 'sld' && (
                <div className={`absolute right-4 top-12 bottom-4 w-64 z-40 pointer-events-none transition-opacity duration-300 ${isPropertiesPanelOpen ? 'opacity-100' : 'opacity-0'}`}>
                    {isPropertiesPanelOpen && (
                        <div className="pointer-events-auto h-full premium-glass rounded-xl overflow-hidden flex flex-col animate-slide-in-right">
                            <PropertiesPanel />
                        </div>
                    )}
                </div>
            )}

            {/* Bottom Tabs (SLD mode only) */}
            {activeView === 'sld' && (
                <div className={`absolute bottom-2 z-30 premium-glass rounded-full px-4 py-0.5 animate-slide-in-bottom transition-all duration-300 ${showLeftPanel ? 'left-64' : 'left-4'} right-80`}>
                    <CanvasTabs />
                </div>
            )}

            {/* Chat Panel - Floating */}
            <ChatPanel />

            {/* Settings Dialog */}
            <SettingsDialog
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                onSave={() => calculateNetwork()} // Re-calculate when settings change
            />

            {/* Voltage Drop Calculator Dialog */}
            <VoltageDropCalculatorDialog
                isOpen={showVoltageDropDialog}
                onClose={() => setShowVoltageDropDialog(false)}
            />

            {/* Auto Rating Result Dialog */}
            <AutoRatingResultDialog
                isOpen={showAutoRatingResult}
                onClose={() => setShowAutoRatingResult(false)}
                onDownloadReport={handleDownloadReport}
                success={autoRatingSuccess}
                message={autoRatingMessage}
                processLog={autoRatingLog}
            />

            {/* Save Project Dialog */}
            <SaveProjectDialog
                isOpen={showSaveDialog}
                onClose={() => setShowSaveDialog(false)}
                onSave={handleConfirmSave}
                existingNames={diagrams.map(d => d.name)}
                currentName={sheets[0]?.name || 'Untitled Project'}
            />

            {/* Network Monitor */}
            {showNetworkMonitor && (
                <NetworkMonitor onClose={() => setShowNetworkMonitor(false)} />
            )}

            {/* Open Diagram Dialog */}
            {showOpen && (
                <div className="absolute inset-0 bg-black/30 flex items-start justify-center pt-24 z-50" onClick={() => setShowOpen(false)}>
                    <div
                        className="rounded-lg shadow-lg border w-[420px]"
                        style={{ backgroundColor: colors.panelBackground, borderColor: colors.border }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: colors.border }}>
                            <div className="font-semibold" style={{ color: colors.text }}>Open Diagram</div>
                            <button className="text-sm hover:opacity-70" style={{ color: colors.text }} onClick={() => setShowOpen(false)}>Close</button>
                        </div>

                        {/* Search Input */}
                        <div className="px-4 py-2 border-b" style={{ borderColor: colors.border }}>
                            <input
                                type="text"
                                placeholder="Search projects..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                style={{
                                    backgroundColor: colors.canvasBackground,
                                    borderColor: colors.border,
                                    color: colors.text
                                }}
                                autoFocus
                            />
                        </div>

                        <div className="max-h-80 overflow-y-auto p-2">
                            {(() => {
                                const filteredDiagrams = diagrams.filter(d =>
                                    d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                    d.id.toLowerCase().includes(searchQuery.toLowerCase())
                                );

                                if (filteredDiagrams.length === 0) {
                                    return (
                                        <div className="text-sm p-3" style={{ color: colors.text }}>
                                            {diagrams.length === 0 ? 'No diagrams found.' : 'No matching projects.'}
                                        </div>
                                    );
                                }

                                return (
                                    <ul>
                                        {filteredDiagrams.map(d => (
                                            <li key={d.id}>
                                                <div className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/10 rounded">
                                                    <button
                                                        onClick={() => loadDiagram(d.id)}
                                                        className="flex-1 text-left"
                                                        style={{ color: colors.text }}
                                                    >
                                                        <span className="text-sm">{d.name}</span>
                                                        <span className="text-xs opacity-50 ml-2">{d.id.slice(0, 8)}</span>
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            if (window.confirm(`Delete project "${d.name}"?`)) {
                                                                try {
                                                                    await api.deleteProject(d.id);
                                                                    setToastMessage(`Project "${d.name}" deleted successfully!`);
                                                                    setToastType('success');
                                                                    // Refresh list
                                                                    const list = await api.getDiagrams();
                                                                    setDiagrams(list || []);
                                                                } catch (error: any) {
                                                                    // Handle 404 - project already deleted or doesn't exist
                                                                    if (error.response?.status === 404) {
                                                                        // Remove stale entry from local list
                                                                        setDiagrams(prev => prev.filter(p => p.id !== d.id));
                                                                        setToastMessage(`Project "${d.name}" was already deleted.`);
                                                                        setToastType('info');
                                                                    } else {
                                                                        console.error('Delete failed:', error);
                                                                        setToastMessage('Delete failed. Check console for details.');
                                                                        setToastType('error');
                                                                    }
                                                                }
                                                            }
                                                        }}
                                                        className="text-red-500 hover:text-red-700 p-1"
                                                        title="Delete project"
                                                    >
                                                        ×
                                                    </button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                );
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {/* Toast Notification */}
            {toastMessage && (
                <Toast
                    message={toastMessage}
                    type={toastType}
                    onClose={() => setToastMessage(null)}
                />
            )}
        </div>
    );
}

function App() {
    return (
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<LandingPage />} />
                <Route path="/design" element={<DesignerApp />} />
            </Routes>
        </BrowserRouter>
    );
}


export default App;
