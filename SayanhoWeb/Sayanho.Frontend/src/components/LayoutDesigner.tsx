// Layout Designer - Main layout design view wrapper with sync functionality
// Combines LayoutCanvas, LayoutSidebar, LayoutToolbar into a complete view

import React, { useRef, useState, Suspense, lazy, useCallback, forwardRef, useImperativeHandle } from 'react';
import { LayoutCanvas, LayoutCanvasRef } from './LayoutCanvas';
import { LayoutSidebar } from './LayoutSidebar';
import { LayoutToolbar } from './LayoutToolbar.tsx';
import { UploadPlanDialog } from './UploadPlanDialog';
import { ScaleCalibrationDialog } from './ScaleCalibrationDialog';
// Lazy load ThreeDViewDialog to avoid loading @react-three/fiber at module init time
const ThreeDViewDialog = lazy(() => import('./ThreeDViewDialog').then(mod => ({ default: mod.ThreeDViewDialog })));
import { useLayoutStore } from '../store/useLayoutStore';
import { useStore } from '../store/useStore';
import { useTheme } from '../context/ThemeContext';
import { Plus, RefreshCw, CheckCircle, AlertCircle, Layers } from 'lucide-react';
import { syncEngine, calculateFloorPlanLoad } from '../utils/SyncEngine';

interface LayoutDesignerProps {
    showLeftPanel: boolean;
}

export interface LayoutDesignerRef {
    saveImage: () => void;
}

export const LayoutDesigner = forwardRef<LayoutDesignerRef, LayoutDesignerProps>(({ showLeftPanel }, ref) => {
    const { colors, theme } = useTheme();
    const canvasRef = useRef<LayoutCanvasRef>(null);

    const {
        floorPlans,
        activeFloorPlanId,
        setActiveFloorPlan,
        getCurrentFloorPlan,
        copySelection,
        pasteSelection,
        deleteSelected,
        undo,
        redo
    } = useLayoutStore();

    // SLD store for sync
    const { addItem, getCurrentSheet, stagingItems, setStagingItems, sheets, activeSheetId } = useStore();

    const [scale, setScale] = useState(0.5);
    const [showUploadDialog, setShowUploadDialog] = useState(false);
    const [show3DView, setShow3DView] = useState(false);
    const [showScaleCalibration, setShowScaleCalibration] = useState(false);
    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
    const [syncMessage, setSyncMessage] = useState('');
    const [showMagicWires, setShowMagicWires] = useState(true);

    // Keyboard shortcuts
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            // Ignore if input/textarea is focused
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                copySelection();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                e.preventDefault();
                pasteSelection();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                // e.preventDefault(); // Don't prevent default for backspace as it might be navigation, but for Delete it's fine
                if (e.key === 'Delete') e.preventDefault();
                deleteSelected();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [copySelection, pasteSelection, deleteSelected, undo, redo]);

    const currentPlan = getCurrentFloorPlan();

    // Calculate load summary for current plan
    const loadSummary = currentPlan ? calculateFloorPlanLoad(currentPlan) : null;

    useImperativeHandle(ref, () => ({
        saveImage: () => canvasRef.current?.saveImage()
    }));

    // Sync Layout to SLD - using upstream-to-downstream algorithm
    const handleSyncToSld = useCallback(async () => {
        if (!currentPlan || currentPlan.components.length === 0) {
            setSyncStatus('error');
            setSyncMessage('No components to sync');
            setTimeout(() => setSyncStatus('idle'), 3000);
            return;
        }

        setSyncStatus('syncing');
        setSyncMessage('Generating SLD from layout...');

        try {
            // Generate SLD items from layout using sync engine
            const result = await syncEngine.syncLayoutToSld(currentPlan, (msg) => {
                setSyncMessage(msg);
            });

            // Filtering strategy:
            // 1. Check if item is already on the SLD active sheet (placed)
            // 2. Check if item is already in staging (staging)
            const allPlacedSldIds = new Set(sheets.flatMap(s => s.canvasItems).map(i => i.uniqueID));
            const existingIds = new Set([
                ...allPlacedSldIds,
                ...stagingItems.map(i => i.uniqueID)
            ]);

            const newStagingItems = [...stagingItems];
            let addedCount = 0;

            for (const item of result.items) {
                // Check by ID first (strongest link)
                // If ID is new/generated, we might check by some other prop, but SyncEngine usually attempts to link.
                // However, generateSldFromLayout usually creates NEW items if no link map exists.
                // Ideally, SyncEngine should have preserved IDs if they were linked.
                // Here we simply assume if ID exists, it's the same item.
                if (!existingIds.has(item.uniqueID)) {
                    newStagingItems.push(item);
                    addedCount++;
                }
            }

            setStagingItems(newStagingItems);

            // TODO: Add connections? Connections rely on items being placed.
            // If we stage items, we can't stage connections easily unless we stage them too.
            // For now, we skip connections for unplaced items.

            setSyncStatus('success');
            setSyncMessage(`Synced ${addedCount} new items to Staging`);

            if (result.warnings.length > 0) {
                console.warn('[SyncEngine] Warnings:', result.warnings);
            }

            setTimeout(() => setSyncStatus('idle'), 3000);
        } catch (error) {
            console.error('[SyncEngine] Error:', error);
            setSyncStatus('error');
            setSyncMessage('Sync failed. See console for details.');
            setTimeout(() => setSyncStatus('idle'), 3000);
        }
    }, [currentPlan, getCurrentSheet, stagingItems, setStagingItems, sheets]);

    // AUTO-SYNC: Trigger Layout→SLD sync ONLY when component count actually changes
    const prevComponentCountRef = React.useRef<number>(0);
    const isFirstMountRef = React.useRef(true);

    React.useEffect(() => {
        const currentCount = currentPlan?.components?.length ?? 0;
        const prevCount = prevComponentCountRef.current;

        // Skip first mount to avoid initial sync when loading
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            prevComponentCountRef.current = currentCount;
            return;
        }

        // Only sync if count actually changed (not on every render)
        if (currentCount !== prevCount && currentCount > 0) {
            console.log(`[AutoSync] Component count changed: ${prevCount} → ${currentCount}`);
            prevComponentCountRef.current = currentCount;
            handleSyncToSld();
        }
    }, [currentPlan?.components?.length]); // eslint-disable-line react-hooks/exhaustive-deps

    // Sync SLD to Layout (Reverse Sync) - Populates Layout Staging
    // We check this on mount or when SLD sheet items change significantly?
    // For now, let's do it on effect when we enter this view.
    const { setStagingComponents, stagingComponents: layoutStaging } = useLayoutStore();

    React.useEffect(() => {
        if (!currentPlan) return;

        // Get SLD components (all sheets)
        const sldComponents = sheets.flatMap(s => s.canvasItems);

        if (sldComponents.length === 0) return;

        // Sync logic
        try {
            const stagedItems = syncEngine.syncSldToLayout(currentPlan, sldComponents);

            const placedSldIds = new Set(
                useLayoutStore.getState().floorPlans.flatMap(p => p.components.map(c => c.sldItemId)).filter(Boolean) as string[]
            );
            const placedLayoutIds = new Set(
                useLayoutStore.getState().floorPlans.flatMap(p => p.components.map(c => c.id))
            );

            // Filter out items already in layoutStaging to avoid duplicates
            // syncSldToLayout checks against currentPlan, but not against existing staging
            const newItems = stagedItems.filter(staged => {
                const sldId = staged.sldItemId;
                if (sldId && placedSldIds.has(sldId)) return false;
                if (placedLayoutIds.has(staged.id)) return false;
                return !layoutStaging.some(existing => existing.sldItemId === staged.sldItemId);
            });

            if (newItems.length > 0) {
                setStagingComponents([...layoutStaging, ...newItems]);
                // console.log(`[Layout] Synced ${newItems.length} items from SLD to Staging`);
            }
        } catch (e) {
            console.error("Failed to sync SLD to Layout", e);
        }
    }, [currentPlan, sheets, activeSheetId, setStagingComponents, layoutStaging]);

    return (
        <>
            {/* Full Screen Canvas */}
            <div className="absolute inset-0 z-0">
                <LayoutCanvas
                    ref={canvasRef}
                    onScaleChange={setScale}
                    showMagicWires={showMagicWires}
                />
            </div>

            {/* Toolbar - Centered */}
            <div className="absolute left-1/2 transform -translate-x-1/2 top-2 z-50 pointer-events-auto">
                <LayoutToolbar
                    scale={scale}
                    onZoomIn={() => canvasRef.current?.zoomIn()}
                    onZoomOut={() => canvasRef.current?.zoomOut()}
                    onFitView={() => canvasRef.current?.fitView()}
                    onUploadPlan={() => setShowUploadDialog(true)}
                    onOpen3DView={() => setShow3DView(true)}
                    onScaleCalibrate={() => setShowScaleCalibration(true)}
                    showMagicWires={showMagicWires}
                    onToggleMagicWires={() => setShowMagicWires(!showMagicWires)}
                />
            </div>

            {/* Left Sidebar - Floating */}
            {showLeftPanel && (
                <div
                    className="absolute left-4 top-14 bottom-16 w-60 z-40 premium-glass rounded-xl overflow-hidden flex flex-col transition-all duration-300 animate-slide-in-left shadow-xl"
                    style={{ backgroundColor: colors.panelBackground }}
                >
                    <LayoutSidebar />
                </div>
            )}

            {/* Load Summary Panel - Top Right */}
            {loadSummary && loadSummary.totalLoad > 0 && (
                <div
                    className="absolute top-14 right-4 z-40 premium-glass rounded-xl p-3 shadow-lg animate-fade-in"
                    style={{ backgroundColor: colors.panelBackground }}
                >
                    <div className="text-xs font-medium mb-2 flex items-center gap-2" style={{ color: colors.text }}>
                        <Layers size={14} className="text-blue-500" />
                        Load Summary
                    </div>
                    <div className="space-y-1 text-xs" style={{ color: colors.text }}>
                        <div className="flex justify-between gap-4">
                            <span className="opacity-60">Lighting:</span>
                            <span className="font-mono">{loadSummary.lightingLoad}W</span>
                        </div>
                        <div className="flex justify-between gap-4">
                            <span className="opacity-60">Power:</span>
                            <span className="font-mono">{loadSummary.powerLoad}W</span>
                        </div>
                        <div className="flex justify-between gap-4">
                            <span className="opacity-60">HVAC:</span>
                            <span className="font-mono">{loadSummary.hvacLoad}W</span>
                        </div>
                        <div className="flex justify-between gap-4 border-t pt-1 mt-1 font-medium" style={{ borderColor: colors.border }}>
                            <span>Total:</span>
                            <span className="font-mono text-blue-500">{loadSummary.totalLoad}W</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Sync Status Toast */}
            {syncStatus !== 'idle' && (
                <div
                    className={`
                        absolute top-20 left-1/2 transform -translate-x-1/2 z-50 
                        px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 text-sm
                        animate-fade-in
                        ${syncStatus === 'syncing' ? 'bg-blue-500 text-white' : ''}
                        ${syncStatus === 'success' ? 'bg-green-500 text-white' : ''}
                        ${syncStatus === 'error' ? 'bg-red-500 text-white' : ''}
                    `}
                >
                    {syncStatus === 'syncing' && <RefreshCw size={16} className="animate-spin" />}
                    {syncStatus === 'success' && <CheckCircle size={16} />}
                    {syncStatus === 'error' && <AlertCircle size={16} />}
                    {syncMessage}
                </div>
            )}

            {/* Floor Plan Tabs - Bottom */}
            <div
                className={`absolute bottom-2 z-30 premium-glass rounded-full px-4 py-1.5 animate-slide-in-bottom transition-all duration-300 shadow-lg ${showLeftPanel ? 'left-64' : 'left-4'} right-4`}
                style={{ backgroundColor: colors.menuBackground }}
            >
                <div className="flex items-center gap-2">
                    {/* Plan tabs */}
                    <div className="flex items-center gap-1 overflow-x-auto">
                        {floorPlans.map(plan => (
                            <button
                                key={plan.id}
                                onClick={() => setActiveFloorPlan(plan.id)}
                                className={`
                                    px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap
                                    transition-all duration-150
                                    ${activeFloorPlanId === plan.id
                                        ? 'bg-blue-500 text-white shadow-md'
                                        : 'hover:bg-white/10'
                                    }
                                `}
                                style={activeFloorPlanId === plan.id ? {} : { color: colors.text }}
                            >
                                {plan.name}
                                {/* Component count badge */}
                                <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${activeFloorPlanId === plan.id
                                    ? 'bg-white/20'
                                    : 'bg-blue-500/20'
                                    }`}>
                                    {plan.components.length}
                                </span>
                            </button>
                        ))}
                    </div>

                    {/* Add new plan button */}
                    <button
                        onClick={() => setShowUploadDialog(true)}
                        className="p-1.5 rounded-full hover:bg-white/10 transition-colors"
                        title="Add Floor Plan"
                    >
                        <Plus size={16} style={{ color: colors.text }} />
                    </button>

                    {/* Empty state */}
                    {floorPlans.length === 0 && (
                        <span className="text-xs opacity-60" style={{ color: colors.text }}>
                            No floor plans - click + to create
                        </span>
                    )}
                </div>
            </div>

            {/* Dialogs */}
            <UploadPlanDialog
                isOpen={showUploadDialog}
                onClose={() => setShowUploadDialog(false)}
            />

            {show3DView && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">Loading 3D View...</div>}>
                    <ThreeDViewDialog
                        isOpen={show3DView}
                        onClose={() => setShow3DView(false)}
                    />
                </Suspense>
            )}

            <ScaleCalibrationDialog
                isOpen={showScaleCalibration}
                onClose={() => setShowScaleCalibration(false)}
            />
        </>
    );
});

LayoutDesigner.displayName = 'LayoutDesigner';
