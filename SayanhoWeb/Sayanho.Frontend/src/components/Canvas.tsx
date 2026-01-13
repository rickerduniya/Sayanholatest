import React, { useEffect, useState, useRef, forwardRef, useImperativeHandle } from 'react';
import { createPortal as reactCreatePortal } from 'react-dom';
import { Stage, Layer, Line, Group, Text, Rect } from 'react-konva';
import { useStore } from '../store/useStore';
import { useLayoutStore } from '../store/useLayoutStore';
import { CanvasItem, Connector, Point } from '../types';
import { ItemComponent } from './ItemComponent';
import { CreatePortalDialog } from './CreatePortalDialog';
import { SelectSheetDialog } from './SelectSheetDialog';
import { TextComponent } from './TextComponent';
import { ConnectorUtils } from '../utils/ConnectorUtils';
import { MousePointer2, Hand, ZoomIn, ZoomOut } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { getItemDefinition, DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { useResizeObserver } from '../hooks/useResizeObserver';
import { api } from '../services/api';
import { calculateAlignmentGuides } from '../utils/SnapUtils';
import { LOAD_ITEM_DEFAULTS } from '../utils/DefaultRulesEngine';
import { MaterialSelectionDialog } from './MaterialSelectionDialog';
import { ApplicationSettings } from '../utils/ApplicationSettings';
import { TouchHandler, TouchGesture } from '../utils/TouchHandler';
import { calculateSnapPosition } from '../utils/SnapUtils';
import { sortOptionStringsAsc } from '../utils/sortUtils';
import { fetchProperties } from '../utils/api';

const getPhaseColor = (connector: Connector, theme: string): string => {
    const useColor = ApplicationSettings.getSaveImageInColor();
    if (!useColor) return theme === 'dark' ? '#FFFFFF' : '#000000';

    if (connector.currentValues && connector.currentValues["Phase"]) {
        const phase = connector.currentValues["Phase"];
        if (phase === "R") return '#FF4500'; // OrangeRed
        if (phase === "Y") return '#FFD700'; // Gold
        if (phase === "B") return '#0000CD'; // MediumBlue
    }

    // Fallback logic mirroring C#
    if (connector.sourceItem.name === "HTPN" || connector.targetItem.name === "HTPN") {
        if (connector.sourcePointKey.includes("R") || connector.targetPointKey.includes("R")) return '#FF0000';
        if (connector.sourcePointKey.includes("Y") || connector.targetPointKey.includes("Y")) return '#FFD700';
        if (connector.sourcePointKey.includes("B") || connector.targetPointKey.includes("B")) return '#0000FF';
    }

    return theme === 'dark' ? '#FFFFFF' : '#000000';
};

const calculateArrowPoints = (center: Point, dirX: number, dirY: number, scale: number): number[] => {
    // Base size in pixels (at scale 1)
    const baseArrowSize = 15;
    const baseArrowWidth = 10;

    // We want the arrow to stay relatively constant in screen size? 
    // Or world size? C# uses `arrowSize = baseArrowSize * scale`.
    // If we are in Konva Stage with scale, we draw in world coordinates.
    // If we want it to look like C#, we should just use constant world units.
    // But wait, C# `Draw` takes `scale`. And it calculates `arrowSize = baseArrowSize * scale`.
    // This means as you zoom in (scale increases), the arrow gets bigger in pixels.
    // In Konva, if we draw a shape of size 15, and zoom 2x, it becomes 30 pixels.
    // So we just need a constant size in world units.

    // However, the C# code passes `scale` to `Draw`.
    // And `Draw` does `arrowSize = baseArrowSize * scale`.
    // So if scale is 2, arrowSize is 30.
    // In Konva, if we draw size 30, and Stage scale is 2, it becomes 60 pixels on screen.
    // That seems like double scaling.
    // Let's look at C# again.
    // `Draw(float scale, ...)`
    // `g.FillPolygon(..., arrowPoints)`
    // The Graphics object `g` might already be scaled?
    // In `CanvasImageSaver.cs` or `UnifiedDiagramForm.cs`, usually `g.ScaleTransform` is used.
    // If `g` is already scaled, then `arrowSize * scale` would double scale.
    // But `Connector.cs` calculates points and then subtracts `scrollOffsetX`.
    // It seems `Connector.cs` handles world-to-screen transformation manually?
    // "Adjust for scroll offset... arrowPoints[j].X - scrollOffsetX".
    // Yes, it seems C# does manual transformation.
    // In Konva, Stage handles transformation.
    // So we should use constant world units.

    // So we should use constant world units.

    const arrowSize = 15; // Constant world size (follows zoom)
    // No, if we want it to behave like a physical object on the canvas (like the line), it should scale WITH the canvas.
    // The line width is `2 / scale` (in the existing code).
    // `strokeWidth={15 / scale}` for hit area.
    // `strokeWidth={selectedConnectorIndex === i ? 3 / scale : 2 / scale}`.
    // This suggests the line width stays constant in SCREEN pixels (anti-scaling).
    // If we want the arrow to match the line style, we should also anti-scale it.

    const size = 15;
    const width = 10;


    const perpX = -dirY;
    const perpY = dirX;

    // Tip
    const tipX = center.x + dirX * size / 2;
    const tipY = center.y + dirY * size / 2;

    // Base 1
    const base1X = center.x - dirX * size / 2 + perpX * width / 2;
    const base1Y = center.y - dirY * size / 2 + perpY * width / 2;

    // Base 2
    const base2X = center.x - dirX * size / 2 - perpX * width / 2;
    const base2Y = center.y - dirY * size / 2 - perpY * width / 2;

    return [tipX, tipY, base1X, base1Y, base2X, base2Y];
};


export interface CanvasRef {
    saveImage: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    setZoom: (scale: number) => void;
    fitView: () => void;
}

interface CanvasProps {
    onScaleChange?: (scale: number) => void;
    panMode: boolean;
    isAddTextMode?: boolean;
    onAddTextComplete?: () => void;
}

export const Canvas = forwardRef<CanvasRef, CanvasProps>((props, ref) => {
    const {
        sheets, activeSheetId, addItem, updateItemPosition, updateItemSize, updateItemLock, duplicateItem,
        selectItem, selectedItemIds, selectAll, clearSelection, deleteSelected, moveItems,
        updateSheet, deleteItem, addConnector, selectedConnectorIndices, selectConnector, setEditMode, takeSnapshot,
        copySelection, pasteSelection, copyConnectorProperties, pasteConnectorProperties,
        rotateItem, flipItemVertically, flipItemHorizontally, updateItemProperties, updateItemTransform,
        copiedItems, copiedConnectorProperties, showCurrentValues,
        // Portal helpers
        isNetLabelUnique, createPortal, createPairedPortal, getPortalsByNetId, countConnectorsForItem,
        // Navigation
        setActiveSheet,
        // Staging items
        removeStagingItem, markStagingItemPlaced, isStagingItemPlaced
    } = useStore();
    const currentSheet = sheets.find(s => s.sheetId === activeSheetId);
    const { colors, theme } = useTheme();
    const stageRef = useRef<any>(null);
    const dragStartPositions = useRef<Map<string, { x: number, y: number }>>(new Map());
    const touchHandlerRef = useRef<TouchHandler | null>(null);

    // Responsive Canvas Sizing
    const { ref: containerRef, width: containerWidth, height: containerHeight } = useResizeObserver<HTMLDivElement>();

    // Interaction Modes
    const { panMode, isAddTextMode, onAddTextComplete } = props;

    // Connection State
    const [dragStart, setDragStart] = useState<{ itemId: string, pointKey: string, startPos: { x: number, y: number } } | null>(null);
    const [clickStart, setClickStart] = useState<{ itemId: string, pointKey: string } | null>(null);
    const [tempLine, setTempLine] = useState<number[] | null>(null);
    const [showMaterialDialog, setShowMaterialDialog] = useState(false);
    const [pendingConnection, setPendingConnection] = useState<{
        sourceId: string;
        sourceKey: string;
        targetId: string;
        targetKey: string;
    } | null>(null);
    const [hideConnectionPoints, setHideConnectionPoints] = useState(false); // For image export

    // Zoom and Pan state
    const [scale, setScale] = useState(currentSheet?.scale || 1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [isDraggingItem, setIsDraggingItem] = useState(false);
    const [menu, setMenu] = useState<{ visible: boolean; x: number; y: number; itemId: string | null; connectorIndex: number | null }>({ visible: false, x: 0, y: 0, itemId: null, connectorIndex: null });
    const [guides, setGuides] = useState<{ horizontal: number[], vertical: number[] }>({ horizontal: [], vertical: [] });

    // Selection Box State
    const [selectionBox, setSelectionBox] = useState<{ start: Point; end: Point } | null>(null);

    // Portal dialog state
    const [showCreatePortal, setShowCreatePortal] = useState(false);
    const [pendingPortalPos, setPendingPortalPos] = useState<{ x: number, y: number } | null>(null);
    const [showSelectSheet, setShowSelectSheet] = useState(false);
    const [pendingPair, setPendingPair] = useState<{ netId: string, direction: 'in' | 'out' } | null>(null);

    // Ref to track if we are actually dragging a connection line
    const isDraggingConnectionRef = useRef(false);
    // Ref to track if we are dragging an item (synchronous tracking for click handlers)
    const isDraggingRef = useRef(false);
    // Ref to track the distance of the last drag operation
    const lastDragDistanceRef = useRef(0);
    const lastDragEndTimeRef = useRef(0);

    // Debug helper
    const DEBUG = true;
    const log = (...args: any[]) => { if (DEBUG) console.log(...args); };

    // Touch Event Handling
    useEffect(() => {
        const handleGesture = (gesture: TouchGesture) => {
            if (gesture.type === 'pinch' && gesture.scale) {
                // Pinch to zoom
                const newScale = Math.max(0.1, Math.min(5, scale * gesture.scale));
                setScale(newScale);
            } else if (gesture.type === 'pan' && gesture.deltaX !== undefined && gesture.deltaY !== undefined) {
                // Two-finger pan
                setPosition(prev => ({
                    x: prev.x + gesture.deltaX!,
                    y: prev.y + gesture.deltaY!
                }));
            } else if (gesture.type === 'longPress') {
                // Long press for context menu
                const containerRect = stageRef.current?.container().getBoundingClientRect();
                if (containerRect) {
                    setMenu({
                        visible: true,
                        x: gesture.x - containerRect.left,
                        y: gesture.y - containerRect.top,
                        itemId: null,
                        connectorIndex: null
                    });
                }
            }
        };

        touchHandlerRef.current = new TouchHandler(handleGesture);

        const container = stageRef.current?.container();
        if (container) {
            const handleTouchStart = (e: TouchEvent) => {
                touchHandlerRef.current?.handleTouchStart(e);
            };
            const handleTouchMove = (e: TouchEvent) => {
                e.preventDefault(); // Prevent scroll
                touchHandlerRef.current?.handleTouchMove(e, scale);
            };
            const handleTouchEnd = (e: TouchEvent) => {
                touchHandlerRef.current?.handleTouchEnd(e);
            };

            container.addEventListener('touchstart', handleTouchStart, { passive: false });
            container.addEventListener('touchmove', handleTouchMove, { passive: false });
            container.addEventListener('touchend', handleTouchEnd);

            return () => {
                container.removeEventListener('touchstart', handleTouchStart);
                container.removeEventListener('touchmove', handleTouchMove);
                container.removeEventListener('touchend', handleTouchEnd);
                touchHandlerRef.current?.cleanup();
            };
        }
    }, [scale, stageRef]);

    const calculateContentBounds = () => {
        if (!currentSheet || currentSheet.canvasItems.length === 0) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        currentSheet.canvasItems.forEach(item => {
            minX = Math.min(minX, item.position.x);
            minY = Math.min(minY, item.position.y);
            maxX = Math.max(maxX, item.position.x + item.size.width);
            maxY = Math.max(maxY, item.position.y + item.size.height);
        });

        // Calculate bounding box of all connectors
        const existingPaths: Point[][] = [];
        currentSheet.storedConnectors.forEach(connector => {
            const sourceItem = currentSheet.canvasItems.find(ci => ci.uniqueID === connector.sourceItem.uniqueID) || connector.sourceItem;
            const targetItem = currentSheet.canvasItems.find(ci => ci.uniqueID === connector.targetItem.uniqueID) || connector.targetItem;

            const sourcePointValid = sourceItem.connectionPoints && sourceItem.connectionPoints[connector.sourcePointKey];
            const targetPointValid = targetItem.connectionPoints && targetItem.connectionPoints[connector.targetPointKey];

            if (!sourcePointValid || !targetPointValid) {
                console.warn('[Canvas][Bounds] Skipping connector with missing connection point', {
                    sourceValid: !!sourcePointValid,
                    targetValid: !!targetPointValid,
                    sourceKey: connector.sourcePointKey,
                    targetKey: connector.targetPointKey
                });
                return;
            }

            // Calculate path at scale 1 (world coordinates)
            const result = ConnectorUtils.calculateConnectorPath(
                { ...connector, sourceItem, targetItem },
                currentSheet.canvasItems,
                existingPaths,
                1 // Force scale 1 for world coordinate calculation
            );

            existingPaths.push(result.points);

            result.points.forEach(p => {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            });
        });

        if (minX === Infinity) return null;

        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    };

    useImperativeHandle(ref, () => ({
        saveImage: async () => {
            console.log('[SAVE IMAGE] Starting save image process...');
            if (stageRef.current && currentSheet) {
                try {
                    // Hide connection points before export
                    setHideConnectionPoints(true);

                    // Wait for state update to propagate and re-render
                    await new Promise(resolve => setTimeout(resolve, 300));

                    const stage = stageRef.current.getStage();
                    console.log('[SAVE IMAGE] Got stage reference');

                    // Force layer redraw to ensure connection points are hidden
                    stage.getLayers().forEach((layer: any) => layer.batchDraw());

                    const bounds = calculateContentBounds();
                    if (!bounds) {
                        console.log('[SAVE IMAGE] Canvas is empty');
                        alert("Canvas is empty.");
                        return;
                    }

                    // Add padding/margin
                    const padding = 50;
                    const minX = bounds.minX - padding;
                    const minY = bounds.minY - padding;
                    const maxX = bounds.maxX + padding;
                    const maxY = bounds.maxY + padding;
                    const width = maxX - minX;
                    const height = maxY - minY;

                    console.log('[SAVE IMAGE] Bounding box:', { minX, minY, maxX, maxY, width, height });

                    // 3. Create a temporary canvas for the final image
                    const tempCanvas = document.createElement('canvas');
                    const pixelRatio = 2; // High resolution
                    tempCanvas.width = width * pixelRatio;
                    tempCanvas.height = height * pixelRatio;
                    const ctx = tempCanvas.getContext('2d');

                    if (!ctx) {
                        throw new Error("Could not get 2d context");
                    }

                    // 4. Fill with background color matching the theme
                    ctx.fillStyle = colors.canvasBackground;
                    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
                    console.log('[SAVE IMAGE] Created temp canvas with white background');

                    // 5. Get the stage content as an image
                    console.log('[SAVE IMAGE] Calling stage.toDataURL...');

                    // Save current stage state
                    const oldScale = stage.scaleX();
                    const oldPos = stage.position();

                    // Reset stage to show the full area we want to capture
                    // We move the stage so that (minX, minY) is at (0,0)
                    stage.scale({ x: 1, y: 1 });
                    stage.position({ x: -minX, y: -minY });
                    stage.batchDraw();

                    let dataURL;
                    try {
                        dataURL = stage.toDataURL({
                            x: 0,
                            y: 0,
                            width: width,
                            height: height,
                            pixelRatio: pixelRatio,
                            mimeType: 'image/png'
                        });
                        console.log('[SAVE IMAGE] toDataURL succeeded, dataURL length:', dataURL.length);
                    } catch (e) {
                        console.error('[SAVE IMAGE] toDataURL failed:', e);
                        alert('Failed to export canvas. The canvas may be tainted by cross-origin images.');
                        // Restore stage state even on error
                        stage.scale({ x: oldScale, y: oldScale });
                        stage.position(oldPos);
                        stage.batchDraw();
                        return;
                    }

                    // Restore stage state
                    stage.scale({ x: oldScale, y: oldScale });
                    stage.position(oldPos);
                    stage.batchDraw();

                    // 6. Draw the stage content onto the white canvas
                    const img = new Image();
                    img.onload = () => {
                        console.log('[SAVE IMAGE] Image loaded, drawing to temp canvas');
                        ctx.drawImage(img, 0, 0);

                        // 7. Convert to Blob and Download
                        // We use application/octet-stream to force the browser to treat it as a download
                        // This often helps with filename preservation
                        console.log('[SAVE IMAGE] Converting to Blob...');
                        tempCanvas.toBlob((blob) => {
                            if (blob) {
                                console.log('[SAVE IMAGE] Blob created, size:', blob.size);
                                const url = URL.createObjectURL(blob);
                                const link = document.createElement('a');
                                const filename = `diagram_${Date.now()}.png`;
                                link.download = filename;
                                link.href = url;
                                // link.style.display = 'none'; // Try keeping it visible but hidden via positioning
                                link.style.position = 'absolute';
                                link.style.left = '-9999px';
                                document.body.appendChild(link);

                                console.log('[SAVE IMAGE] Link element:', link);
                                console.log('[SAVE IMAGE] Triggering download for:', filename);

                                // Small delay to ensure DOM update
                                setTimeout(() => {
                                    link.click();

                                    // Show success message
                                    alert(`Image saved as ${filename}! Check your Downloads folder.`);

                                    // Cleanup
                                    setTimeout(() => {
                                        document.body.removeChild(link);
                                        URL.revokeObjectURL(url);
                                        console.log('[SAVE IMAGE] Cleanup complete');
                                    }, 5000);
                                }, 100);
                            } else {
                                console.error('[SAVE IMAGE] Failed to create blob');
                                alert('Failed to create image blob.');
                            }
                        }, 'image/png');
                    };
                    img.onerror = (e) => {
                        console.error("[SAVE IMAGE] Error loading stage snapshot:", e);
                        alert("Failed to process diagram image.");
                    };
                    img.src = dataURL;

                } catch (e) {
                    console.error('[SAVE IMAGE] Error:', e);
                    alert('Failed to save image. See console for details.');
                } finally {
                    // Restore connection points visibility
                    setHideConnectionPoints(false);
                }
            } else {
                console.log('[SAVE IMAGE] No stage ref or current sheet');
            }
        },
        zoomIn: () => {
            setScale(prev => Math.min(prev * 1.2, 5));
        },
        zoomOut: () => {
            setScale(prev => Math.max(prev / 1.2, 0.1));
        },
        resetZoom: () => {
            setScale(0.65);
            setPosition({ x: 0, y: 0 });
        },
        setZoom: (newScale: number) => {
            setScale(Math.max(0.1, Math.min(newScale, 5)));
        },
        fitView: () => {
            const bounds = calculateContentBounds();
            if (!bounds) return;

            const padding = 50;
            const boundsWidth = bounds.width + padding * 2;
            const boundsHeight = bounds.height + padding * 2;

            const stage = stageRef.current?.getStage();
            if (!stage) return;

            // Container size (visible area)
            const stageWidth = stage.width();
            const stageHeight = stage.height();

            // Calculate scale to fit
            const scaleX = stageWidth / boundsWidth;
            const scaleY = stageHeight / boundsHeight;
            let newScale = Math.min(scaleX, scaleY);

            // Clamp scale (don't zoom in too much for small items, don't zoom out too far)
            newScale = Math.max(0.1, Math.min(newScale, 1.5)); // Max 1.5x to avoid looking huge

            // Calculate position to center the content
            // The content top-left is at (bounds.minX - padding, bounds.minY - padding)
            // We want to move that point to be centered

            // Center of bounds in world coordinates
            const boundsCenterX = bounds.minX + bounds.width / 2;
            const boundsCenterY = bounds.minY + bounds.height / 2;

            // Center of viewport in world coordinates (if we want it centered)
            // Viewport center in screen pixels is (stageWidth/2, stageHeight/2)
            // World pos = (ScreenPos - StagePos) / Scale
            // We want: ScreenPos = StagePos + WorldPos * Scale
            // StagePos = ScreenPos - WorldPos * Scale

            const newX = (stageWidth / 2) - (boundsCenterX * newScale);
            const newY = (stageHeight / 2) - (boundsCenterY * newScale);

            setScale(newScale);
            setPosition({ x: newX, y: newY });
        }
    }));

    // --- Viewport Persistence ---

    // 1. Restore Viewport when Sheet Changes
    useEffect(() => {
        if (currentSheet) {
            // Only restore if we are switching to a DIFFERENT sheet (or initial load)
            // But how do we distinguish "store update" from "sheet switch"?
            // We rely on sheetId. If sheetId changes, we MUST restore.
            // What if we just reloaded the same sheet?

            // To be safe, we check if the local state diverges significantly from the store 
            // AND we define this as a "reset" condition? 
            // Actually, simplest is: depend on sheetId.
            setPosition({ x: currentSheet.viewportX || 0, y: currentSheet.viewportY || 0 });
            setScale(currentSheet.scale || 0.65);
        }
    }, [currentSheet?.sheetId]);

    // 2. Sync Viewport to Store (Debounced)
    useEffect(() => {
        if (!updateSheet || !currentSheet) return;

        const timer = setTimeout(() => {
            const hasChanged =
                Math.abs(currentSheet.scale - scale) > 0.001 ||
                Math.abs((currentSheet.viewportX || 0) - position.x) > 1 ||
                Math.abs((currentSheet.viewportY || 0) - position.y) > 1;

            if (hasChanged) {
                updateSheet({
                    scale,
                    viewportX: position.x,
                    viewportY: position.y
                }, { recalcNetwork: false });
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [scale, position, updateSheet, currentSheet]); // Dependent on values to trigger debounce

    // Auto-focus on mount if selection exists (Teleport support)
    useEffect(() => {
        // Only run if exactly one item is selected (teleport scenario)
        if (selectedItemIds.length === 1 && currentSheet) {
            const itemId = selectedItemIds[0];
            const item = currentSheet.canvasItems.find(i => i.uniqueID === itemId);

            if (item) {
                setTimeout(() => {
                    // Use ref directly to get latest dimensions if observing hasn't fired yet
                    const stageW = containerRef.current?.offsetWidth || window.innerWidth;
                    const stageH = containerRef.current?.offsetHeight || window.innerHeight;

                    const itemCenterX = item.position.x + item.size.width / 2;
                    const itemCenterY = item.position.y + item.size.height / 2;

                    const targetScale = 1.0;

                    setScale(targetScale);
                    setPosition({
                        x: stageW / 2 - itemCenterX * targetScale,
                        y: stageH / 2 - itemCenterY * targetScale
                    });
                }, 100);
            }
        }
    }, []); // Run ONCE on mount

    useEffect(() => {
        if (props.onScaleChange) {
            props.onScaleChange(scale);
        }
    }, [scale, props.onScaleChange]);

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        stageRef.current.setPointersPositions(e);
        const stage = stageRef.current.getStage();
        const rel = stage.getRelativePointerPosition();
        const adjustedX = rel?.x ?? 0;
        const adjustedY = rel?.y ?? 0;

        const itemData = JSON.parse(e.dataTransfer.getData('application/json'));
        log('[UI][DROP] item from toolbox', {
            name: itemData?.name,
            iconPath: itemData?.iconPath,
            stage: { x: stage.x(), y: stage.y(), scale: stage.scaleX() },
            pointer: stage.getPointerPosition(),
            relative: rel,
            dropAt: { x: adjustedX, y: adjustedY }
        });

        // Check if this is a staging item (from Unplaced Items tab)
        const isStagingItem = itemData._isStagingItem === true;
        const stagingItemId = itemData.uniqueID;

        // Prevent duplicate placement of staging items
        if (isStagingItem && stagingItemId && isStagingItemPlaced(stagingItemId)) {
            console.warn('[Canvas] Staging item already placed:', stagingItemId);
            return;
        }

        const newItem: CanvasItem = {
            uniqueID: isStagingItem ? stagingItemId : crypto.randomUUID(), // Keep original ID for staging items to maintain sync
            name: itemData.name,
            position: { x: adjustedX, y: adjustedY },
            size: itemData.size,
            connectionPoints: itemData.connectionPoints,
            properties: isStagingItem ? (itemData.properties || []) : [], // Preserve properties for staging items
            alternativeCompany1: itemData.alternativeCompany1 || '',
            alternativeCompany2: itemData.alternativeCompany2 || '',
            svgContent: itemData.svgContent || undefined,
            iconPath: itemData.iconPath,
            locked: false,
            idPoints: itemData.idPoints || {},
            incomer: itemData.incomer || {},
            outgoing: itemData.outgoing || [],
            accessories: itemData.accessories || []
        };

        try {
            // For staging items, preserve the existing properties (including _layoutComponentId)
            // and only add missing default properties
            if (isStagingItem && newItem.properties.length > 0) {
                // Staging item already has properties - don't overwrite them
                // Just ensure we have the basics if anything is missing
                const existingProps = newItem.properties[0] || {};
                const props = await api.getItemProperties(itemData.name, 1);
                if (props?.properties && props.properties.length > 0) {
                    // Merge: keep existing props (like _layoutComponentId), add any missing from API
                    newItem.properties = [{
                        ...props.properties[0],  // API defaults as base
                        ...existingProps         // Existing props override (preserves _layoutComponentId)
                    }];
                }
                newItem.alternativeCompany1 = props?.alternativeCompany1 || newItem.alternativeCompany1;
                newItem.alternativeCompany2 = props?.alternativeCompany2 || newItem.alternativeCompany2;
            } else {
                // Normal item - load properties from API as usual
                const props = await api.getItemProperties(itemData.name, 1);
                if (props?.properties && props.properties.length > 0) {
                    newItem.properties = [props.properties[0]];
                } else if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                    // Fallback to local defaults if API returns nothing
                    newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
                }
                newItem.alternativeCompany1 = props?.alternativeCompany1 || '';
                newItem.alternativeCompany2 = props?.alternativeCompany2 || '';
            }
        } catch (err) {
            log('[UI][DROP] default properties load failed', { name: itemData.name, error: String(err) });
            // Fallback on error too - but still preserve staging item props
            if (!isStagingItem && LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }
        }

        // Source item: Override with hardcoded properties (matching C# Program.cs line 1394-1403)
        if (newItem.name === "Source") {
            newItem.properties = [{
                "Type": "3-phase",
                "Voltage": "415 V",
                "Frequency": "50 Hz"
            }];
        }

        // Fetch SVG Content
        if (itemData.iconPath) {
            try {
                const iconName = itemData.iconPath.split('/').pop();
                const url = api.getIconUrl(iconName);
                const encodedUrl = encodeURI(url);
                const response = await fetch(encodedUrl);
                if (response.ok) {
                    newItem.svgContent = await response.text();
                }
            } catch (e) {
                console.error("Failed to fetch SVG content", e);
            }
        }

        // Apply local definitions for static items
        const staticDef = getItemDefinition(newItem.name);
        if (staticDef && !["HTPN", "VTPN", "SPN DB", "Busbar Chamber"].includes(newItem.name)) {
            newItem.size = staticDef.size;
            newItem.connectionPoints = staticDef.connectionPoints;
        }

        // Initialize Distribution Boards and Switches
        if (["HTPN", "VTPN", "SPN DB", "Main Switch", "Change Over Switch", "Point Switch Board", "Avg. 5A Switch Board", "Busbar Chamber"].includes(newItem.name)) {
            if (!newItem.properties[0]) newItem.properties[0] = {};
            let wayVal = newItem.properties[0]["Way"];
            if (!wayVal || wayVal.includes(',')) {
                if (newItem.name === "SPN DB") wayVal = "2+4";
                else wayVal = "4";
                newItem.properties[0]["Way"] = wayVal;
            }

            try {
                const initData = await api.initializeItem(newItem.name, newItem.properties);
                if (initData) {
                    if (initData.incomer) newItem.incomer = initData.incomer;
                    if (initData.outgoing) newItem.outgoing = initData.outgoing;
                    if (initData.accessories) newItem.accessories = initData.accessories;
                }
            } catch (err) {
                console.error(`[Canvas] Failed to initialize item accessories:`, err);
            }

            // Ensure DB outgoing defaults are applied immediately on creation
            if (["HTPN", "VTPN", "SPN DB", "Busbar Chamber"].includes(newItem.name)) {
                const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(newItem.name);
                if (threshold > 0 && newItem.outgoing && newItem.outgoing.length > 0) {
                    const parseRating = (s: string) => {
                        const m = (s || '').toString().match(/(\d+(?:\.\d+)?)/);
                        return m ? parseFloat(m[1]) : NaN;
                    };

                    let defaultRating = "";
                    try {
                        const pole = newItem.name === "VTPN" ? "TP" : "SP";
                        const mcb = await fetchProperties("MCB");

                        const allRatings = sortOptionStringsAsc(
                            Array.from(new Set(
                                (mcb.properties || [])
                                    .map(p => p["Current Rating"])
                                    .filter(Boolean)
                            ))
                        );

                        const poleRatingsRaw = (mcb.properties || [])
                            .filter(p => {
                                const pPole = (p["Pole"] || "").toString();
                                if (!pPole) return false;
                                return pPole === pole || pPole.includes(pole);
                            })
                            .map(p => p["Current Rating"])
                            .filter(Boolean);
                        const poleRatings = sortOptionStringsAsc(Array.from(new Set(poleRatingsRaw)));
                        const ratings = poleRatings.length > 0 ? poleRatings : allRatings;

                        defaultRating = ratings.find(r => {
                            const v = parseRating(r);
                            return Number.isFinite(v) && v >= threshold;
                        }) || ratings[0] || "";
                    } catch (e) {
                        console.error('[Canvas] Failed to fetch outgoing rating options for defaults', e);
                    }

                    if (defaultRating) {
                        newItem.outgoing = newItem.outgoing.map(o => ({ ...(o || {}), "Current Rating": defaultRating }));
                    }
                }
            }

            const geometry = calculateGeometry(newItem);
            if (geometry) {
                newItem.size = geometry.size;
                newItem.connectionPoints = geometry.connectionPoints;
            }

            if (newItem.svgContent) {
                const updatedSvg = updateItemVisuals(newItem);
                if (updatedSvg) newItem.svgContent = updatedSvg;
            }
        }

        // PHASE 1.1: Ensure every SLD item has a canonical _layoutComponentId
        // This is critical for identity stability - reverse sync uses this to map to Layout components
        if (!newItem.properties[0]) {
            newItem.properties = [{}];
        }
        if (!newItem.properties[0]['_layoutComponentId']) {
            // Generate a stable canonical Layout component ID
            newItem.properties[0]['_layoutComponentId'] = `comp_${crypto.randomUUID()}`;
            console.log('[Canvas] Generated canonical _layoutComponentId:', newItem.properties[0]['_layoutComponentId']);
        }

        addItem(newItem);

        // If this was a staging item, remove it from staging and mark as placed
        if (isStagingItem && stagingItemId) {
            removeStagingItem(stagingItemId);
            markStagingItemPlaced(stagingItemId);
            console.log('[Canvas] Staging item placed and removed from staging:', stagingItemId);

            const layoutId = (newItem.properties?.[0] as any)?.['_layoutComponentId'];
            if (layoutId) {
                try {
                    useLayoutStore.getState().updateComponent(layoutId, { sldItemId: newItem.uniqueID });
                } catch (e) {
                    console.warn('[Canvas] Failed to backlink Layout component to placed SLD item', e);
                }
            }
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleWheel = (e: any) => {
        e.evt.preventDefault();
        const scaleBy = 1.1;
        const stage = e.target.getStage();
        if (!stage) return;

        const oldScale = stage.scaleX();
        const pointer = stage.getPointerPosition();

        if (!pointer) return;

        const mousePointTo = {
            x: (pointer.x - stage.x()) / oldScale,
            y: (pointer.y - stage.y()) / oldScale,
        };

        const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
        const clampedScale = Math.max(0.1, Math.min(newScale, 5));

        setScale(clampedScale);

        const newPos = {
            x: pointer.x - mousePointTo.x * clampedScale,
            y: pointer.y - mousePointTo.y * clampedScale,
        };

        setPosition(newPos);
    };

    const handleZoomIn = () => {
        const newScale = scale * 1.2;
        setScale(Math.min(newScale, 5));
    };

    const handleZoomOut = () => {
        const newScale = scale / 1.2;
        setScale(Math.max(newScale, 0.1));
    };

    const handleReset = () => {
        setScale(1);
        setPosition({ x: 0, y: 0 });
        if (stageRef.current) {
            const stage = stageRef.current.getStage();
            stage.position({ x: 0, y: 0 });
            stage.batchDraw();
        }
    };

    const handleDelete = () => {
        if (selectedItemIds.length > 0) {
            deleteSelected();
            return;
        }
        if (selectedConnectorIndices.length > 0) {
            deleteSelected();
        }
    };

    // --- Connection Logic ---

    const createConnection = (sourceId: string, sourceKey: string, targetId: string, targetKey: string) => {
        if (sourceId === targetId) return; // Don't connect to self

        const sourceItem = currentSheet?.canvasItems.find(i => i.uniqueID === sourceId);
        const targetItem = currentSheet?.canvasItems.find(i => i.uniqueID === targetId);

        if (!sourceItem || !targetItem) return;

        // Check if this is a special connection (Point Switch Board or Avg. 5A Switch Board)
        const isSpecialConnection =
            sourceItem.name === "Point Switch Board" ||
            targetItem.name === "Point Switch Board" ||
            sourceItem.name === "Avg. 5A Switch Board" ||
            targetItem.name === "Avg. 5A Switch Board";

        // Skip material selection if this connection involves an 'in' portal (mirrors properties)
        const isPortal = (it: any) => it?.name === 'Portal';
        const getDir = (it: any) => {
            const p = (it?.properties?.[0] || {}) as Record<string, string>;
            return (p['Direction'] || p['direction'] || '').toLowerCase();
        };

        const involvesInPortal = (isPortal(sourceItem) && getDir(sourceItem) === 'in') ||
            (isPortal(targetItem) && getDir(targetItem) === 'in');

        if (isSpecialConnection || involvesInPortal) {
            // Create connection directly without material selection
            finalizeConnection(sourceId, sourceKey, targetId, targetKey, 'Cable');
        } else {
            // Show material selection dialog
            setPendingConnection({ sourceId, sourceKey, targetId, targetKey });
            setShowMaterialDialog(true);
        }
    };

    const finalizeConnection = async (sourceId: string, sourceKey: string, targetId: string, targetKey: string, materialType: 'Cable' | 'Wiring') => {
        const sourceItem = currentSheet?.canvasItems.find(i => i.uniqueID === sourceId);
        const targetItem = currentSheet?.canvasItems.find(i => i.uniqueID === targetId);

        if (sourceItem && targetItem && addConnector && currentSheet) {
            // Portal allowances: allow dragging from/to portals in any direction; rely on addConnector to swap endpoints.
            const isPortal = (it: any) => it?.name === 'Portal';

            // Disallow portal-to-portal direct connection
            if (isPortal(sourceItem) && isPortal(targetItem)) {
                alert('Connecting a portal to another portal is not allowed.');
                return;
            }

            // One connector per portal (per sheet)
            if (isPortal(sourceItem)) {
                const cnt = countConnectorsForItem(currentSheet.sheetId, sourceItem.uniqueID);
                if (cnt >= 1) { alert('This portal already has a connection.'); return; }
            }
            if (isPortal(targetItem)) {
                const cnt = countConnectorsForItem(currentSheet.sheetId, targetItem.uniqueID);
                if (cnt >= 1) { alert('This portal already has a connection.'); return; }
            }

            // Fetch material-specific properties from backend (defaults)
            let properties: Record<string, string> = {};
            let alternativeCompany1 = '';
            let alternativeCompany2 = '';
            let laying: Record<string, string> = {};
            let materialOverride: 'Cable' | 'Wiring' | null = null;
            let forceVirtual = false;
            let forceLengthZero = false;

            // If connecting via an 'in' portal, mirror properties from its counterpart's connector
            const findPortalMeta = (it: any) => (it?.properties?.[0] || {}) as Record<string, string>;
            const getNetId = (it: any) => (findPortalMeta(it)['NetId'] || findPortalMeta(it)['netId'] || '').trim();
            const getDir = (it: any) => (findPortalMeta(it)['Direction'] || findPortalMeta(it)['direction'] || '').toLowerCase();

            const maybeMirrorFromCounterpart = () => {
                // Determine if this connection includes an 'in' portal
                const portalSide = isPortal(sourceItem) ? sourceItem : (isPortal(targetItem) ? targetItem : null);
                if (!portalSide) return;
                const dir = getDir(portalSide);
                if (dir !== 'in') return; // Only mirror on the target-side portal
                // Always treat 'in'-side connectors as virtual/zero-length
                forceVirtual = true;
                forceLengthZero = true;
                const netId = getNetId(portalSide);
                if (!netId) return;

                // Find counterpart portal
                const allPortals: any[] = [];
                sheets.forEach(sh => sh.canvasItems.forEach(ci => { if (ci.name === 'Portal') allPortals.push(ci); }));
                const pair = allPortals.filter(p => getNetId(p) === netId);
                if (pair.length !== 2) return;
                const counterpart = pair.find(p => p.uniqueID !== portalSide.uniqueID);
                if (!counterpart) return;

                // Find connector attached to counterpart portal
                const counterpartSheet = sheets.find(sh => sh.canvasItems.some(ci => ci.uniqueID === counterpart.uniqueID));
                const attached = counterpartSheet?.storedConnectors.find(c => c.sourceItem.uniqueID === counterpart.uniqueID || c.targetItem.uniqueID === counterpart.uniqueID);
                if (!attached) return;

                // Mirror properties and related fields if counterpart connector exists
                properties = { ...(attached.properties || {}) };
                materialOverride = attached.materialType;
                alternativeCompany1 = attached.alternativeCompany1 || '';
                alternativeCompany2 = attached.alternativeCompany2 || '';
                laying = { ...(attached.laying || {}) };
                // Ensure a flag for read-only handling in UI/back-end IsVirtual
                properties['IsVirtual'] = 'True';
            };

            maybeMirrorFromCounterpart();

            try {
                const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://sayanho-g22t.onrender.com/api';
                const response = await fetch(`${API_BASE_URL}/properties/${materialType}`);
                let apiData: any = null;
                if (response.ok && !forceVirtual) {
                    apiData = await response.json();
                    if (apiData.properties && apiData.properties.length > 0) {
                        properties = apiData.properties[0];
                        alternativeCompany1 = apiData.alternativeCompany1 || '';
                        alternativeCompany2 = apiData.alternativeCompany2 || '';
                        laying = apiData.laying || {};
                    }
                }

                // Apply dynamic core/wire configuration based on DOWNSTREAM item's phase type
                // Downstream = item with "in" connection point (receiving power)
                // Upstream = item with "out" connection point (sending power)
                // (excludes Point Switch Board and Avg. 5A Switch Board)
                if (!forceVirtual && sourceItem && targetItem) {
                    // Determine actual downstream item based on connection point types
                    // "in" point = downstream (receiving), "out" point = upstream (sending)
                    let downstreamItem = targetItem;
                    let downstreamPointKey = targetKey;

                    // Check if source has "in" point - then source is actually downstream
                    if (sourceKey.toLowerCase().startsWith('in') && !targetKey.toLowerCase().startsWith('in')) {
                        downstreamItem = sourceItem;
                        downstreamPointKey = sourceKey;
                    }
                    // Check if target has "out" point while source has "out" - use target as downstream (fallback)
                    else if (targetKey.toLowerCase().startsWith('out') && sourceKey.toLowerCase().startsWith('out')) {
                        // Both have "out" - unusual case, default to target
                        downstreamItem = targetItem;
                    }
                    // Normal case: source has "out", target has "in" - target is downstream

                    const downstreamProps = downstreamItem.properties?.[0] || {};
                    console.log(`[ConnectorDefaults] Downstream item: ${downstreamItem.name} (point: ${downstreamPointKey})`);

                    // Apply dynamic Core for cables
                    if (materialType === 'Cable') {
                        const dynamicDefaults = DefaultRulesEngine.getConnectorDefaultsForTarget(
                            materialType,
                            downstreamItem.name,
                            downstreamProps
                        );
                        if (dynamicDefaults.properties["Core"]) {
                            properties["Core"] = dynamicDefaults.properties["Core"];
                            console.log(`[ConnectorDefaults] Applied ${dynamicDefaults.properties["Core"]} for downstream: ${downstreamItem.name}`);
                        }
                    }

                    // Apply wire configuration for wiring - find minimum conductor size from database
                    if (materialType === 'Wiring' && apiData?.properties) {
                        const phaseType = DefaultRulesEngine.getItemPhaseType(downstreamItem.name, downstreamProps);
                        const isExcluded = DefaultRulesEngine.isExcludedFromPhaseLogic(downstreamItem.name);

                        if (!isExcluded) {
                            // Extract all available conductor sizes from the backend response
                            const availableSizes: string[] = apiData.properties
                                .map((p: any) => p["Conductor Size"])
                                .filter((s: string) => s && typeof s === 'string');

                            // Find the minimum conductor size for the required pattern
                            let targetConductorSize: string | null = null;

                            if (phaseType === 'three-phase') {
                                // Pattern: "3 x ... + 2 x ..."
                                const threePhasePattern = /^3 x \d+(\.\d+)? \+ 2 x \d+(\.\d+)? sq\.mm$/;
                                const matchingSizes = availableSizes.filter(s => threePhasePattern.test(s));
                                if (matchingSizes.length > 0) {
                                    // Sort by extracting the first numeric value to find minimum
                                    matchingSizes.sort((a, b) => {
                                        const numA = parseFloat(a.match(/^3 x (\d+\.?\d*)/)?.[1] || '999');
                                        const numB = parseFloat(b.match(/^3 x (\d+\.?\d*)/)?.[1] || '999');
                                        return numA - numB;
                                    });
                                    targetConductorSize = matchingSizes[0];
                                }
                            } else {
                                // Single-phase pattern: "2 x ... + 1 x ..."
                                const singlePhasePattern = /^2 x \d+(\.\d+)? \+ 1 x \d+(\.\d+)? sq\.mm$/;
                                const matchingSizes = availableSizes.filter(s => singlePhasePattern.test(s));
                                if (matchingSizes.length > 0) {
                                    // Sort by extracting the first numeric value to find minimum
                                    matchingSizes.sort((a, b) => {
                                        const numA = parseFloat(a.match(/^2 x (\d+\.?\d*)/)?.[1] || '999');
                                        const numB = parseFloat(b.match(/^2 x (\d+\.?\d*)/)?.[1] || '999');
                                        return numA - numB;
                                    });
                                    targetConductorSize = matchingSizes[0];
                                }
                            }

                            if (targetConductorSize) {
                                properties["Conductor Size"] = targetConductorSize;
                                console.log(`[ConnectorDefaults] Applied Conductor Size: ${targetConductorSize} for downstream: ${downstreamItem.name} (${phaseType})`);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to fetch material properties:', error);
            }

            const connector: Connector = {
                sourceItem: sourceItem,
                sourcePointKey: sourceKey,
                targetItem: targetItem,
                targetPointKey: targetKey,
                properties: properties,
                currentValues: {
                    "Current": "0 A",
                    "R_Current": "0 A",
                    "Y_Current": "0 A",
                    "B_Current": "0 A",
                    "Phase": ""
                },
                alternativeCompany1: alternativeCompany1,
                alternativeCompany2: alternativeCompany2,
                laying: laying,
                accessories: [],
                length: forceLengthZero ? 0 : 0,
                materialType: materialOverride || materialType,
                isVirtual: forceVirtual
            };
            addConnector(connector);
            log('[UI][CONNECT] Created connection', { sourceId, sourceKey, targetId, targetKey, materialType });
        }
    };

    const handleMaterialSelect = (material: 'Cable' | 'Wiring') => {
        if (pendingConnection) {
            finalizeConnection(
                pendingConnection.sourceId,
                pendingConnection.sourceKey,
                pendingConnection.targetId,
                pendingConnection.targetKey,
                material
            );
        }
        setShowMaterialDialog(false);
        setPendingConnection(null);
    };

    const handleMaterialCancel = () => {
        setShowMaterialDialog(false);
        setPendingConnection(null);
    };

    const handleConnectionPointMouseDown = (itemId: string, pointKey: string, e: any) => {
        if (panMode) return;
        const item = currentSheet?.canvasItems.find(i => i.uniqueID === itemId);
        if (!item) return;

        const point = item.connectionPoints[pointKey];
        const startX = item.position.x + point.x;
        const startY = item.position.y + point.y;

        setDragStart({ itemId, pointKey, startPos: { x: startX, y: startY } });
        setTempLine([startX, startY, startX, startY]);
        isDraggingConnectionRef.current = false;
    };

    const handleConnectionPointMouseUp = (itemId: string, pointKey: string, e: any) => {
        if (panMode) return;

        // Case 1: Drag-to-Connect completion
        if (dragStart) {
            createConnection(dragStart.itemId, dragStart.pointKey, itemId, pointKey);
            setDragStart(null);
            setTempLine(null);
            return;
        }
    };

    const handleConnectionPointClick = (itemId: string, pointKey: string, e: any) => {
        if (panMode) return;

        // If we were dragging, ignore the click (it was a drag release)
        if (isDraggingConnectionRef.current) {
            isDraggingConnectionRef.current = false;
            return;
        }

        if (!clickStart) {
            // Start click-click connection
            setClickStart({ itemId, pointKey });
            log('[UI][CONNECT] Click start', { itemId, pointKey });
        } else {
            // Complete click-click connection
            createConnection(clickStart.itemId, clickStart.pointKey, itemId, pointKey);
            setClickStart(null);
        }
    };

    const handleGlobalMouseMove = (e: any) => {
        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        const adjustedX = (pointer.x - position.x) / scale;
        const adjustedY = (pointer.y - position.y) / scale;

        if (dragStart) {
            isDraggingConnectionRef.current = true;
            setTempLine([dragStart.startPos.x, dragStart.startPos.y, adjustedX, adjustedY]);
        } else if (selectionBox) {
            setSelectionBox(prev => prev ? { ...prev, end: { x: adjustedX, y: adjustedY } } : null);

            // Update selection based on intersection
            if (currentSheet) {
                const boxX = Math.min(selectionBox.start.x, adjustedX);
                const boxY = Math.min(selectionBox.start.y, adjustedY);
                const boxW = Math.abs(adjustedX - selectionBox.start.x);
                const boxH = Math.abs(adjustedY - selectionBox.start.y);

                const newSelectedIds: string[] = [];
                currentSheet.canvasItems.forEach(item => {
                    // Simple AABB intersection
                    if (
                        item.position.x < boxX + boxW &&
                        item.position.x + item.size.width > boxX &&
                        item.position.y < boxY + boxH &&
                        item.position.y + item.size.height > boxY
                    ) {
                        newSelectedIds.push(item.uniqueID);
                    }
                });

                // We could optimize this to not call selectItem on every move if ids haven't changed
                // But for now, let's just update if different
                // Actually, selectItem(id, multi) toggles. We need a way to SET selection.
                // Let's use a temporary local state or just clear and add?
                // The store doesn't have "setSelectedIds". 
                // Let's add a hack: clear then select each? No, that triggers many updates.
                // Ideally we should add `setSelectedIds` to store.
                // For now, let's just do it on MouseUp to avoid performance issues, 
                // OR just render the box and calculate selection on MouseUp.
                // Calculating on MouseUp is standard and better for performance.
            }
        }
    };

    const handleGlobalMouseUp = () => {
        if (dragStart) {
            // Released over nothing
            setDragStart(null);
            setTempLine(null);
        }
        if (selectionBox) {
            // Finalize selection
            if (currentSheet) {
                const boxX = Math.min(selectionBox.start.x, selectionBox.end.x);
                const boxY = Math.min(selectionBox.start.y, selectionBox.end.y);
                const boxW = Math.abs(selectionBox.end.x - selectionBox.start.x);
                const boxH = Math.abs(selectionBox.end.y - selectionBox.start.y);

                // Only select if box has some size (avoid accidental clicks)
                if (boxW > 2 || boxH > 2) {
                    const newSelectedIds: string[] = [];
                    currentSheet.canvasItems.forEach(item => {
                        if (
                            item.position.x < boxX + boxW &&
                            item.position.x + item.size.width > boxX &&
                            item.position.y < boxY + boxH &&
                            item.position.y + item.size.height > boxY
                        ) {
                            newSelectedIds.push(item.uniqueID);
                        }
                    });

                    // If items are in the box, select items (connectors are ignored)
                    if (newSelectedIds.length > 0) {
                        clearSelection();
                        selectConnector(null); // Clear connector selection
                        newSelectedIds.forEach(id => selectItem(id, true));
                    } else {
                        // No items in box - check for connectors
                        const connectorIndicesInBox: number[] = [];

                        // Helper to check if a line segment intersects with the selection box
                        const lineIntersectsBox = (points: { x: number; y: number }[]): boolean => {
                            for (const point of points) {
                                if (point.x >= boxX && point.x <= boxX + boxW &&
                                    point.y >= boxY && point.y <= boxY + boxH) {
                                    return true;
                                }
                            }
                            // Also check if any segment crosses the box
                            for (let i = 0; i < points.length - 1; i++) {
                                const p1 = points[i];
                                const p2 = points[i + 1];
                                // Simple bounding box check for segment
                                const segMinX = Math.min(p1.x, p2.x);
                                const segMaxX = Math.max(p1.x, p2.x);
                                const segMinY = Math.min(p1.y, p2.y);
                                const segMaxY = Math.max(p1.y, p2.y);
                                if (segMaxX >= boxX && segMinX <= boxX + boxW &&
                                    segMaxY >= boxY && segMinY <= boxY + boxH) {
                                    return true;
                                }
                            }
                            return false;
                        };

                        calculatedPaths.forEach((pathData, idx) => {
                            if (lineIntersectsBox(pathData.points)) {
                                connectorIndicesInBox.push(idx);
                            }
                        });

                        if (connectorIndicesInBox.length > 0) {
                            clearSelection(); // Clear item selection
                            selectConnector(connectorIndicesInBox);
                        }
                    }
                }
            }
            setSelectionBox(null);
        }
    };

    // Use a ref to hold the latest handleGlobalMouseUp to avoid re-attaching the listener
    const handleGlobalMouseUpRef = useRef(handleGlobalMouseUp);

    // Update the ref on every render (since handleGlobalMouseUp is recreated on every render)
    useEffect(() => {
        handleGlobalMouseUpRef.current = handleGlobalMouseUp;
    }); // No dependency array means it updates on every render

    // Attach global listener once
    useEffect(() => {
        const onApplyGlobalMouseUp = () => {
            // Invoke the latest handler
            handleGlobalMouseUpRef.current();
        };
        window.addEventListener('mouseup', onApplyGlobalMouseUp);
        return () => window.removeEventListener('mouseup', onApplyGlobalMouseUp);
    }, []);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete') {
                handleDelete();
            }
            if (e.key === 'Escape') {
                setClickStart(null);
                setDragStart(null);
                setTempLine(null);
                setSelectionBox(null);
                clearSelection();
            }
            // Copy/Paste shortcuts
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                copySelection();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                // Paste at mouse position? Or center?
                // For shortcut, maybe center of screen or offset from original
                pasteSelection();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                selectAll();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedItemIds, selectedConnectorIndices, clickStart, dragStart, selectionBox]);

    // Helper to calculate all paths for rendering
    const calculatedPaths = React.useMemo(() => {
        if (!currentSheet) return [];
        const existingPaths: Point[][] = [];
        return currentSheet.storedConnectors.map((connector, i) => {
            const sourceItem = currentSheet.canvasItems.find(ci => ci.uniqueID === connector.sourceItem.uniqueID) || connector.sourceItem;
            const targetItem = currentSheet.canvasItems.find(ci => ci.uniqueID === connector.targetItem.uniqueID) || connector.targetItem;

            const updatedConnector = { ...connector, sourceItem, targetItem };

            // CRITICAL SENTRY: Check if connection points exist on the items
            // This prevents crashes when an item's configuration changes (re-rendering connection points)
            // but the connector still references the old point key (e.g. Busbar 4-bar -> 2-bar)
            const sourcePointValid = sourceItem.connectionPoints && sourceItem.connectionPoints[connector.sourcePointKey];
            const targetPointValid = targetItem.connectionPoints && targetItem.connectionPoints[connector.targetPointKey];

            if (!sourcePointValid || !targetPointValid) {
                console.warn(`[Canvas] Missing connection point for connector ${i}`, {
                    sourceValid: !!sourcePointValid,
                    targetValid: !!targetPointValid,
                    sourceKey: connector.sourcePointKey,
                    targetKey: connector.targetPointKey
                });
                return { points: [], connector: updatedConnector };
            }

            const result = ConnectorUtils.calculateConnectorPath(
                updatedConnector,
                currentSheet.canvasItems,
                existingPaths,
                1, // Fixed scale 1 for path logic (ignore zoom)
                currentSheet.storedConnectors // Pass all connectors for X-position ordering
            );
            existingPaths.push(result.points);
            return { ...result, connector: updatedConnector };
        });
    }, [currentSheet?.storedConnectors, currentSheet?.canvasItems]);

    // Background Pattern Style
    const backgroundStyle: React.CSSProperties = {
        backgroundColor: colors.canvasBackground,
        backgroundImage: theme === 'dark'
            ? 'radial-gradient(#1e293b 1px, transparent 1px)' // Darker dots (Slate 800)
            : 'radial-gradient(#ccc 1px, transparent 1px)',
        backgroundSize: `${20 * scale}px ${20 * scale}px`,
        backgroundPosition: `${position.x}px ${position.y}px`
    };

    return (
        <div
            ref={containerRef}
            className="flex-1 overflow-hidden relative h-full"
            style={backgroundStyle}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
        >
            <Stage
                width={containerWidth}
                height={containerHeight}
                ref={stageRef}
                draggable={panMode}
                scaleX={scale}
                scaleY={scale}
                x={position.x}
                y={position.y}
                onWheel={handleWheel}
                onMouseMove={handleGlobalMouseMove}
                onDragMove={(e) => {
                    if (e.target === e.target.getStage()) {
                        setPosition({ x: e.target.x(), y: e.target.y() });
                    }
                }}
                onDragEnd={(e) => {
                    if (e.target === e.target.getStage()) {
                        setPosition({ x: e.target.x(), y: e.target.y() });
                    }
                }}
                onMouseDown={(e) => {
                    if (e.target === e.target.getStage()) {
                        // Add Text Mode Logic
                        if (isAddTextMode) {
                            const stage = e.target.getStage();
                            const pointer = stage?.getPointerPosition();
                            if (pointer) {
                                const x = (pointer.x - position.x) / scale;
                                const y = (pointer.y - position.y) / scale;

                                // Create Text Item
                                const newTextItem: CanvasItem = {
                                    uniqueID: crypto.randomUUID(),
                                    name: "Text",
                                    position: { x, y },
                                    size: { width: 200, height: 50 },
                                    connectionPoints: {},
                                    properties: [{
                                        "Text": "Double-click to edit",
                                        "FontSize": "16",
                                        "FontFamily": "Arial",
                                        "Color": "default", // Use "default" to indicate theme-aware color
                                        "Align": "left"
                                    }],
                                    alternativeCompany1: '',
                                    alternativeCompany2: '',
                                    svgContent: undefined,
                                    iconPath: undefined,
                                    locked: false,
                                    idPoints: {},
                                    incomer: {},
                                    outgoing: [],
                                    accessories: []
                                };
                                addItem(newTextItem);
                                selectItem(newTextItem.uniqueID);

                                if (onAddTextComplete) onAddTextComplete();
                            }
                            return;
                        }

                        // Clicking on empty space - but not with right click (context menu)
                        // Right click is button 2
                        if (!e.evt.shiftKey && !e.evt.ctrlKey && e.evt.button !== 2) {
                            selectItem(null); // Clear selection
                            selectConnector(null);
                        }

                        // If clicking on empty space, cancel click-start
                        if (clickStart) setClickStart(null);
                        // Hide menu if visible
                        if (menu.visible) setMenu({ ...menu, visible: false });

                        // Start Selection Box (if not panning)
                        if (!panMode) {
                            const stage = e.target.getStage();
                            const pointer = stage?.getPointerPosition();
                            if (pointer) {
                                const x = (pointer.x - position.x) / scale;
                                const y = (pointer.y - position.y) / scale;
                                setSelectionBox({ start: { x, y }, end: { x, y } });
                            }
                        }
                    }
                }}
                onContextMenu={(e) => {
                    // Prevent default browser menu
                    e.evt.preventDefault();
                    if (e.target === e.target.getStage()) {
                        // Blank canvas context menu - use client coords for fixed positioning
                        setMenu({
                            visible: true,
                            x: e.evt.clientX,
                            y: e.evt.clientY,
                            itemId: null,
                            connectorIndex: null
                        });
                    }
                }}
                style={{ cursor: panMode ? (isDraggingItem ? 'grabbing' : 'grab') : 'default' }}
            >
                <Layer>
                    {/* Connectors */}
                    {calculatedPaths.map((pathData, i) => {
                        const pts = pathData.points.flatMap(p => [p.x, p.y]);
                        return (
                            <Group key={i}
                                onContextMenu={(e) => {
                                    e.evt.preventDefault();
                                    // If this connector is already selected, keep the selection
                                    // Otherwise, select only this connector
                                    if (!selectedConnectorIndices.includes(i)) {
                                        selectConnector(i, false);
                                    }
                                    selectItem(null);
                                    setMenu({
                                        visible: true,
                                        x: e.evt.clientX,
                                        y: e.evt.clientY,
                                        itemId: null,
                                        connectorIndex: i
                                    });
                                }}
                            >
                                {/* Transparent Hit Area */}
                                <Line
                                    points={pts}
                                    stroke="transparent"
                                    strokeWidth={Math.max(15 / scale, selectedConnectorIndices.includes(i) ? 3 : 2)}
                                    lineJoin="round"
                                    lineCap="round"
                                    onClick={(e) => {
                                        if (e.evt.button === 2) return;
                                        selectConnector(i);
                                    }}
                                    onMouseEnter={(e) => {
                                        const stage = e.target.getStage();
                                        if (stage) {
                                            const container = stage.container();
                                            container.style.cursor = "pointer";
                                        }
                                    }}
                                    onMouseLeave={(e) => {
                                        const stage = e.target.getStage();
                                        if (stage) {
                                            const container = stage.container();
                                            container.style.cursor = panMode ? (isDraggingItem ? 'grabbing' : 'grab') : 'default';
                                        }
                                    }}
                                />
                                {/* Visible Line */}
                                <Line
                                    points={pts}
                                    stroke={selectedConnectorIndices.includes(i) ? "#2563eb" : getPhaseColor(pathData.connector, theme)}
                                    strokeWidth={selectedConnectorIndices.includes(i) ? 3 : 2}
                                    lineJoin="round"
                                    lineCap="round"
                                    listening={false}
                                />
                                {/* Arrows */}
                                {ApplicationSettings.getShowCurrentValues() && pathData.connector.currentValues && (
                                    pathData.points.map((p, idx) => {
                                        if (idx === 0 || idx >= pathData.points.length - 1) return null;
                                        const start = pathData.points[idx];
                                        const end = pathData.points[idx + 1];

                                        const dx = end.x - start.x;
                                        const dy = end.y - start.y;
                                        const dist = Math.sqrt(dx * dx + dy * dy);
                                        if (dist < 20) return null; // Min distance for arrow

                                        const midX = (start.x + end.x) / 2;
                                        const midY = (start.y + end.y) / 2;
                                        const dirX = dx / dist;
                                        const dirY = dy / dist;

                                        const arrowPts = calculateArrowPoints({ x: midX, y: midY }, dirX, dirY, scale);
                                        const arrowColor = getPhaseColor(pathData.connector, theme);

                                        return (
                                            <Line
                                                key={`arrow-${i}-${idx}`}
                                                points={arrowPts}
                                                fill={arrowColor}
                                                closed={true}
                                                listening={false}
                                            />
                                        );
                                    })
                                )}
                                {pathData.specText && (
                                    <Text
                                        x={pathData.specText.specTextPosition.x}
                                        y={pathData.specText.specTextPosition.y}
                                        text={pathData.specText.specText}
                                        fontSize={ApplicationSettings.getConnectorSpecTextFontSize()}
                                        fontStyle="bold"
                                        fill={colors.text}
                                        rotation={pathData.specText.isHorizontal ? 0 : -90}
                                        listening={false}
                                    />
                                )}
                                {/* Current Value Text */}
                                {showCurrentValues && pathData.connector.currentValues && (() => {
                                    const currentValues = pathData.connector.currentValues;
                                    const current = currentValues["Current"];
                                    const phase = currentValues["Phase"];

                                    // Skip if no current or zero current
                                    if (!current || current === "0 A" || current === "0.00 A") return null;

                                    // Calculate midpoint of the connector for text placement
                                    const midIndex = Math.floor(pathData.points.length / 2);
                                    const midPoint = pathData.points[midIndex];

                                    let currentText = "";
                                    if (phase === "ALL") {
                                        // Three-phase: show all phases
                                        const rCurrent = currentValues["R_Current"] || "0 A";
                                        const yCurrent = currentValues["Y_Current"] || "0 A";
                                        const bCurrent = currentValues["B_Current"] || "0 A";
                                        currentText = `R - ${rCurrent}, Y - ${yCurrent}, B - ${bCurrent}`;
                                    } else if (phase && phase !== "") {
                                        // Single phase with phase label
                                        currentText = `${phase} - ${current}`;
                                    } else {
                                        // No phase information (single-phase source)
                                        currentText = current;
                                    }

                                    return (
                                        <Text
                                            x={midPoint.x}
                                            y={midPoint.y - 10}
                                            text={currentText}
                                            fontSize={12}
                                            fill="#FF0000"
                                            listening={false}
                                        />
                                    );
                                })()}
                            </Group>
                        );
                    })}

                    {/* Temporary connection line */}
                    {tempLine && (
                        <Line
                            points={tempLine}
                            stroke="#3b82f6"
                            strokeWidth={2 / scale}
                            dash={[10, 5]}
                        />
                    )}

                    {/* Selection Box */}
                    {selectionBox && (
                        <Rect
                            x={Math.min(selectionBox.start.x, selectionBox.end.x)}
                            y={Math.min(selectionBox.start.y, selectionBox.end.y)}
                            width={Math.abs(selectionBox.end.x - selectionBox.start.x)}
                            height={Math.abs(selectionBox.end.y - selectionBox.start.y)}
                            fill="rgba(0, 161, 255, 0.3)"
                            stroke="#00a1ff"
                            strokeWidth={1 / scale}
                        />
                    )}

                    {/* Alignment Guides */}
                    {guides.horizontal.map((y, i) => (
                        <Line
                            key={`h-${i}`}
                            points={[-10000, y, 10000, y]} // Extend infinitely
                            stroke="red"
                            strokeWidth={1 / scale}
                            dash={[4 / scale, 4 / scale]}
                        />
                    ))}
                    {guides.vertical.map((x, i) => (
                        <Line
                            key={`v-${i}`}
                            points={[x, -10000, x, 10000]} // Extend infinitely
                            stroke="red"
                            strokeWidth={1 / scale}
                            dash={[4 / scale, 4 / scale]}
                        />
                    ))}

                    {/* Items (non-text) */}
                    {currentSheet?.canvasItems.filter(item => item.name !== "Text").map((item) => (
                        <ItemComponent
                            key={item.uniqueID}
                            item={item}
                            isSelected={selectedItemIds.includes(item.uniqueID) || clickStart?.itemId === item.uniqueID}
                            panMode={panMode}
                            onSelect={(e) => {
                                // Logic:
                                // 1. If not dragging (pure click), allow.
                                // 2. If dragging (or just finished), check distance < 5px.
                                const recentlyDragged = Date.now() - lastDragEndTimeRef.current < 300;
                                const isDragInteraction = isDraggingItem || isDraggingRef.current || recentlyDragged;
                                const movedSignificantly = lastDragDistanceRef.current > 5;

                                if (!panMode && (!isDragInteraction || !movedSignificantly)) {
                                    selectConnector(null);
                                    // Handle Multi-Select (Ctrl/Shift)
                                    const isMulti = e?.evt?.ctrlKey || e?.evt?.shiftKey;
                                    selectItem(item.uniqueID, isMulti);
                                }
                            }}
                            onDragStart={(e) => {
                                setIsDraggingItem(true);
                                isDraggingRef.current = true;
                                lastDragDistanceRef.current = 0;
                                takeSnapshot();

                                // Capture start positions for all selected items
                                const startPositions = new Map<string, { x: number, y: number }>();
                                if (currentSheet) {
                                    // If the dragged item is not in the selection, clear selection but DO NOT select the dragged item
                                    if (!selectedItemIds.includes(item.uniqueID)) {
                                        selectItem(null);
                                        startPositions.set(item.uniqueID, { x: item.position.x, y: item.position.y });
                                    } else {
                                        // Otherwise, capture positions for all selected items
                                        selectedItemIds.forEach(id => {
                                            const selectedItem = currentSheet.canvasItems.find(i => i.uniqueID === id);
                                            if (selectedItem) {
                                                startPositions.set(id, { x: selectedItem.position.x, y: selectedItem.position.y });
                                            }
                                        });
                                    }
                                }
                                dragStartPositions.current = startPositions;
                            }}
                            onDragMove={(x, y) => {
                                if (!currentSheet) return;

                                // Calculate delta based on the dragged item's start position
                                const startPos = dragStartPositions.current.get(item.uniqueID);
                                if (!startPos) return;

                                const deltaX = x - startPos.x;
                                const deltaY = y - startPos.y;

                                // Calculate alignment guides (only if single item selected)
                                let finalDeltaX = deltaX;
                                let finalDeltaY = deltaY;

                                if (selectedItemIds.length <= 1) {
                                    const { x: snappedX, y: snappedY, horizontalGuides, verticalGuides } = calculateAlignmentGuides(
                                        item,
                                        currentSheet.canvasItems,
                                        startPos.x + deltaX,
                                        startPos.y + deltaY,
                                        5, // Snap Threshold
                                        100, // Nearby Threshold (Guides)
                                        scale
                                    );
                                    setGuides({ horizontal: horizontalGuides, vertical: verticalGuides });

                                    // Adjust delta based on snap
                                    finalDeltaX = snappedX - startPos.x;
                                    finalDeltaY = snappedY - startPos.y;
                                } else {
                                    setGuides({ horizontal: [], vertical: [] });
                                }

                                // Prepare batch updates
                                const updates: { id: string, x: number, y: number }[] = [];

                                dragStartPositions.current.forEach((pos, id) => {
                                    updates.push({
                                        id,
                                        x: pos.x + finalDeltaX,
                                        y: pos.y + finalDeltaY
                                    });
                                });

                                moveItems(updates);
                            }}
                            onDragEnd={(x, y) => {
                                // Calculate drag distance
                                const startPos = dragStartPositions.current.get(item.uniqueID);
                                if (startPos) {
                                    const dist = Math.sqrt(Math.pow(x - startPos.x, 2) + Math.pow(y - startPos.y, 2));
                                    lastDragDistanceRef.current = dist;
                                }
                                lastDragEndTimeRef.current = Date.now();

                                // --- Snap to Fit Logic ---
                                // Only snap if a single item is being dragged
                                let finalX = x;
                                let finalY = y;

                                if (currentSheet && selectedItemIds.length <= 1) {
                                    const otherItems = currentSheet.canvasItems.filter(i => i.uniqueID !== item.uniqueID);
                                    const snapResult = calculateSnapPosition(item, x, y, otherItems, currentSheet.storedConnectors, 20); // 20px tolerance
                                    finalX = snapResult.x;
                                    finalY = snapResult.y;
                                }
                                // -------------------------

                                updateItemPosition(item.uniqueID, finalX, finalY);

                                // Reset drag state
                                setIsDraggingItem(false); // Keep this from original
                                setTimeout(() => {
                                    isDraggingRef.current = false;
                                }, 50);
                                setGuides({ horizontal: [], vertical: [] }); // Clear guides
                                dragStartPositions.current.clear();
                            }}
                            showConnectionPoints={!hideConnectionPoints} // Hide during image export
                            onConnectionPointClick={(key, e) => handleConnectionPointClick(item.uniqueID, key, e)}
                            onConnectionPointMouseDown={(key, e) => handleConnectionPointMouseDown(item.uniqueID, key, e)}
                            onConnectionPointMouseUp={(key, e) => handleConnectionPointMouseUp(item.uniqueID, key, e)}
                            onResizeEnd={(w, h) => {
                                updateItemSize(item.uniqueID, Math.round(w), Math.round(h));
                            }}
                            onContextMenu={(cx, cy) => {
                                // If the item is not already selected, select it (and clear others)
                                if (!selectedItemIds.includes(item.uniqueID)) {
                                    selectItem(item.uniqueID, false, false);
                                }

                                const containerRect = stageRef.current.container().getBoundingClientRect();
                                setMenu({
                                    visible: true,
                                    x: cx - containerRect.left,
                                    y: cy - containerRect.top,
                                    itemId: item.uniqueID,
                                    connectorIndex: null
                                });
                            }}
                            onDoubleClick={() => {
                                if (!panMode) {
                                    selectConnector(null);
                                    selectItem(item.uniqueID);
                                    setEditMode(true);
                                }
                            }}
                        />
                    ))}

                    {/* Text Items */}
                    {currentSheet?.canvasItems.filter(item => item.name === "Text").map((item) => (
                        <TextComponent
                            key={item.uniqueID}
                            item={item}
                            isSelected={selectedItemIds.includes(item.uniqueID)}
                            panMode={panMode}
                            scale={scale}
                            onSelect={(e) => {
                                if (!panMode) {
                                    selectConnector(null);
                                    const isMulti = e?.evt?.ctrlKey || e?.evt?.shiftKey;
                                    selectItem(item.uniqueID, isMulti);
                                }
                            }}
                            onDragStart={(e) => {
                                setIsDraggingItem(true);
                                takeSnapshot();
                            }}
                            onDragEnd={(x, y) => {
                                updateItemPosition(item.uniqueID, x, y);
                            }}
                            onTransformEnd={(x, y, width, height, rotation) => {
                                updateItemTransform(item.uniqueID, x, y, width, height, rotation);
                            }}
                            onTextChange={(text) => {
                                updateItemProperties(item.uniqueID, { "Text": text });
                            }}
                            onDoubleClick={() => {
                                if (!panMode) {
                                    selectConnector(null);
                                    selectItem(item.uniqueID);
                                    setEditMode(true);
                                }
                            }}
                            onContextMenu={(cx, cy) => {
                                // If the item is not already selected, select it (and clear others)
                                if (!selectedItemIds.includes(item.uniqueID)) {
                                    selectItem(item.uniqueID, false, false);
                                }

                                const containerRect = stageRef.current.container().getBoundingClientRect();
                                setMenu({
                                    visible: true,
                                    x: cx - containerRect.left,
                                    y: cy - containerRect.top,
                                    itemId: item.uniqueID,
                                    connectorIndex: null
                                });
                            }}
                        />
                    ))}

                </Layer>
            </Stage>

            {/* Connection Mode Indicator (Click-Click) */}
            {clickStart && (
                <div className="absolute top-24 left-1/2 transform -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg z-50">
                    Click target connection point to complete connection
                </div>
            )}
            {/* Context Menu - Via Portal to escape stacking context */}
            {menu.visible && reactCreatePortal(
                <>
                    {/* Click-away backdrop */}
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
                            backgroundColor: colors.menuBackground,
                            borderColor: colors.border,
                            color: colors.menuText
                        }}
                    >
                        {/* Item Menu */}
                        {menu.itemId && (
                            <>
                                <button
                                    className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => { deleteSelected(); setMenu({ ...menu, visible: false }); }}
                                >
                                    {selectedItemIds.length > 1 ? `Delete ${selectedItemIds.length} Items` : "Delete Item"}
                                </button>
                                <button
                                    className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => { copySelection(); setMenu({ ...menu, visible: false }); }}
                                >
                                    {selectedItemIds.length > 1 ? `Copy ${selectedItemIds.length} Items` : "Copy Item"}
                                </button>
                                <button
                                    className={`block w-full text-left px-3 py-1 disabled:opacity-50 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => { pasteSelection(); setMenu({ ...menu, visible: false }); }}
                                    disabled={!copiedItems || copiedItems.length === 0}
                                >
                                    {copiedItems && copiedItems.length > 1 ? `Paste ${copiedItems.length} Items` : "Paste Item"}
                                </button>
                                <div className="border-t my-1" style={{ borderColor: colors.border }}></div>
                                {selectedItemIds.length <= 1 && (
                                    <>
                                        <button
                                            className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                            onClick={() => { rotateItem(menu.itemId!, 'clockwise'); setMenu({ ...menu, visible: false }); }}
                                        >Rotate Clockwise</button>
                                        <button
                                            className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                            onClick={() => { rotateItem(menu.itemId!, 'counter-clockwise'); setMenu({ ...menu, visible: false }); }}
                                        >Rotate Anti-Clockwise</button>
                                        <div className="border-t my-1" style={{ borderColor: colors.border }}></div>
                                    </>
                                )}
                                {/* Portal-specific actions */}
                                {(() => {
                                    const item = currentSheet?.canvasItems.find(i => i.uniqueID === menu.itemId);
                                    if (!item || item.name !== 'Portal') return null;
                                    const p = (item.properties?.[0] || {}) as any;
                                    const netId = p['NetId'] || p['netId'];
                                    const direction = (p['Direction'] || p['direction'] || 'out') as 'in' | 'out';
                                    const portals = netId ? getPortalsByNetId(netId) : [];
                                    const canCreatePair = netId && (!portals || portals.length < 2);
                                    const counterpart = netId ? (portals || []).find(pt => pt.uniqueID !== item.uniqueID) : undefined;
                                    return (
                                        <>
                                            {canCreatePair && (
                                                <>
                                                    <button
                                                        className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                                        onClick={() => {
                                                            setPendingPair({ netId, direction });
                                                            setShowSelectSheet(true);
                                                            setMenu({ ...menu, visible: false });
                                                        }}
                                                    >Create paired portal…</button>
                                                    <div className="border-t my-1" style={{ borderColor: colors.border }}></div>
                                                </>
                                            )}
                                            {counterpart && (
                                                <button
                                                    className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                                    onClick={() => {
                                                        const dest = sheets.find(sh => sh.canvasItems.some(ci => ci.uniqueID === counterpart.uniqueID));
                                                        if (dest) {
                                                            setActiveSheet(dest.sheetId);
                                                            setTimeout(() => selectItem(counterpart.uniqueID, false, true), 0);
                                                        }
                                                        setMenu({ ...menu, visible: false });
                                                    }}
                                                >Jump to counterpart</button>
                                            )}
                                        </>
                                    );
                                })()}
                                <button
                                    className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => {
                                        const item = currentSheet?.canvasItems.find(i => i.uniqueID === menu.itemId);
                                        if (item) updateItemLock(menu.itemId!, !item.locked);
                                        setMenu({ ...menu, visible: false });
                                    }}
                                >
                                    {currentSheet?.canvasItems.find(i => i.uniqueID === menu.itemId)?.locked ? "Unlock Item" : "Lock Item"}
                                </button>
                                {/* Go to Layout - Teleport Feature */}
                                {(() => {
                                    const item = currentSheet?.canvasItems.find(i => i.uniqueID === menu.itemId);
                                    const layoutComponentId = item?.properties?.[0]?.['_layoutComponentId'];
                                    if (!layoutComponentId) return null;
                                    return (
                                        <>
                                            <div className="border-t my-1" style={{ borderColor: colors.border }}></div>
                                            <button
                                                className={`block w-full text-left px-3 py-1 text-blue-500 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                                onClick={() => {
                                                    // Switch to Layout view
                                                    useLayoutStore.getState().setActiveView('layout');
                                                    // Select the component in Layout
                                                    const st = useLayoutStore.getState();
                                                    const targetPlan = st.floorPlans.find(p => p.components.some(c => c.id === layoutComponentId));
                                                    if (targetPlan && st.activeFloorPlanId !== targetPlan.id) {
                                                        st.setActiveFloorPlan(targetPlan.id);
                                                    }
                                                    st.selectElement(layoutComponentId);
                                                    setMenu({ ...menu, visible: false });
                                                }}
                                            >Go to Layout ↗</button>
                                        </>
                                    );
                                })()}
                            </>
                        )}

                        {/* Connector Menu */}
                        {menu.connectorIndex !== null && (
                            <>
                                <button
                                    className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => {
                                        deleteSelected();
                                        setMenu({ ...menu, visible: false });
                                    }}
                                >{selectedConnectorIndices.length > 1 ? `Delete ${selectedConnectorIndices.length} Connectors` : "Delete Connection"}</button>
                                {selectedConnectorIndices.length === 1 && (
                                    <>
                                        <button
                                            className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                            onClick={() => {
                                                setEditMode(true);
                                                setMenu({ ...menu, visible: false });
                                            }}
                                        >Properties</button>
                                        <div className="border-t my-1" style={{ borderColor: colors.border }}></div>
                                        <button
                                            className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                            onClick={() => { copyConnectorProperties(menu.connectorIndex!); setMenu({ ...menu, visible: false }); }}
                                        >Copy Properties</button>
                                        <button
                                            className={`block w-full text-left px-3 py-1 disabled:opacity-50 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                            onClick={() => { pasteConnectorProperties(menu.connectorIndex!); setMenu({ ...menu, visible: false }); }}
                                            disabled={!copiedConnectorProperties}
                                        >Paste Properties</button>
                                    </>
                                )}
                            </>
                        )}

                        {/* Blank Canvas Menu */}
                        {menu.itemId === null && menu.connectorIndex === null && (
                            <>
                                <button
                                    className={`block w-full text-left px-3 py-1 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => {
                                        const stageX = (menu.x - position.x) / scale;
                                        const stageY = (menu.y - position.y) / scale;
                                        createPortal('out', { x: stageX, y: stageY });
                                        setMenu({ ...menu, visible: false });
                                    }}
                                >Create Portal…</button>
                                <div className="border-t my-1" style={{ borderColor: colors.border }}></div>
                                <button
                                    className={`block w-full text-left px-3 py-1 disabled:opacity-50 ${theme === 'dark' ? 'hover:bg-slate-700' : 'hover:bg-gray-100'}`}
                                    onClick={() => {
                                        const stageX = (menu.x - position.x) / scale;
                                        const stageY = (menu.y - position.y) / scale;
                                        pasteSelection({ x: stageX, y: stageY });
                                        setMenu({ ...menu, visible: false });
                                    }}
                                    disabled={!copiedItems || copiedItems.length === 0}
                                >
                                    {copiedItems && copiedItems.length > 1 ? `Paste ${copiedItems.length} Items` : "Paste Item"}
                                </button>
                            </>
                        )}
                    </div>
                </>,
                document.body
            )}

            {/* Material Selection Dialog */}
            {showMaterialDialog && (
                <MaterialSelectionDialog
                    onSelect={handleMaterialSelect}
                    onCancel={handleMaterialCancel}
                />
            )}

            {/* Create Portal Dialog */}
            {showCreatePortal && pendingPortalPos && (
                <CreatePortalDialog
                    onCreate={(direction) => {
                        createPortal(direction, pendingPortalPos);
                        setShowCreatePortal(false);
                        setPendingPortalPos(null);
                    }}
                    onCancel={() => { setShowCreatePortal(false); setPendingPortalPos(null); }}
                />
            )}

            {/* Select Sheet Dialog for pairing */}
            {showSelectSheet && pendingPair && (
                <SelectSheetDialog
                    sheets={sheets}
                    excludeSheetId={activeSheetId || ''}
                    onSelect={(sheetId: string) => {
                        createPairedPortal(pendingPair.netId, pendingPair.direction, sheetId);
                        setShowSelectSheet(false);
                        setPendingPair(null);
                    }}
                    onCancel={() => { setShowSelectSheet(false); setPendingPair(null); }}
                />
            )}
        </div>
    );
});
