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
    LayoutComponentType
} from '../types/layout';
import { Point } from '../types';
import {
    snapToGrid,
    snapToWall,
    constrainWallAngle,
    DRAWING_TOOL_CURSORS,
    DRAWING_TOOL_INSTRUCTIONS,
    getRoomCentroid,
    isPointInRoom,
    findRoomAtPoint,
    getDistanceLabel,
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

export const LayoutCanvas = forwardRef<LayoutCanvasRef, LayoutCanvasProps>(({ onScaleChange, showMagicWires }, ref) => {
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
    const { sheets, activeSheetId } = useStore();
    const activeSheet = sheets.find(s => s.sheetId === activeSheetId);
    const sldConnectors = activeSheet?.storedConnectors || [];

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
        const layoutPosById = new Map<string, { x: number; y: number }>();
        for (const comp of currentPlan.components) {
            const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
            const w = def?.size?.width || 24;
            const h = def?.size?.height || 24;
            // Center position
            layoutPosById.set(comp.id, {
                x: comp.position.x + w / 2,
                y: comp.position.y + h / 2
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

        if (drawingState.gridSnap) {
            return snapToGrid({ x, y }, drawingState.gridSize);
        }

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
                    const end = drawingState.gridSnap
                        ? constrainWallAngle(start, point, 45)
                        : point;

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
            const end = drawingState.gridSnap
                ? constrainWallAngle(start, point, 45)
                : point;
            setCurrentPath([start, end]);

            // Update HUD
            const pxLen = Math.hypot(end.x - start.x, end.y - start.y);
            const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
            const normalizedAngle = (angle < 0 ? angle + 360 : angle).toFixed(1);
            const label = `${getDistanceLabel(pxLen, currentPlan?.pixelsPerMeter || 50)} | ${normalizedAngle}°`;

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

    // Render rooms
    const renderRooms = () => {
        if (!currentPlan) return null;

        return currentPlan.rooms.map((room, idx) => {
            const points = room.polygon.flatMap(p => [p.x, p.y]);
            const centroid = getRoomCentroid(room);
            const isSelected = selectedElementIds.includes(room.id);
            // Always use palette for detected rooms unless a custom color is set (ignore room.type)
            const fillColor = room.color || DETECTED_ROOM_PALETTE[idx % DETECTED_ROOM_PALETTE.length];

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
                    <Text
                        x={centroid.x - 30}
                        y={centroid.y - 8}
                        text={room.name}
                        fontSize={12}
                        fill={theme === 'dark' ? '#fff' : '#333'}
                        align="center"
                        width={60}
                        listening={false} // Allow clicks to pass through to the Group
                    />
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
                                fill={theme === 'dark' ? '#111827' : '#ffffff'}
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
                                    const next = drawingState.gridSnap
                                        ? constrainWallAngle(wall.endPoint, pos, 45)
                                        : pos;
                                    e.target.x(next.x);
                                    e.target.y(next.y);
                                }}
                                onDragEnd={(e) => {
                                    e.cancelBubble = true;
                                    const pos = { x: e.target.x(), y: e.target.y() };
                                    const next = drawingState.gridSnap
                                        ? constrainWallAngle(wall.endPoint, pos, 45)
                                        : pos;
                                    updateWall(wall.id, { startPoint: next });
                                }}
                            />

                            <Circle
                                x={wall.endPoint.x}
                                y={wall.endPoint.y}
                                radius={9}
                                fill={theme === 'dark' ? '#111827' : '#ffffff'}
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
                                    const next = drawingState.gridSnap
                                        ? constrainWallAngle(wall.startPoint, pos, 45)
                                        : pos;
                                    e.target.x(next.x);
                                    e.target.y(next.y);
                                }}
                                onDragEnd={(e) => {
                                    e.cancelBubble = true;
                                    const pos = { x: e.target.x(), y: e.target.y() };
                                    const next = drawingState.gridSnap
                                        ? constrainWallAngle(wall.startPoint, pos, 45)
                                        : pos;
                                    updateWall(wall.id, { endPoint: next });
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
                        // Snap to grid during drag
                        if (drawingState.gridSnap) {
                            const gridSize = drawingState.gridSize;
                            e.target.x(Math.round(e.target.x() / gridSize) * gridSize);
                            e.target.y(Math.round(e.target.y() / gridSize) * gridSize);
                        }
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
                            <Group>
                                {/* Fallback for missing icons */}
                                <Circle
                                    radius={def.size.width / 2}
                                    fill={theme === 'dark' ? '#374151' : '#fff'}
                                    stroke={isSelected ? '#3b82f6' : colors.border}
                                    strokeWidth={isSelected ? 2 : 1}
                                />
                                <Text
                                    x={-def.size.width / 2}
                                    y={-8}
                                    width={def.size.width}
                                    text={def.symbol}
                                    fontSize={14}
                                    fill={theme === 'dark' ? '#fff' : '#333'}
                                    align="center"
                                />
                            </Group>
                        )}
                </Group >
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

                // Add the component with its ID preserved
                addComponentWithId(newComponent);

                // Remove from staging and mark as placed
                if (stagingId) {
                    removeStagingComponent(stagingId);
                    markStagingComponentPlaced(stagingId);
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
                    {drawingState.gridSnap && renderGrid()}

                    {/* Rooms */}
                    {renderRooms()}

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

                    {/* Window Handles (Always Top) */}
                    {renderWindowHandles()}

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
        </div>
    );
});

LayoutCanvas.displayName = 'LayoutCanvas';
