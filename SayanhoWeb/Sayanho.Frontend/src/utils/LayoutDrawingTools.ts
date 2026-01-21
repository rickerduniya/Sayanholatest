// Drawing tools and helper functions for floor plan manual editing

import { Point } from '../types';
import { Wall, Room, Door, LayoutWindow, DrawingTool, MeasurementUnit } from '../types/layout';

const FEET_PER_METER = 3.280839895013123;
const INCHES_PER_FOOT = 12;
const SQFT_PER_SQM = 10.763910416709722;

// ============================================================================
// Grid and Snapping
// ============================================================================

/**
 * Snap a point to the nearest grid intersection - DEPRECATED/REMOVED
 */
// Grid system removed as per user request

/**
 * Find the closest point on a wall segment to the given point
 */
export function closestPointOnWall(point: Point, wall: Wall): Point {
    const { startPoint, endPoint } = wall;

    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) return startPoint;

    // Project point onto the wall line
    let t = ((point.x - startPoint.x) * dx + (point.y - startPoint.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    return {
        x: startPoint.x + t * dx,
        y: startPoint.y + t * dy
    };
}

/**
 * Find the nearest wall to a point and return snap info
 */
export function snapToWall(point: Point, walls: Wall[], snapDistance: number = 10): { wall: Wall; snapPoint: Point } | null {
    let nearestWall: Wall | null = null;
    let nearestPoint: Point | null = null;
    let minDistance = snapDistance;

    for (const wall of walls) {
        const closest = closestPointOnWall(point, wall);
        const dist = Math.hypot(closest.x - point.x, closest.y - point.y);

        if (dist < minDistance) {
            minDistance = dist;
            nearestWall = wall;
            nearestPoint = closest;
        }
    }

    if (nearestWall && nearestPoint) {
        return { wall: nearestWall, snapPoint: nearestPoint };
    }

    return null;
}

/**
 * Find intersection point between two wall segments (if any)
 */
export function findWallIntersection(wall1: Wall, wall2: Wall): Point | null {
    const x1 = wall1.startPoint.x, y1 = wall1.startPoint.y;
    const x2 = wall1.endPoint.x, y2 = wall1.endPoint.y;
    const x3 = wall2.startPoint.x, y3 = wall2.startPoint.y;
    const x4 = wall2.endPoint.x, y4 = wall2.endPoint.y;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);

    if (Math.abs(denom) < 0.0001) return null; // Parallel lines

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            x: x1 + t * (x2 - x1),
            y: y1 + t * (y2 - y1)
        };
    }

    return null;
}

// ============================================================================
// Wall Operations
// ============================================================================

/**
 * Calculate wall length in pixels
 */
export function getWallLength(wall: Wall): number {
    return Math.hypot(
        wall.endPoint.x - wall.startPoint.x,
        wall.endPoint.y - wall.startPoint.y
    );
}

/**
 * Get wall angle in degrees (0-360)
 */
export function getWallAngle(wall: Wall): number {
    const dx = wall.endPoint.x - wall.startPoint.x;
    const dy = wall.endPoint.y - wall.startPoint.y;
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (angle < 0) angle += 360;
    return angle;
}

/**
 * Check if a wall is horizontal (within tolerance)
 */
export function isWallHorizontal(wall: Wall, tolerance: number = 5): boolean {
    const angle = getWallAngle(wall);
    return angle < tolerance || angle > 360 - tolerance ||
        (angle > 180 - tolerance && angle < 180 + tolerance);
}

/**
 * Check if a wall is vertical (within tolerance)
 */
export function isWallVertical(wall: Wall, tolerance: number = 5): boolean {
    const angle = getWallAngle(wall);
    return (angle > 90 - tolerance && angle < 90 + tolerance) ||
        (angle > 270 - tolerance && angle < 270 + tolerance);
}

/**
 * Constrain wall angle to 0°, 45°, 90°, etc.
 */
export function constrainWallAngle(startPoint: Point, endPoint: Point, angleSnap: number = 45): Point {
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const length = Math.hypot(dx, dy);

    let angle = Math.atan2(dy, dx);
    const snapRad = (angleSnap * Math.PI) / 180;
    angle = Math.round(angle / snapRad) * snapRad;

    return {
        x: startPoint.x + length * Math.cos(angle),
        y: startPoint.y + length * Math.sin(angle)
    };
}

// ============================================================================
// Room Operations
// ============================================================================

/**
 * Calculate room area (in square pixels)
 * Uses Shoelace formula for polygon area
 */
export function calculateRoomArea(room: Room): number {
    const points = room.polygon;
    const n = points.length;
    if (n < 3) return 0;

    let area = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += points[i].x * points[j].y;
        area -= points[j].x * points[i].y;
    }

    return Math.abs(area) / 2;
}

export function getAreaLabel(squarePixels: number, pixelsPerMeter: number = 50, unit: MeasurementUnit = 'm'): string {
    if (pixelsPerMeter <= 0) return '';
    const squareMeters = squarePixels / (pixelsPerMeter * pixelsPerMeter);
    if (unit === 'ft') {
        const squareFeet = squareMeters * SQFT_PER_SQM;
        return `${squareFeet.toFixed(2)} sq.ft`;
    }
    return `${squareMeters.toFixed(2)} sq.mt`;
}

/**
 * Check if a point is inside a room polygon
 * Uses ray casting algorithm
 */
export function isPointInRoom(point: Point, room: Room): boolean {
    const polygon = room.polygon;
    const n = polygon.length;
    let inside = false;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;

        if (((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * Find which room contains a given point
 */
export function findRoomAtPoint(point: Point, rooms: Room[]): Room | null {
    for (const room of rooms) {
        if (isPointInRoom(point, room)) {
            return room;
        }
    }
    return null;
}

/**
 * Calculate room centroid for label placement
 */
export function getRoomCentroid(room: Room): Point {
    const points = room.polygon;
    const n = points.length;
    if (n === 0) return { x: 0, y: 0 };

    let cx = 0, cy = 0;
    for (const p of points) {
        cx += p.x;
        cy += p.y;
    }

    return { x: cx / n, y: cy / n };
}

// ============================================================================
// Door/Window Operations
// ============================================================================

/**
 * Calculate door position along a wall (0-1 parameter)
 */
export function getDoorPositionOnWall(door: Door, wall: Wall): number {
    const wallLen = getWallLength(wall);
    if (wallLen === 0) return 0;

    const dx = door.position.x - wall.startPoint.x;
    const dy = door.position.y - wall.startPoint.y;
    const dist = Math.hypot(dx, dy);

    return dist / wallLen;
}

/**
 * Place a door at a specific position on a wall
 */
export function placeDoorOnWall(wall: Wall, t: number, width: number): { position: Point; rotation: number } {
    const dx = wall.endPoint.x - wall.startPoint.x;
    const dy = wall.endPoint.y - wall.startPoint.y;

    const position = {
        x: wall.startPoint.x + t * dx,
        y: wall.startPoint.y + t * dy
    };

    const rotation = Math.atan2(dy, dx) * (180 / Math.PI);

    return { position, rotation };
}

// ============================================================================
// Drawing Tool Helpers
// ============================================================================

export const DRAWING_TOOL_CURSORS: Record<DrawingTool, string> = {
    select: 'default',
    pan: 'grab',
    wall: 'crosshair',
    room: 'crosshair',
    door: 'cell',
    window: 'cell',
    stair: 'crosshair',
    component: 'copy',
    connection: 'crosshair',
    erase: 'not-allowed',
    pick: 'crosshair',
    calibrate: 'crosshair'
};

export const DRAWING_TOOL_INSTRUCTIONS: Record<DrawingTool, string> = {
    select: 'Click to select elements, drag to move',
    pan: 'Drag to pan the canvas',
    wall: 'Click start point, then click end point to draw wall',
    room: 'Click corners to define room polygon, double-click to close',
    door: 'Click on a wall to place a door',
    window: 'Click on a wall to place a window',
    stair: 'Click corners to define stair area',
    component: 'Click to place component',
    connection: 'Click source, then click target to connect',
    erase: 'Click elements to delete them',
    pick: 'Click to pick properties from element',
    calibrate: 'Draw a line of known length to calibrate scale'
};

// ============================================================================
// UUID Generation
// ============================================================================

export function generateLayoutId(prefix: string = 'layout'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// Drafting Helpers (Measurements & Constraints)
// ============================================================================

/**
 * Format pixel distance to string label (Meters/CM)
 * @param pixels Distance in pixels
 * @param scale Pixels per meter (default 50 or read from plan)
 */
export function getDistanceLabel(pixels: number, scale: number = 50): string {
    return getDistanceLabelWithUnit(pixels, scale, 'm');
}

export function getDistanceLabelWithUnit(pixels: number, pixelsPerMeter: number = 50, unit: MeasurementUnit = 'm'): string {
    if (pixelsPerMeter <= 0) return '';
    const meters = pixels / pixelsPerMeter;

    if (unit === 'ft') {
        const feet = meters * FEET_PER_METER;
        if (feet < 1) {
            return `${Math.round(feet * INCHES_PER_FOOT)} in`;
        }
        return `${feet.toFixed(2)} ft`;
    }

    if (meters < 1) {
        return `${Math.round(meters * 100)} cm`;
    }
    return `${meters.toFixed(2)} m`;
}

/**
 * Calculate simple orthogonal (Manhattan) path between two points
 * Returns 2 or 3 segments (L-shape or Z-shape)
 */
export function calculateOrthogonalPath(start: Point, end: Point, avoidObstacles: boolean = false): Point[] {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    // Simple L-shape: horizontal first, then vertical
    // Or vertical first, then horizontal based on which is dominant?
    // Let's go midpoint for Z-shape (standard for schematic layouts)

    const midX = start.x + dx / 2;

    // Z-Shape (Horizontal start)
    return [
        start,
        { x: midX, y: start.y },
        { x: midX, y: end.y },
        end
    ];
}

// ============================================================================
// Polygon Cleanup
// ============================================================================

/**
 * Sanitize room polygons by snapping vertices to nearest wall endpoints.
 * This fixes "rounded" corners from API detection by forcing them to known square wall corners.
 */
export function sanitizeRoomPolygons(rooms: Room[], walls: Wall[], snapDistance = 25): Room[] {
    return rooms.map(room => {
        const newPolygon = room.polygon.map(pt => {
            // Find nearest wall endpoint
            let nearest: Point | null = null;
            let minD = snapDistance;

            for (const wall of walls) {
                // Check Start
                const dStart = Math.hypot(wall.startPoint.x - pt.x, wall.startPoint.y - pt.y);
                if (dStart < minD) {
                    minD = dStart;
                    nearest = wall.startPoint;
                }
                // Check End
                const dEnd = Math.hypot(wall.endPoint.x - pt.x, wall.endPoint.y - pt.y);
                if (dEnd < minD) {
                    minD = dEnd;
                    nearest = wall.endPoint;
                }
            }

            return nearest ? { ...nearest } : pt;
        });

        return { ...room, polygon: newPolygon };
    });
}
