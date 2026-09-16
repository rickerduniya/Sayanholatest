// Layout Canvas Component - Main floor plan editing canvas
// Uses React-Konva for 2D drawing similar to the SLD Canvas

import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import { createPortal as reactCreatePortal } from 'react-dom';
import { Stage, Layer, Rect, Line, Group, Circle, Text, Image as KonvaImage } from 'react-konva';
import { useLayoutStore } from '../store/useLayoutStore';
import { useStore } from '../store/useStore';
import { useTheme } from '../context/ThemeContext';
import {
    Wall,
    Room,
    Door,
    LayoutWindow,
    LayoutComponent,
    DrawingTool,
    LayoutComponentType,
    OcrItem
} from '../types/layout';
import { Connector, Point, CanvasItem } from '../types';
import { createConnectorWithDefaults } from '../utils/ConnectorFactory';
import {
    snapToWall,
    constrainWallAngle,
    resolveDraftingSnap,
    DRAWING_TOOL_CURSORS,
    DRAWING_TOOL_INSTRUCTIONS,
    getRoomCentroid,
    calculateRoomArea,
    isPointInRoom,
    getDistanceLabelWithUnit,
    getAreaLabel,
    calculateOrthogonalPath,
    normalizeBounds,
    boundsArea,
    boundsIntersect,
    boundsFromPoints,
    boundsAroundPoint,
    Bounds
} from '../utils/LayoutDrawingTools';
// Boundary-tolerant room lookup. A wall-mounted fitting sits ON the room
// polygon's edge, so a strict containment test leaves it with no room and drops
// it from per-room load totals.
import { findRoomForPoint, orientComponentOnWall, getRoomInteriorPoint, needsWallSeating } from '../utils/PlacementGeometry';
import {
    LAYOUT_COMPONENT_DEFINITIONS,
    getLayoutComponentDef,
    getScaledComponentSize
} from '../utils/LayoutComponentDefinitions';
import { layoutImageStore } from '../utils/LayoutImageStore';
import { useLayoutComponentImages } from '../hooks/useLayoutComponentImages';
import { ApplicationSettings } from '../utils/ApplicationSettings';
import { parseHtpnPointPhase, resolveUpstreamPhase, getLocalOutgoingPhase } from '../utils/NetworkAnalyzer';
import type { LayoutConnection } from '../types/layout';

export interface LayoutCanvasRef {
    saveImage: () => void;
    captureSnapshot: () => Promise<string>;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    setZoom: (scale: number) => void;
    fitView: () => void;
}

const getSldConnectorColor = (connector: Connector, theme: string, allConnectors?: Connector[], allItems?: CanvasItem[]): string => {
    const useColor = ApplicationSettings.getSaveImageInColor();
    if (!useColor) return theme === 'dark' ? '#FFFFFF' : '#000000';

    const phase = connector.currentValues?.["Phase"];
    if (phase === "R") return '#FF4500';
    if (phase === "Y") return '#FFD700';
    if (phase === "B") return '#0000CD';

    // No Source connected yet: resolve the device-derived phase upstream so
    // grand-children of any single-phase outgoing (HTPN ways, Busbar taps,
    // LT panel feeders, SPN DBs, single-phase switches) color the same as
    // immediate children.
    if (allConnectors && allConnectors.length > 0) {
        const resolved = resolveUpstreamPhase(connector, allConnectors, allItems);
        if (resolved === "R") return '#FF4500';
        if (resolved === "Y") return '#FFD700';
        if (resolved === "B") return '#0000CD';
    }

    // Immediate-neighbour fallback for single-phase outgoing devices.
    const freshSource = (allItems && connector.sourceItem?.uniqueID)
        ? allItems.find(i => i.uniqueID === connector.sourceItem.uniqueID) || connector.sourceItem
        : connector.sourceItem;
    const local = getLocalOutgoingPhase(connector, freshSource);
    if (local === "R") return '#FF4500';
    if (local === "Y") return '#FFD700';
    if (local === "B") return '#0000CD';

    const srcName = connector.sourceItem?.name;
    const dstName = connector.targetItem?.name;
    const srcKey = connector.sourcePointKey || '';
    const dstKey = connector.targetPointKey || '';

    if (srcName === "HTPN" || dstName === "HTPN") {
        const pointPhase = parseHtpnPointPhase(srcKey) || parseHtpnPointPhase(dstKey);
        if (pointPhase === "R") return '#FF0000';
        if (pointPhase === "Y") return '#FFD700';
        if (pointPhase === "B") return '#0000FF';
        if (srcKey.includes("R") || dstKey.includes("R")) return '#FF0000';
        if (srcKey.includes("Y") || dstKey.includes("Y")) return '#FFD700';
        if (srcKey.includes("B") || dstKey.includes("B")) return '#0000FF';
    }

    return theme === 'dark' ? '#FFFFFF' : '#000000';
};

const PHASE_COLORS: Record<string, string> = {
    R: '#FF4500',
    Y: '#FFD700',
    B: '#0000CD',
};

const getLayoutIdForSldItem = (item?: { properties?: Array<Record<string, string>> }): string | undefined =>
    item?.properties?.[0]?.['_layoutComponentId'];

/**
 * Phase color for a physical layout conduit route. Prefers an explicitly
 * stored phase, then the matching SLD connector (which now carries
 * device-derived phase even without a Source), resolved through the same
 * upstream walk used by the SLD canvas.
 */
const getLayoutConnectionColor = (
    conn: LayoutConnection,
    sldConnectors: Connector[],
    sldItems?: CanvasItem[]
): string | null => {
    const stored = (conn.properties?.phase || '').toUpperCase();
    if (stored === 'R' || stored === 'Y' || stored === 'B') return PHASE_COLORS[stored];

    if (sldConnectors.length === 0) return null;
    const match = sldConnectors.find(sld => {
        const srcLayoutId = getLayoutIdForSldItem(sld.sourceItem);
        const dstLayoutId = getLayoutIdForSldItem(sld.targetItem);
        return (srcLayoutId === conn.sourceId && dstLayoutId === conn.targetId) ||
            (srcLayoutId === conn.targetId && dstLayoutId === conn.sourceId);
    });
    if (!match) return null;
    const direct = match.currentValues?.['Phase'];
    const resolved = (direct && PHASE_COLORS[direct] ? direct : resolveUpstreamPhase(match, sldConnectors, sldItems));
    return PHASE_COLORS[resolved] || null;
};

interface LayoutCanvasProps {
    onScaleChange?: (scale: number) => void;
    showMagicWires?: boolean;
    onCalibrationFinished?: (pixelLength: number) => void;
    isAddTextMode?: boolean;
    onAddTextComplete?: () => void;
    // Visibility
    showWalls?: boolean;
    showDoors?: boolean;
    showWindows?: boolean;
    showRooms?: boolean;
    onSldConnectionResult?: (status: 'success' | 'error', message: string) => void;
    /**
     * Live cursor position in plan coordinates, or null when the pointer leaves
     * the canvas. Reported upward so the status bar can live outside the Konva
     * stage, next to the floor-plan tabs, rather than overlapping the drawing.
     */
    onCursorChange?: (point: Point | null) => void;
    /** Opens the New Floor Plan dialog from the empty state. */
    onRequestNewPlan?: () => void;
    /**
     * True when the right-hand properties panel is open, so canvas overlays
     * (the OCR controls) can shift left instead of hiding underneath it.
     */
    inspectorOpen?: boolean;
    /**
     * True when the Load Summary card occupies the top-right corner, so the OCR
     * panel drops below it instead of covering it.
     */
    loadSummaryVisible?: boolean;
}

const LOAD_CATEGORIES = new Set(['appliances', 'lighting', 'fans', 'others']);

const isPointSwitchBoard = (component: LayoutComponent) => component.type === 'point_switch_board';

const isConnectableLoad = (component: LayoutComponent) => {
    const category = getLayoutComponentDef(component.type)?.category;
    return category ? LOAD_CATEGORIES.has(category) : false;
};

// Room type to color mapping
const ROOM_COLORS: Record<string, string> = {
    bedroom: 'rgba(147, 197, 253, 0.3)',      // blue
    living_room: 'rgba(253, 224, 71, 0.3)',   // yellow
    kitchen: 'rgba(252, 165, 165, 0.3)',      // red
    bathroom: 'rgba(196, 181, 253, 0.3)',     // purple
    dining: 'rgba(163, 230, 53, 0.3)',        // green
    office: 'rgba(251, 146, 60, 0.3)',        // orange
    hallway: 'rgba(244, 114, 182, 0.3)',      // pink
    storage: 'rgba(156, 163, 175, 0.3)',     // gray
    garage: 'rgba(59, 130, 246, 0.3)',        // blue-alt
    balcony: 'rgba(34, 197, 94, 0.3)',        // emerald
    other: 'rgba(209, 213, 219, 0.3)'         // default gray
};

// Palette for auto-detected rooms (more opaque)
const DETECTED_ROOM_PALETTE = [
    'rgba(147, 197, 253, 0.7)',   // blue
    'rgba(253, 224, 71, 0.7)',    // yellow
    'rgba(252, 165, 165, 0.7)',    // red
    'rgba(196, 181, 253, 0.7)',   // purple
    'rgba(163, 230, 53, 0.7)',    // green
    'rgba(251, 146, 60, 0.7)',    // orange
    'rgba(244, 114, 182, 0.7)',   // pink
    'rgba(156, 163, 175, 0.7)',   // gray
    'rgba(59, 130, 246, 0.7)',    // blue-alt
    'rgba(34, 197, 94, 0.7)',     // emerald
];

export const LayoutCanvas = forwardRef<LayoutCanvasRef, LayoutCanvasProps>(({
    onScaleChange,
    showMagicWires,
    onCalibrationFinished,
    isAddTextMode,
    onAddTextComplete,
    showWalls = true,
    showDoors = true,
    showWindows = true,
    showRooms = true,
    onSldConnectionResult,
    onCursorChange,
    onRequestNewPlan,
    inspectorOpen,
    loadSummaryVisible
}, ref) => {
    const stageRef = useRef<any>(null);
    const { theme, colors } = useTheme();
    const componentImages = useLayoutComponentImages();

    // Text editing state
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');

    // Layout store
    const {
        getCurrentFloorPlan,
        drawingState,
        setActiveTool,
        setSelectedComponentType,
        addWall,
        updateWall,
        addRoom,
        updateRoom,
        addDoor,
        updateDoor,
        addWindow,
        updateWindow,
        addComponent,
        addComponentWithId,
        addConnection,
        updateConnection,
        selectedElementIds,
        selectElement,
        selectElements,
        clearSelection,
        deleteSelected,
        updateViewport,
        updateFloorPlan,
        takeSnapshot,
        // Staging components
        removeStagingComponent,
        markStagingComponentPlaced,
        isStagingComponentPlaced,
        // OCR Settings
        ocrSettings,
        setOcrSettings
    } = useLayoutStore();

    const { showOcr, minConfidence: ocrMinConfidence, query: ocrQuery, showBoxes: showOcrBoxes } = ocrSettings;

    const currentPlan = getCurrentFloorPlan();

    useEffect(() => {
        if (!currentPlan) return;
        console.log('[LayoutCanvas] currentPlan calibration', {
            planId: currentPlan.id,
            pixelsPerMeter: currentPlan.pixelsPerMeter,
            measurementUnit: currentPlan.measurementUnit,
            isScaleCalibrated: currentPlan.isScaleCalibrated
        });
    }, [
        currentPlan?.id,
        currentPlan?.pixelsPerMeter,
        currentPlan?.measurementUnit,
        currentPlan?.isScaleCalibrated
    ]);

    // Local state
    const [scale, setScale] = useState(currentPlan?.scale || 0.5);
    const [position, setPosition] = useState({
        x: currentPlan?.viewportX || 0,
        y: currentPlan?.viewportY || 0
    });
    const [isDrawing, setIsDrawing] = useState(false);
    const [currentPath, setCurrentPath] = useState<Point[]>([]);
    const [selectionBox, setSelectionBox] = useState<{ start: Point; end: Point } | null>(null);
    const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
    const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
    const [connectionSource, setConnectionSource] = useState<string | null>(null);
    const [isCreatingSldConnection, setIsCreatingSldConnection] = useState(false);

    /** True while a sidebar item is being dragged over the canvas. Drives the drop hint. */
    const [isDragOver, setIsDragOver] = useState(false);

    /**
     * Live cursor position in world coordinates, for the status bar readout.
     * Kept out of `hoverInfo` because that one only exists while drafting.
     * Mirrored upward via onCursorChange so the status bar can render outside
     * the canvas without re-rendering the Konva stage on every mouse move.
     */
    const reportCursor = useCallback((point: Point | null) => {
        onCursorChange?.(point);
    }, [onCursorChange]);

    /**
     * The snap target under the drafting cursor, if any. Rendered as a marker so
     * the user can see they are about to join an existing corner or wall face
     * before they commit the click.
     */
    const [activeSnap, setActiveSnap] = useState<{ point: Point; type: 'endpoint' | 'wall' } | null>(null);

    /**
     * Held-modifier mirror. Konva only gives us modifier flags on its own
     * events, but wall drafting needs to know whether Shift is down while the
     * pointer merely moves, and Space needs to temporarily switch to panning.
     */
    const [shiftHeld, setShiftHeld] = useState(false);
    const [spaceHeld, setSpaceHeld] = useState(false);

    /**
     * Tool to restore when Space (temporary pan) is released.
     * A ref, not state, so the keyup handler always sees the latest value
     * without needing to re-bind the listener.
     */
    const toolBeforeSpaceRef = useRef<DrawingTool | null>(null);

    /**
     * Click handler shared by every selectable element.
     *
     * Shift+click extends the selection. The store has always supported
     * multi-select, but every canvas click hardcoded single-select, so the
     * capability was unreachable from the UI.
     */
    const handleElementClick = useCallback((id: string, e: any) => {
        // Placing components should not also select what you clicked over.
        if (drawingState.activeTool === 'component') return;
        if (e) e.cancelBubble = true;
        selectElement(id, Boolean(e?.evt?.shiftKey));
    }, [drawingState.activeTool, selectElement]);

    // HUD State
    const [hoverInfo, setHoverInfo] = useState<{ x: number, y: number, text: string } | null>(null);
    const [ocrHoverInfo, setOcrHoverInfo] = useState<{ x: number, y: number, text: string } | null>(null);

    const [selectedOcrId, setSelectedOcrId] = useState<string | null>(null);
    const [ocrCopied, setOcrCopied] = useState(false);

    useEffect(() => {
        if (!currentPlan) return;
        const nextScale = currentPlan.scale || 0.5;
        setScale(nextScale);
        setPosition({
            x: currentPlan.viewportX || 0,
            y: currentPlan.viewportY || 0
        });
        onScaleChange?.(nextScale);
    }, [currentPlan?.id, onScaleChange]);

    useEffect(() => {
        if (!currentPlan) return;

        const nextScale = currentPlan.scale || 0.5;
        const nextX = currentPlan.viewportX || 0;
        const nextY = currentPlan.viewportY || 0;

        setScale((prev) => (Math.abs(prev - nextScale) > 1e-6 ? nextScale : prev));
        setPosition((prev) => {
            if (Math.abs(prev.x - nextX) <= 1e-6 && Math.abs(prev.y - nextY) <= 1e-6) return prev;
            return { x: nextX, y: nextY };
        });
    }, [currentPlan?.scale, currentPlan?.viewportX, currentPlan?.viewportY]);

    useEffect(() => {
        if (!currentPlan) return;
        const t = window.setTimeout(() => {
            const hasChanged =
                Math.abs((currentPlan.scale || 0.5) - scale) > 0.001 ||
                Math.abs((currentPlan.viewportX || 0) - position.x) > 1 ||
                Math.abs((currentPlan.viewportY || 0) - position.y) > 1;

            if (hasChanged) {
                updateViewport(position.x, position.y, scale);
            }
        }, 120);
        return () => window.clearTimeout(t);
    }, [currentPlan?.id, currentPlan?.scale, currentPlan?.viewportX, currentPlan?.viewportY, position.x, position.y, scale, updateViewport]);

    // AUTO-CENTER NEW PLANS
    // If a plan is loaded and its viewport is roughly 0,0 (default), try to center it
    useEffect(() => {
        if (currentPlan && containerSize.width > 0 &&
            Math.abs(currentPlan.viewportX || 0) < 1 &&
            Math.abs(currentPlan.viewportY || 0) < 1 &&
            (currentPlan.walls.length > 0 || currentPlan.rooms.length > 0)) {

            // Use a slight delay to ensure container is ready
            setTimeout(() => {
                // Calculate center
                const padding = 50;
                const scaleX = (containerSize.width - padding * 2) / currentPlan.width;
                const scaleY = (containerSize.height - padding * 2) / currentPlan.height;
                const newScale = Math.min(scaleX, scaleY, 0.8); // 0.8 max scale for initial view

                const newPos = {
                    x: (containerSize.width - currentPlan.width * newScale) / 2,
                    y: (containerSize.height - currentPlan.height * newScale) / 2
                };

                setScale(newScale);
                setPosition(newPos);
                onScaleChange?.(newScale);

                // Save this initial viewport
                updateViewport(newPos.x, newPos.y, newScale);
            }, 100);
        }
    }, [currentPlan?.id, containerSize.width, containerSize.height]);

    // PHASE 3.1: Read SLD connectors for Magic Wire feature
    // Include ALL sheets to support cross-sheet connections
    const { sheets, addConnector } = useStore();
    const sldConnectors = sheets.flatMap(s => s.storedConnectors);
    const sldItems = sheets.flatMap(s => s.canvasItems);

    const createSynchronizedPointSwitchBoardConnection = async (
        firstComponent: LayoutComponent,
        secondComponent: LayoutComponent,
        routedPath: Point[]
    ) => {
        if (isCreatingSldConnection || !currentPlan) return;

        const switchBoard = isPointSwitchBoard(firstComponent)
            ? firstComponent
            : isPointSwitchBoard(secondComponent)
                ? secondComponent
                : null;
        const load = switchBoard?.id === firstComponent.id ? secondComponent : firstComponent;

        if (!switchBoard || !isConnectableLoad(load)) {
            onSldConnectionResult?.('error', 'Select one Point Switch Board and one load.');
            return;
        }

        const findLinkedSldItem = (component: LayoutComponent) => sheets
            .flatMap(sheet => sheet.canvasItems)
            .find(item => item.uniqueID === component.sldItemId || item.properties?.[0]?.['_layoutComponentId'] === component.id);

        const switchBoardSldItem = findLinkedSldItem(switchBoard);
        const loadSldItem = findLinkedSldItem(load);

        if (!switchBoardSldItem || !loadSldItem) {
            onSldConnectionResult?.('error', 'Place the Point Switch Board and load on the same SLD sheet before connecting them.');
            return;
        }

        const switchBoardSheet = sheets.find(sheet => sheet.canvasItems.some(item => item.uniqueID === switchBoardSldItem.uniqueID));
        const loadSheet = sheets.find(sheet => sheet.canvasItems.some(item => item.uniqueID === loadSldItem.uniqueID));

        if (!switchBoardSheet || !loadSheet || switchBoardSheet.sheetId !== loadSheet.sheetId) {
            onSldConnectionResult?.('error', 'The Point Switch Board and load must be on the same SLD sheet.');
            return;
        }

        const layoutPath = [switchBoard.position, ...routedPath.slice(1), load.position];
        const existingLayoutConnection = currentPlan.connections.find(connection =>
            (connection.sourceId === switchBoard.id && connection.targetId === load.id) ||
            (connection.sourceId === load.id && connection.targetId === switchBoard.id)
        );
        const ensureLayoutConnection = () => {
            if (existingLayoutConnection) {
                updateConnection(existingLayoutConnection.id, {
                    sourceId: switchBoard.id,
                    targetId: load.id,
                    path: layoutPath,
                    type: 'power'
                });
                return;
            }

            addConnection({
                sourceId: switchBoard.id,
                targetId: load.id,
                path: layoutPath,
                type: 'power'
            });
        };

        const existingSldConnection = switchBoardSheet.storedConnectors.find(connector =>
            connector.sourceItem.uniqueID === switchBoardSldItem.uniqueID &&
            connector.targetItem.uniqueID === loadSldItem.uniqueID
        );

        if (existingSldConnection) {
            ensureLayoutConnection();
            onSldConnectionResult?.('success', `Already connected in SLD via ${existingSldConnection.sourcePointKey}.`);
            return;
        }

        const outputPorts = Object.keys(switchBoardSldItem.connectionPoints || {})
            .filter(port => /^out[1-9]$/.test(port))
            .sort((first, second) => Number(first.slice(3)) - Number(second.slice(3)));
        const usedOutputPorts = new Set(
            switchBoardSheet.storedConnectors
                .filter(connector => connector.sourceItem.uniqueID === switchBoardSldItem.uniqueID)
                .map(connector => connector.sourcePointKey)
                .filter(port => outputPorts.includes(port))
        );
        const nextOutputPort = outputPorts.find(port => !usedOutputPorts.has(port));

        if (!nextOutputPort) {
            onSldConnectionResult?.('error', 'This Point Switch Board already uses all 9 outgoing connections.');
            return;
        }

        setIsCreatingSldConnection(true);
        try {
            const result = await createConnectorWithDefaults({
                activeSheet: switchBoardSheet,
                allSheets: sheets,
                sourceItem: switchBoardSldItem,
                sourcePointKey: nextOutputPort,
                targetItem: loadSldItem,
                targetPointKey: 'in',
                materialType: 'Wiring'
            });

            if (result.error || !result.connector) {
                onSldConnectionResult?.('error', result.error || 'Unable to create the SLD connection.');
                return;
            }

            addConnector(result.connector, switchBoardSheet.sheetId);
            ensureLayoutConnection();
            onSldConnectionResult?.('success', `Connected via ${nextOutputPort}; ${usedOutputPorts.size + 1} of 9 SLD outputs used.`);
        } catch (error) {
            console.error('[LayoutCanvas] Failed to create synchronized SLD connection', error);
            onSldConnectionResult?.('error', 'Unable to create the SLD connection. Please try again.');
        } finally {
            setIsCreatingSldConnection(false);
        }
    };

    // Context Menu State
    const [menu, setMenu] = useState<{ visible: boolean; x: number; y: number; componentId: string | null }>({
        visible: false,
        x: 0,
        y: 0,
        componentId: null
    });

    // PHASE 3.2: Derive magic wires from SLD connectors
    // Build position map and filter to only placed components
    const magicWires = useMemo(() => {
        if (!showMagicWires || !currentPlan || sldConnectors.length === 0) return [];

        // Build layoutId → position map from current plan components
        // Components are rendered with their position as the CENTER (using Konva offset)
        // So we use the position directly
        const layoutPosById = new Map<string, { x: number; y: number }>();
        for (const comp of currentPlan.components) {
            // Position IS the center point (components are rendered with offset)
            layoutPosById.set(comp.id, {
                x: comp.position.x,
                y: comp.position.y
            });
        }

        // Map SLD connectors to Layout wires
        const wires: Array<{
            sourcePos: { x: number; y: number };
            targetPos: { x: number; y: number };
            key: string;
            color: string;
            sourceId: string;
            targetId: string;
        }> = [];

        for (let i = 0; i < sldConnectors.length; i++) {
            const connector = sldConnectors[i] as Connector;
            const srcLayoutId = connector.sourceItem?.properties?.[0]?.['_layoutComponentId'];
            const dstLayoutId = connector.targetItem?.properties?.[0]?.['_layoutComponentId'];

            if (!srcLayoutId || !dstLayoutId) continue;

            const srcPos = layoutPosById.get(srcLayoutId);
            const dstPos = layoutPosById.get(dstLayoutId);

            if (!srcPos || !dstPos) continue; // One or both not placed

            wires.push({
                sourcePos: srcPos,
                targetPos: dstPos,
                key: `${srcLayoutId}-${dstLayoutId}-${connector.sourcePointKey}-${connector.targetPointKey}-${i}`,
                color: getSldConnectorColor(connector, theme, sldConnectors, sldItems),
                sourceId: srcLayoutId,
                targetId: dstLayoutId
            });
        }

        return wires;
    }, [currentPlan?.components, sldConnectors, sldItems, showMagicWires, theme]);

    // Connection highlight: when a placed component is selected, emphasize its
    // incoming/outgoing wires (layout connections + magic SLD wires) and dim
    // everything else so the path is easy to trace.
    const connectionHighlight = useMemo(() => {
        const empty = {
            selectedComponentIds: [] as string[],
            highlightedConnectionIds: new Set<string>(),
            highlightedMagicWireKeys: new Set<string>(),
            neighbourComponentIds: new Set<string>(),
            hasHighlight: false
        };
        if (!currentPlan || selectedElementIds.length === 0) return empty;

        const componentIds = new Set(currentPlan.components.map(c => c.id));
        const selectedComponentIds = selectedElementIds.filter(id => componentIds.has(id));
        if (selectedComponentIds.length === 0) return empty;
        const selectedSet = new Set(selectedComponentIds);

        const highlightedConnectionIds = new Set<string>();
        const neighbourComponentIds = new Set<string>();
        for (const conn of currentPlan.connections) {
            const touchesSource = selectedSet.has(conn.sourceId);
            const touchesTarget = selectedSet.has(conn.targetId);
            if (touchesSource || touchesTarget) {
                highlightedConnectionIds.add(conn.id);
                // The "other end" of the wire — used to outline the neighbour
                // component so the user sees from where to where it connects.
                if (!selectedSet.has(conn.sourceId)) neighbourComponentIds.add(conn.sourceId);
                if (!selectedSet.has(conn.targetId)) neighbourComponentIds.add(conn.targetId);
            }
        }

        const highlightedMagicWireKeys = new Set<string>();
        for (const wire of magicWires) {
            if (selectedSet.has(wire.sourceId) || selectedSet.has(wire.targetId)) {
                highlightedMagicWireKeys.add(wire.key);
                if (!selectedSet.has(wire.sourceId)) neighbourComponentIds.add(wire.sourceId);
                if (!selectedSet.has(wire.targetId)) neighbourComponentIds.add(wire.targetId);
            }
        }

        const hasHighlight = highlightedConnectionIds.size > 0 || highlightedMagicWireKeys.size > 0;
        // No wires for this item — keep the canvas as-is instead of dimming all.
        if (!hasHighlight) return empty;

        return {
            selectedComponentIds,
            highlightedConnectionIds,
            highlightedMagicWireKeys,
            neighbourComponentIds,
            hasHighlight: true
        };
    }, [currentPlan, selectedElementIds, magicWires]);

    // Container ref for size
    const containerRef = useRef<HTMLDivElement>(null);

    // Update container size
    useEffect(() => {
        const updateSize = () => {
            if (containerRef.current) {
                setContainerSize({
                    width: containerRef.current.offsetWidth,
                    height: containerRef.current.offsetHeight
                });
            }
        };

        updateSize();
        window.addEventListener('resize', updateSize);
        return () => window.removeEventListener('resize', updateSize);
    }, []);

    // Load background image from IndexedDB
    useEffect(() => {
        if (currentPlan?.backgroundImageId) {
            layoutImageStore.getImageAsDataUrl(currentPlan.backgroundImageId)
                .then(dataUrl => {
                    if (dataUrl) {
                        const img = new window.Image();
                        img.src = dataUrl;
                        img.onload = () => setBackgroundImage(img);
                    }
                })
                .catch(console.error);
        } else {
            setBackgroundImage(null);
        }
    }, [currentPlan?.backgroundImageId]);

    // Auto-focus on mount if selection exists (Teleport support)
    useEffect(() => {
        // We only focus if there is exactly one item selected (likely via Teleport)
        if (selectedElementIds.length === 1 && currentPlan) {
            const compId = selectedElementIds[0];
            const comp = currentPlan.components.find(c => c.id === compId);
            if (comp) {
                // Defer slightly to allow container size to settle
                setTimeout(() => {
                    const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
                    const w = def?.size?.width || 24;
                    const h = def?.size?.height || 24;
                    const cx = comp.position.x + w / 2;
                    const cy = comp.position.y + h / 2;

                    // Use current container size (or fallback)
                    // Accessing ref directly to get latest size if state is stale
                    const stageW = containerRef.current?.offsetWidth || 800;
                    const stageH = containerRef.current?.offsetHeight || 600;

                    const targetScale = 1.0;
                    setScale(targetScale);
                    onScaleChange?.(targetScale);

                    setPosition({
                        x: stageW / 2 - cx * targetScale,
                        y: stageH / 2 - cy * targetScale
                    });
                }, 100);
            }
        }
    }, []); // Run only once on mount

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
        saveImage: () => {
            if (!stageRef.current || !currentPlan) return;
            try {
                const stage = stageRef.current.getStage();

                const oldScaleX = stage.scaleX();
                const oldScaleY = stage.scaleY();
                const oldPos = stage.position();

                stage.scale({ x: 1, y: 1 });
                stage.position({ x: 0, y: 0 });
                stage.batchDraw();

                const dataUrl = stage.toDataURL({
                    x: 0,
                    y: 0,
                    width: currentPlan.width,
                    height: currentPlan.height,
                    pixelRatio: 2,
                    mimeType: 'image/png'
                });

                stage.scale({ x: oldScaleX, y: oldScaleY });
                stage.position(oldPos);
                stage.batchDraw();

                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = `${currentPlan.name || 'layout'}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            } catch (e) {
                console.error('[LayoutCanvas] saveImage failed:', e);
                alert('Failed to export image.');
            }
        },
        captureSnapshot: async () => {
            if (!stageRef.current || !currentPlan) return '';

            const stage = stageRef.current.getStage();
            const oldScaleX = stage.scaleX();
            const oldScaleY = stage.scaleY();
            const oldPosition = stage.position();

            try {
                stage.scale({ x: 1, y: 1 });
                stage.position({ x: 0, y: 0 });
                stage.batchDraw();
                return stage.toDataURL({
                    x: 0,
                    y: 0,
                    width: currentPlan.width,
                    height: currentPlan.height,
                    pixelRatio: 2,
                    mimeType: 'image/png'
                });
            } catch (error) {
                console.error('[LayoutCanvas] captureSnapshot failed:', error);
                return '';
            } finally {
                stage.scale({ x: oldScaleX, y: oldScaleY });
                stage.position(oldPosition);
                stage.batchDraw();
            }
        },
        zoomIn: () => {
            const newScale = Math.min(scale * 1.2, 3);
            setScale(newScale);
            onScaleChange?.(newScale);
        },
        zoomOut: () => {
            const newScale = Math.max(scale / 1.2, 0.1);
            setScale(newScale);
            onScaleChange?.(newScale);
        },
        resetZoom: () => {
            setScale(0.5);
            setPosition({ x: 0, y: 0 });
            onScaleChange?.(0.5);
        },
        setZoom: (newScale: number) => {
            setScale(newScale);
            onScaleChange?.(newScale);
        },
        fitView: () => {
            if (!currentPlan) return;
            const padding = 50;
            const scaleX = (containerSize.width - padding * 2) / currentPlan.width;
            const scaleY = (containerSize.height - padding * 2) / currentPlan.height;
            const newScale = Math.min(scaleX, scaleY, 1);

            setScale(newScale);
            setPosition({
                x: (containerSize.width - currentPlan.width * newScale) / 2,
                y: (containerSize.height - currentPlan.height * newScale) / 2
            });
            onScaleChange?.(newScale);
        }
    }));

    // Handle wheel zoom
    const handleWheel = useCallback((e: any) => {
        e.evt.preventDefault();

        const scaleBy = 1.1;
        const stage = stageRef.current;
        const oldScale = scale;

        const pointer = stage.getPointerPosition();
        const mousePointTo = {
            x: (pointer.x - position.x) / oldScale,
            y: (pointer.y - position.y) / oldScale
        };

        const direction = e.evt.deltaY > 0 ? -1 : 1;
        const newScale = direction > 0
            ? Math.min(oldScale * scaleBy, 3)
            : Math.max(oldScale / scaleBy, 0.1);

        setScale(newScale);
        setPosition({
            x: pointer.x - mousePointTo.x * newScale,
            y: pointer.y - mousePointTo.y * newScale
        });
        onScaleChange?.(newScale);
    }, [scale, position, onScaleChange]);

    // Get canvas position from stage event
    const getCanvasPoint = (e: any): Point => {
        const stage = stageRef.current;
        const pointer = stage.getPointerPosition();

        const x = (pointer.x - position.x) / scale;
        const y = (pointer.y - position.y) / scale;

        return { x, y };
    };

    /**
     * Every element on the plan that a marquee touches.
     *
     * Uses "touch" semantics (overlap, not containment) — see boundsIntersect.
     * Rooms are the exception: they are large background fills, so requiring the
     * marquee centre to fall inside them avoids selecting a whole room every
     * time the user drags a small box over a socket that happens to sit in it.
     */
    const collectElementsInBox = useCallback((box: Bounds): string[] => {
        if (!currentPlan) return [];

        const ids: string[] = [];
        const ppm = currentPlan.pixelsPerMeter || 50;

        for (const wall of currentPlan.walls) {
            const bounds = boundsFromPoints([wall.startPoint, wall.endPoint]);
            // A perfectly axis-aligned wall has zero extent on one axis, so pad
            // by half its thickness to keep it hit-testable.
            if (bounds) {
                const pad = Math.max(2, wall.thickness / 2);
                if (boundsIntersect(box, {
                    x1: bounds.x1 - pad,
                    y1: bounds.y1 - pad,
                    x2: bounds.x2 + pad,
                    y2: bounds.y2 + pad
                })) {
                    ids.push(wall.id);
                }
            }
        }

        for (const door of currentPlan.doors) {
            const half = Math.max(6, door.width / 2);
            if (boundsIntersect(box, boundsAroundPoint(door.position, half, half))) {
                ids.push(door.id);
            }
        }

        for (const win of currentPlan.windows) {
            const halfW = Math.max(6, win.width / 2);
            const halfH = Math.max(6, win.height / 2);
            if (boundsIntersect(box, boundsAroundPoint(win.position, halfW, halfH))) {
                ids.push(win.id);
            }
        }

        for (const comp of currentPlan.components) {
            const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
            const size = def?.realSizeMm
                ? getScaledComponentSize(comp.type, ppm)
                : (def?.size ?? { width: 24, height: 24 });
            if (boundsIntersect(box, boundsAroundPoint(comp.position, size.width / 2, size.height / 2))) {
                ids.push(comp.id);
            }
        }

        for (const textItem of currentPlan.textItems || []) {
            const width = textItem.width ?? Math.max(20, textItem.text.length * (textItem.fontSize || 14) * 0.6);
            const height = textItem.fontSize || 14;
            if (boundsIntersect(box, {
                x1: textItem.position.x,
                y1: textItem.position.y,
                x2: textItem.position.x + width,
                y2: textItem.position.y + height
            })) {
                ids.push(textItem.id);
            }
        }

        // Rooms: require the marquee centre to land inside the polygon.
        const boxCenter = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
        for (const room of currentPlan.rooms) {
            if (isPointInRoom(boxCenter, room)) {
                ids.push(room.id);
            }
        }

        return ids;
    }, [currentPlan]);

    /**
     * Apply drafting aids to a raw cursor position.
     *
     * Order matters: an explicit angle constraint (Shift) wins over snapping,
     * because the user asking for a clean 90° wall does not want it yanked a few
     * pixels sideways onto a nearby corner.
     */
    const applyWallDraftingAids = useCallback((raw: Point, origin: Point | null): Point => {
        if (origin && shiftHeld) {
            return constrainWallAngle(origin, raw, 45);
        }

        if (currentPlan) {
            const snap = resolveDraftingSnap(raw, currentPlan.walls, 14 / Math.max(scale, 0.1), 10 / Math.max(scale, 0.1));
            if (snap) return snap.point;
        }

        return raw;
    }, [currentPlan, shiftHeld, scale]);

    const projectPointToWall = (p: Point, wall: Wall): Point => {
        const ax = wall.startPoint.x;
        const ay = wall.startPoint.y;
        const bx = wall.endPoint.x;
        const by = wall.endPoint.y;

        const abx = bx - ax;
        const aby = by - ay;
        const apx = p.x - ax;
        const apy = p.y - ay;
        const denom = abx * abx + aby * aby;
        if (denom <= 1e-6) return { x: ax, y: ay };
        let t = (apx * abx + apy * aby) / denom;
        t = Math.max(0, Math.min(1, t));
        return { x: ax + t * abx, y: ay + t * aby };
    };

    const getWallUnitVector = (wall: Wall): Point => {
        const dx = wall.endPoint.x - wall.startPoint.x;
        const dy = wall.endPoint.y - wall.startPoint.y;
        const len = Math.hypot(dx, dy);
        if (len <= 1e-6) return { x: 1, y: 0 };
        return { x: dx / len, y: dy / len };
    };

    // Handle mouse down on stage
    const handleMouseDown = (e: any) => {
        const rawPoint = getCanvasPoint(e);
        const point = rawPoint;
        const tool = drawingState.activeTool;

        // Space-to-pan takes priority over whatever tool is active.
        if (tool === 'pan' || spaceHeld) {
            // Pan is handled by draggable stage
            return;
        }

        // Text mode - click to add text box
        if (isAddTextMode && currentPlan) {
            takeSnapshot();
            const newTextItem = {
                id: `text-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                text: 'Text',
                position: point,
                fontSize: 14,
                fontFamily: 'Arial',
                color: theme === 'dark' ? '#ffffff' : '#000000',
                align: 'left' as const,
                width: 100
            };
            updateFloorPlan(currentPlan.id, {
                textItems: [...(currentPlan.textItems || []), newTextItem]
            });
            onAddTextComplete?.();
            return;
        }

        // Selection Tool Logic
        if (tool === 'select') {
            // Clicking empty canvas starts a rubber-band marquee. The selection
            // itself is not cleared yet: that happens on mouse-up only if the
            // drag turned out to be a click (zero-area box). Clearing here would
            // make Shift+drag-to-add impossible.
            const isBackground = e.target === e.target.getStage() || e.target.name() === 'grid-background';
            if (isBackground) {
                setSelectionBox({ start: point, end: point });
            }
            return;
        }

        if (tool === 'pick') {
            if (currentPlan) {
                // Simple hit detection for walls
                // We reuse snapToWall or closestPoint on wall logic, but here we just need to know if we clicked NEAR a wall
                const snap = snapToWall(point, currentPlan.walls, 20); // 20px tolerance
                if (snap) {
                    const { setWallThickness, setActiveTool } = useLayoutStore.getState();
                    setWallThickness(snap.wall.thickness);
                    setActiveTool('wall'); // Switch back to wall tool immediately
                    // Optional: Show some feedback
                }
            }
            return;
        }

        if (tool === 'wall') {
            if (!isDrawing) {
                // Snap the start point too, so chains begin exactly on corners.
                const start = applyWallDraftingAids(rawPoint, null);
                setIsDrawing(true);
                setCurrentPath([start]);
            } else {
                // Complete wall
                if (currentPath.length > 0) {
                    const start = currentPath[0];
                    const end = applyWallDraftingAids(rawPoint, start);

                    // Prevent zero length walls
                    if (Math.hypot(end.x - start.x, end.y - start.y) > 5) {
                        addWall({
                            startPoint: start,
                            endPoint: end,
                            thickness: drawingState.wallThickness ?? 10
                        });

                        if (drawingState.continuousWallMode) {
                            // CONTINUOUS DRAWING: Start next segment from end point
                            setCurrentPath([end]);
                        } else {
                            // SINGLE LINE MODE: Stop drawing
                            setIsDrawing(false);
                            setCurrentPath([]);
                        }
                    }
                }
            }
            return;
        }

        if (tool === 'room') {
            if (!isDrawing) {
                setIsDrawing(true);
                setCurrentPath([point]);
            } else {
                // Add point to room polygon
                setCurrentPath([...currentPath, point]);
            }
            return;
        }

        if (tool === 'door' || tool === 'window') {
            // Find wall at click point
            if (currentPlan) {
                const snapInfo = snapToWall(point, currentPlan.walls);
                if (snapInfo) {
                    const wallAngle = Math.atan2(
                        snapInfo.wall.endPoint.y - snapInfo.wall.startPoint.y,
                        snapInfo.wall.endPoint.x - snapInfo.wall.startPoint.x
                    ) * 180 / Math.PI;
                    if (tool === 'door') {
                        addDoor({
                            position: snapInfo.snapPoint,
                            width: 40,
                            wallId: snapInfo.wall.id,
                            rotation: wallAngle,
                            type: 'single'
                        });
                    } else {
                        addWindow({
                            position: snapInfo.snapPoint,
                            width: 50,
                            height: 20,
                            wallId: snapInfo.wall.id,
                            rotation: wallAngle
                        });
                    }
                }
            }
            return;
        }

        if (tool === 'component' && drawingState.selectedComponentType) {
            let placePos = point;
            let rotation = 0;

            // Smart Snap to Wall
            // If we are close to a wall, snap to it and align rotation.
            // Room-side fittings (bulb perpendicular; tube, boards, AC and
            // geyser offset into the served room) seat off the wall face —
            // dragging across a partition wall re-seats them to the new side.
            if (currentPlan) {
                const snapInfo = snapToWall(point, currentPlan.walls, 25); // 25px tolerance
                if (snapInfo) {
                    const compType = drawingState.selectedComponentType;
                    if (needsWallSeating(compType)) {
                        const ppm = currentPlan.pixelsPerMeter || 50;
                        const roomHit = findRoomForPoint(point, currentPlan.rooms)
                            ?? findRoomForPoint(snapInfo.snapPoint, currentPlan.rooms);
                        const oriented = orientComponentOnWall(compType, snapInfo.snapPoint, snapInfo.wall, {
                            roomInterior: roomHit ? getRoomInteriorPoint(roomHit.room) : null,
                            approach: { x: point.x - snapInfo.snapPoint.x, y: point.y - snapInfo.snapPoint.y },
                            pixelsPerMeter: ppm
                        });
                        placePos = oriented.position;
                        rotation = oriented.rotation;
                    } else {
                        placePos = snapInfo.snapPoint;

                        // Calculate wall angle
                        const wallAngle = Math.atan2(
                            snapInfo.wall.endPoint.y - snapInfo.wall.startPoint.y,
                            snapInfo.wall.endPoint.x - snapInfo.wall.startPoint.x
                        ) * 180 / Math.PI;

                        rotation = wallAngle;
                    }
                }
            }

            addComponent({
                type: drawingState.selectedComponentType,
                position: placePos,
                rotation: rotation,
                properties: {},
                roomId: currentPlan ? findRoomForPoint(placePos, currentPlan.rooms)?.room.id : undefined
            });
            return;
        }

        if (tool === 'connection') {
            // Find component at click point
            if (currentPlan) {
                const clickedComponent = currentPlan.components.find(comp => {
                    const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
                    const radius = def.size.width / 2;
                    const dx = point.x - comp.position.x;
                    const dy = point.y - comp.position.y;
                    return Math.sqrt(dx * dx + dy * dy) <= radius + 5;
                });

                if (clickedComponent) {
                    if (!isDrawing) {
                        // First click - start connection from this component
                        setIsDrawing(true);
                        setCurrentPath([clickedComponent.position]);
                        setConnectionSource(clickedComponent.id);
                    } else if (connectionSource && clickedComponent.id !== connectionSource) {
                        // Second click on different component - complete connection
                        const sourceComponent = currentPlan.components.find(component => component.id === connectionSource);
                        if (!sourceComponent) {
                            setIsDrawing(false);
                            setCurrentPath([]);
                            setConnectionSource(null);
                            return;
                        }
                        void createSynchronizedPointSwitchBoardConnection(sourceComponent, clickedComponent, currentPath);
                        setIsDrawing(false);
                        setCurrentPath([]);
                        setConnectionSource(null);
                    }
                } else if (isDrawing) {
                    // Click on empty space - add waypoint
                    setCurrentPath([...currentPath, point]);
                }
            }
            return;
        }

        if (tool === 'calibrate') {
            if (!isDrawing) {
                setIsDrawing(true);
                setCurrentPath([point]);
            } else {
                // Complete calibration line
                const start = currentPath[0];
                const end = point;
                const length = Math.hypot(end.x - start.x, end.y - start.y);

                if (length > 5) {
                    onCalibrationFinished?.(length);
                    setIsDrawing(false);
                    setCurrentPath([]);
                }
            }
            return;
        }
    };

    // Handle mouse move
    const handleMouseMove = (e: any) => {
        const point = getCanvasPoint(e);
        const tool = drawingState.activeTool;

        // Status-bar coordinate readout, always live.
        reportCursor(point);

        // Rubber-band marquee in progress.
        if (selectionBox) {
            setSelectionBox({ start: selectionBox.start, end: point });
            setHoverInfo(null);
            return;
        }

        // Snap preview for the drafting tools. Shown even before the first click
        // so the user knows where a wall will begin, not just where it will end.
        if ((tool === 'wall' || tool === 'door' || tool === 'window' || tool === 'component') && currentPlan) {
            if (tool === 'wall' && isDrawing && shiftHeld) {
                // Angle-constrained: no snap marker, the constraint is the aid.
                setActiveSnap(null);
            } else {
                const tolerance = 14 / Math.max(scale, 0.1);
                const snap = resolveDraftingSnap(point, currentPlan.walls, tolerance, tolerance * 0.75);
                setActiveSnap(snap);
            }
        } else if (activeSnap) {
            setActiveSnap(null);
        }

        if (!isDrawing) {
            setHoverInfo(null);
            return;
        }

        if (tool === 'wall' && currentPath.length > 0) {
            const start = currentPath[0];
            const end = applyWallDraftingAids(point, start);
            setCurrentPath([start, end]);

            // Update HUD
            const pxLen = Math.hypot(end.x - start.x, end.y - start.y);
            const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
            const normalizedAngle = (angle < 0 ? angle + 360 : angle).toFixed(1);
            const unit = currentPlan?.measurementUnit || 'm';
            const label = `${getDistanceLabelWithUnit(pxLen, currentPlan?.pixelsPerMeter || 50, unit)} | ${normalizedAngle}°${shiftHeld ? ' · 45° lock' : ''}`;

            // Screen coordinates for HUD
            const stage = stageRef.current;
            if (stage) {
                const pointerPos = stage.getPointerPosition();
                if (pointerPos) {
                    setHoverInfo({
                        x: pointerPos.x + 20,
                        y: pointerPos.y + 20,
                        text: label
                    });
                }
            }
        } else if (tool === 'room' && currentPath.length > 0) {
            // Live preview of the segment being added to the polygon, plus a
            // running vertex count so the user knows when close is possible.
            const stage = stageRef.current;
            if (stage) {
                const pointerPos = stage.getPointerPosition();
                if (pointerPos) {
                    setHoverInfo({
                        x: pointerPos.x + 20,
                        y: pointerPos.y + 20,
                        text: currentPath.length >= 3
                            ? `${currentPath.length} corners · double-click or Enter to close`
                            : `${currentPath.length} corner${currentPath.length === 1 ? '' : 's'} · need 3 to close`
                    });
                }
            }
        } else if (tool === 'calibrate' && currentPath.length > 0) {
            const start = currentPath[0];
            const end = point;
            setCurrentPath([start, end]);

            // HUD for calibration
            const pxLen = Math.hypot(end.x - start.x, end.y - start.y);
            const label = `${pxLen.toFixed(0)} px`;

            // Screen coordinates for HUD
            const stage = stageRef.current;
            if (stage) {
                const pointerPos = stage.getPointerPosition();
                if (pointerPos) {
                    setHoverInfo({
                        x: pointerPos.x + 20,
                        y: pointerPos.y + 20,
                        text: label
                    });
                }
            }
        } else {
            setHoverInfo(null);
        }
    };

    /**
     * Finish a rubber-band marquee.
     *
     * A near-zero-area box means the user clicked rather than dragged, which is
     * the signal to clear the selection. This is why mouse-down no longer clears
     * eagerly — doing so broke Shift+drag additive selection.
     */
    const handleMouseUp = (e: any) => {
        if (!selectionBox) return;

        const box = normalizeBounds(selectionBox.start, selectionBox.end);
        setSelectionBox(null);

        // Threshold in world units, scale-corrected so the feel is the same at
        // any zoom level.
        const clickThreshold = 16 / Math.max(scale, 0.1);
        const isClick = boundsArea(box) < clickThreshold * clickThreshold;

        if (isClick) {
            clearSelection();
            return;
        }

        const additive = Boolean(e?.evt?.shiftKey) || shiftHeld;
        const ids = collectElementsInBox(box);

        if (ids.length > 0) {
            selectElements(ids, additive);
        } else if (!additive) {
            clearSelection();
        }
    };

    /**
     * Close the in-progress room polygon.
     *
     * Shared by double-click and Enter. Double-click alone was undiscoverable
     * and awkward to hit accurately at low zoom.
     */
    const completeRoomPolygon = useCallback(() => {
        if (currentPath.length < 3) return;

        addRoom({
            name: `Room ${(currentPlan?.rooms.length || 0) + 1}`,
            polygon: currentPath,
            type: 'other'
        });
        setIsDrawing(false);
        setCurrentPath([]);
    }, [addRoom, currentPath, currentPlan?.rooms.length]);

    // Handle double click (complete room polygon)
    const handleDoubleClick = (_e: any) => {
        if (drawingState.activeTool === 'room' && currentPath.length >= 3) {
            completeRoomPolygon();
        }
    };

    /**
     * Cancel whatever is in progress, one step at a time.
     *
     * Escape used to always jump back to the select tool, which meant losing
     * your place in the middle of drawing a long wall chain. Now the first
     * Escape abandons the current geometry and keeps the tool, and a second
     * Escape (with nothing in progress) returns to select.
     */
    const cancelCurrentAction = useCallback(() => {
        if (isDrawing || currentPath.length > 0) {
            setIsDrawing(false);
            setCurrentPath([]);
            setConnectionSource(null);
            setHoverInfo(null);
            return;
        }

        if (selectionBox) {
            setSelectionBox(null);
            return;
        }

        if (drawingState.activeTool !== 'select') {
            setActiveTool('select');
            // Also disarm component placement, otherwise re-picking the select
            // tool later could resume dropping the previously chosen symbol.
            setSelectedComponentType(undefined);
            return;
        }

        clearSelection();
    }, [
        isDrawing,
        currentPath.length,
        selectionBox,
        drawingState.activeTool,
        setActiveTool,
        setSelectedComponentType,
        clearSelection
    ]);

    // Canvas-local keyboard handling.
    //
    // Deliberately narrow: element deletion, undo/redo, copy/paste and tool
    // switching all live in LayoutDesigner so there is a single owner for each
    // shortcut. This handler previously also bound Delete, which double-fired
    // with LayoutDesigner's handler and had no input-focus guard, so pressing
    // Backspace while typing in a text box deleted canvas geometry.
    useEffect(() => {
        const isTypingTarget = (target: EventTarget | null) => {
            const el = target as HTMLElement | null;
            if (!el) return false;
            const tag = el.tagName?.toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (isTypingTarget(e.target)) return;

            if (e.key === 'Shift') {
                setShiftHeld(true);
                return;
            }

            // Space = temporary pan, the convention in every drafting tool.
            // Remembers the previous tool so releasing Space restores it.
            if (e.code === 'Space' && !e.repeat) {
                e.preventDefault();
                setSpaceHeld(true);
                if (drawingState.activeTool !== 'pan') {
                    toolBeforeSpaceRef.current = drawingState.activeTool;
                    setActiveTool('pan');
                }
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                cancelCurrentAction();
                return;
            }

            if (e.key === 'Enter' && drawingState.activeTool === 'room' && currentPath.length >= 3) {
                e.preventDefault();
                completeRoomPolygon();
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Shift') {
                setShiftHeld(false);
                return;
            }

            if (e.code === 'Space') {
                setSpaceHeld(false);
                const previous = toolBeforeSpaceRef.current;
                toolBeforeSpaceRef.current = null;
                if (previous) setActiveTool(previous);
            }
        };

        // Releasing the modifier while the window is unfocused would otherwise
        // leave us stuck in pan mode.
        const handleBlur = () => {
            setShiftHeld(false);
            if (spaceHeld) {
                setSpaceHeld(false);
                const previous = toolBeforeSpaceRef.current;
                toolBeforeSpaceRef.current = null;
                if (previous) setActiveTool(previous);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, [
        cancelCurrentAction,
        completeRoomPolygon,
        currentPath.length,
        drawingState.activeTool,
        setActiveTool,
        spaceHeld
    ]);

    // Render grid
    // Render grid - DISABLED (User requested removal)
    const renderGrid = () => {
        return null;
    };

    const normalizedOcrQuery = ocrQuery.trim().toLowerCase();

    const filteredOcrItems = useMemo(() => {
        if (!currentPlan?.ocr?.enabled || !currentPlan.ocr.items) return [] as OcrItem[];
        const minConf = Number.isFinite(ocrMinConfidence) ? (ocrMinConfidence / 100) : 0;
        const q = normalizedOcrQuery;
        return currentPlan.ocr.items.filter(it => {
            const conf = (it.confidence ?? 0) / 100;
            if (conf < minConf) return false;
            if (!q) return true;
            return (it.text || '').toLowerCase().includes(q);
        });
    }, [currentPlan?.ocr?.enabled, currentPlan?.ocr?.items, ocrMinConfidence, normalizedOcrQuery]);

    const visibleOcrItems = useMemo(() => {
        if (!filteredOcrItems || filteredOcrItems.length === 0) return [] as OcrItem[];

        const ordered = [...filteredOcrItems].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        const picked: OcrItem[] = [];
        const minDist = Math.max(10, 18 * (scale > 1e-6 ? (1 / scale) : 1));

        for (const it of ordered) {
            const cx = it.center.x;
            const cy = it.center.y;

            let ok = true;
            for (const p of picked) {
                const dx = cx - p.center.x;
                const dy = cy - p.center.y;
                if ((dx * dx + dy * dy) < (minDist * minDist)) {
                    ok = false;
                    break;
                }
            }
            if (ok) picked.push(it);
        }

        return picked;
    }, [filteredOcrItems, scale]);

    const renderOcrOverlay = () => {
        if (!currentPlan?.ocr?.enabled) return null;
        if (!showOcr) return null;
        if (!visibleOcrItems || visibleOcrItems.length === 0) return null;

        const invScale = scale > 1e-6 ? (1 / scale) : 1;
        const fontSize = Math.max(8, Math.min(16, 12 * invScale));
        const pad = 2 * invScale;
        const strokeW = 1 * invScale;

        const toScreen = (p: { x: number; y: number }) => ({
            x: p.x * scale + position.x,
            y: p.y * scale + position.y
        });

        return visibleOcrItems.map((it) => {
            const isSelected = selectedOcrId === it.id;
            const bbox = it.bbox;
            const x = it.center.x;
            const y = it.center.y;
            const bgFill = theme === 'dark' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.75)';
            const textFill = theme === 'dark' ? '#f9fafb' : '#111827';
            const accent = isSelected ? '#3b82f6' : '#10b981';

            const handleEnter = () => {
                const stage = stageRef.current?.getStage?.();
                const pointer = stage?.getPointerPosition?.();
                if (pointer) {
                    setOcrHoverInfo({ x: pointer.x + 16, y: pointer.y + 16, text: it.text });
                } else {
                    const p = toScreen({ x, y });
                    setOcrHoverInfo({ x: p.x + 16, y: p.y + 16, text: it.text });
                }
            };

            const handleMove = () => {
                const stage = stageRef.current?.getStage?.();
                const pointer = stage?.getPointerPosition?.();
                if (!pointer) return;
                setOcrHoverInfo({ x: pointer.x + 16, y: pointer.y + 16, text: it.text });
            };

            const handleLeave = () => setOcrHoverInfo(null);

            const handleClick = async () => {
                setSelectedOcrId(it.id);
                try {
                    await navigator.clipboard.writeText(it.text);
                    const stage = stageRef.current?.getStage?.();
                    const pointer = stage?.getPointerPosition?.();
                    if (pointer) {
                        setOcrHoverInfo({ x: pointer.x + 16, y: pointer.y + 16, text: `Copied: ${it.text}` });
                        window.setTimeout(() => setOcrHoverInfo(null), 1200);
                    }
                } catch {
                }
            };

            return (
                <Group
                    key={it.id}
                    onMouseEnter={handleEnter}
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                    onClick={handleClick}
                >
                    {showOcrBoxes && (
                        <Rect
                            x={bbox.x1}
                            y={bbox.y1}
                            width={Math.max(0, bbox.x2 - bbox.x1)}
                            height={Math.max(0, bbox.y2 - bbox.y1)}
                            stroke={accent}
                            strokeWidth={strokeW}
                            dash={[4 * invScale, 3 * invScale]}
                            listening={false}
                        />
                    )}

                    <Rect
                        x={x - 2}
                        y={y - fontSize / 2 - pad}
                        width={Math.max(40 * invScale, (it.text.length * (fontSize * 0.6)) + (pad * 2))}
                        height={fontSize + pad * 2}
                        fill={bgFill}
                        stroke={accent}
                        strokeWidth={strokeW}
                        cornerRadius={3 * invScale}
                        opacity={isSelected ? 0.95 : 0.7}
                        listening={false}
                    />

                    <Text
                        x={x}
                        y={y - fontSize / 2}
                        text={it.text}
                        fontSize={fontSize}
                        fill={textFill}
                        align="left"
                        listening={false}
                    />
                </Group>
            );
        });
    };

    // Render rooms
    const renderRooms = () => {
        if (!currentPlan) return null;

        return currentPlan.rooms.map((room, idx) => {
            const points = room.polygon.flatMap(p => [p.x, p.y]);
            const centroid = getRoomCentroid(room);
            const isSelected = selectedElementIds.includes(room.id);
            // Always use palette for detected rooms unless a custom color is set (ignore room.type)
            const fillColor = room.color || DETECTED_ROOM_PALETTE[idx % DETECTED_ROOM_PALETTE.length];

            const unit = currentPlan.measurementUnit || 'm';
            const showArea = Boolean(
                currentPlan.isScaleCalibrated ||
                unit === 'ft' ||
                Math.abs((currentPlan.pixelsPerMeter || 50) - 50) > 1e-6
            );
            const areaLabel = showArea
                ? getAreaLabel(calculateRoomArea(room), currentPlan.pixelsPerMeter || 50, unit)
                : '';

            return (
                <Group key={room.id} onClick={(e) => handleElementClick(room.id, e)}>
                    <Line
                        points={[...points, points[0], points[1]]}
                        fill={fillColor}
                        stroke={isSelected ? '#3b82f6' : 'transparent'}
                        strokeWidth={isSelected ? 2 : 0}
                        closed
                        lineJoin="miter"
                    />

                    {/* Smart Room Label - Background Box */}
                    <Rect
                        x={centroid.x - 70}
                        y={centroid.y - 32}
                        width={140}
                        height={room.detectedMeasurements ? 58 : (room.ocrArea ? 42 : 26)}
                        fill={theme === 'dark' ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)'}
                        cornerRadius={4}
                        listening={false}
                    />

                    {/* Room Name (Bold) */}
                    <Text
                        x={centroid.x - 65}
                        y={centroid.y - 28}
                        text={room.name}
                        fontSize={13}
                        fontStyle="bold"
                        fill={theme === 'dark' ? '#fff' : '#1f2937'}
                        align="center"
                        width={130}
                        listening={false}
                    />

                    {/* Detected Dimensions */}
                    {room.detectedMeasurements && (
                        <Text
                            x={centroid.x - 65}
                            y={centroid.y - 12}
                            text={room.detectedMeasurements}
                            fontSize={10}
                            fill={theme === 'dark' ? '#9ca3af' : '#6b7280'}
                            align="center"
                            width={130}
                            listening={false}
                        />
                    )}

                    {/* Area Label - Prefer OCR area, fallback to polygon */}
                    {(room.ocrArea || showArea) && (
                        <Text
                            x={centroid.x - 65}
                            y={centroid.y + (room.detectedMeasurements ? 4 : -12) + 14}
                            text={
                                room.ocrArea
                                    ? `${room.ocrArea.toFixed(2)} sq.ft`
                                    : areaLabel
                            }
                            fontSize={11}
                            fontStyle="bold"
                            fill={room.ocrArea ? '#10b981' : (theme === 'dark' ? '#fbbf24' : '#d97706')}
                            align="center"
                            width={130}
                            listening={false}
                        />
                    )}
                </Group>
            );
        });
    };

    // Render walls
    const renderWalls = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.walls.filter(w => selectedElementIds.includes(w.id) === renderSelected);

        return targets.map(wall => {
            const isSelected = selectedElementIds.includes(wall.id);
            const showHandles = isSelected && drawingState.activeTool === 'select';

            return (
                <Group key={wall.id}>
                    <Line
                        points={[
                            wall.startPoint.x,
                            wall.startPoint.y,
                            wall.endPoint.x,
                            wall.endPoint.y
                        ]}
                        stroke={isSelected ? '#3b82f6' : (theme === 'dark' ? '#e5e7eb' : '#1f2937')}
                        strokeWidth={wall.thickness}
                        lineCap="butt"
                        onClick={(e) => handleElementClick(wall.id, e)}
                        draggable={drawingState.activeTool === 'select'}
                        onDragStart={() => takeSnapshot()}
                        onDragEnd={(e) => {
                            const dx = e.target.x();
                            const dy = e.target.y();

                            // Reset transform
                            e.target.x(0);
                            e.target.y(0);

                            // Update coordinates
                            updateWall(wall.id, {
                                startPoint: { x: wall.startPoint.x + dx, y: wall.startPoint.y + dy },
                                endPoint: { x: wall.endPoint.x + dx, y: wall.endPoint.y + dy }
                            });
                        }}
                    />

                    {showHandles && (
                        <>
                            <Circle
                                x={wall.startPoint.x}
                                y={wall.startPoint.y}
                                radius={9}
                                fill="transparent"
                                stroke="#3b82f6"
                                strokeWidth={2}
                                draggable
                                onDragStart={(e) => {
                                    takeSnapshot();
                                    e.cancelBubble = true;
                                }}
                                onDragMove={(e) => {
                                    e.cancelBubble = true;
                                    const pos = { x: e.target.x(), y: e.target.y() };

                                    // Project point onto line defined by (endPoint -> startPoint) to preserve angle
                                    const fixed = wall.endPoint;
                                    const original = wall.startPoint;

                                    const dx = original.x - fixed.x;
                                    const dy = original.y - fixed.y;
                                    const magSq = dx * dx + dy * dy;

                                    if (magSq > 1e-6) {
                                        // Project vector (pos - fixed) onto vector (original - fixed)
                                        const vmx = pos.x - fixed.x;
                                        const vmy = pos.y - fixed.y;
                                        const dot = vmx * dx + vmy * dy;
                                        const t = dot / magSq;

                                        const nx = fixed.x + t * dx;
                                        const ny = fixed.y + t * dy;

                                        e.target.x(nx);
                                        e.target.y(ny);
                                    }
                                }}
                                onDragEnd={(e) => {
                                    e.cancelBubble = true;
                                    // The position is already constrained by DragMove
                                    updateWall(wall.id, { startPoint: { x: e.target.x(), y: e.target.y() } });
                                }}
                            />

                            <Circle
                                x={wall.endPoint.x}
                                y={wall.endPoint.y}
                                radius={9}
                                fill="transparent"
                                stroke="#3b82f6"
                                strokeWidth={2}
                                draggable
                                onDragStart={(e) => {
                                    takeSnapshot();
                                    e.cancelBubble = true;
                                }}
                                onDragMove={(e) => {
                                    e.cancelBubble = true;
                                    const pos = { x: e.target.x(), y: e.target.y() };

                                    // Project point onto line defined by (startPoint -> endPoint) to preserve angle
                                    const fixed = wall.startPoint;
                                    const original = wall.endPoint;

                                    const dx = original.x - fixed.x;
                                    const dy = original.y - fixed.y;
                                    const magSq = dx * dx + dy * dy;

                                    if (magSq > 1e-6) {
                                        // Project vector (pos - fixed) onto vector (original - fixed)
                                        const vmx = pos.x - fixed.x;
                                        const vmy = pos.y - fixed.y;
                                        const dot = vmx * dx + vmy * dy;
                                        const t = dot / magSq;

                                        const nx = fixed.x + t * dx;
                                        const ny = fixed.y + t * dy;

                                        e.target.x(nx);
                                        e.target.y(ny);
                                    }
                                }}
                                onDragEnd={(e) => {
                                    e.cancelBubble = true;
                                    updateWall(wall.id, { endPoint: { x: e.target.x(), y: e.target.y() } });
                                }}
                            />
                        </>
                    )}
                </Group>
            );
        });
    };

    // Render doors
    const renderDoors = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.doors.filter(d => selectedElementIds.includes(d.id) === renderSelected);

        return targets.map(door => {
            const isSelected = selectedElementIds.includes(door.id);
            const strokeColor = isSelected ? '#3b82f6' : (theme === 'dark' ? '#9ca3af' : '#374151');
            const fillColor = theme === 'dark' ? '#111827' : '#ffffff';

            const wall = currentPlan.walls.find(w => w.id === door.wallId);
            const wallRotation = wall
                ? Math.atan2(wall.endPoint.y - wall.startPoint.y, wall.endPoint.x - wall.startPoint.x) * 180 / Math.PI
                : null;
            const rotation = wallRotation ?? door.rotation;
            const rad = rotation * Math.PI / 180;
            const unit = wall ? getWallUnitVector(wall) : { x: Math.cos(rad), y: Math.sin(rad) };
            const showHandles = isSelected && drawingState.activeTool === 'select';

            // Handles in Local Space (simplifies rotation)
            const p1Local = { x: -door.width / 2, y: 0 };
            const p2Local = { x: door.width / 2, y: 0 };

            return (
                <Group
                    key={door.id}
                    x={door.position.x}
                    y={door.position.y}
                    rotation={rotation}
                    onClick={(e) => handleElementClick(door.id, e)}
                    draggable={drawingState.activeTool === 'select'}
                    dragBoundFunc={(pos) => {
                        // Slide-on-Wall Logic
                        const worldX = (pos.x - position.x) / scale;
                        const worldY = (pos.y - position.y) / scale;

                        // 1. Try to snap to ANY wall (not just current)
                        // Use a generous tolerance so it feels magnetic (e.g., 50px)
                        if (currentPlan) {
                            const snap = snapToWall({ x: worldX, y: worldY }, currentPlan.walls, 50);
                            if (snap) {
                                // Return SCREEN coordinates of the snap point
                                return {
                                    x: snap.snapPoint.x * scale + position.x,
                                    y: snap.snapPoint.y * scale + position.y
                                };
                            }
                        }

                        return pos;
                    }}
                    onDragMove={(e) => {
                        // Auto-Rotate during drag
                        const rawPos = { x: e.target.x(), y: e.target.y() };
                        if (currentPlan) {
                            const snap = snapToWall(rawPos, currentPlan.walls, 80);
                            if (snap) {
                                // Update rotation visually immediately
                                const angle = Math.atan2(
                                    snap.wall.endPoint.y - snap.wall.startPoint.y,
                                    snap.wall.endPoint.x - snap.wall.startPoint.x
                                ) * 180 / Math.PI;
                                e.target.rotation(angle);
                            }
                        }
                        e.cancelBubble = true;
                    }}
                    onDragStart={(e) => {
                        takeSnapshot();
                        e.cancelBubble = true;
                    }}
                    onDragEnd={(e) => {
                        e.cancelBubble = true;
                        const rawPos = { x: e.target.x(), y: e.target.y() };

                        // Final commit
                        const snap = snapToWall(rawPos, currentPlan.walls, 80);
                        if (snap) {
                            const angle = Math.atan2(
                                snap.wall.endPoint.y - snap.wall.startPoint.y,
                                snap.wall.endPoint.x - snap.wall.startPoint.x
                            ) * 180 / Math.PI;
                            updateDoor(door.id, {
                                position: snap.snapPoint,
                                rotation: angle,
                                wallId: snap.wall.id
                            });
                        } else {
                            updateDoor(door.id, { position: rawPos, wallId: 'orphan' });
                        }
                    }}
                >
                    {/* Door opening gap */}
                    <Rect
                        x={-door.width / 2}
                        y={-5}
                        width={door.width}
                        height={10}
                        fill={fillColor}
                        stroke={strokeColor}
                        strokeWidth={2}
                    />


                    {showHandles && (
                        <>
                            {/* Left/Start Handle (p1) */}
                            <Circle
                                x={p1Local.x}
                                y={p1Local.y}
                                radius={8}
                                fill={theme === 'dark' ? '#111827' : '#ffffff'}
                                stroke="#3b82f6"
                                strokeWidth={2}
                                draggable
                                dragBoundFunc={(pos) => {
                                    // Transform Screen -> World
                                    const worldX = (pos.x - position.x) / scale;
                                    const worldY = (pos.y - position.y) / scale;

                                    // Transform World -> Local (inverse of Group transform)
                                    // Group is at door.position with rotation
                                    const dx = worldX - door.position.x;
                                    const dy = worldY - door.position.y;
                                    const r = -rotation * Math.PI / 180;
                                    const cos = Math.cos(r);
                                    const sin = Math.sin(r);

                                    // Local X aligned with door width
                                    const localX = dx * cos - dy * sin;

                                    // Clamp X to prevent crossover (max X is p2Local.x - 20)
                                    // p1 is typically negative, p2 positive
                                    const clampedLocalX = Math.min(localX, p2Local.x - 20);

                                    // Transform Local -> World
                                    const r2 = rotation * Math.PI / 180;
                                    const cos2 = Math.cos(r2);
                                    const sin2 = Math.sin(r2);

                                    // We force local Y to 0
                                    const finalWorldX = door.position.x + clampedLocalX * cos2;
                                    const finalWorldY = door.position.y + clampedLocalX * sin2;

                                    return {
                                        x: finalWorldX * scale + position.x,
                                        y: finalWorldY * scale + position.y
                                    };
                                }}
                                onDragStart={(e) => {
                                    takeSnapshot();
                                    e.cancelBubble = true;
                                }}
                                onDragEnd={(e) => {
                                    e.cancelBubble = true;

                                    // Use the constrained local X from dragBoundFunc
                                    const constrainedLocalX = e.target.x();

                                    // P1 (Left) is being dragged. Anchor is P2 (Right, at +width/2)
                                    const anchorLocalX = door.width / 2;

                                    // Local Logic
                                    // New Width = Distance between Anchor and New P1
                                    // P1 is to the left of P2, so Width = P2 - P1
                                    const nextWidth = anchorLocalX - constrainedLocalX;

                                    // New Center in Local Space (relative to Old Center)
                                    // Midpoint = (P1 + P2) / 2
                                    const centerOffsetLocal = (constrainedLocalX + anchorLocalX) / 2;

                                    // Transform Local Offset to World
                                    // World = OldCenter + Unit * Offset
                                    // (Unit vector is derived from rotation, which matches Local X axis)
                                    const nextCenter = {
                                        x: door.position.x + unit.x * centerOffsetLocal,
                                        y: door.position.y + unit.y * centerOffsetLocal
                                    };

                                    // Reset handle position locally to avoid visual drift before re-render
                                    e.target.x(constrainedLocalX);
                                    e.target.y(0); // Lock Y

                                    updateDoor(door.id, { width: Math.max(20, nextWidth), position: nextCenter, rotation });
                                }}
                            />
                            {/* Right/End Handle (p2) */}
                            <Circle
                                x={p2Local.x}
                                y={p2Local.y}
                                radius={8}
                                fill={theme === 'dark' ? '#111827' : '#ffffff'}
                                stroke="#3b82f6"
                                strokeWidth={2}
                                draggable
                                dragBoundFunc={(pos) => {
                                    const worldX = (pos.x - position.x) / scale;
                                    const worldY = (pos.y - position.y) / scale;

                                    const dx = worldX - door.position.x;
                                    const dy = worldY - door.position.y;
                                    const r = -rotation * Math.PI / 180;
                                    const cos = Math.cos(r);
                                    const sin = Math.sin(r);

                                    const localX = dx * cos - dy * sin;

                                    // Clamp X (min X is p1Local.x + 20)
                                    const clampedLocalX = Math.max(localX, p1Local.x + 20);

                                    const r2 = rotation * Math.PI / 180;
                                    const cos2 = Math.cos(r2);
                                    const sin2 = Math.sin(r2);

                                    const finalWorldX = door.position.x + clampedLocalX * cos2;
                                    const finalWorldY = door.position.y + clampedLocalX * sin2;

                                    return {
                                        x: finalWorldX * scale + position.x,
                                        y: finalWorldY * scale + position.y
                                    };
                                }}
                                onDragStart={(e) => {
                                    takeSnapshot();
                                    e.cancelBubble = true;
                                }}
                                onDragEnd={(e) => {
                                    e.cancelBubble = true;

                                    const constrainedLocalX = e.target.x();

                                    // P2 (Right) is being dragged. Anchor is P1 (Left, at -width/2)
                                    const anchorLocalX = -door.width / 2;

                                    // Local Logic
                                    // New Width = P2 - P1
                                    const nextWidth = constrainedLocalX - anchorLocalX;

                                    // Midpoint
                                    const centerOffsetLocal = (constrainedLocalX + anchorLocalX) / 2;

                                    const nextCenter = {
                                        x: door.position.x + unit.x * centerOffsetLocal,
                                        y: door.position.y + unit.y * centerOffsetLocal
                                    };

                                    e.target.x(constrainedLocalX);
                                    e.target.y(0);

                                    updateDoor(door.id, { width: Math.max(20, nextWidth), position: nextCenter, rotation });
                                }}
                            />
                        </>
                    )}
                </Group>
            );
        });
    };

    // Render windows
    const renderWindows = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.windows.filter(w => selectedElementIds.includes(w.id) === renderSelected);

        return targets.map(win => {
            const wall = currentPlan.walls.find(w => w.id === win.wallId);
            const wallRotation = wall
                ? Math.atan2(wall.endPoint.y - wall.startPoint.y, wall.endPoint.x - wall.startPoint.x) * 180 / Math.PI
                : null;
            const rotation = wallRotation ?? win.rotation ?? 0;
            const isSelected = selectedElementIds.includes(win.id);

            return (
                <Rect
                    key={win.id}
                    x={win.position.x}
                    y={win.position.y}
                    width={win.width}
                    height={win.height}
                    offsetX={win.width / 2}
                    offsetY={win.height / 2}
                    rotation={rotation}
                    fill={theme === 'dark' ? '#60a5fa' : '#93c5fd'}
                    stroke={isSelected ? '#3b82f6' : '#3b82f6'}
                    strokeWidth={isSelected ? 3 : 1}
                    onClick={(e) => handleElementClick(win.id, e)}
                    draggable={drawingState.activeTool === 'select'}
                    dragBoundFunc={(pos) => {
                        const worldX = (pos.x - position.x) / scale;
                        const worldY = (pos.y - position.y) / scale;
                        if (currentPlan) {
                            const snap = snapToWall({ x: worldX, y: worldY }, currentPlan.walls, 50);
                            if (snap) {
                                return {
                                    x: snap.snapPoint.x * scale + position.x,
                                    y: snap.snapPoint.y * scale + position.y
                                };
                            }
                        }
                        return pos;
                    }}
                    onDragMove={(e) => {
                        const rawPos = { x: e.target.x(), y: e.target.y() };
                        if (currentPlan) {
                            const snap = snapToWall(rawPos, currentPlan.walls, 80);
                            if (snap) {
                                const angle = Math.atan2(
                                    snap.wall.endPoint.y - snap.wall.startPoint.y,
                                    snap.wall.endPoint.x - snap.wall.startPoint.x
                                ) * 180 / Math.PI;
                                e.target.rotation(angle);
                            }
                        }
                        e.cancelBubble = true;
                    }}
                    onDragStart={() => takeSnapshot()}
                    onDragEnd={(e) => {
                        const rawPos = { x: e.target.x(), y: e.target.y() };
                        const snap = snapToWall(rawPos, currentPlan.walls, 80);
                        if (snap) {
                            const snapRot = Math.atan2(
                                snap.wall.endPoint.y - snap.wall.startPoint.y,
                                snap.wall.endPoint.x - snap.wall.startPoint.x
                            ) * 180 / Math.PI;
                            updateWindow(win.id, { position: snap.snapPoint, wallId: snap.wall.id, rotation: snapRot });
                        } else {
                            updateWindow(win.id, { position: rawPos, wallId: 'orphan', rotation });
                        }
                    }}
                />
            );
        });
    };

    const renderWindowHandles = () => {
        if (!currentPlan) return null;

        return currentPlan.windows
            .filter(w => selectedElementIds.includes(w.id) && drawingState.activeTool === 'select')
            .map(w => {
                const wall = currentPlan.walls.find(ww => ww.id === w.wallId);
                const wallRotation = wall
                    ? Math.atan2(wall.endPoint.y - wall.startPoint.y, wall.endPoint.x - wall.startPoint.x) * 180 / Math.PI
                    : null;
                const rotation = wallRotation ?? w.rotation ?? 0;
                const rad = rotation * Math.PI / 180;
                const unit = wall ? getWallUnitVector(wall) : { x: Math.cos(rad), y: Math.sin(rad) };

                const halfW = Math.max(10, w.width / 2);
                const p1 = { x: w.position.x - unit.x * halfW, y: w.position.y - unit.y * halfW };
                const p2 = { x: w.position.x + unit.x * halfW, y: w.position.y + unit.y * halfW };


                // Helper to render handle with asymmetrical resizing
                const renderHandle = (key: string, pt: Point, anchor: Point, isP1: boolean) => (
                    <Circle
                        key={key}
                        x={pt.x}
                        y={pt.y}
                        radius={8}
                        fill={theme === 'dark' ? '#111827' : '#ffffff'}
                        stroke="#3b82f6"
                        strokeWidth={2}
                        draggable
                        dragBoundFunc={(pos) => {
                            // 1. World coordinates
                            const worldX = (pos.x - position.x) / scale;
                            const worldY = (pos.y - position.y) / scale;

                            // 2. Define Line: Anchor -> Dir
                            // If isP1 (Left), anchor is P2 (Right). Vector P2->P1 should be -unit.
                            // However, we calculated p1 = center - unit*halfW, p2 = center + unit*halfW
                            // So vector P2->P1 is direction (-unit).
                            // If isP2 (Right), anchor is P1 (Left). Vector P1->P2 is direction (+unit).

                            const dirX = isP1 ? -unit.x : unit.x;
                            const dirY = isP1 ? -unit.y : unit.y;

                            // 3. Project worldPos onto Line(Anchor, Dir)
                            // Point on line P = Anchor + t * Dir
                            // t = Dot(World - Anchor, Dir)
                            const vX = worldX - anchor.x;
                            const vY = worldY - anchor.y;
                            let t = vX * dirX + vY * dirY;

                            // 4. Constraint: Minimum Width (e.g. 20)
                            // t represents the distance from anchor to new handle pos.
                            // We want t >= 20.
                            t = Math.max(20, t);

                            // 5. Calculate constrained world pos
                            const constrainedX = anchor.x + t * dirX;
                            const constrainedY = anchor.y + t * dirY;

                            // 6. Return screen coords
                            return {
                                x: constrainedX * scale + position.x,
                                y: constrainedY * scale + position.y
                            };
                        }}
                        onDragStart={(e) => {
                            takeSnapshot();
                            e.cancelBubble = true;
                        }}
                        onDragEnd={(e) => {
                            e.cancelBubble = true;

                            // With dragBoundFunc, e.target.x() is the valid constrained world position *relative* to Stage?
                            // No, dragBoundFunc returns Absolute Scale position.
                            // Window handles are in a Group with (0,0). So e.target.x() is absolute world position relative to Group?
                            // Wait. The Group for window handles is at (0,0) (default).
                            // So e.target.x() is indeed the World Coordinates (assuming Stage scale is handled by Konva transformation of the mouse event to local space? No).
                            // In Konva:
                            // Node.x() is relative to Parent.
                            // Parent is Group at (0,0).
                            // So Node.x() IS the World Coordinate relative to Origin.

                            // However, dragBoundFunc returns *Absolute Position* (Screen).
                            // Konva then converts that Absolute Position to Local Position (Node.x()) and sets it.
                            // So e.target.x() will be the CONSTRAINED World Coordinate we calculated.

                            const finalX = e.target.x();
                            const finalY = e.target.y();

                            // Calculate new width/center from this confirmed position
                            // New width is dist(Final, Anchor)
                            const newWidth = Math.hypot(finalX - anchor.x, finalY - anchor.y);

                            const newCenter = {
                                x: (anchor.x + finalX) / 2,
                                y: (anchor.y + finalY) / 2
                            };

                            updateWindow(w.id, {
                                width: Math.max(20, newWidth),
                                position: newCenter,
                                rotation,
                                ...(wall ? { wallId: wall.id } : {})
                            });
                        }}
                    />
                );

                return (
                    <Group key={`${w.id}-handles`}>
                        {renderHandle('a', p1, p2, true)}
                        {renderHandle('b', p2, p1, false)}
                    </Group>
                );
            });
    };

    // Render connections (wires/conduits)
    const renderConnections = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.connections.filter(c => selectedElementIds.includes(c.id) === renderSelected);

        return targets.map(conn => {
            const isSelected = selectedElementIds.includes(conn.id);
            const baseColor = conn.type === 'power' ? '#dc2626' : (conn.type === 'control' ? '#2563eb' : '#4b5563');
            // Phase wins over the type color when known (stored phase or the
            // matching SLD connector's HTPN-derived phase, even with no Source).
            const color = getLayoutConnectionColor(conn, sldConnectors, sldItems) || baseColor;

            // Highlight wires touching the selected component(s); dim the rest.
            const isRelated = connectionHighlight.highlightedConnectionIds.has(conn.id);
            const isDimmed = connectionHighlight.hasHighlight && !isRelated && !isSelected;

            // Determine path based on renderType
            // Keep original points for source/target refs
            const start = conn.path[0];
            const end = conn.path[conn.path.length - 1];

            const renderType = conn.renderType || 'arc'; // Default to new Arc style
            let renderPoints = conn.path.flatMap(p => [p.x, p.y]);
            let tension = 0;
            let isBezier = false;

            if (renderType === 'orthogonal') {
                const orthoPoints = calculateOrthogonalPath(start, end);
                renderPoints = orthoPoints.flatMap(p => [p.x, p.y]);
                tension = 0;
            } else if (renderType === 'arc') { // Simulate "hanging wire" or AutoCAD arc
                // Calculate Quadratic Bezier Control Point
                // Midpoint
                const midX = (start.x + end.x) / 2;
                const midY = (start.y + end.y) / 2;
                // Vector
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                const len = Math.sqrt(dx * dx + dy * dy);

                // Offset (bulge) - default 0.2 of length
                const bulge = conn.arcBulge || 0.2;
                const offset = Math.max(len * bulge, 20);

                // Normal vector (-dy, dx) normalized
                // If len is 0 avoid NaN
                if (len > 0) {
                    const nx = -dy / len;
                    const ny = dx / len;

                    // Control Point
                    const cpX = midX + nx * offset;
                    const cpY = midY + ny * offset;

                    renderPoints = [start.x, start.y, cpX, cpY, end.x, end.y];
                    tension = 0.5;
                    isBezier = true;
                }
            } else if (renderType === 'curve') {
                tension = 0.2; // Original loose curve
            }

            return (
                <Group key={conn.id} onClick={(e) => handleElementClick(conn.id, e)} opacity={isDimmed ? 0.18 : 1}>
                    {/* Glow under highlighted wires so they pop against the plan */}
                    {isRelated && (
                        <Line
                            points={renderPoints}
                            stroke={color}
                            strokeWidth={isSelected ? 9 : 8}
                            lineCap="round"
                            lineJoin="round"
                            tension={tension}
                            bezier={isBezier}
                            opacity={0.25}
                            listening={false}
                        />
                    )}
                    {/* Main Wire Line */}
                    <Line
                        points={renderPoints}
                        stroke={color}
                        strokeWidth={isRelated ? (isSelected ? 5 : 4) : (isSelected ? 3 : 2)}
                        lineCap="round"
                        lineJoin="round"
                        tension={tension}
                        bezier={isBezier}
                        opacity={isRelated ? 1 : (isDimmed ? 0.35 : 0.8)}
                        shadowColor={isRelated ? color : undefined}
                        shadowBlur={isRelated ? 6 : 0}
                    />

                    {/* Shadow/Highlight for depth */}
                    <Line
                        points={renderPoints}
                        stroke="white"
                        strokeWidth={4}
                        lineCap="round"
                        lineJoin="round"
                        tension={tension}
                        bezier={isBezier}
                        opacity={0.0} // Invisible hit area
                        onMouseEnter={(e: any) => {
                            const container = e.target.getStage().container();
                            container.style.cursor = 'pointer';
                        }}
                        onMouseLeave={(e: any) => {
                            const container = e.target.getStage().container();
                            container.style.cursor = 'default';
                        }}
                    />

                    {/* Endpoints/Nodes */}
                    {[start, end].map((p, i) => (
                        <Circle
                            key={i}
                            x={p.x}
                            y={p.y}
                            radius={isRelated ? 4.5 : 3}
                            fill={color}
                            opacity={isDimmed ? 0.35 : 1}
                            shadowColor={isRelated ? color : undefined}
                            shadowBlur={isRelated ? 6 : 0}
                        />
                    ))}
                </Group>
            );
        });
    };

    const renderComponents = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.components.filter(c => selectedElementIds.includes(c.id) === renderSelected);
        const ppm = currentPlan.pixelsPerMeter || 50;

        return targets.map(comp => {
            const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
            const isSelected = selectedElementIds.includes(comp.id);
            const isNeighbour = connectionHighlight.neighbourComponentIds.has(comp.id);
            const image = componentImages[comp.type];

            // Use calibrated real-world size if available, otherwise fall back to def.size
            const sz = def?.realSizeMm
                ? getScaledComponentSize(comp.type, ppm)
                : (def?.size ?? { width: 24, height: 24 });

            return (
                <Group
                    key={comp.id}
                    x={comp.position.x}
                    y={comp.position.y}
                    rotation={comp.rotation}
                    onClick={(e) => handleElementClick(comp.id, e)}
                    onContextMenu={(e) => {
                        e.evt.preventDefault();
                        e.cancelBubble = true;
                        setMenu({
                            visible: true,
                            x: e.evt.clientX,
                            y: e.evt.clientY,
                            componentId: comp.id
                        });
                    }}
                    draggable={drawingState.activeTool === 'select'}
                    onDragStart={(e) => {
                        takeSnapshot();
                        e.cancelBubble = true;
                    }}
                    onDragMove={(e) => {
                        e.cancelBubble = true;

                    }}
                    onDragEnd={(e) => {
                        e.cancelBubble = true;
                        const { updateComponent } = useLayoutStore.getState();
                        const rawPos = { x: e.target.x(), y: e.target.y() };

                        // Room-side fittings re-seat off the wall face toward the
                        // room they were dragged toward — crossing a partition
                        // wall moves them to the new side (flipping types also
                        // turn to face it; labelled units stay upright).
                        let nextPos = rawPos;
                        let nextRotation = comp.rotation;

                        if (currentPlan) {
                            const snapInfo = snapToWall(rawPos, currentPlan.walls, 25);
                            if (snapInfo) {
                                if (needsWallSeating(comp.type)) {
                                    const roomHit = findRoomForPoint(rawPos, currentPlan.rooms)
                                        ?? findRoomForPoint(snapInfo.snapPoint, currentPlan.rooms)
                                        ?? (comp.roomId ? (() => {
                                            const known = currentPlan.rooms.find(r => r.id === comp.roomId);
                                            return known ? { room: known } as any : null;
                                        })() : null);
                                    const oriented = orientComponentOnWall(comp.type, snapInfo.snapPoint, snapInfo.wall, {
                                        roomInterior: roomHit ? getRoomInteriorPoint(roomHit.room) : null,
                                        approach: { x: rawPos.x - snapInfo.snapPoint.x, y: rawPos.y - snapInfo.snapPoint.y },
                                        pixelsPerMeter: currentPlan.pixelsPerMeter || 50
                                    });
                                    nextPos = oriented.position;
                                    nextRotation = oriented.rotation;
                                } else {
                                    nextPos = snapInfo.snapPoint;
                                    nextRotation = Math.atan2(
                                        snapInfo.wall.endPoint.y - snapInfo.wall.startPoint.y,
                                        snapInfo.wall.endPoint.x - snapInfo.wall.startPoint.x
                                    ) * 180 / Math.PI;
                                }
                            }
                        }

                        updateComponent(comp.id, {
                            position: nextPos,
                            rotation: nextRotation,
                            // Keep the room association truthful after a move,
                            // otherwise per-room load totals drift out of date.
                            roomId: currentPlan ? findRoomForPoint(nextPos, currentPlan.rooms)?.room.id : comp.roomId
                        });
                    }}
                >
                    {
                        image ? (
                            <>
                                {/* Selection Glow */}
                                {
                                    isSelected && (
                                        <Rect
                                            x={-sz.width / 2 - 4}
                                            y={-sz.height / 2 - 4}
                                            width={sz.width + 8}
                                            height={sz.height + 8}
                                            stroke="#3b82f6"
                                            strokeWidth={2}
                                            cornerRadius={4}
                                            dash={[4, 4]}
                                        />
                                    )
                                }
                                {/* Neighbour glow: directly wired to the selection */}
                                {
                                    !isSelected && isNeighbour && (
                                        <Rect
                                            x={-sz.width / 2 - 4}
                                            y={-sz.height / 2 - 4}
                                            width={sz.width + 8}
                                            height={sz.height + 8}
                                            stroke="#f59e0b"
                                            strokeWidth={2}
                                            cornerRadius={4}
                                            dash={[6, 3]}
                                            listening={false}
                                        />
                                    )
                                }
                                <KonvaImage
                                    image={image}
                                    width={sz.width}
                                    height={sz.height}
                                    offset={{ x: sz.width / 2, y: sz.height / 2 }}
                                />
                            </>
                        ) : (
                            /* Fallback: just show symbol text, no background circle */
                            <Text
                                x={-sz.width / 2}
                                y={-8}
                                width={sz.width}
                                text={def?.symbol ?? '?'}
                                fontSize={16}
                                fontStyle="bold"
                                fill={isSelected ? '#3b82f6' : (isNeighbour ? '#f59e0b' : (theme === 'dark' ? '#e5e7eb' : '#374151'))}
                                align="center"
                            />
                        )}
                </Group >
            );
        });
    };

    // Render Magic Wires - AutoCAD-style connection visualization from SLD connectors
    // Shows curved dashed lines between linked Layout components
    const renderMagicWires = () => {
        if (!showMagicWires || magicWires.length === 0) return null;

        // Calculate canvas center for smart arc direction
        const canvasCenter = currentPlan ? {
            x: currentPlan.width / 2,
            y: currentPlan.height / 2
        } : { x: 500, y: 500 };

        // Track wires by source for fanning effect
        const sourceWireCount = new Map<string, number>();
        const sourceWireIndex = new Map<string, number>();

        // First pass: count wires per source
        magicWires.forEach(wire => {
            const key = `${Math.round(wire.sourcePos.x)}-${Math.round(wire.sourcePos.y)}`;
            sourceWireCount.set(key, (sourceWireCount.get(key) || 0) + 1);
        });

        return magicWires.map((wire, globalIndex) => {
            const { sourcePos, targetPos, key, color } = wire;
            const isRelated = connectionHighlight.highlightedMagicWireKeys.has(key);
            const isDimmed = connectionHighlight.hasHighlight && !isRelated;

            // Calculate basic geometry
            const midX = (sourcePos.x + targetPos.x) / 2;
            const midY = (sourcePos.y + targetPos.y) / 2;
            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const len = Math.sqrt(dx * dx + dy * dy);

            if (len < 5) {
                // Skip very short/zero-length wires
                return null;
            }

            // Get source grouping info for fanning
            const sourceKey = `${Math.round(sourcePos.x)}-${Math.round(sourcePos.y)}`;
            const totalFromSource = sourceWireCount.get(sourceKey) || 1;
            const indexInSource = sourceWireIndex.get(sourceKey) || 0;
            sourceWireIndex.set(sourceKey, indexInSource + 1);

            // Calculate perpendicular unit vectors (two possible directions)
            const perpX1 = -dy / len;
            const perpY1 = dx / len;
            const perpX2 = dy / len;
            const perpY2 = -dx / len;

            // SMART DIRECTION SELECTION:
            // 1. Calculate midpoint distance to canvas center
            // 2. Check which perpendicular direction goes AWAY from center (more natural)
            // 3. For multiple wires from same source, alternate/fan directions

            const midToCenter = {
                x: canvasCenter.x - midX,
                y: canvasCenter.y - midY
            };

            // Dot product to see which perpendicular points away from center
            const dot1 = perpX1 * midToCenter.x + perpY1 * midToCenter.y;
            const dot2 = perpX2 * midToCenter.x + perpY2 * midToCenter.y;

            // Base direction: prefer the one pointing AWAY from center (negative dot)
            let baseDirection = dot1 < dot2 ? 1 : -1;

            // For multiple wires from same source, fan them out
            // Alternate direction for each wire, with slight angular offset
            if (totalFromSource > 1) {
                // Spread factor: distribute wires across arc
                const spreadAngle = Math.PI / 4; // 45 degree spread
                const angleOffset = ((indexInSource / (totalFromSource - 1)) - 0.5) * spreadAngle;

                // Rotate the perpendicular vector slightly
                const cosA = Math.cos(angleOffset);
                const sinA = Math.sin(angleOffset);

                // Apply rotation to perpendicular
                const rotPerpX = perpX1 * cosA - perpY1 * sinA;
                const rotPerpY = perpX1 * sinA + perpY1 * cosA;

                // Use direction based on index (odd/even alternate)
                baseDirection = indexInSource % 2 === 0 ? 1 : -1;

                // Calculate arc bulge - proportional to distance
                const baseBulge = 0.15 + (indexInSource * 0.05); // Vary bulge per wire
                const offset = Math.min(Math.max(len * baseBulge, 20), 60);

                // Control point with rotation
                const cpX = midX + rotPerpX * offset * baseDirection;
                const cpY = midY + rotPerpY * offset * baseDirection;

                const points = [sourcePos.x, sourcePos.y, cpX, cpY, targetPos.x, targetPos.y];

                return (
                    <Group key={key} opacity={isDimmed ? 0.15 : 1}>
                        {/* Shadow for subtle depth */}
                        <Line
                            points={points}
                            stroke="rgba(100, 116, 139, 0.2)"
                            strokeWidth={3}
                            lineCap="round"
                            lineJoin="round"
                            tension={0.5}
                            bezier={true}
                        />
                        {/* Main wire */}
                        <Line
                            points={points}
                            stroke={color}
                            strokeWidth={isRelated ? 3 : 1.2}
                            lineCap="round"
                            lineJoin="round"
                            tension={0.5}
                            bezier={true}
                            dash={isRelated ? undefined : [6, 4]}
                            shadowColor={isRelated ? color : undefined}
                            shadowBlur={isRelated ? 8 : 0}
                            opacity={isRelated ? 1 : (isDimmed ? 0.4 : 0.9)}
                        />
                        {/* Connection dots */}
                        <Circle x={sourcePos.x} y={sourcePos.y} radius={isRelated ? 4 : 2.5} fill={color} />
                        <Circle x={targetPos.x} y={targetPos.y} radius={isRelated ? 4 : 2.5} fill={color} />
                    </Group>
                );
            }

            // Single wire from source - use smart direction
            const baseBulge = 0.18;
            const offset = Math.min(Math.max(len * baseBulge, 25), 70);

            const cpX = midX + perpX1 * offset * baseDirection;
            const cpY = midY + perpY1 * offset * baseDirection;

            const points = [sourcePos.x, sourcePos.y, cpX, cpY, targetPos.x, targetPos.y];

            return (
                <Group key={key} opacity={isDimmed ? 0.15 : 1}>
                    {/* Shadow for subtle depth */}
                    <Line
                        points={points}
                        stroke="rgba(100, 116, 139, 0.2)"
                        strokeWidth={3}
                        lineCap="round"
                        lineJoin="round"
                        tension={0.5}
                        bezier={true}
                    />
                    {/* Main wire */}
                    <Line
                        points={points}
                        stroke={color}
                        strokeWidth={isRelated ? 3 : 1.2}
                        lineCap="round"
                        lineJoin="round"
                        tension={0.5}
                        bezier={true}
                        dash={isRelated ? undefined : [6, 4]}
                        shadowColor={isRelated ? color : undefined}
                        shadowBlur={isRelated ? 8 : 0}
                        opacity={isRelated ? 1 : (isDimmed ? 0.4 : 0.9)}
                    />
                    {/* Connection dots */}
                    <Circle x={sourcePos.x} y={sourcePos.y} radius={isRelated ? 4 : 2.5} fill={color} />
                    <Circle x={targetPos.x} y={targetPos.y} radius={isRelated ? 4 : 2.5} fill={color} />
                </Group>
            );
        }).filter(Boolean);
    };


    // Render text items
    const renderTextItems = () => {
        if (!currentPlan || !currentPlan.textItems) return null;

        return currentPlan.textItems.map(textItem => {
            const isSelected = selectedElementIds.includes(textItem.id);

            return (
                <Text
                    key={textItem.id}
                    x={textItem.position.x}
                    y={textItem.position.y}
                    text={textItem.text}
                    fontSize={textItem.fontSize || 14}
                    fontFamily={textItem.fontFamily || 'Arial'}
                    fill={textItem.color || (theme === 'dark' ? '#ffffff' : '#000000')}
                    align={textItem.align || 'left'}
                    width={textItem.width}
                    rotation={textItem.rotation || 0}
                    draggable={drawingState.activeTool === 'select'}
                    onClick={(e) => handleElementClick(textItem.id, e)}
                    onDragStart={() => takeSnapshot()}
                    onDragEnd={(e) => {
                        const newPos = { x: e.target.x(), y: e.target.y() };
                        // Update text item position
                        if (currentPlan) {
                            updateFloorPlan(currentPlan.id, {
                                textItems: currentPlan.textItems?.map(t =>
                                    t.id === textItem.id ? { ...t, position: newPos } : t
                                )
                            });
                        }
                    }}
                    onDblClick={() => {
                        // Enable text editing
                        setEditingTextId(textItem.id);
                        setEditText(textItem.text);
                    }}
                    stroke={isSelected ? '#3b82f6' : undefined}
                    strokeWidth={isSelected ? 0.5 : 0}
                />
            );
        });
    };

    // Render current drawing path
    const renderDrawingPath = () => {
        if (!isDrawing || currentPath.length === 0) return null;

        const tool = drawingState.activeTool;

        if (tool === 'wall' && currentPath.length === 2) {
            return (
                <Line
                    points={[
                        currentPath[0].x,
                        currentPath[0].y,
                        currentPath[1].x,
                        currentPath[1].y
                    ]}
                    stroke="#3b82f6"
                    strokeWidth={drawingState.wallThickness ?? 10}
                    lineCap="round"
                    opacity={0.4}
                />
            );
        }

        if (tool === 'room' && currentPath.length > 0) {
            const points = currentPath.flatMap(p => [p.x, p.y]);
            return (
                <Line
                    points={points}
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dash={[5, 5]}
                />
            );
        }

        return null;
    };

    // Cursor reflects the effective tool. `component` mode gets a crosshair
    // rather than 'copy': the copy cursor implies a clipboard paste, not
    // placement, and it obscured the exact point being clicked.
    const cursor = drawingState.activeTool === 'component'
        ? 'crosshair'
        : DRAWING_TOOL_CURSORS[drawingState.activeTool];

    if (!currentPlan) {
        // Empty state. Previously two lines of grey text with no affordance —
        // the only way forward was to find the small "+" in the bottom bar.
        return (
            <div
                ref={containerRef}
                className="w-full h-full flex items-center justify-center"
                style={{ backgroundColor: colors.canvasBackground }}
            >
                <div className="max-w-sm p-8 text-center" style={{ color: colors.text }}>
                    <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-blue-500/15 text-blue-500">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 21V5a2 2 0 0 1 2-2h11l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                            <path d="M16 3v5h5M8 13h8M8 17h5" />
                        </svg>
                    </div>

                    <p className="text-base font-semibold">Start a floor plan</p>
                    <p className="mt-1 text-sm opacity-60">
                        Upload an architectural drawing to trace and auto-detect walls and rooms,
                        or start from a blank canvas.
                    </p>

                    <button
                        type="button"
                        onClick={onRequestNewPlan}
                        className="mt-4 rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
                    >
                        Add floor plan
                    </button>

                    <p className="mt-4 text-[11px] opacity-45">
                        Tip: calibrate the scale afterwards so areas and cable lengths are accurate.
                    </p>
                </div>
            </div>
        );
    }

    // Handle drop of staging components
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const stage = stageRef.current?.getStage();
        if (!stage) return;

        try {
            const raw = e.dataTransfer.getData('application/json');
            if (!raw) return;
            const data = JSON.parse(raw);

            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;

            const dropX = (e.clientX - rect.left - position.x) / scale;
            const dropY = (e.clientY - rect.top - position.y) / scale;

            // Palette drag. The library previously only supported click-then-click
            // placement, while the "Unplaced" tab supported drag-and-drop — two
            // different interactions for the same outcome, in the same sidebar.
            if (data._isLibraryComponent && data.type) {
                let placePos = { x: dropX, y: dropY };
                let rotation = 0;

                // Same wall snapping as click placement, so a dragged switch
                // lands flush on the wall and inherits its angle.
                if (currentPlan) {
                    const snapInfo = snapToWall(placePos, currentPlan.walls, 25);
                    if (snapInfo) {
                        placePos = snapInfo.snapPoint;
                        rotation = Math.atan2(
                            snapInfo.wall.endPoint.y - snapInfo.wall.startPoint.y,
                            snapInfo.wall.endPoint.x - snapInfo.wall.startPoint.x
                        ) * 180 / Math.PI;
                    }
                }

                addComponent({
                    type: data.type as LayoutComponentType,
                    position: placePos,
                    rotation,
                    properties: {},
                    roomId: currentPlan ? findRoomForPoint(placePos, currentPlan.rooms)?.room.id : undefined
                });
                return;
            }

            // Check if this is a staging component
            if (data._isStagingComponent) {
                const stagingId = data.id;

                // Prevent duplicate placement
                if (stagingId && isStagingComponentPlaced(stagingId)) {
                    console.warn('[LayoutCanvas] Staging component already placed:', stagingId);
                    return;
                }

                // Create the component with its existing ID
                const newComponent: LayoutComponent = {
                    id: data.id,
                    type: data.type,
                    position: { x: dropX, y: dropY },
                    rotation: data.rotation || 0,
                    roomId: data.roomId,
                    properties: data.properties || {},
                    sldItemId: data.sldItemId
                };

                // Mark as in-flight FIRST to prevent race conditions
                if (stagingId) {
                    markStagingComponentPlaced(stagingId);
                }

                // Add the component with its ID preserved
                addComponentWithId(newComponent);

                // Clean up staging
                if (stagingId) {
                    removeStagingComponent(stagingId);
                    console.log('[LayoutCanvas] Staging component placed:', stagingId);
                }
            }
        } catch (error) {
            console.error('[LayoutCanvas] Drop error:', error);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!isDragOver) setIsDragOver(true);
    };

    return (
        <div
            ref={containerRef}
            className="w-full h-full relative"
            style={{
                cursor,
                backgroundColor: colors.canvasBackground
            }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={(e) => {
                // Only clear when the pointer truly leaves the container, not
                // when it crosses onto a child node.
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setIsDragOver(false);
            }}
        >
            {/* Drop hint. Without this the canvas gave no feedback that a dragged
                palette item could be released here. */}
            {isDragOver && (
                <div className="pointer-events-none absolute inset-3 z-20 rounded-xl border-2 border-dashed border-blue-500/70 bg-blue-500/5">
                    <span className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-blue-500 px-3 py-1 text-[11px] font-medium text-white shadow">
                        Drop to place on this floor plan
                    </span>
                </div>
            )}

            {/* Drawing instructions used to sit at top-centre, directly underneath
                the floating toolbar which occupies the same spot — it was clipped
                and unreadable. It now lives in the status bar at the bottom. */}

            <Stage
                ref={stageRef}
                width={containerSize.width}
                height={containerSize.height}
                scaleX={scale}
                scaleY={scale}
                x={position.x}
                y={position.y}
                draggable={drawingState.activeTool === 'pan'}
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => {
                    // Finish any marquee that ends outside the canvas, otherwise
                    // it would stay stuck on screen until the next click.
                    if (selectionBox) handleMouseUp(null);
                    reportCursor(null);
                    setActiveSnap(null);
                    setHoverInfo(null);
                }}
                onDblClick={handleDoubleClick}
                onDragEnd={(e) => {
                    if (e.target !== e.target.getStage()) return;
                    setPosition({ x: e.target.x(), y: e.target.y() });
                }}
            >
                <Layer>
                    {/* Canvas background */}
                    <Rect
                        x={0}
                        y={0}
                        width={currentPlan.width}
                        height={currentPlan.height}
                        fill={theme === 'dark' ? '#1f2937' : '#fff'}
                        stroke={colors.border}
                        strokeWidth={2}
                        name="grid-background"
                    />

                    {/* Background image */}
                    {backgroundImage && (
                        <KonvaImage
                            image={backgroundImage}
                            x={0}
                            y={0}
                            width={currentPlan.width}
                            height={currentPlan.height}
                            opacity={0.5}
                            name="grid-background"
                        />
                    )}

                    {/* Grid */}


                    {/* Rooms */}
                    {showRooms && renderRooms()}

                    {/* Magic Wires - AutoCAD-style SLD connection overlay */}
                    {renderMagicWires()}

                    {/* Unselected Layers (Bottom) */}
                    {showWalls && renderWalls(false)}
                    {showDoors && renderDoors(false)}
                    {showWindows && renderWindows(false)}
                    {renderConnections(false)}
                    {renderComponents(false)}

                    {/* Selected Layers (Top) */}
                    {showWalls && renderWalls(true)}
                    {showDoors && renderDoors(true)}
                    {showWindows && renderWindows(true)}
                    {renderConnections(true)}
                    {renderComponents(true)}

                    {/* Text Items */}
                    {renderTextItems()}

                    {renderOcrOverlay()}

                    {/* Window Handles (Always Top) */}
                    {renderWindowHandles()}

                    {/* Calibration Line */}
                    {drawingState.activeTool === 'calibrate' && isDrawing && currentPath.length > 0 && (
                        <Group>
                            <Line
                                points={currentPath.flatMap(p => [p.x, p.y])}
                                stroke="#ef4444"
                                strokeWidth={2}
                                dash={[10, 5]}
                            />
                            <Circle
                                x={currentPath[0].x}
                                y={currentPath[0].y}
                                radius={4}
                                fill="#ef4444"
                            />
                            {currentPath.length > 1 && (
                                <Circle
                                    x={currentPath[currentPath.length - 1].x}
                                    y={currentPath[currentPath.length - 1].y}
                                    radius={4}
                                    fill="#ef4444"
                                />
                            )}
                        </Group>
                    )}

                    {/* Current drawing path */}
                    {renderDrawingPath()}

                    {/* Snap indicator — shows what the next click will attach to */}
                    {activeSnap && (
                        <Group listening={false}>
                            {activeSnap.type === 'endpoint' ? (
                                // Square marker = existing wall corner (exact join)
                                <Rect
                                    x={activeSnap.point.x - 6 / scale}
                                    y={activeSnap.point.y - 6 / scale}
                                    width={12 / scale}
                                    height={12 / scale}
                                    stroke="#f59e0b"
                                    strokeWidth={2 / scale}
                                />
                            ) : (
                                // Circle marker = somewhere along a wall face (T-junction)
                                <Circle
                                    x={activeSnap.point.x}
                                    y={activeSnap.point.y}
                                    radius={6 / scale}
                                    stroke="#22d3ee"
                                    strokeWidth={2 / scale}
                                />
                            )}
                        </Group>
                    )}

                    {/* Rubber-band selection marquee */}
                    {selectionBox && (
                        <Rect
                            x={Math.min(selectionBox.start.x, selectionBox.end.x)}
                            y={Math.min(selectionBox.start.y, selectionBox.end.y)}
                            width={Math.abs(selectionBox.end.x - selectionBox.start.x)}
                            height={Math.abs(selectionBox.end.y - selectionBox.start.y)}
                            fill="rgba(59, 130, 246, 0.12)"
                            stroke="#3b82f6"
                            strokeWidth={1 / scale}
                            dash={[4 / scale, 3 / scale]}
                            listening={false}
                        />
                    )}
                </Layer>
            </Stage>

            {/* Context Menu Portal */}
            {menu.visible && reactCreatePortal(
                <>
                    <div
                        className="fixed inset-0 z-[9998]"
                        onClick={() => setMenu({ ...menu, visible: false })}
                        onContextMenu={(e) => { e.preventDefault(); setMenu({ ...menu, visible: false }); }}
                    />
                    <div
                        className="fixed border rounded shadow-lg text-xs py-0.5 z-[9999] min-w-[140px]"
                        style={{
                            top: menu.y,
                            left: menu.x,
                            backgroundColor: colors.canvasBackground, // Use valid color or standard background
                            borderColor: colors.border,
                            color: colors.text
                        }}
                    >
                        {/* Teleport Action */}
                        <button
                            className={`block w-full text-left px-3 py-1 text-blue-500 hover:bg-black/5`}
                            onClick={() => {
                                const comp = currentPlan?.components.find(c => c.id === menu.componentId);
                                if (comp) {
                                    let targetSldId = comp.sldItemId;

                                    if (!targetSldId) {
                                        const st = useStore.getState();
                                        const placed = st.sheets.flatMap(s => s.canvasItems).find(i => i.properties?.[0]?.['_layoutComponentId'] === comp.id);
                                        const staged = st.stagingItems.find(i => i.properties?.[0]?.['_layoutComponentId'] === comp.id);
                                        targetSldId = placed?.uniqueID || staged?.uniqueID;

                                        if (targetSldId) {
                                            useLayoutStore.getState().updateComponent(comp.id, { sldItemId: targetSldId });
                                        }
                                    }

                                    if (targetSldId) {
                                        // Find which sheet this item belongs to
                                        const sldStore = useStore.getState();
                                        const targetSheet = sldStore.sheets.find(s => s.canvasItems.some(i => i.uniqueID === targetSldId));

                                        if (targetSheet && targetSheet.sheetId !== sldStore.activeSheetId) {
                                            sldStore.setActiveSheet(targetSheet.sheetId);
                                        }

                                        // Select SLD Item (this updates selectedItemIds)
                                        sldStore.selectItem(targetSldId);

                                        // Switch to SLD View
                                        useLayoutStore.getState().setActiveView('sld');
                                    }
                                }
                                setMenu({ ...menu, visible: false });
                            }}
                        >
                            Go to Schematic ↗
                        </button>

                        {/* Divider */}
                        <div className="h-px mx-2 my-1" style={{ backgroundColor: colors.border }} />

                        {/* Copy */}
                        <button
                            className="block w-full text-left px-3 py-1 hover:bg-black/5 dark:hover:bg-white/10"
                            onClick={() => {
                                if (menu.componentId) {
                                    selectElement(menu.componentId);
                                    useLayoutStore.getState().copySelection();
                                }
                                setMenu({ ...menu, visible: false });
                            }}
                        >
                            📋 Copy
                        </button>

                        {/* Rotate 90° */}
                        <button
                            className="block w-full text-left px-3 py-1 hover:bg-black/5 dark:hover:bg-white/10"
                            onClick={() => {
                                const comp = currentPlan?.components.find(c => c.id === menu.componentId);
                                if (comp) {
                                    takeSnapshot();
                                    useLayoutStore.getState().updateComponent(comp.id, {
                                        rotation: ((comp.rotation || 0) + 90) % 360
                                    });
                                }
                                setMenu({ ...menu, visible: false });
                            }}
                        >
                            🔄 Rotate 90°
                        </button>

                        {/* Delete */}
                        <button
                            className="block w-full text-left px-3 py-1 text-red-500 hover:bg-red-500/10"
                            onClick={() => {
                                if (menu.componentId) {
                                    selectElement(menu.componentId);
                                    deleteSelected();
                                }
                                setMenu({ ...menu, visible: false });
                            }}
                        >
                            🗑️ Delete
                        </button>
                    </div>
                </>,
                document.body
            )}
            {/* HUD Overlay */}
            {hoverInfo && (
                <div
                    className="absolute z-50 pointer-events-none px-2 py-1 bg-black/80 text-white text-xs rounded border border-white/20 shadow-xl backdrop-blur-sm"
                    style={{
                        top: hoverInfo.y,
                        left: hoverInfo.x
                    }}
                >
                    {hoverInfo.text}
                </div>
            )}

            {ocrHoverInfo && (
                <div
                    className="absolute z-50 pointer-events-none px-2 py-1 bg-black/80 text-white text-xs rounded border border-white/20 shadow-xl backdrop-blur-sm"
                    style={{
                        top: ocrHoverInfo.y,
                        left: ocrHoverInfo.x
                    }}
                >
                    {ocrHoverInfo.text}
                </div>
            )}

            {currentPlan?.ocr?.enabled && (
                <div
                    className={`absolute z-40 rounded-lg border shadow-lg p-3 w-[280px] transition-all duration-300 ${inspectorOpen ? 'right-64' : 'right-3'} ${loadSummaryVisible ? 'top-[260px]' : 'top-28'}`}
                    style={{
                        backgroundColor: colors.panelBackground,
                        borderColor: colors.border,
                        color: colors.text
                    }}
                >
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-semibold">OCR Labels</div>
                        <button
                            className="text-xs px-2 py-1 rounded hover:bg-black/10 dark:hover:bg-white/10"
                            onClick={() => setOcrSettings({ showOcr: !showOcr })}
                        >
                            {showOcr ? 'Hide' : 'Show'}
                        </button>
                    </div>

                    <div className="space-y-2">
                        <div>
                            <div className="flex items-center justify-between text-[11px] opacity-80 mb-1">
                                <span>Min confidence</span>
                                <span className="font-mono">{ocrMinConfidence}%</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={100}
                                value={ocrMinConfidence}
                                onChange={(e) => setOcrSettings({ minConfidence: parseInt(e.target.value, 10) || 0 })}
                                className="w-full"
                            />
                        </div>

                        <div>
                            <div className="text-[11px] opacity-80 mb-1">Search</div>
                            <input
                                value={ocrQuery}
                                onChange={(e) => setOcrSettings({ query: e.target.value })}
                                placeholder="e.g. DB, KITCHEN, 12A"
                                className="w-full px-2 py-1 rounded border text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                                style={{
                                    backgroundColor: colors.canvasBackground,
                                    borderColor: colors.border,
                                    color: colors.text
                                }}
                            />
                        </div>

                        <label className="flex items-center gap-2 text-xs select-none">
                            <input
                                type="checkbox"
                                checked={showOcrBoxes}
                                onChange={(e) => setOcrSettings({ showBoxes: e.target.checked })}
                            />
                            Show bounding boxes
                        </label>

                        <button
                            className={`w-full text-xs px-2 py-1 rounded border transition-colors ${ocrCopied ? 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30' : 'hover:bg-black/10 dark:hover:bg-white/10'}`}
                            style={{ borderColor: colors.border, color: ocrCopied ? undefined : colors.text }}
                            onClick={async () => {
                                try {
                                    const payload = {
                                        ...currentPlan.ocr,
                                        items: currentPlan.ocr?.items || []
                                    };
                                    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
                                    setOcrCopied(true);
                                    window.setTimeout(() => setOcrCopied(false), 1200);
                                } catch {
                                }
                            }}
                        >
                            {ocrCopied ? 'Copied OCR JSON' : 'Copy OCR JSON'}
                        </button>

                        <div className="text-[11px] opacity-70">
                            Showing {showOcr ? visibleOcrItems.length : 0} / {filteredOcrItems.length} labels
                        </div>

                        {currentPlan?.ocr?.orientation && (
                            <div className="text-[11px] opacity-70">
                                Orientation: {currentPlan.ocr.orientation.rotate_degrees ?? currentPlan.ocr.orientation.orientation_degrees ?? 'n/a'}°
                            </div>
                        )}
                    </div>
                </div>
            )}


            {/* Text Editing Overlay */}
            {editingTextId && currentPlan && (() => {
                const item = currentPlan.textItems?.find(t => t.id === editingTextId);
                if (!item) return null;

                return (
                    <div
                        style={{
                            position: 'absolute',
                            top: item.position.y * scale + position.y,
                            left: item.position.x * scale + position.x,
                            transform: 'translate(0%, -50%)', // Text origin is top-left, adjust for centering if needed
                            pointerEvents: 'auto',
                            zIndex: 1000
                        }}
                    >
                        <div className="relative">
                            <textarea
                                autoFocus
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                onBlur={(e) => {
                                    // Check if the new focus is inside our editor container (e.g. properties panel)
                                    // The parent is the div.relative wrapper which contains both textarea and properties panel
                                    if (e.relatedTarget && (e.target as HTMLElement).parentElement?.contains(e.relatedTarget as Node)) {
                                        return;
                                    }

                                    if (currentPlan) {
                                        updateFloorPlan(currentPlan.id, {
                                            textItems: currentPlan.textItems?.map(t =>
                                                t.id === editingTextId ? { ...t, text: editText } : t
                                            )
                                        });
                                    }
                                    setEditingTextId(null);
                                }}
                                onKeyDown={(e) => {
                                    // Stop propagation to prevent global shortcuts (like Backspace/Delete)
                                    e.stopPropagation();

                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        (e.target as HTMLTextAreaElement).blur();
                                    }
                                    if (e.key === 'Escape') {
                                        setEditingTextId(null);
                                    }
                                }}
                                style={{
                                    fontSize: `${(item.fontSize || 14) * scale}px`,
                                    fontFamily: item.fontFamily || 'Arial',
                                    color: item.color || (theme === 'dark' ? '#ffffff' : '#000000'),
                                    background: 'rgba(0,0,0,0.5)',
                                    border: '1px solid #3b82f6',
                                    borderRadius: '4px',
                                    padding: '4px',
                                    outline: 'none',
                                    resize: 'both',
                                    overflow: 'hidden',
                                    minWidth: '50px',
                                    minHeight: '1.2em',
                                    whiteSpace: 'pre'
                                }}
                            />
                            {/* Properties Panel for Text (Font size, Color) - Floating nearby */}
                            <div className="absolute top-full left-0 mt-2 bg-[#1e1e1e] border border-white/20 rounded p-2 flex flex-col gap-2 shadow-xl z-50 w-48"
                                onMouseDown={(e) => e.stopPropagation()}
                            >
                                <div className="text-[10px] uppercase text-gray-500 font-bold">Text Properties</div>
                                <div className="flex items-center gap-2">
                                    <label className="text-xs text-gray-400 w-12">Size:</label>
                                    <input
                                        type="number"
                                        value={item.fontSize || 14}
                                        onChange={(e) => {
                                            const size = parseInt(e.target.value) || 14;
                                            updateFloorPlan(currentPlan.id, {
                                                textItems: currentPlan.textItems?.map(t =>
                                                    t.id === editingTextId ? { ...t, fontSize: size } : t
                                                )
                                            });
                                        }}
                                        className="w-16 bg-black/20 border border-white/10 rounded px-1 py-0.5 text-xs text-white"
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <label className="text-xs text-gray-400 w-12">Color:</label>
                                    <input
                                        type="color"
                                        value={item.color || '#000000'}
                                        onChange={(e) => {
                                            updateFloorPlan(currentPlan.id, {
                                                textItems: currentPlan.textItems?.map(t =>
                                                    t.id === editingTextId ? { ...t, color: e.target.value } : t
                                                )
                                            });
                                        }}
                                        className="w-8 h-6 bg-transparent border-none p-0 cursor-pointer"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
});

LayoutCanvas.displayName = 'LayoutCanvas';
