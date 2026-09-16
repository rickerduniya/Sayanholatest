// useDiagramCallbacks — builds the DiagramCallbacks bundle that ChatService needs
// to manipulate the SLD.
//
// Extracted from ChatPanel, which previously built this object twice (once in an
// effect, once in handleNewChat) and had to keep both copies in sync by hand. It
// now has a single definition shared by the chat panel and the agent panel, so
// the agent cannot end up with a subtly different tool surface from chat.
//
// The item-creation helper deliberately mirrors what happens when a human drops
// an item from the sidebar: fetch DB defaults, fetch the SVG, apply static
// geometry, run backend initialization for distribution boards, recalculate
// geometry, then update visuals. Anything less produces items that look right but
// have no connection points, which breaks every subsequent wiring call.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../services/api';
import { CanvasItem, Connector, ItemData } from '../types';
import { DiagramCallbacks } from '../services/ChatService';
import { getItemDefinition, LOAD_ITEM_DEFAULTS, DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { fetchProperties } from '../utils/api';
import { sortOptionStringsAsc } from '../utils/sortUtils';
import { createConnectorWithDefaults } from '../utils/ConnectorFactory';
import { findIncompatibleConnectorsForItem } from '../utils/PhaseCompatibility';
import { applyAutoArrange } from '../utils/AutoArrange';
import { ApplicationSettings } from '../utils/ApplicationSettings';

type ShowToast = (message: string, type: 'success' | 'error' | 'info') => void;

export const useDiagramCallbacks = (showToast: ShowToast) => {
    const [availableItems, setAvailableItems] = useState<ItemData[]>([]);

    useEffect(() => {
        let cancelled = false;
        api.getItems()
            .then(items => { if (!cancelled) setAvailableItems(items); })
            .catch(e => console.error('Failed to fetch items for AI assistant', e));
        return () => { cancelled = true; };
    }, []);

    const addItemHelper = useCallback(async (
        itemName: string,
        position?: { x: number; y: number },
        properties?: Record<string, any>
    ): Promise<CanvasItem | null> => {
        const store = useStore.getState();

        if (itemName === 'Text') {
            const newItem: CanvasItem = {
                uniqueID: crypto.randomUUID(),
                name: 'Text',
                position: position || { x: 300, y: 300 },
                size: { width: 150, height: 50 },
                connectionPoints: {},
                properties: [{
                    'Text': 'New Text',
                    'FontSize': '16',
                    'FontFamily': 'Arial',
                    'Color': 'default',
                    'Align': 'left',
                    ...(properties || {})
                }],
                alternativeCompany1: '',
                alternativeCompany2: '',
                locked: false,
                idPoints: {},
                incomer: {},
                outgoing: [],
                accessories: []
            };
            store.addItem(newItem);
            return newItem;
        }

        // Prefer an exact name match. Substring matching is a fallback only:
        // matching "Geyser" loosely could otherwise return "Geyser Point".
        const itemData =
            availableItems.find(i => i.name.toLowerCase() === itemName.toLowerCase()) ||
            availableItems.find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));

        if (!itemData) {
            console.error(`Item "${itemName}" not found in available items`);
            return null;
        }

        const newItem: CanvasItem = {
            uniqueID: crypto.randomUUID(),
            name: itemData.name,
            position: position || { x: 300, y: 300 },
            size: itemData.size,
            connectionPoints: itemData.connectionPoints,
            properties: [],
            alternativeCompany1: '',
            alternativeCompany2: '',
            svgContent: undefined,
            iconPath: itemData.iconPath,
            locked: false,
            idPoints: {},
            incomer: {},
            outgoing: [],
            accessories: []
        };

        try {
            const props = await api.getItemProperties(itemData.name, 1);
            if (props?.properties && props.properties.length > 0) {
                newItem.properties = [props.properties[0]];
            } else if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }
            newItem.alternativeCompany1 = props?.alternativeCompany1 || '';
            newItem.alternativeCompany2 = props?.alternativeCompany2 || '';
        } catch (err) {
            console.error('Failed to load properties', err);
            if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }
        }

        if (itemData.iconPath) {
            try {
                const iconName = itemData.iconPath.split('/').pop();
                const response = await fetch(encodeURI(api.getIconUrl(iconName!)));
                if (response.ok) newItem.svgContent = await response.text();
            } catch (e) {
                console.error('Failed to fetch SVG content', e);
            }
        }

        const staticDef = getItemDefinition(newItem.name);
        if (staticDef && !['HTPN', 'VTPN', 'SPN DB'].includes(newItem.name)) {
            newItem.size = staticDef.size;
            newItem.connectionPoints = staticDef.connectionPoints;
        }

        if (['HTPN', 'VTPN', 'SPN DB', 'Main Switch', 'Change Over Switch', 'Point Switch Board'].includes(newItem.name)) {
            if (!newItem.properties[0]) newItem.properties[0] = {};

            // A caller-supplied Way must win here. The agent sizes boards from the
            // real load count, and silently overwriting its choice with the
            // default produced boards with too few ways to wire.
            const requestedWay = properties?.['Way'] !== undefined ? String(properties['Way']) : undefined;
            let wayVal = requestedWay ?? newItem.properties[0]['Way'];
            if (!wayVal || wayVal.includes(',')) {
                wayVal = newItem.name === 'SPN DB' ? '2+4' : '4';
            }
            newItem.properties[0]['Way'] = wayVal;

            try {
                const initData = await api.initializeItem(newItem.name, newItem.properties);
                if (initData) {
                    if (initData.incomer) newItem.incomer = initData.incomer;
                    if (initData.outgoing) newItem.outgoing = initData.outgoing;
                    if (initData.accessories) newItem.accessories = initData.accessories;
                }
            } catch (err) {
                console.error('[useDiagramCallbacks] Failed to initialize item accessories:', err);
            }

            if (['HTPN', 'VTPN', 'SPN DB'].includes(newItem.name)) {
                const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(newItem.name);
                if (threshold > 0 && newItem.outgoing && newItem.outgoing.length > 0) {
                    const parseRating = (s: string) => {
                        const m = (s || '').toString().match(/(\d+(?:\.\d+)?)/);
                        return m ? parseFloat(m[1]) : NaN;
                    };

                    let defaultRating = '';
                    try {
                        const pole = newItem.name === 'VTPN' ? 'TP' : 'SP';
                        const mcb = await fetchProperties('MCB');

                        const allRatings = sortOptionStringsAsc(
                            Array.from(new Set((mcb.properties || []).map(p => p['Current Rating']).filter(Boolean)))
                        );
                        const poleRatings = sortOptionStringsAsc(Array.from(new Set(
                            (mcb.properties || [])
                                .filter(p => {
                                    const pPole = (p['Pole'] || '').toString();
                                    return pPole ? (pPole === pole || pPole.includes(pole)) : false;
                                })
                                .map(p => p['Current Rating'])
                                .filter(Boolean)
                        )));
                        const ratings = poleRatings.length > 0 ? poleRatings : allRatings;

                        defaultRating = ratings.find(r => {
                            const v = parseRating(r);
                            return Number.isFinite(v) && v >= threshold;
                        }) || ratings[0] || '';
                    } catch (e) {
                        console.error('[useDiagramCallbacks] Failed to fetch outgoing rating options', e);
                    }

                    if (defaultRating) {
                        newItem.outgoing = newItem.outgoing.map(o => ({ ...(o || {}), 'Current Rating': defaultRating }));
                    }
                }
            }

            const result = calculateGeometry(newItem);
            if (result) {
                newItem.size = result.size;
                newItem.connectionPoints = result.connectionPoints;
            }
        }

        if (newItem.svgContent && newItem.properties[0]) {
            const updatedSvg = updateItemVisuals(newItem);
            if (updatedSvg) newItem.svgContent = updatedSvg;
        }

        store.addItem(newItem);
        return newItem;
    }, [availableItems]);

    const connectItemsHelper = useCallback(async (args: {
        sourceItemId: string;
        sourcePointKey: string;
        targetItemId: string;
        targetPointKey: string;
        materialType?: 'Cable' | 'Wiring';
    }): Promise<{ connector: Connector; connectorIndex: number } | { error: string }> => {
        const store = useStore.getState();
        const currentSheet = store.getCurrentSheet();
        if (!currentSheet) return { error: 'No active sheet.' };

        const sourceItem = currentSheet.canvasItems.find(i => i.uniqueID === args.sourceItemId);
        const targetItem = currentSheet.canvasItems.find(i => i.uniqueID === args.targetItemId);
        if (!sourceItem || !targetItem) return { error: 'Source or target item not found on the active sheet.' };

        if (!sourceItem.connectionPoints?.[args.sourcePointKey]) {
            return {
                error: `Invalid sourcePointKey "${args.sourcePointKey}" for ${sourceItem.name}. Valid keys: ${Object.keys(sourceItem.connectionPoints || {}).join(', ')}`
            };
        }
        if (!targetItem.connectionPoints?.[args.targetPointKey]) {
            return {
                error: `Invalid targetPointKey "${args.targetPointKey}" for ${targetItem.name}. Valid keys: ${Object.keys(targetItem.connectionPoints || {}).join(', ')}`
            };
        }

        // Reject a duplicate on the same key before creating anything. The rule
        // "one connector per point key" is the single most common thing an agent
        // gets wrong, and a clear error teaches it faster than a silent overlap.
        const keyTaken = currentSheet.storedConnectors.some(c =>
            (c.sourceItem?.uniqueID === sourceItem.uniqueID && c.sourcePointKey === args.sourcePointKey) ||
            (c.targetItem?.uniqueID === sourceItem.uniqueID && c.targetPointKey === args.sourcePointKey)
        );
        if (keyTaken) {
            return { error: `${sourceItem.name} point "${args.sourcePointKey}" is already connected. Use a free output, or add another board.` };
        }
        const targetKeyTaken = currentSheet.storedConnectors.some(c =>
            (c.targetItem?.uniqueID === targetItem.uniqueID && c.targetPointKey === args.targetPointKey) ||
            (c.sourceItem?.uniqueID === targetItem.uniqueID && c.sourcePointKey === args.targetPointKey)
        );
        if (targetKeyTaken) {
            return { error: `${targetItem.name} point "${args.targetPointKey}" is already connected.` };
        }

        const beforeCount = currentSheet.storedConnectors.length;
        const result = await createConnectorWithDefaults({
            activeSheet: currentSheet,
            allSheets: store.sheets,
            sourceItem,
            sourcePointKey: args.sourcePointKey,
            targetItem,
            targetPointKey: args.targetPointKey,
            materialType: args.materialType || 'Cable'
        });

        if (result.error) return { error: result.error };
        if (!result.connector) return { error: 'Failed to create connector.' };
        if (result.warnings && result.warnings.length > 0) {
            showToast(result.warnings.join('\n'), 'info');
        }

        store.addConnector(result.connector);
        const created = useStore.getState().getCurrentSheet()?.storedConnectors[beforeCount];
        if (!created) return { error: 'Connector was not added.' };
        return { connector: created, connectorIndex: beforeCount };
    }, [showToast]);

    const buildCallbacks = useCallback((): DiagramCallbacks => {
        const store = () => useStore.getState();

        return {
            addItem: addItemHelper,
            deleteItem: (itemId: string) => store().deleteItem(itemId),
            calculateNetwork: () => store().calculateNetwork(),
            getSheets: () => store().sheets,
            getCurrentSheet: () => store().getCurrentSheet(),
            getActiveSheetId: () => store().activeSheetId,
            setActiveSheet: (id: string) => store().setActiveSheet(id),
            addSheet: (name?: string) => store().addSheet(name),
            renameSheet: (id: string, name: string) => store().renameSheet(id, name),
            removeSheet: (id: string) => store().removeSheet(id),
            moveItems: (moves) => {
                if (!moves || moves.length === 0) return;
                const s = store();
                s.takeSnapshot();
                s.moveItems(moves.map(m => ({ id: m.itemId, x: m.x, y: m.y })));
                s.calculateNetwork();
            },
            updateItemProperties: (id, props) => store().updateItemProperties(id, props),
            updateItemTransform: (id, x, y, w, h, r) => store().updateItemTransform(id, x, y, w, h, r),
            updateItemLock: (id, locked) => store().updateItemLock(id, locked),
            updateItemFields: (id, updates): { success: true } | { error: string } => {
                const s = store();
                const sheet = s.getCurrentSheet();
                if (!sheet) return { error: 'No active sheet.' };
                // Guard phase-relevant edits from the agent/chat path
                // (panel outgoing Pole / incomer config).
                if (updates && (updates.outgoing || updates.incomer)) {
                    const current = sheet.canvasItems.find(it => it.uniqueID === id);
                    if (current) {
                        const preview = { ...current, ...updates };
                        const issues = findIncompatibleConnectorsForItem(
                            preview,
                            sheet.storedConnectors,
                            sheet.canvasItems.map(it => it.uniqueID === id ? preview : it)
                        );
                        if (issues.length > 0) {
                            const msg = `Blocked: this change would make ${issues.length} connection(s) phase-incompatible (single vs 3-phase). Rewire first. First conflict: ${issues[0].error}`;
                            showToast(msg, 'error');
                            return { error: msg };
                        }
                    }
                }
                s.takeSnapshot();
                s.updateSheet(
                    { canvasItems: sheet.canvasItems.map(it => it.uniqueID === id ? { ...it, ...updates } : it) },
                    { recalcNetwork: false }
                );
                return { success: true };
            },
            updateItemRaw: (id, updates, options): { success: true } | { error: string } => {
                const s = store();
                const sheet = s.getCurrentSheet();
                if (!sheet) return { error: 'No active sheet.' };
                if (updates && (updates.properties || updates.outgoing || updates.incomer)) {
                    const current = sheet.canvasItems.find(it => it.uniqueID === id);
                    if (current) {
                        const preview = { ...current, ...updates };
                        const issues = findIncompatibleConnectorsForItem(
                            preview,
                            sheet.storedConnectors,
                            sheet.canvasItems.map(it => it.uniqueID === id ? preview : it)
                        );
                        if (issues.length > 0) {
                            const msg = `Blocked: this change would make ${issues.length} connection(s) phase-incompatible (single vs 3-phase). Rewire first. First conflict: ${issues[0].error}`;
                            showToast(msg, 'error');
                            return { error: msg };
                        }
                    }
                }
                s.takeSnapshot();
                s.updateSheet(
                    { canvasItems: sheet.canvasItems.map(it => it.uniqueID === id ? { ...it, ...updates } : it) },
                    { recalcNetwork: options?.recalcNetwork }
                );
                return { success: true };
            },
            duplicateItem: (id) => store().duplicateItem(id),
            connectItems: connectItemsHelper,
            updateConnector: (index, updates) => store().updateConnector(index, updates),
            deleteConnector: (index) => {
                const s = store();
                const sheet = s.getCurrentSheet();
                if (!sheet) return;
                if (index < 0 || index >= sheet.storedConnectors.length) return;
                s.takeSnapshot();
                s.updateSheet({ storedConnectors: sheet.storedConnectors.filter((_, i) => i !== index) });
                s.calculateNetwork();
            },
            autoLayoutActiveSheet: () => {
                const s = store();
                const sheet = s.getCurrentSheet();
                if (!sheet) return;
                s.takeSnapshot();
                s.updateSheet({ canvasItems: applyAutoArrange(sheet.canvasItems, sheet.storedConnectors, ApplicationSettings.getSldDownstreamGapFactor()) });
                s.calculateNetwork();
            },
            listAvailableItems: () => availableItems.map(i => ({
                name: i.name,
                connectionPointKeys: Object.keys(i.connectionPoints || {})
            })),
            undo: () => store().undo(),
            redo: () => store().redo(),
            showToast
        };
    }, [addItemHelper, connectItemsHelper, availableItems, showToast]);

    return { buildCallbacks, availableItems };
};
