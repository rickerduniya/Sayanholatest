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
 * Snap a point to the nearest wall endpoint.
 *
 * Distinct from snapToWall, which snaps to anywhere along a wall's length. When
 * drafting, joining a new wall exactly to an existing corner matters far more
 * than landing somewhere on its face, otherwise the plan ends up full of
 * near-miss junctions that break room detection.
 */
export function snapToWallEndpoint(
    point: Point,
    walls: Wall[],
    snapDistance: number = 14
): { point: Point; wall: Wall } | null {
    let best: { point: Point; wall: Wall } | null = null;
    let minDistance = snapDistance;

    for (const wall of walls) {
        for (const candidate of [wall.startPoint, wall.endPoint]) {
            const dist = Math.hypot(candidate.x - point.x, candidate.y - point.y);
            if (dist < minDistance) {
                minDistance = dist;
                best = { point: { x: candidate.x, y: candidate.y }, wall };
            }
        }
    }

    return best;
}

/**
 * Resolve the best snap target for a drafting cursor, in priority order:
 *   1. an existing wall endpoint (exact corner join)
 *   2. a point along an existing wall (T-junction)
 *
 * The returned `type` lets the canvas draw a different indicator per snap kind,
 * so the user can tell what they are about to connect to before clicking.
 */
export function resolveDraftingSnap(
    point: Point,
    walls: Wall[],
    endpointTolerance: number = 14,
    wallTolerance: number = 10
): { point: Point; type: 'endpoint' | 'wall' } | null {
    const endpoint = snapToWallEndpoint(point, walls, endpointTolerance);
    if (endpoint) return { point: endpoint.point, type: 'endpoint' };

    const onWall = snapToWall(point, walls, wallTolerance);
    if (onWall) return { point: onWall.snapPoint, type: 'wall' };

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
    select: 'Click to select · drag empty space to box-select · Shift+click to add',
    pan: 'Drag to pan · hold Space from any tool',
    wall: 'Click start, then click end · Shift constrains to 45° · Esc cancels',
    room: 'Click each corner · double-click or Enter to close · Esc cancels',
    door: 'Click a wall to place a door',
    window: 'Click a wall to place a window',
    stair: 'Click corners to define stair area',
    component: 'Click to place · snaps to nearby walls · Esc to stop placing',
    connection: 'Click a Point Switch Board, then click a load',
    erase: 'Click elements to delete them',
    pick: 'Click a wall to copy its thickness',
    calibrate: 'Draw a line over a known distance, then enter its real length'
};

// ============================================================================
// Bounding boxes & box-selection hit testing
// ============================================================================

export interface Bounds {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/** Normalize two arbitrary corner points into an ordered bounding box. */
export function normalizeBounds(a: Point, b: Point): Bounds {
    return {
        x1: Math.min(a.x, b.x),
        y1: Math.min(a.y, b.y),
        x2: Math.max(a.x, b.x),
        y2: Math.max(a.y, b.y)
    };
}

export function boundsArea(bounds: Bounds): number {
    return Math.abs(bounds.x2 - bounds.x1) * Math.abs(bounds.y2 - bounds.y1);
}

export function pointInBounds(point: Point, bounds: Bounds): boolean {
    return point.x >= bounds.x1 && point.x <= bounds.x2 &&
        point.y >= bounds.y1 && point.y <= bounds.y2;
}

/**
 * Do two boxes overlap at all?
 *
 * Used for "touch" style rubber-band selection: an element is picked if the
 * marquee touches it, rather than requiring full containment. Touch selection
 * is far less fiddly on a dense floor plan where fully enclosing a long wall
 * would mean dragging across the whole drawing.
 */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
    return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
}

export function boundsFromPoints(points: Point[]): Bounds | null {
    if (points.length === 0) return null;

    let x1 = points[0].x;
    let y1 = points[0].y;
    let x2 = points[0].x;
    let y2 = points[0].y;

    for (const p of points) {
        if (p.x < x1) x1 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x;
        if (p.y > y2) y2 = p.y;
    }

    return { x1, y1, x2, y2 };
}

/** Bounding box around a point, expanded by a half-extent in each axis. */
export function boundsAroundPoint(point: Point, halfWidth: number, halfHeight: number): Bounds {
    return {
        x1: point.x - halfWidth,
        y1: point.y - halfHeight,
        x2: point.x + halfWidth,
        y2: point.y + halfHeight
    };
}


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
