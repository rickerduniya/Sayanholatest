// Layout Store - Zustand slice for layout state management
// Separate from main SLD store for cleaner architecture

import { create } from 'zustand';
import {
    FloorPlan,
    Wall,
    Room,
    Door,
    LayoutWindow,
    LayoutComponent,
    LayoutConnection,
    LayoutTextItem,
    DrawingTool,
    DrawingState,
    ViewMode,
    LayoutComponentType,
    Point
} from '../types/layout';
import { generateLayoutId } from '../utils/LayoutDrawingTools';
import { stitchWalls, remapAttachedItems } from '../utils/WallStitching';

type LayoutSnapshot = {
    floorPlans: FloorPlan[];
    stagingComponents: LayoutComponent[];
    placedStagingComponentIds: string[];
};

type ApiDebugData = {
    timestamp: number;
    request: {
        url: string;
        method: string;
        filename: string;
        fileSize: number;
        fileType: string;
        confidence_threshold: string;
        detection_threshold: string;
    };
    response?: {
        status: number;
        statusText: string;
        receivedAt: string;
        json: unknown;
    };
    error?: {
        message: string;
    };
};

interface LayoutStoreState {
    // View mode (shared with main app)
    activeView: ViewMode;
    setActiveView: (view: ViewMode) => void;

    // Floor plans
    floorPlans: FloorPlan[];
    activeFloorPlanId: string | null;

    // Drawing state
    drawingState: DrawingState;

    // Floor plan actions
    addFloorPlan: (plan?: Partial<FloorPlan>) => string;
    updateFloorPlan: (id: string, updates: Partial<FloorPlan>) => void;
    removeFloorPlan: (id: string) => void;
    setActiveFloorPlan: (id: string | null) => void;
    getCurrentFloorPlan: () => FloorPlan | undefined;

    // Drawing tool actions
    setActiveTool: (tool: DrawingTool) => void;
    setSelectedComponentType: (type: LayoutComponentType | undefined) => void;
    setWallThickness: (thickness: number) => void;
    setContinuousWallMode: (enabled: boolean) => void;

    // Wall actions
    addWall: (wall: Omit<Wall, 'id'>) => void;
    updateWall: (id: string, updates: Partial<Wall>) => void;
    removeWall: (id: string) => void;

    // Room actions
    addRoom: (room: Omit<Room, 'id'>) => void;
    updateRoom: (id: string, updates: Partial<Room>) => void;
    removeRoom: (id: string) => void;

    // Door actions
    addDoor: (door: Omit<Door, 'id'>) => void;
    updateDoor: (id: string, updates: Partial<Door>) => void;
    removeDoor: (id: string) => void;

    // Window actions
    addWindow: (window: Omit<LayoutWindow, 'id'>) => void;
    updateWindow: (id: string, updates: Partial<LayoutWindow>) => void;
    removeWindow: (id: string) => void;

    // Component actions (Staging / Bi-directional Sync)
    stagingComponents: LayoutComponent[];
    placedStagingComponentIds: Set<string>;  // Track placed staging components
    setStagingComponents: (components: LayoutComponent[]) => void;
    removeStagingComponent: (id: string) => void;
    cleanStaleStagingComponents: () => void;  // Remove staging components whose SLD link no longer exists
    markStagingComponentPlaced: (id: string) => void;
    isStagingComponentPlaced: (id: string) => boolean;

    // Component actions
    addComponent: (component: Omit<LayoutComponent, 'id'>) => string;
    addComponentWithId: (component: LayoutComponent) => void;  // For staging items with existing ID
    updateComponent: (id: string, updates: Partial<LayoutComponent>) => void;
    removeComponent: (id: string) => void;

    // Connection actions
    addConnection: (connection: Omit<LayoutConnection, 'id'>) => void;
    updateConnection: (id: string, updates: Partial<LayoutConnection>) => void;
    removeConnection: (id: string) => void;

    // Selection
    selectedElementIds: string[];
    selectElement: (id: string, multi?: boolean) => void;
    selectElements: (ids: string[], additive?: boolean) => void;
    selectAll: () => void;
    clearSelection: () => void;
    deleteSelected: () => void;

    // Editing helpers used by the selection inspector / keyboard
    nudgeSelection: (dx: number, dy: number) => void;
    duplicateSelection: () => void;
    addTextItem: (item: Omit<LayoutTextItem, 'id'>) => string;
    updateTextItem: (id: string, updates: Partial<LayoutTextItem>) => void;
    removeTextItem: (id: string) => void;
    rotateSelection: (degrees: number) => void;

    // Viewport
    updateViewport: (x: number, y: number, scale: number) => void;

    // Clipboard
    clipboard: {
        components: LayoutComponent[];
        walls: Wall[];
    };
    copySelection: () => void;
    pasteSelection: () => void;

    // Undo/Redo
    undoStack: LayoutSnapshot[];
    redoStack: LayoutSnapshot[];
    takeSnapshot: () => void;
    undo: () => void;
    redo: () => void;

    // Smart detect API debug
    apiDebugData: ApiDebugData | null;
    setApiDebugData: (data: ApiDebugData | null) => void;

    // Wall Post-Processing
    resetWallsToOriginal: () => void;
    applySmartStitch: () => void;

    // Element Visibility
    visibility: {
        showWalls: boolean;
        showDoors: boolean;
        showWindows: boolean;
        showRooms: boolean;
    };
    setLayoutVisibility: (key: 'showWalls' | 'showDoors' | 'showWindows' | 'showRooms', value: boolean) => void;

    // OCR Settings
    ocrSettings: {
        showOcr: boolean;
        minConfidence: number;
        query: string;
        showBoxes: boolean;
    };
    setOcrSettings: (settings: Partial<LayoutStoreState['ocrSettings']>) => void;

    // Local project import — bulk-load all layout state
    loadProject: (floorPlans: FloorPlan[], activeFloorPlanId: string | null,
                  stagingComponents: LayoutComponent[], placedIds: string[]) => void;
}

const MAX_HISTORY = 20;

const deepClone = <T,>(v: T): T => {
    if (typeof structuredClone === 'function') return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
};

const createDefaultFloorPlan = (id?: string): FloorPlan => ({
    id: id || generateLayoutId('floor'),
    name: 'Floor Plan 1',
    width: 2000,
    height: 1500,
    pixelsPerMeter: 50,
    measurementUnit: 'm',
    isScaleCalibrated: false,
    walls: [],
    rooms: [],
    doors: [],
    windows: [],
    stairs: [],
    components: [],
    connections: [],
    viewportX: 0,
    viewportY: 0,
    scale: 0.5
});

const createDefaultDrawingState = (): DrawingState => ({
    activeTool: 'select',
    selectedComponentType: undefined,
    isDrawing: false,
    currentPath: [],
    selectedElementIds: [],
    wallThickness: 10,
    continuousWallMode: false // Default to single line as requested
});

// Helper to find current floor plan from state
const findCurrentPlan = (floorPlans: FloorPlan[], activeId: string | null): FloorPlan | undefined => {
    return floorPlans.find(fp => fp.id === activeId);
};

export const useLayoutStore = create<LayoutStoreState>((set, get) => ({
    // Initial state
    activeView: 'sld',
    floorPlans: [],
    activeFloorPlanId: null,
    drawingState: createDefaultDrawingState(),
    selectedElementIds: [],
    undoStack: [],
    redoStack: [],
    apiDebugData: null,
    setApiDebugData: (data) => set({ apiDebugData: data }),

    // Element Visibility
    visibility: {
        showWalls: true,
        showDoors: true,
        showWindows: true,
        showRooms: true
    },
    setLayoutVisibility: (key, value) => set((state) => ({
        visibility: { ...state.visibility, [key]: value }
    })),

    // OCR Settings
    ocrSettings: {
        showOcr: true,
        minConfidence: 60,
        query: '',
        showBoxes: false
    },
    setOcrSettings: (settings) => set((state) => ({
        ocrSettings: { ...state.ocrSettings, ...settings }
    })),

    // Wall Post-Processing
    resetWallsToOriginal: () => {
        const { activeFloorPlanId, floorPlans, takeSnapshot } = get();
        if (!activeFloorPlanId) return;

        takeSnapshot();
        set({
            floorPlans: floorPlans.map(fp => {
                if (fp.id !== activeFloorPlanId || !fp.originalWalls) return fp;
                return {
                    ...fp,
                    walls: [...fp.originalWalls.map(w => ({ ...w }))] // Restore copy
                };
            })
        });
    },

    applySmartStitch: () => {
        const { activeFloorPlanId, floorPlans, takeSnapshot } = get();
        if (!activeFloorPlanId) return;

        takeSnapshot();
        const plan = floorPlans.find(fp => fp.id === activeFloorPlanId);
        if (!plan) return;

        // Re-run stitching on CURRENT walls (to preserve modifications)
        // NOTE: We pass empty arrays for doors/windows to stitchWalls because we handle remapping separately below
        const stitchedWalls = stitchWalls(plan.walls, [], [], plan.width, plan.height);

        // Remap attached items (Doors/Windows) to new stitched walls
        const remappedDoors = remapAttachedItems(plan.doors, stitchedWalls);
        const remappedWindows = remapAttachedItems(plan.windows, stitchedWalls);

        set({
            floorPlans: floorPlans.map(fp => {
                if (fp.id !== activeFloorPlanId) return fp;
                return {
                    ...fp,
                    walls: stitchedWalls,
                    doors: remappedDoors,
                    windows: remappedWindows
                };
            })
        });
    },

    // View mode
    setActiveView: (view) => set({ activeView: view }),

    // Floor plan actions
    addFloorPlan: (plan) => {
        const newPlan = {
            ...createDefaultFloorPlan(),
            ...plan,
            id: plan?.id || generateLayoutId('floor')
        };

        set((state) => ({
            floorPlans: [...state.floorPlans, newPlan],
            activeFloorPlanId: newPlan.id
        }));

        return newPlan.id;
    },

    updateFloorPlan: (id, updates) => set((state) => ({
        floorPlans: state.floorPlans.map(fp =>
            fp.id === id ? { ...fp, ...updates } : fp
        )
    })),

    removeFloorPlan: (id) => set((state) => {
        const newPlans = state.floorPlans.filter(fp => fp.id !== id);
        return {
            floorPlans: newPlans,
            activeFloorPlanId: state.activeFloorPlanId === id
                ? (newPlans[0]?.id || null)
                : state.activeFloorPlanId
        };
    }),

    setActiveFloorPlan: (id) => set({
        activeFloorPlanId: id,
        selectedElementIds: []
    }),

    getCurrentFloorPlan: () => {
        const { floorPlans, activeFloorPlanId } = get();
        return floorPlans.find(fp => fp.id === activeFloorPlanId);
    },

    // Drawing tool actions
    setActiveTool: (tool) => set((state) => ({
        drawingState: { ...state.drawingState, activeTool: tool }
    })),

    setSelectedComponentType: (type) => set((state) => ({
        drawingState: { ...state.drawingState, selectedComponentType: type }
    })),

    setWallThickness: (thickness) => set((state) => ({
        drawingState: { ...state.drawingState, wallThickness: thickness }
    })),

    setContinuousWallMode: (enabled) => set((state) => ({
        drawingState: { ...state.drawingState, continuousWallMode: enabled }
    })),

    // Wall actions
    addWall: (wall) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newWall: Wall = { ...wall, id: generateLayoutId('wall') };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, walls: [...p.walls, newWall] } : p
                )
            };
        });
    },

    updateWall: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        walls: p.walls.map(w => w.id === id ? { ...w, ...updates } : w)
                    } : p
                )
            };
        });
    },

    removeWall: (id) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        walls: p.walls.filter(w => w.id !== id),
                        doors: p.doors.filter(d => d.wallId !== id),
                        windows: p.windows.filter(w => w.wallId !== id)
                    } : p
                )
            };
        });
    },

    // Room actions
    addRoom: (room) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newRoom: Room = { ...room, id: generateLayoutId('room') };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, rooms: [...p.rooms, newRoom] } : p
                )
            };
        });
    },

    updateRoom: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        rooms: p.rooms.map(r => r.id === id ? { ...r, ...updates } : r)
                    } : p
                )
            };
        });
    },

    removeRoom: (id) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        rooms: p.rooms.filter(r => r.id !== id)
                    } : p
                )
            };
        });
    },

    // Door actions
    addDoor: (door) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newDoor: Door = { ...door, id: generateLayoutId('door') };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, doors: [...p.doors, newDoor] } : p
                )
            };
        });
    },

    updateDoor: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        doors: p.doors.map(d => d.id === id ? { ...d, ...updates } : d)
                    } : p
                )
            };
        });
    },

    removeDoor: (id) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        doors: p.doors.filter(d => d.id !== id)
                    } : p
                )
            };
        });
    },

    // Window actions
    addWindow: (window) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newWindow: LayoutWindow = { ...window, id: generateLayoutId('window') };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, windows: [...p.windows, newWindow] } : p
                )
            };
        });
    },

    updateWindow: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        windows: p.windows.map(w => w.id === id ? { ...w, ...updates } : w)
                    } : p
                )
            };
        });
    },

    removeWindow: (id) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        windows: p.windows.filter(w => w.id !== id)
                    } : p
                )
            };
        });
    },

    // Staging actions - source of truth is floorPlans[].components
    // stagingComponents = components waiting to be placed on Layout canvas
    // placedStagingComponentIds = guard to prevent double-drops during drag operations
    stagingComponents: [],
    placedStagingComponentIds: new Set<string>(),

    // setStagingComponents: Filter out any components already on floor plans (source of truth)
    setStagingComponents: (components) => set((state) => {
        // Build sets of all IDs currently placed on any floor plan
        const placedLayoutIds = new Set(state.floorPlans.flatMap(p => p.components.map(c => c.id)));
        const placedSldIds = new Set(
            state.floorPlans.flatMap(p => p.components.map(c => c.sldItemId).filter(Boolean)) as string[]
        );

        return {
            stagingComponents: components.filter(comp => {
                // Already placed by component ID?
                if (placedLayoutIds.has(comp.id)) return false;
                // Already placed by linked SLD ID?
                if (comp.sldItemId && placedSldIds.has(comp.sldItemId)) return false;
                return true;
            })
        };
    }),

    removeStagingComponent: (id) => set((state) => ({
        stagingComponents: state.stagingComponents.filter(c => c.id !== id)
    })),

    // Remove staging components whose linked SLD item no longer exists
    cleanStaleStagingComponents: () => {
        // Dynamically import to avoid circular dependency at module load time
        import('./useStore').then(({ useStore }) => {
            const sldState = useStore.getState();

            // Build set of all existing SLD item IDs (placed on canvas + in staging)
            const existingSldIds = new Set<string>();
            sldState.sheets.forEach(s =>
                s.canvasItems.forEach(i => existingSldIds.add(i.uniqueID))
            );
            sldState.stagingItems.forEach(i => existingSldIds.add(i.uniqueID));

            set((state) => {
                // Filter staging components: keep only those whose sldItemId exists OR have no link
                const cleanedComponents = state.stagingComponents.filter(comp => {
                    if (!comp.sldItemId) return true; // Keep unlinked components
                    return existingSldIds.has(comp.sldItemId);
                });

                if (cleanedComponents.length !== state.stagingComponents.length) {
                    console.log(`[Layout] Cleaned ${state.stagingComponents.length - cleanedComponents.length} stale staging components`);
                }

                return { stagingComponents: cleanedComponents };
            });
        });
    },

    // Mark a component as "in-flight" during drag to prevent double-drops
    markStagingComponentPlaced: (id) => set((state) => {
        const newSet = new Set(state.placedStagingComponentIds);
        newSet.add(id);
        return { placedStagingComponentIds: newSet };
    }),

    // Check if component is already placed (on floor plan) or in-flight (being dragged)
    isStagingComponentPlaced: (id) => {
        const state = get();
        // Check if already on any floor plan (source of truth)
        if (state.floorPlans.some(p => p.components.some(c => c.id === id))) return true;
        // Check if marked as in-flight during drag
        if (state.placedStagingComponentIds.has(id)) return true;
        return false;
    },

    // Component actions
    addComponent: (component) => {
        get().takeSnapshot();
        const newId = generateLayoutId('comp');
        const activeId = get().activeFloorPlanId;

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newComponent: LayoutComponent = { ...component, id: newId };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, components: [...p.components, newComponent] } : p
                )
            };
        });

        return newId;
    },

    // Add component with existing ID (for staging items)
    addComponentWithId: (component) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, components: [...p.components, component] } : p
                )
            };
        });
    },

    updateComponent: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            const activeHas = fp?.components?.some(c => c.id === id) ?? false;
            if (fp && activeHas) {
                return {
                    floorPlans: state.floorPlans.map(p =>
                        p.id === fp.id ? {
                            ...p,
                            components: p.components.map(c => c.id === id ? { ...c, ...updates } : c)
                        } : p
                    )
                };
            }

            // Fallback: update in any plan that contains the component
            const containing = state.floorPlans.find(p => p.components.some(c => c.id === id));
            if (!containing) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === containing.id ? {
                        ...p,
                        components: p.components.map(c => c.id === id ? { ...c, ...updates } : c)
                    } : p
                )
            };
        });
    },

    removeComponent: (id) => {
        const activeId = get().activeFloorPlanId;

        // PHASE 2.1: Get the component to find its linked SLD item before deletion
        const activePlan = findCurrentPlan(get().floorPlans, activeId);
        const containingPlan = activePlan?.components.some(c => c.id === id)
            ? activePlan
            : get().floorPlans.find(p => p.components.some(c => c.id === id));

        const componentToDelete = containingPlan?.components.find(c => c.id === id);
        if (!componentToDelete) return;

        get().takeSnapshot();
        const linkedSldItemId = componentToDelete.sldItemId;

        set((state) => {
            const activeFp = findCurrentPlan(state.floorPlans, activeId);
            const targetPlanId = activeFp?.components.some(c => c.id === id)
                ? activeFp.id
                : (state.floorPlans.find(p => p.components.some(c => c.id === id))?.id);

            if (!targetPlanId) return {};

            const nextPlaced = new Set(state.placedStagingComponentIds);
            nextPlaced.delete(id);

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === targetPlanId ? {
                        ...p,
                        components: p.components.filter(c => c.id !== id),
                        connections: p.connections.filter(
                            conn => conn.sourceId !== id && conn.targetId !== id
                        )
                    } : p
                ),
                // Also remove from staging if it was there
                stagingComponents: state.stagingComponents.filter(c => c.id !== id),
                placedStagingComponentIds: nextPlaced
            };
        });

        // PHASE 2.1: Propagate deletion to SLD store
        if (linkedSldItemId) {
            // Import dynamically to avoid circular dependency
            import('../store/useStore').then(({ useStore }) => {
                const st = useStore.getState();
                const exists = st.sheets.some(s => s.canvasItems.some(i => i.uniqueID === linkedSldItemId));
                if (!exists) return;

                st.deleteItem(linkedSldItemId);
                console.log('[Layout→SLD] Deleted linked SLD item:', linkedSldItemId);
            });
        }

        // Always clean SLD staging of any stale items after Layout deletion
        import('../store/useStore').then(({ useStore }) => {
            useStore.getState().cleanStaleStagingItems();
        });
    },

    // Connection actions
    addConnection: (connection) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newConnection: LayoutConnection = {
                ...connection,
                id: generateLayoutId('conn')
            };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        connections: [...p.connections, newConnection]
                    } : p
                )
            };
        });
    },

    updateConnection: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        connections: p.connections.map(c =>
                            c.id === id ? { ...c, ...updates } : c
                        )
                    } : p
                )
            };
        });
    },

    removeConnection: (id) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        connections: p.connections.filter(c => c.id !== id)
                    } : p
                )
            };
        });
    },

    // Selection
    selectElement: (id, multi = false) => set((state) => {
        if (multi) {
            const alreadySelected = state.selectedElementIds.includes(id);
            return {
                selectedElementIds: alreadySelected
                    ? state.selectedElementIds.filter(eid => eid !== id)
                    : [...state.selectedElementIds, id]
            };
        }
        return { selectedElementIds: [id] };
    }),

    // Replace or extend the selection with a set of ids. Used by rubber-band
    // box selection, where the whole set is known at once.
    selectElements: (ids, additive = false) => set((state) => {
        if (!additive) return { selectedElementIds: [...new Set(ids)] };
        return { selectedElementIds: [...new Set([...state.selectedElementIds, ...ids])] };
    }),

    // Ctrl+A — select every editable element on the active floor plan.
    selectAll: () => set((state) => {
        const fp = findCurrentPlan(state.floorPlans, state.activeFloorPlanId);
        if (!fp) return {};

        return {
            selectedElementIds: [
                ...fp.walls.map(w => w.id),
                ...fp.rooms.map(r => r.id),
                ...fp.doors.map(d => d.id),
                ...fp.windows.map(w => w.id),
                ...fp.components.map(c => c.id),
                ...(fp.textItems || []).map(t => t.id)
            ]
        };
    }),

    clearSelection: () => set({ selectedElementIds: [] }),

    deleteSelected: () => {
        const { selectedElementIds, activeFloorPlanId } = get();
        if (selectedElementIds.length === 0) return;

        const sldIdsToDelete = new Set<string>();
        try {
            const fp = findCurrentPlan(get().floorPlans, activeFloorPlanId);
            if (fp) {
                for (const comp of fp.components) {
                    if (selectedElementIds.includes(comp.id) && comp.sldItemId) {
                        sldIdsToDelete.add(comp.sldItemId);
                    }
                }
            }
        } catch {
        }

        get().takeSnapshot();
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeFloorPlanId);
            if (!fp) return {};

            const idsToDelete = new Set(selectedElementIds);

            const nextPlaced = new Set(state.placedStagingComponentIds);
            idsToDelete.forEach(id => nextPlaced.delete(id));

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        walls: p.walls.filter(w => !idsToDelete.has(w.id)),
                        rooms: p.rooms.filter(r => !idsToDelete.has(r.id)),
                        doors: p.doors.filter(d => !idsToDelete.has(d.id)),
                        windows: p.windows.filter(w => !idsToDelete.has(w.id)),
                        stairs: p.stairs.filter(s => !idsToDelete.has(s.id)),
                        components: p.components.filter(c => !idsToDelete.has(c.id)),
                        textItems: (p.textItems || []).filter(t => !idsToDelete.has(t.id)),
                        connections: p.connections.filter(c =>
                            !idsToDelete.has(c.id) &&
                            !idsToDelete.has(c.sourceId) &&
                            !idsToDelete.has(c.targetId)
                        )
                    } : p
                ),
                selectedElementIds: [],
                placedStagingComponentIds: nextPlaced
            };
        });

        if (sldIdsToDelete.size > 0) {
            import('../store/useStore').then(({ useStore }) => {
                const st = useStore.getState();
                for (const sid of sldIdsToDelete) {
                    const exists = st.sheets.some(s => s.canvasItems.some(i => i.uniqueID === sid));
                    if (!exists) continue;
                    st.deleteItem(sid);
                }
                // Clean stale staging items after bulk deletion
                st.cleanStaleStagingItems();
            });
        } else {
            // Even without linked items, clean any stale staging
            import('../store/useStore').then(({ useStore }) => {
                useStore.getState().cleanStaleStagingItems();
            });
        }
    },

    // Move every selected element by a delta. Arrow-key nudging needs this to
    // work across mixed selections (walls move both endpoints, doors/windows
    // move their centre, rooms move every polygon vertex).
    nudgeSelection: (dx, dy) => {
        const { selectedElementIds, activeFloorPlanId } = get();
        if (selectedElementIds.length === 0 || (dx === 0 && dy === 0)) return;

        get().takeSnapshot();
        const ids = new Set(selectedElementIds);
        const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy });

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeFloorPlanId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p => p.id !== fp.id ? p : {
                    ...p,
                    walls: p.walls.map(w => ids.has(w.id)
                        ? { ...w, startPoint: shift(w.startPoint), endPoint: shift(w.endPoint) }
                        : w),
                    rooms: p.rooms.map(r => ids.has(r.id)
                        ? { ...r, polygon: r.polygon.map(shift) }
                        : r),
                    doors: p.doors.map(d => ids.has(d.id)
                        ? { ...d, position: shift(d.position) }
                        : d),
                    windows: p.windows.map(w => ids.has(w.id)
                        ? { ...w, position: shift(w.position) }
                        : w),
                    components: p.components.map(c => ids.has(c.id)
                        ? { ...c, position: shift(c.position) }
                        : c),
                    textItems: (p.textItems || []).map(t => ids.has(t.id)
                        ? { ...t, position: shift(t.position) }
                        : t)
                })
            };
        });
    },

    // Ctrl+D — copy the selection in place with a small offset and select the
    // copies, so repeated presses walk across the canvas.
    duplicateSelection: () => {
        const { selectedElementIds, activeFloorPlanId, floorPlans } = get();
        const source = findCurrentPlan(floorPlans, activeFloorPlanId);
        if (!source || selectedElementIds.length === 0) return;

        const ids = new Set(selectedElementIds);
        const offset = 20;
        const shift = (p: Point) => ({ x: p.x + offset, y: p.y + offset });

        const newComponents = source.components
            .filter(c => ids.has(c.id))
            .map(c => ({
                ...c,
                id: generateLayoutId('comp'),
                position: shift(c.position),
                // Clearing the link avoids two Layout components claiming the
                // same SLD item, which would corrupt the bi-directional sync.
                sldItemId: undefined
            }));

        const newWalls = source.walls
            .filter(w => ids.has(w.id))
            .map(w => ({
                ...w,
                id: generateLayoutId('wall'),
                startPoint: shift(w.startPoint),
                endPoint: shift(w.endPoint)
            }));

        const newTextItems = (source.textItems || [])
            .filter(t => ids.has(t.id))
            .map(t => ({
                ...t,
                id: generateLayoutId('text'),
                position: shift(t.position)
            }));

        if (newComponents.length === 0 && newWalls.length === 0 && newTextItems.length === 0) return;

        get().takeSnapshot();

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeFloorPlanId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p => p.id !== fp.id ? p : {
                    ...p,
                    components: [...p.components, ...newComponents],
                    walls: [...p.walls, ...newWalls],
                    textItems: [...(p.textItems || []), ...newTextItems]
                }),
                selectedElementIds: [
                    ...newComponents.map(c => c.id),
                    ...newWalls.map(w => w.id),
                    ...newTextItems.map(t => t.id)
                ]
            };
        });
    },

    updateTextItem: (id, updates) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p => p.id !== fp.id ? p : {
                    ...p,
                    textItems: (p.textItems || []).map(t => t.id === id ? { ...t, ...updates } : t)
                })
            };
        });
    },

    addTextItem: (item) => {
        get().takeSnapshot();
        const newId = generateLayoutId('text');
        const activeId = get().activeFloorPlanId;

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            const newTextItem: LayoutTextItem = { ...item, id: newId };
            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, textItems: [...(p.textItems || []), newTextItem] } : p
                )
            };
        });

        return newId;
    },

    removeTextItem: (id) => {
        get().takeSnapshot();
        const activeId = get().activeFloorPlanId;

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? { ...p, textItems: (p.textItems || []).filter(t => t.id !== id) } : p
                )
            };
        });
    },

    // Rotate all selected components by a relative amount. Only components have
    // a free rotation; doors and windows derive theirs from the host wall.
    rotateSelection: (degrees) => {
        const { selectedElementIds, activeFloorPlanId } = get();
        if (selectedElementIds.length === 0) return;

        const ids = new Set(selectedElementIds);
        get().takeSnapshot();

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeFloorPlanId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p => p.id !== fp.id ? p : {
                    ...p,
                    components: p.components.map(c => ids.has(c.id)
                        ? { ...c, rotation: (((c.rotation || 0) + degrees) % 360 + 360) % 360 }
                        : c),
                    textItems: (p.textItems || []).map(t => ids.has(t.id)
                        ? { ...t, rotation: (((t.rotation || 0) + degrees) % 360 + 360) % 360 }
                        : t)
                })
            };
        });
    },

    // Viewport
    updateViewport: (x, y, scale) => {
        const activeId = get().activeFloorPlanId;
        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeId);
            if (!fp) return {};

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        viewportX: x,
                        viewportY: y,
                        scale
                    } : p
                )
            };
        });
    },

    // Clipboard
    clipboard: { components: [], walls: [] },

    copySelection: () => {
        const { selectedElementIds, activeFloorPlanId, floorPlans } = get();
        const fp = findCurrentPlan(floorPlans, activeFloorPlanId);
        if (!fp || selectedElementIds.length === 0) return;

        const components = fp.components.filter(c => selectedElementIds.includes(c.id));
        const walls = fp.walls.filter(w => selectedElementIds.includes(w.id));

        set({ clipboard: { components, walls } });
    },

    pasteSelection: () => {
        const { clipboard, activeFloorPlanId, floorPlans } = get();
        if (clipboard.components.length === 0 && clipboard.walls.length === 0) return;

        get().takeSnapshot();
        const offset = 20;

        set((state) => {
            const fp = findCurrentPlan(state.floorPlans, activeFloorPlanId);
            if (!fp) return {};

            const newComponents = clipboard.components.map(c => ({
                ...c,
                id: generateLayoutId('comp'),
                position: { x: c.position.x + offset, y: c.position.y + offset },
                sldItemId: undefined // Clear link on copy to avoid duplicate sync issues
            }));

            const newIds = newComponents.map(c => c.id);

            return {
                floorPlans: state.floorPlans.map(p =>
                    p.id === fp.id ? {
                        ...p,
                        components: [...p.components, ...newComponents]
                    } : p
                ),
                selectedElementIds: newIds
            };
        });
    },

    // Undo/Redo
    takeSnapshot: () => set((state) => ({
        undoStack: [...state.undoStack, deepClone({
            floorPlans: state.floorPlans,
            stagingComponents: state.stagingComponents,
            placedStagingComponentIds: Array.from(state.placedStagingComponentIds)
        })].slice(-MAX_HISTORY),
        redoStack: []
    })),

    undo: () => set((state) => {
        if (state.undoStack.length === 0) return {};

        const previous = state.undoStack[state.undoStack.length - 1];
        const newUndoStack = state.undoStack.slice(0, -1);

        const viewportByPlanId = new Map(previous.floorPlans.map(p => [p.id, { viewportX: p.viewportX, viewportY: p.viewportY, scale: p.scale }]));
        // Preserve current viewport values (view state should not change on undo)
        for (const plan of state.floorPlans) {
            viewportByPlanId.set(plan.id, { viewportX: plan.viewportX, viewportY: plan.viewportY, scale: plan.scale });
        }

        const floorPlansWithViewport = previous.floorPlans.map(p => {
            const v = viewportByPlanId.get(p.id);
            return v ? { ...p, ...v } : p;
        });

        const nextActiveId = floorPlansWithViewport.some(p => p.id === state.activeFloorPlanId)
            ? state.activeFloorPlanId
            : (floorPlansWithViewport[0]?.id ?? null);

        return {
            floorPlans: floorPlansWithViewport,
            activeFloorPlanId: nextActiveId,
            undoStack: newUndoStack,
            redoStack: [...state.redoStack, deepClone({
                floorPlans: state.floorPlans,
                stagingComponents: state.stagingComponents,
                placedStagingComponentIds: Array.from(state.placedStagingComponentIds)
            })],
            selectedElementIds: [],
            stagingComponents: previous.stagingComponents ?? state.stagingComponents,
            placedStagingComponentIds: new Set(previous.placedStagingComponentIds ?? Array.from(state.placedStagingComponentIds))
        };
    }),

    redo: () => set((state) => {
        if (state.redoStack.length === 0) return {};

        const next = state.redoStack[state.redoStack.length - 1];
        const newRedoStack = state.redoStack.slice(0, -1);

        const viewportByPlanId = new Map(next.floorPlans.map(p => [p.id, { viewportX: p.viewportX, viewportY: p.viewportY, scale: p.scale }]));
        // Preserve current viewport values (view state should not change on redo)
        for (const plan of state.floorPlans) {
            viewportByPlanId.set(plan.id, { viewportX: plan.viewportX, viewportY: plan.viewportY, scale: plan.scale });
        }

        const floorPlansWithViewport = next.floorPlans.map(p => {
            const v = viewportByPlanId.get(p.id);
            return v ? { ...p, ...v } : p;
        });

        const nextActiveId = floorPlansWithViewport.some(p => p.id === state.activeFloorPlanId)
            ? state.activeFloorPlanId
            : (floorPlansWithViewport[0]?.id ?? null);

        return {
            floorPlans: floorPlansWithViewport,
            activeFloorPlanId: nextActiveId,
            undoStack: [...state.undoStack, deepClone({
                floorPlans: state.floorPlans,
                stagingComponents: state.stagingComponents,
                placedStagingComponentIds: Array.from(state.placedStagingComponentIds)
            })],
            redoStack: newRedoStack,
            selectedElementIds: [],
            stagingComponents: next.stagingComponents ?? state.stagingComponents,
            placedStagingComponentIds: new Set(next.placedStagingComponentIds ?? Array.from(state.placedStagingComponentIds))
        };
    }),

    // =========================================================================
    // Local Project Import — bulk replace all layout state
    // =========================================================================
    loadProject: (floorPlans, activeFloorPlanId, stagingComponents, placedIds) => set({
        floorPlans,
        activeFloorPlanId: activeFloorPlanId || (floorPlans[0]?.id ?? null),
        stagingComponents,
        placedStagingComponentIds: new Set(placedIds),
        undoStack: [],
        redoStack: [],
        selectedElementIds: [],
        drawingState: createDefaultDrawingState(),
    })
}));
