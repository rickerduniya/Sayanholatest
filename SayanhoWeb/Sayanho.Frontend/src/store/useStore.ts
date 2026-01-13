import { create } from 'zustand';
import { CanvasSheet, CanvasItem, Connector, CanvasSheetState } from '../types';
import { NetworkAnalyzer } from '../utils/NetworkAnalyzer';
import { getItemDefinition } from '../utils/DefaultRulesEngine';
import { LOAD_ITEM_DEFAULTS } from '../utils/DefaultRulesEngine';
import { ConnectorUtils } from '../utils/ConnectorUtils';
import { useLayoutStore } from './useLayoutStore';

interface StoreState {
    sheets: CanvasSheet[];
    activeSheetId: string | null;

    selectedItemIds: string[]; // Changed from selectedItemId
    selectedConnectorIndices: number[];
    editMode: boolean;
    isPropertiesPanelOpen: boolean;
    isChatOpen: boolean;

    // Staging Items (for Layout -> SLD sync)
    stagingItems: CanvasItem[];
    placedStagingIds: Set<string>;  // Track placed staging items to prevent duplicate placement
    setStagingItems: (items: CanvasItem[]) => void;
    removeStagingItem: (id: string) => void;
    markStagingItemPlaced: (id: string) => void;  // Mark a staging item as placed
    isStagingItemPlaced: (id: string) => boolean;  // Check if staging item was already placed

    // Sheet Actions
    setSheets: (sheets: CanvasSheet[]) => void;
    addSheet: (name?: string) => void;
    removeSheet: (id: string) => void;
    setActiveSheet: (id: string) => void;
    renameSheet: (id: string, name: string) => void;

    // Undo/Redo Actions
    undo: () => void;
    redo: () => void;
    takeSnapshot: () => void;

    // Item Actions (operate on active sheet)
    setSheet: (sheet: CanvasSheet) => void; // Legacy/Compatibility
    updateSheet: (updates: Partial<CanvasSheet>, options?: { recalcNetwork?: boolean }) => void;
    addItem: (item: CanvasItem) => void;
    updateItemPosition: (id: string, x: number, y: number) => void;
    moveItems: (updates: { id: string, x: number, y: number }[]) => void; // New: Batch move
    updateItemSize: (id: string, width: number, height: number) => void;
    updateItemLock: (id: string, locked: boolean) => void;
    updateItemProperties: (id: string, properties: Record<string, string>) => void; // New: Update item properties
    updateItemTransform: (id: string, x: number, y: number, width: number, height: number, rotation: number) => void; // New: Update transform
    deleteItem: (id: string) => void; // Keeps single delete for compatibility/specific delete
    deleteSelected: () => void; // New: Delete all selected
    duplicateItem: (id: string) => void;
    selectItem: (id: string | null, multi?: boolean, openPanel?: boolean) => void; // Updated signature
    selectAll: () => void;
    clearSelection: () => void;

    addConnector: (connector: Connector) => void;
    selectConnector: (indexOrIndices: number | number[] | null, openPanel?: boolean) => void;
    setEditMode: (mode: boolean) => void;
    toggleChat: () => void;

    // Helper to get current sheet
    getCurrentSheet: () => CanvasSheet | undefined;

    // Clipboard State
    copiedItems: CanvasItem[] | null; // Changed from copiedItem
    copiedConnectors: Connector[] | null; // New: Store internal connectors
    copiedConnectorProperties: Record<string, string> | null;
    copiedAlternativeCompany1: string;
    copiedAlternativeCompany2: string;
    copiedMaterialType: string;

    // Clipboard Actions
    copySelection: () => void; // New: Copy all selected
    pasteSelection: (position?: { x: number, y: number }) => void; // New: Paste all copied
    copyConnectorProperties: (index: number) => void;
    pasteConnectorProperties: (index: number) => void;

    // Transformation Actions
    rotateItem: (id: string, direction?: 'clockwise' | 'counter-clockwise') => void;
    flipItemVertically: (id: string) => void;
    flipItemHorizontally: (id: string) => void;

    // Connector Actions
    updateConnector: (index: number, updates: Partial<Connector>) => void;

    // Network Analysis
    calculateNetwork: () => void;

    // Settings
    showCurrentValues: boolean;
    toggleShowCurrentValues: () => void;
    settings: {
        maxVoltageDropPercentage: number;
        safetyMarginPercentage: number;
        voltageDropEnabled: boolean;
    };
    updateSettings: (settings: Partial<{
        maxVoltageDropPercentage: number;
        safetyMarginPercentage: number;
        voltageDropEnabled: boolean;
    }>) => void;

    // Portal/Nets
    isNetLabelUnique: (label: string) => boolean;
    getPortalsByNetId: (netId: string) => CanvasItem[];
    countConnectorsForItem: (sheetId: string, itemId: string) => number;
    createPortal: (
        direction: 'in' | 'out',
        position: { x: number; y: number }
    ) => void;
    createPairedPortal: (
        netId: string,
        direction: 'in' | 'out',
        targetSheetId: string,
        position?: { x: number; y: number }
    ) => void;

    // Auto Rating
    applyAutoRatingResults: (sheets: CanvasSheet[]) => void;
}

const MAX_HISTORY = 20;

const deepClone = <T,>(v: T): T => {
    if (typeof structuredClone === 'function') return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
};
const NETWORK_DEBOUNCE_MS = 150;

export const useStore = create<StoreState>((set, get) => ({
    sheets: [{
        sheetId: 'default',
        name: 'Sheet 1',
        canvasItems: [],
        storedConnectors: [],
        existingLinePoints: [],
        existingConnections: [],
        scale: 0.65,
        viewportX: 0,
        viewportY: 0,
        undoStack: [],
        redoStack: []
    }],
    activeSheetId: 'default',
    selectedItemIds: [],
    selectedConnectorIndices: [],
    editMode: false,
    isPropertiesPanelOpen: false,
    isChatOpen: false,

    // Staging Items
    stagingItems: [],
    placedStagingIds: new Set<string>(),
    setStagingItems: (items) => set((state) => {
        const placedIds = new Set(state.sheets.flatMap(s => s.canvasItems).map(i => i.uniqueID));
        return { stagingItems: items.filter(i => !placedIds.has(i.uniqueID)) };
    }),
    removeStagingItem: (id) => set((state) => ({
        stagingItems: state.stagingItems.filter(i => i.uniqueID !== id)
    })),
    markStagingItemPlaced: (id) => set((state) => {
        const newSet = new Set(state.placedStagingIds);
        newSet.add(id);
        return { placedStagingIds: newSet };
    }),
    isStagingItemPlaced: (id) => get().placedStagingIds.has(id) || get().sheets.some(s => s.canvasItems.some(i => i.uniqueID === id)),

    settings: {
        maxVoltageDropPercentage: 7.0,
        safetyMarginPercentage: 25.0,
        voltageDropEnabled: true
    },

    updateSettings: (newSettings) => set((state) => ({
        settings: { ...state.settings, ...newSettings }
    })),

    copiedItems: null,
    copiedConnectors: null,
    copiedConnectorProperties: null,
    copiedAlternativeCompany1: '',
    copiedAlternativeCompany2: '',
    copiedMaterialType: '',

    getCurrentSheet: () => {
        const { sheets, activeSheetId } = get();
        return sheets.find(s => s.sheetId === activeSheetId);
    },

    setSheets: (sheets) => {
        if (sheets.length === 0) return;

        const initializedSheets = sheets.map(s => {
            // Reconstruct connector references from IDs if needed
            const validConnectors = (s.storedConnectors || []).map((c: any) => {
                // If sourceItem is missing or is just an ID (from some serializations), try to fix
                if (!c.sourceItem || !c.sourceItem.uniqueID) {
                    const sId = c.sourceItemId || (c.sourceItem as any); // Handle potential ID only
                    const tId = c.targetItemId || (c.targetItem as any);

                    const sourceItem = s.canvasItems.find(i => i.uniqueID === sId);
                    const targetItem = s.canvasItems.find(i => i.uniqueID === tId);

                    if (sourceItem && targetItem) {
                        return { ...c, sourceItem, targetItem };
                    }
                    console.warn(`[Load] Dropping connector with missing items: ${sId} -> ${tId}`);
                    return null;
                }
                // Ensure sourceItem/targetItem are references to the actual objects in canvasItems
                // This ensures object identity equality which is important for some comparisons
                const sourceItem = s.canvasItems.find(i => i.uniqueID === c.sourceItem.uniqueID) || c.sourceItem;
                const targetItem = s.canvasItems.find(i => i.uniqueID === c.targetItem.uniqueID) || c.targetItem;
                return { ...c, sourceItem, targetItem };
            }).filter(c => c !== null) as Connector[];

            return {
                ...s,
                storedConnectors: validConnectors,
                viewportX: (s as any).viewportX || 0,
                viewportY: (s as any).viewportY || 0,
                undoStack: s.undoStack || [],
                redoStack: s.redoStack || []
            };
        });

        set({
            sheets: initializedSheets,
            activeSheetId: initializedSheets[0].sheetId,
            selectedItemIds: [],
            selectedConnectorIndices: []
        });
    },

    addSheet: (name) => set((state) => {
        const newId = crypto.randomUUID();
        const newSheet: CanvasSheet = {
            sheetId: newId,
            name: name || `Sheet ${state.sheets.length + 1}`,
            canvasItems: [],
            storedConnectors: [],
            existingLinePoints: [],
            existingConnections: [],
            scale: 0.65,
            viewportX: 0,
            viewportY: 0,
            undoStack: [],
            redoStack: []
        };
        return {
            sheets: [...state.sheets, newSheet],
            activeSheetId: newId,
            selectedItemIds: [],
            selectedConnectorIndices: []
        };
    }),

    removeSheet: (id) => set((state) => {
        if (state.sheets.length <= 1) {
            alert("Cannot delete the last sheet.");
            return {};
        }

        const newSheets = state.sheets.filter(s => s.sheetId !== id);
        let newActiveId = state.activeSheetId;
        if (state.activeSheetId === id) {
            newActiveId = newSheets[0].sheetId;
        }

        return {
            sheets: newSheets,
            activeSheetId: newActiveId,
            selectedItemIds: [],
            selectedConnectorIndices: []
        };
    }),

    setActiveSheet: (id) => set({
        activeSheetId: id,
        selectedItemIds: [],
        selectedConnectorIndices: []
    }),

    renameSheet: (id, name) => set((state) => ({
        sheets: state.sheets.map(s => s.sheetId === id ? { ...s, name } : s)
    })),

    // --- Undo/Redo Logic ---

    takeSnapshot: () => set((state) => {
        const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
        if (!activeSheet) return {};

        const snapshot: CanvasSheetState = deepClone({
            canvasItems: activeSheet.canvasItems,
            storedConnectors: activeSheet.storedConnectors,
            existingLinePoints: activeSheet.existingLinePoints,
            existingConnections: activeSheet.existingConnections,
            scale: activeSheet.scale,
            stagingItems: state.stagingItems,
            placedStagingIds: Array.from(state.placedStagingIds)
        });

        const newUndoStack = [...activeSheet.undoStack, snapshot].slice(-MAX_HISTORY);

        return {
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                undoStack: newUndoStack,
                redoStack: []
            } : s)
        };
    }),

    undo: () => set((state) => {
        const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
        if (!activeSheet || activeSheet.undoStack.length === 0) return {};

        const currentSnapshot: CanvasSheetState = deepClone({
            canvasItems: activeSheet.canvasItems,
            storedConnectors: activeSheet.storedConnectors,
            existingLinePoints: activeSheet.existingLinePoints,
            existingConnections: activeSheet.existingConnections,
            scale: activeSheet.scale,
            stagingItems: state.stagingItems,
            placedStagingIds: Array.from(state.placedStagingIds)
        });

        const previousSnapshot = activeSheet.undoStack[activeSheet.undoStack.length - 1];
        const { stagingItems: prevStagingItems, placedStagingIds: prevPlaced, ...previousSheetSnapshot } = previousSnapshot as CanvasSheetState;
        const newUndoStack = activeSheet.undoStack.slice(0, -1);
        const newRedoStack = [...activeSheet.redoStack, currentSnapshot];

        // Preserve current view state (viewport/zoom) across undo
        const keepScale = activeSheet.scale;
        const keepViewportX = activeSheet.viewportX;
        const keepViewportY = activeSheet.viewportY;

        return {
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                ...previousSheetSnapshot,
                scale: keepScale,
                viewportX: keepViewportX,
                viewportY: keepViewportY,
                undoStack: newUndoStack,
                redoStack: newRedoStack
            } : s),
            selectedItemIds: [],
            selectedConnectorIndices: [],
            stagingItems: prevStagingItems ?? state.stagingItems,
            placedStagingIds: new Set(prevPlaced ?? Array.from(state.placedStagingIds))
        };
    }),

    redo: () => set((state) => {
        const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
        if (!activeSheet || activeSheet.redoStack.length === 0) return {};

        const currentSnapshot: CanvasSheetState = deepClone({
            canvasItems: activeSheet.canvasItems,
            storedConnectors: activeSheet.storedConnectors,
            existingLinePoints: activeSheet.existingLinePoints,
            existingConnections: activeSheet.existingConnections,
            scale: activeSheet.scale,
            stagingItems: state.stagingItems,
            placedStagingIds: Array.from(state.placedStagingIds)
        });

        const nextSnapshot = activeSheet.redoStack[activeSheet.redoStack.length - 1];
        const { stagingItems: nextStagingItems, placedStagingIds: nextPlaced, ...nextSheetSnapshot } = nextSnapshot as CanvasSheetState;
        const newRedoStack = activeSheet.redoStack.slice(0, -1);
        const newUndoStack = [...activeSheet.undoStack, currentSnapshot];

        // Preserve current view state (viewport/zoom) across redo
        const keepScale = activeSheet.scale;
        const keepViewportX = activeSheet.viewportX;
        const keepViewportY = activeSheet.viewportY;

        return {
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                ...nextSheetSnapshot,
                scale: keepScale,
                viewportX: keepViewportX,
                viewportY: keepViewportY,
                undoStack: newUndoStack,
                redoStack: newRedoStack
            } : s),
            selectedItemIds: [],
            selectedConnectorIndices: [],
            stagingItems: nextStagingItems ?? state.stagingItems,
            placedStagingIds: new Set(nextPlaced ?? Array.from(state.placedStagingIds))
        };
    }),

    // --- Item Actions ---

    setSheet: (sheet) => set((state) => ({
        sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? sheet : s)
    })),

    updateSheet: (updates, options) => {
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? { ...s, ...updates } : s)
        }));
        if (options?.recalcNetwork !== false) {
            get().calculateNetwork();
        }
    },

    addItem: (item) => {
        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: [...s.canvasItems, item]
            } : s)
        }));
        get().calculateNetwork();
    },

    updateItemPosition: (id, x, y) => {
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item =>
                    item.uniqueID === id ? { ...item, position: { x, y } } : item
                )
            } : s)
        }));
    },

    moveItems: (updates) => {
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item => {
                    const update = updates.find(u => u.id === item.uniqueID);
                    return update ? { ...item, position: { x: update.x, y: update.y } } : item;
                })
            } : s)
        }));
    },

    updateItemSize: (id, width, height) => {
        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item =>
                    item.uniqueID === id ? { ...item, size: { width, height } } : item
                )
            } : s)
        }));
    },

    updateItemLock: (id, locked) => {
        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item =>
                    item.uniqueID === id ? { ...item, locked } : item
                )
            } : s)
        }));
    },

    updateItemProperties: (id, properties) => {
        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item => {
                    if (item.uniqueID === id) {
                        // Merge with existing properties[0] or create new
                        const currentProps = item.properties[0] || {};
                        const newProps = { ...currentProps, ...properties };
                        return { ...item, properties: [newProps] };
                    }
                    return item;
                })
            } : s)
        }));
    },

    updateItemTransform: (id, x, y, width, height, rotation) => {
        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item =>
                    item.uniqueID === id ? { ...item, position: { x, y }, size: { width, height }, rotation } : item
                )
            } : s)
        }));
    },

    deleteItem: (id) => {
        get().takeSnapshot();

        // PHASE 2.2: Get the item to find its linked Layout component before deletion
        let linkedLayoutId: string | undefined;
        for (const s of get().sheets) {
            const item = s.canvasItems.find(i => i.uniqueID === id);
            if (item) {
                linkedLayoutId = item.properties?.[0]?.['_layoutComponentId'];
                break;
            }
        }

        set((state) => {
            // Build a deletion set, cascading if an 'out' portal is deleted
            const deletionIds = new Set<string>([id]);

            // Identify if the item is an OUT portal; if so, find counterpart and add to deletion set
            for (const s of state.sheets) {
                const item = s.canvasItems.find(i => i.uniqueID === id);
                if (item && item.name === 'Portal') {
                    const meta = (item.properties?.[0] || {}) as Record<string, string>;
                    const dir = (meta['Direction'] || meta['direction'] || '').toLowerCase();
                    const netId = (meta['NetId'] || meta['netId'] || '').trim();
                    if (dir === 'out' && netId) {
                        for (const sh of state.sheets) {
                            const counterpart = sh.canvasItems.find(ci => ci.name === 'Portal' && ci.uniqueID !== item.uniqueID && ((ci.properties?.[0] || {}) as Record<string, string>) && (((ci.properties?.[0] || {}) as Record<string, string>)['NetId'] || ((ci.properties?.[0] || {}) as Record<string, string>)['netId']) === netId);
                            if (counterpart) deletionIds.add(counterpart.uniqueID);
                        }
                    }
                    break;
                }
            }

            // Apply deletions across ALL sheets (items and connectors)
            const newSheets = state.sheets.map(s => {
                const filteredItems = s.canvasItems.filter(item => !deletionIds.has(item.uniqueID));
                const filteredConnectors = s.storedConnectors.filter(c => !deletionIds.has(c.sourceItem.uniqueID) && !deletionIds.has(c.targetItem.uniqueID));
                return { ...s, canvasItems: filteredItems, storedConnectors: filteredConnectors };
            });

            // Clear placed staging flags for deleted items so they can be re-placed after re-sync
            const newPlaced = new Set(state.placedStagingIds);
            deletionIds.forEach(did => newPlaced.delete(did));

            const remainingSelection = state.selectedItemIds.filter(sid => !deletionIds.has(sid));
            return {
                sheets: newSheets,
                selectedItemIds: remainingSelection,
                isPropertiesPanelOpen: remainingSelection.length > 0 && state.isPropertiesPanelOpen,
                // Also remove from staging
                stagingItems: state.stagingItems.filter(item => !deletionIds.has(item.uniqueID)),
                placedStagingIds: newPlaced
            };
        });
        get().calculateNetwork();

        // PHASE 2.2: Propagate deletion to Layout store
        if (linkedLayoutId) {
            // Import dynamically to avoid circular dependency
            import('./useLayoutStore').then(({ useLayoutStore }) => {
                // Check across all floor plans (component might not be on the active plan)
                const st = useLayoutStore.getState();
                const exists = st.floorPlans.some(p => p.components.some(c => c.id === linkedLayoutId));
                if (!exists) return;

                st.removeComponent(linkedLayoutId);
                console.log('[SLD→Layout] Deleted linked Layout component:', linkedLayoutId);
            });
        }
    },

    deleteSelected: () => {
        const { selectedItemIds, selectedConnectorIndices } = get();

        // Handle connector deletion if no items selected but connectors are
        if (selectedItemIds.length === 0 && selectedConnectorIndices.length > 0) {
            get().takeSnapshot();
            set((state) => {
                const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
                if (!activeSheet) return {};

                // Filter out connectors at selected indices
                const indicesToDelete = new Set(selectedConnectorIndices);
                const filteredConnectors = activeSheet.storedConnectors.filter((_, idx) => !indicesToDelete.has(idx));

                return {
                    sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                        ...s,
                        storedConnectors: filteredConnectors
                    } : s),
                    selectedConnectorIndices: [],
                    isPropertiesPanelOpen: false
                };
            });
            get().calculateNetwork();
            return;
        }

        if (selectedItemIds.length === 0) return;

        const layoutIdsToDelete = new Set<string>();

        get().takeSnapshot();
        set((state) => {
            // Expand selection with counterparts for any OUT portals
            const idsToDelete = new Set<string>(selectedItemIds);
            for (const s of state.sheets) {
                s.canvasItems.forEach(item => {
                    if (idsToDelete.has(item.uniqueID) && item.name === 'Portal') {
                        const meta = (item.properties?.[0] || {}) as Record<string, string>;
                        const dir = (meta['Direction'] || meta['direction'] || '').toLowerCase();
                        const netId = (meta['NetId'] || meta['netId'] || '').trim();
                        if (dir === 'out' && netId) {
                            for (const sh of state.sheets) {
                                const counterpart = sh.canvasItems.find(ci => ci.name === 'Portal' && ci.uniqueID !== item.uniqueID && ((ci.properties?.[0] || {}) as Record<string, string>) && (((ci.properties?.[0] || {}) as Record<string, string>)['NetId'] || ((ci.properties?.[0] || {}) as Record<string, string>)['netId']) === netId);
                                if (counterpart) idsToDelete.add(counterpart.uniqueID);
                            }
                        }
                    }
                });
            }

            // Remove across ALL sheets
            const newSheets = state.sheets.map(s => {
                const filteredItems = s.canvasItems.filter(item => !idsToDelete.has(item.uniqueID));
                const filteredConnectors = s.storedConnectors.filter(c => !idsToDelete.has(c.sourceItem.uniqueID) && !idsToDelete.has(c.targetItem.uniqueID));
                return { ...s, canvasItems: filteredItems, storedConnectors: filteredConnectors };
            });

            // Collect linked Layout IDs for propagation
            for (const sh of state.sheets) {
                for (const item of sh.canvasItems) {
                    if (!idsToDelete.has(item.uniqueID)) continue;
                    const lid = item.properties?.[0]?.['_layoutComponentId'];
                    if (lid) layoutIdsToDelete.add(lid);
                }
            }

            const newPlaced = new Set(state.placedStagingIds);
            idsToDelete.forEach(did => newPlaced.delete(did));

            return {
                sheets: newSheets,
                selectedItemIds: [],
                isPropertiesPanelOpen: false,
                placedStagingIds: newPlaced
            };
        });
        get().calculateNetwork();

        if (layoutIdsToDelete.size > 0) {
            import('./useLayoutStore').then(({ useLayoutStore }) => {
                const st = useLayoutStore.getState();
                for (const lid of layoutIdsToDelete) {
                    const exists = st.floorPlans.some(p => p.components.some(c => c.id === lid));
                    if (!exists) continue;
                    st.removeComponent(lid);
                }
            });
        }
    },

    duplicateItem: (id) => {
        get().takeSnapshot();
        set((state) => {
            const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
            if (!activeSheet) return {};

            const item = activeSheet.canvasItems.find(i => i.uniqueID === id);
            if (!item) return {};

            // PHASE 1.2: Deep copy properties and regenerate _layoutComponentId
            // This prevents two SLD items from pointing to the same Layout component (mapping ambiguity)
            const newProperties = item.properties ? item.properties.map(prop => {
                const copied = { ...prop };
                // Regenerate canonical Layout ID for the duplicate
                if (copied['_layoutComponentId']) {
                    copied['_layoutComponentId'] = `comp_${crypto.randomUUID()}`;
                    console.log('[useStore] Regenerated _layoutComponentId for duplicate:', copied['_layoutComponentId']);
                }
                return copied;
            }) : [];

            const newItem = {
                ...item,
                uniqueID: crypto.randomUUID(),
                position: { x: item.position.x + 20, y: item.position.y + 20 },
                properties: newProperties
            };

            return {
                sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                    ...s,
                    canvasItems: [...s.canvasItems, newItem]
                } : s)
            };
        });
        get().calculateNetwork();
    },

    selectItem: (id, multi = false, openPanel = true) => set((state) => {
        if (id === null) {
            return { selectedItemIds: [], isPropertiesPanelOpen: false };
        }
        if (multi) {
            // Toggle selection
            const alreadySelected = state.selectedItemIds.includes(id);
            return {
                selectedItemIds: alreadySelected
                    ? state.selectedItemIds.filter(sid => sid !== id)
                    : [...state.selectedItemIds, id],
                isPropertiesPanelOpen: false // Always close panel on multi-select
            };
        }
        return { selectedItemIds: [id], isPropertiesPanelOpen: openPanel };
    }),

    selectAll: () => set((state) => {
        const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
        if (!activeSheet) return {};
        return { selectedItemIds: activeSheet.canvasItems.map(i => i.uniqueID) };
    }),

    clearSelection: () => set({ selectedItemIds: [], isPropertiesPanelOpen: false }),

    addConnector: (connector) => {
        get().takeSnapshot();

        let finalConnector = { ...connector };
        const sKey = finalConnector.sourcePointKey.toLowerCase();
        const tKey = finalConnector.targetPointKey.toLowerCase();

        if ((sKey.includes('in') || sKey === 'in') && (tKey.includes('out') || tKey.startsWith('out'))) {
            const tempItem = finalConnector.sourceItem;
            finalConnector.sourceItem = finalConnector.targetItem;
            finalConnector.targetItem = tempItem;

            const tempKey = finalConnector.sourcePointKey;
            finalConnector.sourcePointKey = finalConnector.targetPointKey;
            finalConnector.targetPointKey = tempKey;
        }

        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                storedConnectors: [...s.storedConnectors, finalConnector]
            } : s)
        }));
        // Mirror to counterpart if the connector is attached to an 'out' portal
        try {
            const isPortal = (it: CanvasItem | undefined) => !!it && it.name === 'Portal';
            const portalItem = isPortal(finalConnector.sourceItem) ? finalConnector.sourceItem
                : (isPortal(finalConnector.targetItem) ? finalConnector.targetItem : undefined);
            if (portalItem) {
                const meta = (portalItem.properties?.[0] || {}) as Record<string, string>;
                const dir = (meta['Direction'] || meta['direction'] || '').toLowerCase();
                const netId = (meta['NetId'] || meta['netId'] || '').trim();
                if (dir === 'out' && netId) {
                    const state = get();
                    // Find counterpart portal
                    let counterpartSheetIdx = -1;
                    let counterpartItemId: string | null = null;
                    state.sheets.forEach((sh, si) => {
                        sh.canvasItems.forEach(ci => {
                            if (ci.name === 'Portal') {
                                const p = (ci.properties?.[0] || {}) as Record<string, string>;
                                const nid = (p['NetId'] || p['netId'] || '').trim();
                                if (nid === netId && ci.uniqueID !== portalItem.uniqueID) {
                                    counterpartSheetIdx = si;
                                    counterpartItemId = ci.uniqueID;
                                }
                            }
                        });
                    });
                    if (counterpartSheetIdx >= 0 && counterpartItemId) {
                        const sh = get().sheets[counterpartSheetIdx];
                        const idx = sh.storedConnectors.findIndex(cc =>
                            cc.sourceItem.uniqueID === counterpartItemId || cc.targetItem.uniqueID === counterpartItemId
                        );
                        if (idx >= 0) {
                            const baseProps: Record<string, string> = { ...(finalConnector.properties || {}) };
                            baseProps['IsVirtual'] = 'True';
                            const mirrored: Connector = {
                                ...sh.storedConnectors[idx],
                                properties: baseProps,
                                alternativeCompany1: finalConnector.alternativeCompany1,
                                alternativeCompany2: finalConnector.alternativeCompany2,
                                laying: { ...(finalConnector.laying || {}) },
                                materialType: finalConnector.materialType,
                                length: 0,
                                isVirtual: true
                            };
                            // Commit the mirrored connector into sheets
                            const newStored = sh.storedConnectors.map((cc, i) => i === idx ? mirrored : cc);
                            set((st) => ({
                                sheets: st.sheets.map((sheet, si) => si === counterpartSheetIdx ? { ...sheet, storedConnectors: newStored } : sheet)
                            }));
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Portal Mirror] Failed to mirror connector to counterpart:', e);
        }
        get().calculateNetwork();
    },

    selectConnector: (indexOrIndices, openPanel = true) => set(() => {
        let indices: number[];
        if (indexOrIndices === null) {
            indices = [];
        } else if (Array.isArray(indexOrIndices)) {
            indices = indexOrIndices;
        } else {
            indices = [indexOrIndices];
        }
        return {
            selectedConnectorIndices: indices,
            isPropertiesPanelOpen: indices.length === 1 && openPanel,
            selectedItemIds: []
        };
    }),

    updateConnector: (index, updates) => {
        get().takeSnapshot();
        set((state) => {
            const activeSheet = state.sheets.find(s => s.sheetId === state.activeSheetId);
            if (!activeSheet) return {};
            const updatedConnectors = activeSheet.storedConnectors.map((c, i) =>
                i === index ? { ...c, ...updates } : c
            );

            // Prepare sheets result with current sheet updated
            let newSheets = state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                storedConnectors: updatedConnectors
            } : s);

            // Mirror to counterpart portal connector if applicable
            const changed = updatedConnectors[index];
            if (changed) {
                const isPortal = (it: CanvasItem | undefined) => !!it && it.name === 'Portal';
                const portalItem = isPortal(changed.sourceItem) ? changed.sourceItem
                    : (isPortal(changed.targetItem) ? changed.targetItem : undefined);
                if (portalItem) {
                    const meta = (portalItem.properties?.[0] || {}) as Record<string, string>;
                    const dir = (meta['Direction'] || meta['direction'] || '').toLowerCase();
                    const netId = (meta['NetId'] || meta['netId'] || '').trim();

                    // Only mirror from 'out' side portal connectors to their counterpart
                    if (dir === 'out' && netId) {
                        // Find counterpart portal across all sheets
                        let counterpartSheetIdx = -1;
                        let counterpartItemId: string | null = null;
                        state.sheets.forEach((sh, si) => {
                            sh.canvasItems.forEach(ci => {
                                if (ci.name === 'Portal') {
                                    const p = (ci.properties?.[0] || {}) as Record<string, string>;
                                    const nid = (p['NetId'] || p['netId'] || '').trim();
                                    if (nid === netId && ci.uniqueID !== portalItem.uniqueID) {
                                        counterpartSheetIdx = si;
                                        counterpartItemId = ci.uniqueID;
                                    }
                                }
                            });
                        });

                        if (counterpartSheetIdx >= 0 && counterpartItemId) {
                            const targetSheet = newSheets[counterpartSheetIdx];
                            const counterConnIdx = targetSheet.storedConnectors.findIndex(cc =>
                                cc.sourceItem.uniqueID === counterpartItemId || cc.targetItem.uniqueID === counterpartItemId
                            );
                            if (counterConnIdx >= 0) {
                                const baseProps: Record<string, string> = { ...(changed.properties || {}) };
                                baseProps['IsVirtual'] = 'True';
                                const mirrored = {
                                    ...targetSheet.storedConnectors[counterConnIdx],
                                    properties: baseProps,
                                    alternativeCompany1: changed.alternativeCompany1,
                                    alternativeCompany2: changed.alternativeCompany2,
                                    laying: { ...(changed.laying || {}) },
                                    materialType: changed.materialType,
                                    length: 0,
                                    isVirtual: true
                                } as Connector;

                                const newStored = targetSheet.storedConnectors.map((cc, i) => i === counterConnIdx ? mirrored : cc);
                                newSheets = newSheets.map((sh, si) => si === counterpartSheetIdx ? { ...sh, storedConnectors: newStored } : sh);
                            }
                        }
                    }
                }
            }

            return { sheets: newSheets };
        });
        get().calculateNetwork();
    },

    applyAutoRatingResults: (newSheets) => {
        get().takeSnapshot();
        set((state) => {
            // Map new sheets to existing sheets to preserve stacks
            const updatedSheets = newSheets.map((newSheet, index) => {
                const existingSheet = state.sheets[index]; // Assuming 1-to-1 mapping by index or ID
                // Ideally match by ID
                const matchedExisting = state.sheets.find(s => s.sheetId === newSheet.sheetId) || existingSheet;

                if (matchedExisting) {
                    return {
                        ...newSheet,
                        undoStack: matchedExisting.undoStack,
                        redoStack: matchedExisting.redoStack
                    };
                }
                return newSheet;
            });

            return { sheets: updatedSheets };
        });
        get().calculateNetwork();
    },

    setEditMode: (mode) => set({ editMode: mode }),

    toggleChat: () => set((state) => ({ isChatOpen: !state.isChatOpen })),

    // --- Clipboard Actions ---

    copySelection: () => {
        const { selectedItemIds } = get();
        const activeSheet = get().getCurrentSheet();
        if (!activeSheet || selectedItemIds.length === 0) return;

        const itemsToCopy = activeSheet.canvasItems.filter(i => selectedItemIds.includes(i.uniqueID));
        const connectorsToCopy = activeSheet.storedConnectors.filter(c =>
            selectedItemIds.includes(c.sourceItem.uniqueID) &&
            selectedItemIds.includes(c.targetItem.uniqueID)
        );

        // Deep copy
        set({
            copiedItems: JSON.parse(JSON.stringify(itemsToCopy)),
            copiedConnectors: JSON.parse(JSON.stringify(connectorsToCopy))
        });
    },

    pasteSelection: (position) => {
        const { copiedItems, copiedConnectors } = get();
        const activeSheet = get().getCurrentSheet();
        if (!copiedItems || copiedItems.length === 0 || !activeSheet) return;

        get().takeSnapshot();

        const scale = activeSheet.scale || 1;
        const offset = 30;

        // Calculate offset based on position or default
        let offsetX = offset;
        let offsetY = offset;

        if (position) {
            // If pasting at specific position, calculate offset relative to the top-left item
            const minX = Math.min(...copiedItems.map(i => i.position.x));
            const minY = Math.min(...copiedItems.map(i => i.position.y));
            offsetX = position.x - minX;
            offsetY = position.y - minY;
        }

        // Map old IDs to new IDs
        const idMap = new Map<string, string>();
        const newItems: CanvasItem[] = [];

        copiedItems.forEach(item => {
            const newItem = JSON.parse(JSON.stringify(item));
            const newId = crypto.randomUUID();
            idMap.set(item.uniqueID, newId);
            newItem.uniqueID = newId;

            // Apply offset
            // Apply offset
            if (position) {
                newItem.position = { x: item.position.x + offsetX, y: item.position.y + offsetY };
            } else {
                newItem.position = { x: item.position.x + offset, y: item.position.y + offset };
            }
            newItems.push(newItem);
        });

        // Recreate internal connectors
        const newConnectors: Connector[] = [];
        if (copiedConnectors) {
            copiedConnectors.forEach(conn => {
                const newSourceId = idMap.get(conn.sourceItem.uniqueID);
                const newTargetId = idMap.get(conn.targetItem.uniqueID);

                if (newSourceId && newTargetId) {
                    const newConn = JSON.parse(JSON.stringify(conn));
                    newConn.sourceItem = newItems.find(i => i.uniqueID === newSourceId);
                    newConn.targetItem = newItems.find(i => i.uniqueID === newTargetId);
                    newConnectors.push(newConn);
                }
            });
        }

        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: [...s.canvasItems, ...newItems],
                storedConnectors: [...s.storedConnectors, ...newConnectors]
            } : s),
            selectedItemIds: newItems.map(i => i.uniqueID), // Select newly pasted items
            selectedConnectorIndices: []
        }));
        get().calculateNetwork();
    },

    copyConnectorProperties: (index) => {
        const activeSheet = get().getCurrentSheet();
        if (!activeSheet) return;
        const connector = activeSheet.storedConnectors[index];
        if (connector) {
            set({
                copiedConnectorProperties: { ...connector.properties },
                copiedAlternativeCompany1: connector.alternativeCompany1,
                copiedAlternativeCompany2: connector.alternativeCompany2,
                copiedMaterialType: connector.materialType
            });
        }
    },

    pasteConnectorProperties: (index) => {
        const { copiedConnectorProperties, copiedAlternativeCompany1, copiedAlternativeCompany2, copiedMaterialType } = get();
        if (!copiedConnectorProperties) return;

        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                storedConnectors: s.storedConnectors.map((c, i) => i === index ? {
                    ...c,
                    properties: { ...copiedConnectorProperties },
                    alternativeCompany1: copiedAlternativeCompany1,
                    alternativeCompany2: copiedAlternativeCompany2,
                    materialType: copiedMaterialType as "Cable" | "Wiring"
                } : c)
            } : s)
        }));
        get().calculateNetwork();
    },

    // --- Transformation Actions ---

    rotateItem: (id, direction = 'clockwise') => {
        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: s.canvasItems.map(item => {
                    if (item.uniqueID !== id) return item;

                    // Helper to rotate a point 90 degrees
                    const rotatePoint = (p: { x: number, y: number }, width: number, height: number, dir: 'clockwise' | 'counter-clockwise') => {
                        if (dir === 'clockwise') {
                            // Clockwise: newX = height - oldY, newY = oldX
                            return {
                                x: height - p.y,
                                y: p.x
                            };
                        } else {
                            // Counter-Clockwise: newX = oldY, newY = width - oldX
                            return {
                                x: p.y,
                                y: width - p.x
                            };
                        }
                    };

                    const currentRotation = (item.rotation || 0);
                    let newRotation;
                    if (direction === 'clockwise') {
                        newRotation = (currentRotation + 90) % 360;
                    } else {
                        newRotation = (currentRotation - 90 + 360) % 360;
                    }

                    // Rotate connection points using CURRENT dimensions (before swap)
                    const newConnectionPoints = { ...item.connectionPoints };
                    Object.keys(newConnectionPoints).forEach(key => {
                        newConnectionPoints[key] = rotatePoint(newConnectionPoints[key], item.size.width, item.size.height, direction);
                    });

                    // Swap dimensions
                    const newSize = { width: item.size.height, height: item.size.width };

                    return {
                        ...item,
                        size: newSize,
                        connectionPoints: newConnectionPoints,
                        rotation: newRotation
                    };
                })
            } : s)
        }));
        get().calculateNetwork();
    },

    flipItemVertically: (id) => {
        // Removed as per user request
    },

    flipItemHorizontally: (id) => {
        // Removed as per user request
    },

    // --- Network Analysis ---

    calculateNetwork: (() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        return () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const { sheets } = get();
                const sheetsCopy = JSON.parse(JSON.stringify(sheets));
                const analyzer = new NetworkAnalyzer(sheetsCopy);
                analyzer.analyzeNetwork();
                set({ sheets: sheetsCopy });
            }, NETWORK_DEBOUNCE_MS);
        };
    })(),

    // --- Settings ---
    showCurrentValues: localStorage.getItem('showCurrentValues') !== 'false', // Default to true

    toggleShowCurrentValues: () => {
        const newValue = !get().showCurrentValues;
        localStorage.setItem('showCurrentValues', String(newValue));
        set({ showCurrentValues: newValue });
    },

    // --- Portal/Nets ---
    isNetLabelUnique: (label: string) => {
        const lbl = (label || '').trim().toLowerCase();
        if (!lbl) return false;
        const { sheets } = get();
        for (const s of sheets) {
            for (const it of s.canvasItems) {
                if (it.name === 'Portal') {
                    const p = it.properties?.[0] || {} as Record<string, string>;
                    const itLabel = (p['Label'] || p['label'] || '').toLowerCase();
                    if (itLabel && itLabel === lbl) return false;
                }
            }
        }
        return true;
    },

    getPortalsByNetId: (netId: string) => {
        const id = (netId || '').trim();
        if (!id) return [];
        const { sheets } = get();
        const result: CanvasItem[] = [];
        for (const s of sheets) {
            for (const it of s.canvasItems) {
                if (it.name === 'Portal') {
                    const p = it.properties?.[0] || {} as Record<string, string>;
                    if ((p['NetId'] || p['netId']) === id) result.push(it);
                }
            }
        }
        return result;
    },

    countConnectorsForItem: (sheetId: string, itemId: string) => {
        const { sheets } = get();
        const s = sheets.find(sh => sh.sheetId === sheetId);
        if (!s) return 0;
        return s.storedConnectors.filter(c => c.sourceItem.uniqueID === itemId || c.targetItem.uniqueID === itemId).length;
    },

    createPortal: (direction, position) => {
        const def = getItemDefinition('Portal');
        const netId = crypto.randomUUID();

        // Invert connection point key relative to portal direction,
        // keeping visual position consistent with key semantics:
        // - CP 'in' should be at TOP (y = 0)
        // - CP 'out' should be at BOTTOM (y = height)
        // Therefore:
        //   direction 'out' -> expose CP 'in' at TOP
        //   direction 'in'  -> expose CP 'out' at BOTTOM
        const connPts = direction === 'in'
            ? { out: { x: Math.round(def.size.width / 2), y: def.size.height } }
            : { in: { x: Math.round(def.size.width / 2), y: 0 } };

        const svg = (() => {
            const w = def.size.width, h = def.size.height;
            const arrow = direction === 'in'
                ? `<path d="M ${w / 2} ${h * 0.7} L ${w / 2} ${h * 0.3} M ${w / 2} ${h * 0.3} L ${(w / 2) - 6} ${h * 0.3 + 6} M ${w / 2} ${h * 0.3} L ${(w / 2) + 6} ${h * 0.3 + 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
                : `<path d="M ${w / 2} ${h * 0.3} L ${w / 2} ${h * 0.7} M ${w / 2} ${h * 0.7} L ${(w / 2) - 6} ${h * 0.7 - 6} M ${w / 2} ${h * 0.7} L ${(w / 2) + 6} ${h * 0.7 - 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="6" ry="6" fill="#fff" stroke="#111" stroke-width="2"/>
  ${arrow}
</svg>`;
        })();

        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === state.activeSheetId ? {
                ...s,
                canvasItems: [
                    ...s.canvasItems,
                    {
                        uniqueID: crypto.randomUUID(),
                        name: 'Portal',
                        position: { x: position.x, y: position.y },
                        size: def.size,
                        connectionPoints: connPts as any,
                        properties: [{ Label: netId, NetId: netId, Direction: direction }],
                        alternativeCompany1: '',
                        alternativeCompany2: '',
                        svgContent: svg,
                        iconPath: undefined,
                        locked: false,
                        idPoints: {},
                        incomer: {},
                        outgoing: [],
                        accessories: []
                    } as CanvasItem
                ]
            } : s)
        }));
        get().calculateNetwork();
    },

    createPairedPortal: (netId, direction, targetSheetId, position) => {
        const { getPortalsByNetId } = get();
        const portals = getPortalsByNetId(netId);
        if (portals.length >= 2) {
            alert('A portal pair already exists for this net.');
            return;
        }

        const def = getItemDefinition('Portal');

        // Always create paired portal as 'in'
        const compDir: 'in' | 'out' = 'in';
        const pos = position || { x: 100, y: 100 };

        // Invert connection point key relative to portal direction (see createPortal)
        const connPts = compDir === 'in'
            ? { out: { x: Math.round(def.size.width / 2), y: def.size.height } }
            : { in: { x: Math.round(def.size.width / 2), y: 0 } };

        const svg = (() => {
            const w = def.size.width, h = def.size.height;
            const arrow = compDir === 'in'
                ? `<path d="M ${w / 2} ${h * 0.7} L ${w / 2} ${h * 0.3} M ${w / 2} ${h * 0.3} L ${(w / 2) - 6} ${h * 0.3 + 6} M ${w / 2} ${h * 0.3} L ${(w / 2) + 6} ${h * 0.3 + 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
                : `<path d="M ${w / 2} ${h * 0.3} L ${w / 2} ${h * 0.7} M ${w / 2} ${h * 0.7} L ${(w / 2) - 6} ${h * 0.7 - 6} M ${w / 2} ${h * 0.7} L ${(w / 2) + 6} ${h * 0.7 - 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${w}\" height=\"${h}\" viewBox=\"0 0 ${w} ${h}\">
  <rect x=\"2\" y=\"2\" width=\"${w - 4}\" height=\"${h - 4}\" rx=\"6\" ry=\"6\" fill=\"#fff\" stroke=\"#111\" stroke-width=\"2\"/>
  ${arrow}
</svg>`;
        })();

        get().takeSnapshot();
        set((state) => ({
            sheets: state.sheets.map(s => s.sheetId === targetSheetId ? {
                ...s,
                canvasItems: [
                    ...s.canvasItems,
                    {
                        uniqueID: crypto.randomUUID(),
                        name: 'Portal',
                        position: { x: pos.x, y: pos.y },
                        size: def.size,
                        connectionPoints: connPts as any,
                        properties: [{ Label: netId, NetId: netId, Direction: compDir }],
                        alternativeCompany1: '',
                        alternativeCompany2: '',
                        svgContent: svg,
                        iconPath: undefined,
                        locked: false,
                        idPoints: {},
                        incomer: {},
                        outgoing: [],
                        accessories: []
                    } as CanvasItem
                ]
            } : s)
        }));
        get().calculateNetwork();
    }
}));
