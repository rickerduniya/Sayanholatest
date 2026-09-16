// Layout Designer - Main layout design view wrapper with sync functionality
// Combines LayoutCanvas, LayoutSidebar, LayoutToolbar into a complete view

import React, { useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { LayoutCanvas, LayoutCanvasRef } from './LayoutCanvas';
import { LayoutSidebar } from './LayoutSidebar';
import { LayoutToolbar } from './LayoutToolbar.tsx';
import { LayoutInspector } from './LayoutInspector';
import { UploadPlanDialog } from './UploadPlanDialog';
import { ScaleCalibrationDialog } from './ScaleCalibrationDialog';
import { useLayoutStore } from '../store/useLayoutStore';
import { useStore } from '../store/useStore';
import { useTheme } from '../context/ThemeContext';
import { Plus, RefreshCw, CheckCircle, AlertCircle, Layers, X } from 'lucide-react';
import { syncEngine, calculateFloorPlanLoad } from '../utils/SyncEngine';
import { agentController } from '../agent/AgentController';
import { DRAWING_TOOL_INSTRUCTIONS } from '../utils/LayoutDrawingTools';
import { DrawingTool, Point } from '../types/layout';

interface LayoutDesignerProps {
    showLeftPanel: boolean;
    showChat: boolean;
    onToggleChat: () => void;
    /** Design Agent panel visibility, owned by App so a run survives view switches. */
    showAgent?: boolean;
    onToggleAgent?: () => void;
}

export interface LayoutDesignerRef {
    saveImage: () => void;
}

/**
 * Single-key tool shortcuts.
 *
 * The toolbar has always *displayed* these hints but nothing was ever bound to
 * them, so every tool change required a trip to the toolbar with the mouse.
 * Space (temporary pan) and Esc are handled inside LayoutCanvas because they
 * interact with in-progress drawing state.
 */
const TOOL_SHORTCUTS: Record<string, DrawingTool> = {
    v: 'select',
    w: 'wall',
    r: 'room',
    d: 'door',
    n: 'window',
    s: 'stair',
    p: 'pick',
    c: 'connection'
};

export const LayoutDesigner = forwardRef<LayoutDesignerRef, LayoutDesignerProps>(({ showLeftPanel, showChat, onToggleChat, showAgent, onToggleAgent }, ref) => {
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
        duplicateSelection,
        nudgeSelection,
        selectAll,
        selectedElementIds,
        undo,
        redo,
        setActiveTool,
        drawingState,
        updateFloorPlan,
        removeFloorPlan,
        visibility: { showWalls, showDoors, showWindows, showRooms },
        setLayoutVisibility
    } = useLayoutStore();

    // SLD store for sync
    const { addItem, getCurrentSheet, stagingItems, setStagingItems, sheets, activeSheetId, registerCanvasSnapshotCallback } = useStore();

    const [scale, setScale] = useState(0.5);
    const [showUploadDialog, setShowUploadDialog] = useState(false);
    const [showScaleCalibration, setShowScaleCalibration] = useState(false);
    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
    const [syncMessage, setSyncMessage] = useState('');
    const [showMagicWires, setShowMagicWires] = useState(true);
    const [measuredPixels, setMeasuredPixels] = useState<number | undefined>(undefined);
    const [isAddTextMode, setIsAddTextMode] = useState(false);

    /** Live cursor position for the status bar, pushed up from the canvas. */
    const [cursorWorld, setCursorWorld] = useState<Point | null>(null);

    /** Right-hand properties panel. On by default: it doubles as the shortcut guide. */
    const [showInspector, setShowInspector] = useState(true);

    /** Inline floor-plan tab rename. Holds the id being renamed, or null. */
    const [renamingPlanId, setRenamingPlanId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState('');

    /**
     * Whether the design agent is mid-run.
     *
     * Used to stand the automatic Layout↔SLD staging sync down while the agent
     * owns both views — see the auto-sync effects below for why that matters.
     */
    const [agentBusy, setAgentBusy] = useState(() => agentController.isSuppressingAutoSync());
    React.useEffect(
        () => agentController.subscribe(() => setAgentBusy(agentController.isSuppressingAutoSync())),
        []
    );

    // Keyboard shortcuts
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            // Ignore if input/textarea/select is focused or content is editable.
            // `select` was missing before, so pressing D over the room-type
            // dropdown switched tools instead of picking an option.
            const target = e.target as HTMLElement;
            const tagName = target.tagName?.toLowerCase();
            if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable) return;

            const ctrl = e.ctrlKey || e.metaKey;

            if (ctrl && e.key.toLowerCase() === 'c') {
                e.preventDefault();
                copySelection();
                return;
            }
            if (ctrl && e.key.toLowerCase() === 'v') {
                e.preventDefault();
                pasteSelection();
                return;
            }
            if (ctrl && e.key.toLowerCase() === 'd') {
                // Browser default here is "bookmark page", which is never what a
                // user wants while drafting.
                e.preventDefault();
                duplicateSelection();
                return;
            }
            if (ctrl && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                selectAll();
                return;
            }
            if (ctrl && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
                return;
            }

            // Arrow-key nudging. Shift multiplies the step for coarse moves.
            if (e.key.startsWith('Arrow')) {
                if (selectedElementIds.length === 0) return;
                const step = e.shiftKey ? 10 : 1;
                const deltas: Record<string, [number, number]> = {
                    ArrowLeft: [-step, 0],
                    ArrowRight: [step, 0],
                    ArrowUp: [0, -step],
                    ArrowDown: [0, step]
                };
                const delta = deltas[e.key];
                if (delta) {
                    e.preventDefault();
                    nudgeSelection(delta[0], delta[1]);
                }
                return;
            }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (e.key === 'Delete') e.preventDefault();
                deleteSelected();
                return;
            }

            // Zoom, matching the hints already shown in the toolbar.
            if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                canvasRef.current?.zoomIn();
                return;
            }
            if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                canvasRef.current?.zoomOut();
                return;
            }
            if (e.shiftKey && e.key === '!') {
                // Shift+1
                e.preventDefault();
                canvasRef.current?.fitView();
                return;
            }

            // Single-key tool switching. Skip when any modifier is held so we
            // never shadow a browser or OS shortcut.
            if (ctrl || e.altKey) return;

            if (e.key.toLowerCase() === 't') {
                e.preventDefault();
                setIsAddTextMode(prev => !prev);
                return;
            }

            const tool = TOOL_SHORTCUTS[e.key.toLowerCase()];
            if (tool) {
                e.preventDefault();
                setIsAddTextMode(false);
                setActiveTool(tool);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [
        copySelection,
        pasteSelection,
        deleteSelected,
        duplicateSelection,
        nudgeSelection,
        selectAll,
        selectedElementIds.length,
        undo,
        redo,
        setActiveTool
    ]);

    const currentPlan = getCurrentFloorPlan();

    // Calculate load summary for current plan
    const loadSummary = currentPlan ? calculateFloorPlanLoad(currentPlan) : null;

    useImperativeHandle(ref, () => ({
        saveImage: () => canvasRef.current?.saveImage()
    }));

    React.useEffect(() => {
        registerCanvasSnapshotCallback(async () => canvasRef.current?.captureSnapshot() || '');
        return () => registerCanvasSnapshotCallback(null);
    }, [registerCanvasSnapshotCallback]);

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
            // Build set of current Layout component IDs
            const currentLayoutComponentIds = new Set(currentPlan.components.map(c => c.id));

            // Filtering strategy:
            // 1. FIRST: Clean existing staging items - remove any whose Layout component was deleted
            // 2. THEN: Add new items that aren't already placed or in staging

            const allPlacedSldIds = new Set(sheets.flatMap(s => s.canvasItems).map(i => i.uniqueID));

            // Step 1: Clean stale staging items (those whose Layout component no longer exists)
            const cleanedStagingItems = stagingItems.filter(item => {
                // If already placed on canvas, remove from staging
                if (allPlacedSldIds.has(item.uniqueID)) return false;
                // If linked to a Layout component, check if that component still exists
                const linkedLayoutId = item.properties?.[0]?.['_layoutComponentId'];
                if (linkedLayoutId && !currentLayoutComponentIds.has(linkedLayoutId)) {
                    console.log(`[handleSyncToSld] Removing stale staging item: ${item.name} (Layout component ${linkedLayoutId} deleted)`);
                    return false;
                }
                return true;
            });

            // Step 2: Build set of existing IDs (both placed and cleaned staging)
            const existingIds = new Set([
                ...allPlacedSldIds,
                ...cleanedStagingItems.map(i => i.uniqueID)
            ]);

            // Generate only the components that are not already staged or
            // placed. Rebuilding every existing item made each incremental
            // Layout edit slower as the floor plan grew.
            const result = await syncEngine.syncLayoutToSld(currentPlan, (msg) => {
                setSyncMessage(msg);
            }, {
                existingSldItemIds: existingIds
            });

            // Also track existing Layout component links to avoid duplicates
            const existingLayoutLinks = new Set(
                cleanedStagingItems
                    .map(i => i.properties?.[0]?.['_layoutComponentId'])
                    .filter(Boolean)
            );

            const newStagingItems = [...cleanedStagingItems];
            let addedCount = 0;

            for (const item of result.items) {
                const itemLayoutId = item.properties?.[0]?.['_layoutComponentId'];
                // Skip if already in staging by ID
                if (existingIds.has(item.uniqueID)) continue;
                // Skip if layout component is already linked in staging
                if (itemLayoutId && existingLayoutLinks.has(itemLayoutId)) continue;

                newStagingItems.push(item);
                addedCount++;
            }

            setStagingItems(newStagingItems);

            // TODO: Add connections? Connections rely on items being placed.
            // If we stage items, we can't stage connections easily unless we stage them too.
            // For now, we skip connections for unplaced items.

            const removedCount = stagingItems.length - cleanedStagingItems.length;
            setSyncStatus('success');
            setSyncMessage(`Synced: +${addedCount} new, -${removedCount} removed`);

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
    const autoSyncTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        const currentCount = currentPlan?.components?.length ?? 0;
        const prevCount = prevComponentCountRef.current;

        // Skip first mount to avoid initial sync when loading
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            prevComponentCountRef.current = currentCount;
            return;
        }

        // Stand down while the design agent is running.
        //
        // This auto-sync stages a copy of every newly placed component in the
        // "Unplaced" tray, which is right for a human but actively harmful during
        // an agent run: the agent places 26 components, the tray fills up, and
        // layout_build_sld then treats "staged" as "already has a symbol" and
        // materializes nothing. The agent sees an empty sheet, falls back to
        // add_item_to_diagram, and builds a second set of symbols with no link
        // back to the layout — which is why items stayed in Unplaced on both
        // sides and the SLD connections had no layout counterpart.
        //
        // The count ref is still advanced so that when the run ends we do not
        // fire a burst of catch-up syncs for work the agent already materialized.
        if (agentController.isSuppressingAutoSync()) {
            prevComponentCountRef.current = currentCount;
            return;
        }

        // Coalesce rapid additions into one sync. Adding a large set of
        // components used to start a complete sync after every drop.
        if (currentCount !== prevCount && currentCount > 0) {
            prevComponentCountRef.current = currentCount;

            if (autoSyncTimerRef.current) {
                clearTimeout(autoSyncTimerRef.current);
            }

            autoSyncTimerRef.current = setTimeout(() => {
                autoSyncTimerRef.current = null;
                handleSyncToSld();
            }, 300);
        }

        return () => {
            if (autoSyncTimerRef.current) {
                clearTimeout(autoSyncTimerRef.current);
                autoSyncTimerRef.current = null;
            }
        };
    }, [currentPlan?.components?.length, agentBusy]); // eslint-disable-line react-hooks/exhaustive-deps

    // Sync SLD to Layout (Reverse Sync) - Populates Layout Staging
    // We check this on mount or when SLD sheet items change significantly?
    // For now, let's do it on effect when we enter this view.
    const { setStagingComponents } = useLayoutStore();

    React.useEffect(() => {
        if (!currentPlan) return;

        // Same reasoning as the forward auto-sync: while the agent runs, it owns
        // both views. Reverse-syncing mid-run would stage a Layout copy of every
        // SLD symbol the agent just created — filling the Layout "Unplaced" tray
        // with items that are already placed, because the sldItemId link is
        // written a moment after the symbol appears.
        if (agentBusy) return;

        // Get SLD components (all sheets)
        const sldComponents = sheets.flatMap(s => s.canvasItems);

        // Build lookup of SLD item IDs that actually exist
        const existingSldIds = new Set(sldComponents.map(c => c.uniqueID));

        // Get current state directly to avoid dependency loop
        const layoutState = useLayoutStore.getState();
        const currentLayoutStaging = layoutState.stagingComponents;

        // STEP 1: Clean existing staging - remove items whose SLD link no longer exists
        const cleanedExisting = currentLayoutStaging.filter(c => {
            if (!c.sldItemId) return true; // Keep unlinked components
            return existingSldIds.has(c.sldItemId);
        });

        const hadStaleItems = cleanedExisting.length !== currentLayoutStaging.length;
        if (hadStaleItems) {
            console.log(`[LayoutDesigner] Cleaning ${currentLayoutStaging.length - cleanedExisting.length} stale staging components`);
        }

        // If SLD is empty, just update with cleaned staging
        if (sldComponents.length === 0) {
            if (hadStaleItems) {
                setStagingComponents(cleanedExisting);
            }
            return;
        }

        // STEP 2: Add new items from sync
        try {
            const stagedItems = syncEngine.syncSldToLayout(currentPlan, sldComponents);
            const placedStagingIds = layoutState.placedStagingComponentIds;

            const placedSldIds = new Set(
                layoutState.floorPlans.flatMap(p => p.components.map(c => c.sldItemId)).filter(Boolean) as string[]
            );
            const placedLayoutIds = new Set(
                layoutState.floorPlans.flatMap(p => p.components.map(c => c.id))
            );

            // Filter out items already in staging or placed to avoid duplicates
            const newItems = stagedItems.filter(staged => {
                const sldId = staged.sldItemId;
                // Skip if SLD item is already placed in Layout
                if (sldId && placedSldIds.has(sldId)) return false;
                // Skip if layout component ID is already placed
                if (placedLayoutIds.has(staged.id)) return false;
                // Skip if this staging item was already placed
                if (placedStagingIds.has(staged.id)) return false;
                // Skip if already in cleaned staging (check both id and sldItemId)
                return !cleanedExisting.some(existing =>
                    existing.sldItemId === staged.sldItemId || existing.id === staged.id
                );
            });

            // Only update if there are changes
            if (hadStaleItems || newItems.length > 0) {
                setStagingComponents([...cleanedExisting, ...newItems]);
            }
        } catch (e) {
            console.error("Failed to sync SLD to Layout", e);
            // Still apply stale cleanup even if sync fails
            if (hadStaleItems) {
                setStagingComponents(cleanedExisting);
            }
        }
    }, [currentPlan, sheets, activeSheetId, setStagingComponents, agentBusy]); // Removed layoutStaging to prevent loop

    // REVERSE SYNC: Clean SLD staging when Layout components are deleted
    // This effect ensures that when a Layout component is deleted, any SLD staging items
    // that reference that Layout component are also cleaned up
    React.useEffect(() => {
        if (!currentPlan) return;

        // Build set of all existing Layout component IDs (placed on any floor plan)
        const layoutState = useLayoutStore.getState();
        const existingLayoutIds = new Set<string>();
        layoutState.floorPlans.forEach(p => p.components.forEach(c => existingLayoutIds.add(c.id)));
        // Also include staging component IDs
        layoutState.stagingComponents.forEach(c => existingLayoutIds.add(c.id));

        // Get current SLD staging items
        const sldState = useStore.getState();
        const currentSldStaging = sldState.stagingItems;

        // Clean SLD staging: remove items whose _layoutComponentId no longer exists
        const cleanedSldStaging = currentSldStaging.filter(item => {
            const linkedLayoutId = item.properties?.[0]?.['_layoutComponentId'];
            if (!linkedLayoutId) return true; // Keep unlinked items
            return existingLayoutIds.has(linkedLayoutId);
        });

        if (cleanedSldStaging.length !== currentSldStaging.length) {
            console.log(`[LayoutDesigner] Cleaning ${currentSldStaging.length - cleanedSldStaging.length} stale SLD staging items`);
            setStagingItems(cleanedSldStaging);
        }
    }, [currentPlan?.components, setStagingItems]);

    // CATCH-UP SYNC: run once when the agent finishes.
    //
    // The auto-sync above stands down during a run, so anything the agent placed
    // but never materialized into the schematic would otherwise be invisible in
    // the Unplaced tray. One sync on the falling edge puts those — and only
    // those — in the tray; components the agent already wired are skipped because
    // their sldItemId is on the sheet.
    const prevAgentBusyRef = React.useRef(agentBusy);
    React.useEffect(() => {
        const wasBusy = prevAgentBusyRef.current;
        prevAgentBusyRef.current = agentBusy;

        if (!wasBusy || agentBusy) return;
        if (!currentPlan || currentPlan.components.length === 0) return;

        const timer = setTimeout(() => handleSyncToSld(), 400);
        return () => clearTimeout(timer);
    }, [agentBusy]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <>
            {/* Full Screen Canvas */}
            <div className="absolute inset-0 z-0">
                <LayoutCanvas
                    ref={canvasRef}
                    onScaleChange={setScale}
                    showMagicWires={showMagicWires}
                    showWalls={showWalls}
                    showDoors={showDoors}
                    showWindows={showWindows}
                    showRooms={showRooms}
                    onCalibrationFinished={(pixels) => {
                        setMeasuredPixels(pixels);
                        setShowScaleCalibration(true);
                        setActiveTool('select');
                    }}
                    isAddTextMode={isAddTextMode}
                    onAddTextComplete={() => setIsAddTextMode(false)}
                    onSldConnectionResult={(status, message) => {
                        setSyncStatus(status);
                        setSyncMessage(message);
                        window.setTimeout(() => setSyncStatus('idle'), 3500);
                    }}
                    onCursorChange={setCursorWorld}
                    onRequestNewPlan={() => setShowUploadDialog(true)}
                    inspectorOpen={showInspector}
                    loadSummaryVisible={Boolean(loadSummary && loadSummary.totalLoad > 0)}
                />
            </div>

            {/* Toolbar.
                On its own row below App's top bar (menu / branding / view toggle
                / account) rather than sharing it. It was previously centred on the
                whole viewport at ~880px wide, so on anything under ~1600px it ran
                underneath the SLD/Layout toggle — and because App's top bar paints
                after this at the same z-index, the toggle captured the clicks and
                the right-hand tools became unreachable. A dedicated row removes the
                competition entirely; overflow-x-auto keeps every tool reachable on
                narrow windows. */}
            <div className="pointer-events-none absolute left-2 right-2 top-14 z-50 flex justify-center">
                <div className="pointer-events-auto max-w-full overflow-x-auto">
                    <LayoutToolbar
                        scale={scale}
                        onZoomIn={() => canvasRef.current?.zoomIn()}
                        onZoomOut={() => canvasRef.current?.zoomOut()}
                        onFitView={() => canvasRef.current?.fitView()}
                        onUploadPlan={() => setShowUploadDialog(true)}
                        onScaleCalibrate={() => {
                            setActiveTool('calibrate');
                            setMeasuredPixels(undefined);
                        }}
                        showMagicWires={showMagicWires}
                        onToggleMagicWires={() => setShowMagicWires(!showMagicWires)}
                        showChat={showChat}
                        onToggleChat={onToggleChat}
                        showAgent={showAgent}
                        onToggleAgent={onToggleAgent}
                        showWalls={showWalls}
                        onToggleWalls={() => setLayoutVisibility('showWalls', !showWalls)}
                        showDoors={showDoors}
                        onToggleDoors={() => setLayoutVisibility('showDoors', !showDoors)}
                        showWindows={showWindows}
                        onToggleWindows={() => setLayoutVisibility('showWindows', !showWindows)}
                        showRooms={showRooms}
                        onToggleRooms={() => setLayoutVisibility('showRooms', !showRooms)}
                        isAddTextMode={isAddTextMode}
                        onAddText={() => setIsAddTextMode(!isAddTextMode)}
                        showInspector={showInspector}
                        onToggleInspector={() => setShowInspector(prev => !prev)}
                        onNotify={(status, message) => {
                            setSyncStatus(status);
                            setSyncMessage(message);
                            window.setTimeout(() => setSyncStatus('idle'), 3500);
                        }}
                    />
                </div>
            </div>

            {/* Left Sidebar - Floating.
                top-28 clears App's top bar (row 1) and the tool row (row 2). */}
            {showLeftPanel && (
                <div
                    className="absolute left-4 top-28 bottom-14 w-48 z-40 premium-glass rounded-xl overflow-hidden flex flex-col transition-all duration-300 animate-slide-in-left shadow-xl"
                    style={{ backgroundColor: colors.panelBackground }}
                >
                    <LayoutSidebar />
                </div>
            )}

            {/* Right properties panel.
                The Layout view previously had no equivalent of the SLD
                properties panel, so element attributes (wall thickness, room
                name/type, door width, component label and wattage) simply could
                not be edited after creation. */}
            {showInspector && (
                <div
                    className="absolute right-4 top-28 bottom-14 w-56 z-40 premium-glass rounded-xl overflow-hidden flex flex-col animate-slide-in-right shadow-xl"
                    style={{ backgroundColor: colors.panelBackground }}
                >
                    <div
                        className="flex items-center justify-between border-b px-3 py-2"
                        style={{ borderColor: colors.border, color: colors.text }}
                    >
                        <span className="text-xs font-semibold">Properties</span>
                        <button
                            type="button"
                            onClick={() => setShowInspector(false)}
                            className="rounded p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                            aria-label="Close properties panel"
                        >
                            <X size={14} />
                        </button>
                    </div>
                    <div className="flex-1 overflow-hidden">
                        <LayoutInspector />
                    </div>
                </div>
            )}

            {drawingState.activeTool === 'connection' && (
                <div className="absolute top-28 left-1/2 -translate-x-1/2 z-40 rounded-full px-4 py-2 text-xs font-medium shadow-lg" style={{ backgroundColor: colors.panelBackground, color: colors.text, border: `1px solid ${colors.border}` }}>
                    Connection mode: click a Point Switch Board and a load. Each connection uses the next free SLD output, from out1 to out9.
                </div>
            )}

            {/* Load Summary Panel â€” sits left of the properties panel when that
                is open, otherwise hugs the right edge. */}
            {loadSummary && loadSummary.totalLoad > 0 && (
                <div
                    className={`absolute top-28 z-40 premium-glass rounded-xl p-3 shadow-lg animate-fade-in transition-all duration-300 ${showInspector ? 'right-64' : 'right-4'}`}
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
                        absolute top-[124px] left-1/2 transform -translate-x-1/2 z-50 
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

            {/* Bottom bar: floor-plan tabs on the left, live status readout on the
                right. The tool hint used to render at top-centre underneath the
                floating toolbar, where it was overlapped and unreadable. */}
            <div
                className="absolute bottom-2 left-4 right-4 z-30 premium-glass rounded-full pl-3 pr-2 py-1.5 animate-slide-in-bottom shadow-lg"
                style={{ backgroundColor: colors.menuBackground }}
            >
                <div className="flex items-center gap-2">
                    {/* Plan tabs */}
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                        {floorPlans.map(plan => {
                            const isActive = activeFloorPlanId === plan.id;
                            const isRenaming = renamingPlanId === plan.id;

                            if (isRenaming) {
                                const commitRename = () => {
                                    const next = renameDraft.trim();
                                    if (next && next !== plan.name) {
                                        updateFloorPlan(plan.id, { name: next });
                                    }
                                    setRenamingPlanId(null);
                                };

                                return (
                                    <input
                                        key={plan.id}
                                        autoFocus
                                        value={renameDraft}
                                        onChange={(e) => setRenameDraft(e.target.value)}
                                        onBlur={commitRename}
                                        onKeyDown={(e) => {
                                            e.stopPropagation();
                                            if (e.key === 'Enter') commitRename();
                                            if (e.key === 'Escape') setRenamingPlanId(null);
                                        }}
                                        className="w-32 rounded-full bg-white/15 px-3 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                        style={{ color: colors.text }}
                                    />
                                );
                            }

                            return (
                                <div
                                    key={plan.id}
                                    className={`
                                        group flex shrink-0 items-center gap-1 rounded-full pl-3 pr-1.5 py-1
                                        text-xs font-medium whitespace-nowrap transition-all duration-150
                                        ${isActive ? 'bg-blue-500 text-white shadow-md' : 'hover:bg-white/10'}
                                    `}
                                    style={isActive ? {} : { color: colors.text }}
                                >
                                    <button
                                        type="button"
                                        onClick={() => setActiveFloorPlan(plan.id)}
                                        // Double-click to rename is the standard
                                        // gesture for tabbed documents.
                                        onDoubleClick={() => {
                                            setRenamingPlanId(plan.id);
                                            setRenameDraft(plan.name);
                                        }}
                                        title={`${plan.name} â€” double-click to rename`}
                                        className="max-w-[140px] truncate"
                                    >
                                        {plan.name}
                                    </button>

                                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${isActive ? 'bg-white/20' : 'bg-blue-500/20'}`}>
                                        {plan.components.length}
                                    </span>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            // Destructive and not undoable via the
                                            // layout history, so confirm first.
                                            const ok = window.confirm(
                                                `Delete floor plan "${plan.name}"? Its walls, rooms and ${plan.components.length} component(s) will be removed.`
                                            );
                                            if (ok) removeFloorPlan(plan.id);
                                        }}
                                        title="Delete floor plan"
                                        aria-label={`Delete ${plan.name}`}
                                        className="rounded-full p-0.5 opacity-0 transition-opacity hover:bg-black/20 group-hover:opacity-70"
                                    >
                                        <X size={11} />
                                    </button>
                                </div>
                            );
                        })}

                        {/* Add new plan button */}
                        <button
                            onClick={() => setShowUploadDialog(true)}
                            className="shrink-0 rounded-full p-1.5 transition-colors hover:bg-white/10"
                            title="Add Floor Plan"
                        >
                            <Plus size={16} style={{ color: colors.text }} />
                        </button>

                        {/* Empty state */}
                        {floorPlans.length === 0 && (
                            <span className="text-xs opacity-60" style={{ color: colors.text }}>
                                No floor plans â€” click + to upload or create one
                            </span>
                        )}
                    </div>

                    {/* Status readout */}
                    <div
                        className="hidden shrink-0 items-center gap-3 pl-3 text-[11px] md:flex"
                        style={{ color: colors.text }}
                    >
                        <span className="opacity-60">
                            {isAddTextMode
                                ? 'Click the canvas to place a text box'
                                : DRAWING_TOOL_INSTRUCTIONS[drawingState.activeTool]}
                        </span>

                        {selectedElementIds.length > 0 && (
                            <span className="rounded-full bg-blue-500/20 px-2 py-0.5 font-medium text-blue-500">
                                {selectedElementIds.length} selected
                            </span>
                        )}

                        {cursorWorld && (
                            <span className="font-mono opacity-50">
                                {Math.round(cursorWorld.x)}, {Math.round(cursorWorld.y)}
                            </span>
                        )}

                        {currentPlan && (
                            <span
                                className="font-mono opacity-50"
                                title={currentPlan.isScaleCalibrated ? 'Scale calibrated' : 'Scale not calibrated â€” measurements are approximate'}
                            >
                                1{currentPlan.measurementUnit === 'ft' ? 'ft' : 'm'} â‰ˆ{' '}
                                {Math.round(
                                    currentPlan.measurementUnit === 'ft'
                                        ? currentPlan.pixelsPerMeter * 0.3048
                                        : currentPlan.pixelsPerMeter
                                )}px
                                {currentPlan.isScaleCalibrated ? '' : ' ?'}
                            </span>
                        )}

                        <span className="font-mono opacity-50">{Math.round(scale * 100)}%</span>
                    </div>
                </div>
            </div>

            {/* Dialogs */}
            <UploadPlanDialog
                isOpen={showUploadDialog}
                onClose={() => setShowUploadDialog(false)}
            />


            <ScaleCalibrationDialog
                isOpen={showScaleCalibration}
                onClose={() => setShowScaleCalibration(false)}
                initialPixelDistance={measuredPixels}
            />
        </>
    );
});

LayoutDesigner.displayName = 'LayoutDesigner';
