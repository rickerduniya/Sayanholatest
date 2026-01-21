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
import { Point } from '../types';
import {
    snapToWall,
    constrainWallAngle,
    DRAWING_TOOL_CURSORS,
    DRAWING_TOOL_INSTRUCTIONS,
    getRoomCentroid,
    calculateRoomArea,
    isPointInRoom,
    findRoomAtPoint,
    getDistanceLabelWithUnit,
    getAreaLabel,
    calculateOrthogonalPath
} from '../utils/LayoutDrawingTools';
import {
    LAYOUT_COMPONENT_DEFINITIONS,
    getLayoutComponentDef
} from '../utils/LayoutComponentDefinitions';
import { layoutImageStore } from '../utils/LayoutImageStore';
import { useLayoutComponentImages } from '../hooks/useLayoutComponentImages';

export interface LayoutCanvasRef {
    saveImage: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    setZoom: (scale: number) => void;
    fitView: () => void;
}

interface LayoutCanvasProps {
    onScaleChange?: (scale: number) => void;
    showMagicWires?: boolean;
    onCalibrationFinished?: (pixelLength: number) => void;
}

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

export const LayoutCanvas = forwardRef<LayoutCanvasRef, LayoutCanvasProps>(({ onScaleChange, showMagicWires, onCalibrationFinished }, ref) => {
    const stageRef = useRef<any>(null);
    const { theme, colors } = useTheme();
    const componentImages = useLayoutComponentImages();

    // Layout store
    const {
        getCurrentFloorPlan,
        drawingState,
        setActiveTool,
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
        selectedElementIds,
        selectElement,
        clearSelection,
        deleteSelected,
        updateViewport,
        takeSnapshot,
        // Staging components
        removeStagingComponent,
        markStagingComponentPlaced,
        isStagingComponentPlaced
    } = useLayoutStore();

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

    // HUD State
    const [hoverInfo, setHoverInfo] = useState<{ x: number, y: number, text: string } | null>(null);
    const [ocrHoverInfo, setOcrHoverInfo] = useState<{ x: number, y: number, text: string } | null>(null);

    const [showOcr, setShowOcr] = useState(true);
    const [ocrMinConfidence, setOcrMinConfidence] = useState(60);
    const [ocrQuery, setOcrQuery] = useState('');
    const [showOcrBoxes, setShowOcrBoxes] = useState(false);
    const [selectedOcrId, setSelectedOcrId] = useState<string | null>(null);
    const [ocrCopied, setOcrCopied] = useState(false);

    useEffect(() => {
        try {
            const raw = localStorage.getItem('layout_ocr_settings');
            if (!raw) return;
            const s = JSON.parse(raw);
            if (typeof s.showOcr === 'boolean') setShowOcr(s.showOcr);
            if (typeof s.ocrMinConfidence === 'number') setOcrMinConfidence(s.ocrMinConfidence);
            if (typeof s.ocrQuery === 'string') setOcrQuery(s.ocrQuery);
            if (typeof s.showOcrBoxes === 'boolean') setShowOcrBoxes(s.showOcrBoxes);
        } catch {
        }
        // Only once
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(
                'layout_ocr_settings',
                JSON.stringify({ showOcr, ocrMinConfidence, ocrQuery, showOcrBoxes })
            );
        } catch {
        }
    }, [showOcr, ocrMinConfidence, ocrQuery, showOcrBoxes]);

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
    const { sheets } = useStore();
    const sldConnectors = sheets.flatMap(s => s.storedConnectors);

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
        }> = [];

        for (const connector of sldConnectors) {
            const srcLayoutId = connector.sourceItem?.properties?.[0]?.['_layoutComponentId'];
            const dstLayoutId = connector.targetItem?.properties?.[0]?.['_layoutComponentId'];

            if (!srcLayoutId || !dstLayoutId) continue;

            const srcPos = layoutPosById.get(srcLayoutId);
            const dstPos = layoutPosById.get(dstLayoutId);

            if (!srcPos || !dstPos) continue; // One or both not placed

            wires.push({
                sourcePos: srcPos,
                targetPos: dstPos,
                key: `${srcLayoutId}-${dstLayoutId}`
            });
        }

        return wires;
    }, [currentPlan?.components, sldConnectors, showMagicWires]);

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
        const point = getCanvasPoint(e);
        const tool = drawingState.activeTool;

        if (tool === 'pan') {
            // Pan is handled by draggable stage
            return;
        }

        // Selection Tool Logic
        if (tool === 'select') {
            // If clicked on stage (background) or grid background, start box selection or clear selection
            const isBackground = e.target === e.target.getStage() || e.target.name() === 'grid-background';
            if (isBackground) {
                clearSelection();
                setSelectionBox({ start: point, end: point });
            }
            return;
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
                setIsDrawing(true);
                setCurrentPath([point]);
            } else {
                // Complete wall
                if (currentPath.length > 0) {
                    const start = currentPath[0];
                    const end = point;

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
            // If we are close to a wall, snap to it and align rotation
            if (currentPlan) {
                const snapInfo = snapToWall(point, currentPlan.walls, 25); // 25px tolerance
                if (snapInfo) {
                    placePos = snapInfo.snapPoint;

                    // Calculate wall angle
                    const wallAngle = Math.atan2(
                        snapInfo.wall.endPoint.y - snapInfo.wall.startPoint.y,
                        snapInfo.wall.endPoint.x - snapInfo.wall.startPoint.x
                    ) * 180 / Math.PI;

                    rotation = wallAngle;

                    // Optional: Offset from wall center based on component depth?
                    // For now, center on wall line is standard for symbols like switches
                }
            }

            addComponent({
                type: drawingState.selectedComponentType,
                position: placePos,
                rotation: rotation,
                properties: {},
                roomId: currentPlan ? findRoomAtPoint(placePos, currentPlan.rooms)?.id : undefined
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
                        addConnection({
                            sourceId: connectionSource,
                            targetId: clickedComponent.id,
                            path: currentPath.slice(1), // Intermediate points
                            type: 'power'
                        });
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

        if (!isDrawing) {
            setHoverInfo(null);
            return;
        }

        if (tool === 'wall' && currentPath.length > 0) {
            const start = currentPath[0];
            const end = point;
            setCurrentPath([start, end]);

            // Update HUD
            const pxLen = Math.hypot(end.x - start.x, end.y - start.y);
            const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
            const normalizedAngle = (angle < 0 ? angle + 360 : angle).toFixed(1);
            const unit = currentPlan?.measurementUnit || 'm';
            const label = `${getDistanceLabelWithUnit(pxLen, currentPlan?.pixelsPerMeter || 50, unit)} | ${normalizedAngle}°`;

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

    // Handle double click (complete room polygon)
    const handleDoubleClick = (e: any) => {
        if (drawingState.activeTool === 'room' && currentPath.length >= 3) {
            addRoom({
                name: `Room ${(currentPlan?.rooms.length || 0) + 1}`,
                polygon: currentPath,
                type: 'other'
            });
            setIsDrawing(false);
            setCurrentPath([]);
        }
    };

    // Handle key down
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                deleteSelected();
            }
            if (e.key === 'Escape') {
                setIsDrawing(false);
                setCurrentPath([]);
                setActiveTool('select');
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [deleteSelected, setActiveTool]);

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
                <Group key={room.id} onClick={() => selectElement(room.id)}>
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
                        onClick={() => selectElement(wall.id)}
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
                    onClick={() => selectElement(door.id)}
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
                    onClick={() => selectElement(win.id)}
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

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (_e: KeyboardEvent) => {
            return;
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedElementIds]);

    // Render connections (wires/conduits)
    const renderConnections = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.connections.filter(c => selectedElementIds.includes(c.id) === renderSelected);

        return targets.map(conn => {
            const isSelected = selectedElementIds.includes(conn.id);
            const color = conn.type === 'power' ? '#dc2626' : (conn.type === 'control' ? '#2563eb' : '#4b5563');

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
                <Group key={conn.id} onClick={() => selectElement(conn.id)}>
                    {/* Main Wire Line */}
                    <Line
                        points={renderPoints}
                        stroke={color}
                        strokeWidth={isSelected ? 3 : 2}
                        lineCap="round"
                        lineJoin="round"
                        tension={tension}
                        bezier={isBezier}
                        opacity={0.8}
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
                            radius={3}
                            fill={color}
                        />
                    ))}
                </Group>
            );
        });
    };

    // Render electrical components
    const renderComponents = (renderSelected: boolean) => {
        if (!currentPlan) return null;

        const targets = currentPlan.components.filter(c => selectedElementIds.includes(c.id) === renderSelected);

        return targets.map(comp => {
            const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
            const isSelected = selectedElementIds.includes(comp.id);
            const image = componentImages[comp.type];

            return (
                <Group
                    key={comp.id}
                    x={comp.position.x}
                    y={comp.position.y}
                    rotation={comp.rotation}
                    onClick={() => selectElement(comp.id)}
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
                        updateComponent(comp.id, {
                            position: { x: e.target.x(), y: e.target.y() }
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
                                            x={-def.size.width / 2 - 4}
                                            y={-def.size.height / 2 - 4}
                                            width={def.size.width + 8}
                                            height={def.size.height + 8}
                                            stroke="#3b82f6"
                                            strokeWidth={2}
                                            cornerRadius={4}
                                            dash={[4, 4]}
                                        />
                                    )
                                }
                                <KonvaImage
                                    image={image}
                                    width={def.size.width}
                                    height={def.size.height}
                                    offset={{ x: def.size.width / 2, y: def.size.height / 2 }}
                                />
                            </>
                        ) : (
                            /* Fallback: just show symbol text, no background circle */
                            <Text
                                x={-def.size.width / 2}
                                y={-8}
                                width={def.size.width}
                                text={def.symbol}
                                fontSize={16}
                                fontStyle="bold"
                                fill={isSelected ? '#3b82f6' : (theme === 'dark' ? '#e5e7eb' : '#374151')}
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
            const { sourcePos, targetPos, key } = wire;

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
                    <Group key={key}>
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
                            stroke="#475569"
                            strokeWidth={1.2}
                            lineCap="round"
                            lineJoin="round"
                            tension={0.5}
                            bezier={true}
                            dash={[6, 4]}
                        />
                        {/* Connection dots */}
                        <Circle x={sourcePos.x} y={sourcePos.y} radius={2.5} fill="#334155" />
                        <Circle x={targetPos.x} y={targetPos.y} radius={2.5} fill="#334155" />
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
                <Group key={key}>
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
                        stroke="#475569"
                        strokeWidth={1.2}
                        lineCap="round"
                        lineJoin="round"
                        tension={0.5}
                        bezier={true}
                        dash={[6, 4]}
                    />
                    {/* Connection dots */}
                    <Circle x={sourcePos.x} y={sourcePos.y} radius={2.5} fill="#334155" />
                    <Circle x={targetPos.x} y={targetPos.y} radius={2.5} fill="#334155" />
                </Group>
            );
        }).filter(Boolean);
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

    const cursor = DRAWING_TOOL_CURSORS[drawingState.activeTool];

    if (!currentPlan) {
        return (
            <div
                ref={containerRef}
                className="w-full h-full flex items-center justify-center"
                style={{ backgroundColor: colors.canvasBackground }}
            >
                <div className="text-center p-8">
                    <p className="text-lg mb-4" style={{ color: colors.text }}>
                        No floor plan selected
                    </p>
                    <p className="text-sm opacity-60" style={{ color: colors.text }}>
                        Create a new floor plan or upload an image to get started
                    </p>
                </div>
            </div>
        );
    }

    // Handle drop of staging components
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const stage = stageRef.current?.getStage();
        if (!stage) return;

        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));

            // Check if this is a staging component
            if (data._isStagingComponent) {
                const stagingId = data.id;

                // Prevent duplicate placement
                if (stagingId && isStagingComponentPlaced(stagingId)) {
                    console.warn('[LayoutCanvas] Staging component already placed:', stagingId);
                    return;
                }

                // Get drop position in canvas coordinates
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;

                const dropX = (e.clientX - rect.left - position.x) / scale;
                const dropY = (e.clientY - rect.top - position.y) / scale;

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

                    // Update the linked SLD item with the Layout component ID (backlink)
                    if (data.sldItemId) {
                        try {
                            const sldStore = useStore.getState();
                            const sldItem = sldStore.sheets
                                .flatMap(s => s.canvasItems)
                                .find(i => i.uniqueID === data.sldItemId);
                            if (sldItem && !sldItem.properties?.[0]?.['_layoutComponentId']) {
                                // Note: We don't need to update SLD item here as it should already have _layoutComponentId
                                // The sync engine sets _layoutComponentId when creating SLD items from Layout
                            }
                        } catch (e) {
                            console.warn('[LayoutCanvas] Failed to check SLD backlink', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[LayoutCanvas] Drop error:', error);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
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
        >
            {/* Drawing instructions */}
            <div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-10 px-3 py-1 rounded-full text-xs"
                style={{
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    color: '#fff'
                }}
            >
                {DRAWING_TOOL_INSTRUCTIONS[drawingState.activeTool]}
            </div>

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
                    {renderRooms()}

                    {/* Magic Wires - AutoCAD-style SLD connection overlay */}
                    {renderMagicWires()}

                    {/* Unselected Layers (Bottom) */}
                    {renderWalls(false)}
                    {renderDoors(false)}
                    {renderWindows(false)}
                    {renderConnections(false)}
                    {renderComponents(false)}

                    {/* Selected Layers (Top) */}
                    {renderWalls(true)}
                    {renderDoors(true)}
                    {renderWindows(true)}
                    {renderConnections(true)}
                    {renderComponents(true)}

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
                    className="absolute top-12 right-3 z-40 rounded-lg border shadow-lg p-3 w-[280px]"
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
                            onClick={() => setShowOcr(!showOcr)}
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
                                onChange={(e) => setOcrMinConfidence(parseInt(e.target.value, 10) || 0)}
                                className="w-full"
                            />
                        </div>

                        <div>
                            <div className="text-[11px] opacity-80 mb-1">Search</div>
                            <input
                                value={ocrQuery}
                                onChange={(e) => setOcrQuery(e.target.value)}
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
                                onChange={(e) => setShowOcrBoxes(e.target.checked)}
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
        </div>
    );
});

LayoutCanvas.displayName = 'LayoutCanvas';
