// PlacementGeometry — spatial helpers for agent-driven electrical layout.
//
// The agent decides *what* to place and *why*; these functions answer the
// purely geometric questions it would otherwise have to guess at:
//
//   - where is the middle of this room?
//   - which wall segments bound it, and where along them can a switch board go?
//   - how do I spread N ceiling lights evenly across a room?
//   - is this point actually inside the room, and clear of what is already there?
//
// Keeping this in TypeScript rather than in the model's head matters because
// polygon maths done by an LLM drifts: points land outside rooms, lights bunch
// in a corner, and switch boards float in mid-air. Everything here is pure and
// deterministic, so a given floor plan always yields the same candidates.

import { Point } from '../types';
import { FloorPlan, Room, Wall, LayoutComponent } from '../types/layout';
import { calculateRoomArea, getRoomCentroid, isPointInRoom, closestPointOnWall } from './LayoutDrawingTools';
import { getScaledComponentSize } from './LayoutComponentDefinitions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomBounds {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    height: number;
}

export interface WallSegmentInfo {
    wallId: string;
    /** Midpoint of the portion of the wall that borders the room. */
    midpoint: Point;
    start: Point;
    end: Point;
    /** Length in pixels of the bordering portion. */
    length: number;
    thickness: number;
    /** Compass-ish orientation relative to the room, for human-readable output. */
    side: 'north' | 'south' | 'east' | 'west';
    /** Wall angle in degrees (0-360). */
    angle: number;
}

export interface DoorAdjacency {
    doorId: string;
    position: Point;
    wallId: string;
    /** Point on the wall next to the door, offset along the wall — where a
     *  switch board conventionally goes (beside the door, not on top of it). */
    besideDoor: Point;
}

export interface PlacementCandidate {
    position: Point;
    /** Why this point was suggested, so the agent can explain its choice. */
    reason: string;
}

// ---------------------------------------------------------------------------
// Basic room geometry
// ---------------------------------------------------------------------------

export function getRoomBounds(room: Room): RoomBounds | null {
    if (!room.polygon || room.polygon.length === 0) return null;

    let x1 = room.polygon[0].x;
    let y1 = room.polygon[0].y;
    let x2 = x1;
    let y2 = y1;

    for (const p of room.polygon) {
        if (p.x < x1) x1 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x;
        if (p.y > y2) y2 = p.y;
    }

    return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

/**
 * Area in square metres, using the plan's calibration.
 *
 * Returned separately from the pixel area because every sizing decision the
 * agent makes (how many lights, what wattage) should be driven by real-world
 * area, not by however the source image happened to be scaled.
 */
export function getRoomAreaSqm(room: Room, pixelsPerMeter: number): number {
    const ppm = pixelsPerMeter > 0 ? pixelsPerMeter : 50;
    return calculateRoomArea(room) / (ppm * ppm);
}

/**
 * Area-weighted centroid of a room polygon (shoelace formula).
 *
 * This is NOT the same as averaging the vertices (see getRoomCentroid in
 * LayoutDrawingTools, which does that). A vertex average drifts toward
 * whichever end of the room has the most vertices — exactly what automated
 * wall detection produces on L-shaped or merged rooms — so a fan placed at
 * it lands off-centre, sometimes on a wall. The area centroid is the true
 * centre of the surface.
 */
export function getAreaCentroid(room: Room): Point {
    const poly = room.polygon;
    const n = poly.length;
    if (n === 0) return { x: 0, y: 0 };
    if (n < 3) {
        let cx = 0, cy = 0;
        for (const p of poly) { cx += p.x; cy += p.y; }
        return { x: cx / n, y: cy / n };
    }

    let signedArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const cross = a.x * b.y - b.x * a.y;
        signedArea += cross;
        cx += (a.x + b.x) * cross;
        cy += (a.y + b.y) * cross;
    }
    if (Math.abs(signedArea) < 1e-9) {
        return getRoomCentroid(room);
    }
    signedArea /= 2;
    return { x: cx / (6 * signedArea), y: cy / (6 * signedArea) };
}

/**
 * A point guaranteed to be inside the room, as close to the visual centre as
 * possible.
 *
 * The plain centroid of a polygon can fall outside it for L-shaped or concave
 * rooms — which is exactly the shape most real flats have — or get dragged
 * into a doorway band / carve-out that is not the habitable body. When the
 * area centroid is unusable we fall back to sampling a grid and taking the
 * interior point furthest from any edge: the Chebyshev (largest-inscribed-
 * body) centre, the same point an engineer finds by centring the largest
 * rectangle that fits inside the wall lines. It is the default single-fan
 * position for exactly that reason.
 *
 * `minClearance` (px) optionally rejects points too close to the polygon edge.
 * Ceiling-fan callers pass the fan sweep radius plus a margin so the blades
 * cannot overlap a wall; label callers leave it at 0.
 */
export function getRoomInteriorPoint(room: Room, minClearance = 0): Point {
    const centroid = getAreaCentroid(room);
    if (isPointInRoom(centroid, room)) {
        if (minClearance <= 0 || distanceToPolygonEdge(centroid, room.polygon) >= minClearance) {
            return centroid;
        }
    }

    const bounds = getRoomBounds(room);
    if (!bounds) return centroid;

    let best: Point = centroid;
    let bestClearance = -1;
    // Fine enough that the winner sits within ~2 px of the true
    // largest-inscribed-body centre on a domestic plan.
    const steps = 20;

    for (let i = 1; i < steps; i++) {
        for (let j = 1; j < steps; j++) {
            const candidate = {
                x: bounds.x1 + (bounds.width * i) / steps,
                y: bounds.y1 + (bounds.height * j) / steps
            };
            if (!isPointInRoom(candidate, room)) continue;

            const clearance = distanceToPolygonEdge(candidate, room.polygon);
            if (clearance > bestClearance) {
                bestClearance = clearance;
                best = candidate;
            }
        }
    }

    return best;
}

function distanceToPolygonEdge(point: Point, polygon: Point[]): number {
    if (polygon.length < 2) return 0;

    let min = Number.MAX_VALUE;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const d = distancePointToSegment(point, a, b);
        if (d < min) min = d;
    }
    return min;
}

function distancePointToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);

    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Which room does a component at this point belong to?
 *
 * `findRoomAtPoint` is a strict ray-cast containment test, which is wrong for
 * wall-mounted devices: a switch board, AC point or tube light is deliberately
 * placed *on* the wall line, and a point on the polygon boundary may or may not
 * count as "inside" depending on which edge it lands on. In an observed agent run
 * wall-mounted items came back with `roomId: null`, which silently drops them
 * from per-room load totals and makes layout_validate report them as floating
 * outside every room.
 *
 * Two corrections over the strict test:
 *
 *  - When several polygons contain the point, prefer the SMALLEST. Detected plans
 *    do produce overlapping and nested rooms — the same run had detection merge
 *    four spaces into one large polygon that overlapped the real rooms — and the
 *    smaller polygon is the more specific, more useful answer. Edge clearance
 *    breaks a tie between equal areas.
 *  - When no polygon contains it, accept the nearest room whose edge is within
 *    `tolerance` pixels. That is what makes a flush wall mount belong to the room
 *    it is serving.
 */
export function findRoomForPoint(
    point: Point,
    rooms: Room[],
    tolerance = 30
): { room: Room; containment: 'inside' | 'on_boundary' } | null {
    let bestInside: Room | null = null;
    let bestInsideArea = Number.MAX_VALUE;
    let bestInsideClearance = -1;

    let bestNear: Room | null = null;
    let bestNearDistance = Number.MAX_VALUE;

    for (const room of rooms) {
        if (!room.polygon || room.polygon.length < 3) continue;

        if (isPointInRoom(point, room)) {
            const area = calculateRoomArea(room);
            const clearance = distanceToPolygonEdge(point, room.polygon);

            const isBetter =
                area < bestInsideArea - 1 ||
                (Math.abs(area - bestInsideArea) <= 1 && clearance > bestInsideClearance);

            if (isBetter) {
                bestInsideArea = area;
                bestInsideClearance = clearance;
                bestInside = room;
            }
            continue;
        }

        const edgeDistance = distanceToPolygonEdge(point, room.polygon);
        if (edgeDistance <= tolerance && edgeDistance < bestNearDistance) {
            bestNearDistance = edgeDistance;
            bestNear = room;
        }
    }

    if (bestInside) return { room: bestInside, containment: 'inside' };
    if (bestNear) return { room: bestNear, containment: 'on_boundary' };
    return null;
}

// ---------------------------------------------------------------------------
// Even distribution of ceiling-mounted items
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ceiling-fan placement with sweep clearance
// ---------------------------------------------------------------------------
//
// A ceiling fan is a 1200 mm sweep circle. The old grid only asked
// "is the CENTRE inside the room?", so a centre 2 px inside the polygon
// passed while the blades overlapped the wall by ~28 px — and in merged
// concave rooms (living + passage detected as one polygon) grid points
// landed in a 1 m-wide passage strip where no 1.2 m fan can physically
// fit. Every candidate below must instead fit its whole sweep circle:
// centre clearance from the polygon edge >= fan radius + margin, plus
// clearance from door/window positions so the fan never sits on a door
// swing or a window symbol.

export interface CeilingPlacementOptions {
    /** Plan calibration; fan pixel size is derived from it. Default 50. */
    pixelsPerMeter?: number;
    /** Door positions (plan pixels). Fans keep clear of door swings. */
    doors?: Array<{ position: Point }>;
    /** Window positions (plan pixels). Fans keep clear of window symbols. */
    windows?: Array<{ position: Point }>;
    /** Extra margin beyond the fan radius to the nearest wall. Default 8 px. */
    extraMarginPx?: number;
}

/**
 * Skill-derived default fan quantity for a room (load-placement.md Section 3).
 *
 * The agent kept under-counting large rooms from qualitative reasoning
 * ("safest: 1 fan") instead of applying the area table — e.g. a 26.8 m²
 * (288 sqft) lobby typed as living space got 1 fan when the table says 2
 * for anything over 22 m². Surfacing this number in the suggest response
 * makes the shortfall visible at decision time.
 *
 * Returns 0 for room types that never take ceiling fans (kitchen, bathroom,
 * toilet, balcony, corridor, staircase, storage, utility, pooja).
 */
export function recommendedCeilingFanCount(roomType: string, areaSqm: number): number {
    switch (roomType) {
        case 'bedroom':
            return areaSqm > 20 ? 2 : 1;
        case 'living_room':
            return areaSqm > 22 ? 2 : 1;
        case 'dining':
        case 'office':
            return 1;
        default:
            return 0;
    }
}

/** Pixel radius of the 1200 mm ceiling-fan sweep at this calibration. */
export function getCeilingFanRadiusPx(pixelsPerMeter = 50): number {    try {
        return getScaledComponentSize('ceiling_fan_point', pixelsPerMeter).width / 2;
    } catch {
        return 30;
    }
}

/** Required centre-to-wall-edge clearance for a fan: sweep radius + margin. */
export function getCeilingFanClearancePx(pixelsPerMeter = 50, extraMarginPx = 8): number {
    return getCeilingFanRadiusPx(pixelsPerMeter) + Math.max(0, extraMarginPx);
}

export interface CeilingFeasibility {
    feasible: boolean;
    /** Centre clearance to the nearest polygon edge, in px. */
    edgeClearance: number;
    requiredClearance: number;
    issues: string[];
}

/**
 * Check whether a fan centred at `point` fits: whole sweep inside the room
 * polygon and clear of doors/windows. Used to annotate suggestions and
 * placements with warnings instead of silently overlapping a wall.
 */
export function checkCeilingFeasibility(
    point: Point,
    room: Room,
    opts: CeilingPlacementOptions = {}
): CeilingFeasibility {
    const ppm = opts.pixelsPerMeter && opts.pixelsPerMeter > 0 ? opts.pixelsPerMeter : 50;
    const required = getCeilingFanClearancePx(ppm, opts.extraMarginPx ?? 8);
    const fanRadius = getCeilingFanRadiusPx(ppm);
    const issues: string[] = [];

    if (!isPointInRoom(point, room)) {
        issues.push('centre is outside the room polygon');
    }
    const edgeClearance = distanceToPolygonEdge(point, room.polygon);
    if (edgeClearance < required) {
        issues.push(
            `only ${Math.round(edgeClearance)}px from the wall edge; ` +
            `a ${Math.round(fanRadius * 2)}px fan sweep needs ${Math.round(required)}px`
        );
    }

    const keepOut = fanRadius + 24;
    for (const d of opts.doors || []) {
        if (Math.hypot(d.position.x - point.x, d.position.y - point.y) < keepOut) {
            issues.push('overlaps a door position / swing');
            break;
        }
    }
    for (const w of opts.windows || []) {
        if (Math.hypot(w.position.x - point.x, w.position.y - point.y) < keepOut) {
            issues.push('overlaps a window position');
            break;
        }
    }

    return { feasible: issues.length === 0, edgeClearance, requiredClearance: required, issues };
}

/**
 * Nearest feasible fan position to an obstructed ideal point.
 *
 * Expands in rings so the deviation from the symmetric ideal is minimal and
 * always caused by a real obstruction (wall neck, door keep-out). Fixed angle
 * order makes it deterministic: the same plan always yields the same points.
 */
function spiralCeilingSearch(
    ideal: Point,
    room: Room,
    opts: CeilingPlacementOptions,
    maxRadius: number
): Point | null {
    const stepCount = 12;
    for (let radius = 4; radius <= maxRadius; radius += 4) {
        for (let i = 0; i < stepCount; i++) {
            const theta = (i / stepCount) * Math.PI * 2;
            const candidate = {
                x: ideal.x + Math.cos(theta) * radius,
                y: ideal.y + Math.sin(theta) * radius
            };
            if (checkCeilingFeasibility(candidate, room, opts).feasible) return candidate;
        }
    }
    return null;
}

/**
 * Spread `count` ceiling points evenly across a room.
 *
 * Symmetry first: the room is divided into `count` equal zones along its
 * long axis and each fan goes to its zone's exact centre — halves at 1/4
 * and 3/4 of the length, thirds at 1/6, 3/6, 5/6 — whenever that point fits
 * a full 1200 mm sweep clear of walls, doors and windows (it always does on
 * a clean rectangle). Only a real obstruction moves a fan, and then the
 * search takes the nearest feasible point to the ideal, so the deviation is
 * minimal and has a physical reason visible on the overlay.
 *
 * When fewer than `count` feasible points exist (room too narrow for that
 * many 1200 mm sweeps), returns what fits — the caller must surface a
 * geometryNote rather than forcing overlaps.
 */
export function distributeCeilingPoints(
    room: Room,
    count: number,
    opts: CeilingPlacementOptions = {}
): Point[] {
    if (count <= 0) return [];

    const ppm = opts.pixelsPerMeter && opts.pixelsPerMeter > 0 ? opts.pixelsPerMeter : 50;
    const required = getCeilingFanClearancePx(ppm, opts.extraMarginPx ?? 8);
    const fanDiameter = getCeilingFanRadiusPx(ppm) * 2;

    if (count === 1) return [getRoomInteriorPoint(room, required)];

    const bounds = getRoomBounds(room);
    if (!bounds) return [];

    // Split the bounds into `count` equal zones along the long axis. The
    // zone centre is the symmetric ideal; it is used verbatim whenever it
    // fits, otherwise the nearest feasible point to it.
    const horizontal = bounds.width >= bounds.height;
    const zoneLen = (horizontal ? bounds.width : bounds.height) / count;
    const picked: Point[] = [];
    const pickedClearance: number[] = [];

    for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        const ideal = horizontal
            ? { x: bounds.x1 + bounds.width * t, y: bounds.y1 + bounds.height / 2 }
            : { x: bounds.x1 + bounds.width / 2, y: bounds.y1 + bounds.height * t };

        const found = checkCeilingFeasibility(ideal, room, opts).feasible
            ? ideal
            : spiralCeilingSearch(ideal, room, opts, zoneLen);
        if (found) {
            picked.push(found);
            pickedClearance.push(distanceToPolygonEdge(found, room.polygon));
        }
    }

    if (picked.length === 0) {
        // Nothing fits a full sweep (e.g. a narrow passage detected as a
        // room): fall back to the widest interior point so the caller still
        // gets a best-effort position to warn about.
        return [getRoomInteriorPoint(room)];
    }

    // Guard the sweep-separation promise: if two zone winners end up closer
    // than one fan diameter (tiny room, coarse zones), keep the wider one.
    const kept: Point[] = [];
    const keptClearance: number[] = [];
    const order = picked.map((_, i) => i).sort((a, b) => pickedClearance[b] - pickedClearance[a]);
    for (const i of order) {
        if (kept.every(p => Math.hypot(p.x - picked[i].x, p.y - picked[i].y) >= fanDiameter)) {
            kept.push(picked[i]);
            keptClearance.push(pickedClearance[i]);
        }
    }

    return kept;
}

// ---------------------------------------------------------------------------
// Walls bordering a room
// ---------------------------------------------------------------------------

/**
 * Which walls bound this room, and where along each one a wall-mounted device
 * can sit.
 *
 * A wall counts as bordering the room when a sample of points along it lie
 * close to the room polygon's edge. Detected floor plans rarely have walls that
 * exactly coincide with room polygons, so an exact geometric test would find
 * nothing; the tolerance is what makes this work on real scans.
 */
export function getRoomWallSegments(
    room: Room,
    walls: Wall[],
    tolerance = 30
): WallSegmentInfo[] {
    const bounds = getRoomBounds(room);
    if (!bounds) return [];

    const center = { x: (bounds.x1 + bounds.x2) / 2, y: (bounds.y1 + bounds.y2) / 2 };
    const results: WallSegmentInfo[] = [];

    for (const wall of walls) {
        // Sample along the wall; keep the run of samples that border the room.
        const samples = 9;
        const bordering: Point[] = [];

        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const p = {
                x: wall.startPoint.x + (wall.endPoint.x - wall.startPoint.x) * t,
                y: wall.startPoint.y + (wall.endPoint.y - wall.startPoint.y) * t
            };
            if (distanceToPolygonEdge(p, room.polygon) <= tolerance) {
                bordering.push(p);
            }
        }

        // A single sample is a corner touch, not a shared wall.
        if (bordering.length < 2) continue;

        const first = bordering[0];
        const last = bordering[bordering.length - 1];
        const midpoint = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
        const length = Math.hypot(last.x - first.x, last.y - first.y);
        if (length < 20) continue;

        let angle = Math.atan2(wall.endPoint.y - wall.startPoint.y, wall.endPoint.x - wall.startPoint.x) * 180 / Math.PI;
        if (angle < 0) angle += 360;

        // Side is judged from the wall midpoint relative to the room centre.
        const dx = midpoint.x - center.x;
        const dy = midpoint.y - center.y;
        let side: WallSegmentInfo['side'];
        if (Math.abs(dx) > Math.abs(dy)) {
            side = dx > 0 ? 'east' : 'west';
        } else {
            side = dy > 0 ? 'south' : 'north';
        }

        results.push({
            wallId: wall.id,
            midpoint,
            start: first,
            end: last,
            length,
            thickness: wall.thickness,
            side,
            angle
        });
    }

    // Longest walls first: they are the ones with room for a board.
    return results.sort((a, b) => b.length - a.length);
}

/**
 * Positions along the room's walls suitable for a wall-mounted device
 * (switch board, 5A socket board, AC point, and every light — see
 * agent/skills/load-placement.md Section 2.1).
 *
 * Points are returned at fractions along each bordering wall run rather than
 * only at midpoints, so multiple boards on the same wall do not stack.
 *
 * Points sit on the wall centreline, which is where a flush-mounted device
 * belongs and where `snapToNearestWall` would put it anyway. That means they are
 * on the room polygon's boundary rather than strictly inside it, so room
 * assignment must use `findRoomForPoint`, not a bare containment test.
 */
export function getWallMountCandidates(
    room: Room,
    walls: Wall[],
    perWall = 3
): PlacementCandidate[] {
    const segments = getRoomWallSegments(room, walls);
    const candidates: PlacementCandidate[] = [];

    for (const seg of segments) {
        for (let i = 1; i <= perWall; i++) {
            const t = i / (perWall + 1);
            candidates.push({
                position: {
                    x: seg.start.x + (seg.end.x - seg.start.x) * t,
                    y: seg.start.y + (seg.end.y - seg.start.y) * t
                },
                reason: `${seg.side} wall of ${room.name || 'room'} (${Math.round(seg.length)}px run)`
            });
        }
    }

    return candidates;
}

/**
 * Doors bordering the room, with the conventional "beside the door" point.
 *
 * Switch boards go next to the door on the latch side so you can reach them on
 * entering. We cannot know the hinge side from a 2D plan, so we offer a point
 * offset along the wall by roughly half a door width plus clearance and let the
 * agent choose.
 */
export function getRoomDoorAdjacencies(
    plan: FloorPlan,
    room: Room,
    tolerance = 40
): DoorAdjacency[] {
    const results: DoorAdjacency[] = [];

    for (const door of plan.doors) {
        if (distanceToPolygonEdge(door.position, room.polygon) > tolerance) continue;

        const wall = plan.walls.find(w => w.id === door.wallId);
        let offsetX = door.width * 0.75 + 15;
        let offsetY = 0;

        if (wall) {
            const dx = wall.endPoint.x - wall.startPoint.x;
            const dy = wall.endPoint.y - wall.startPoint.y;
            const len = Math.hypot(dx, dy) || 1;
            const unit = { x: dx / len, y: dy / len };
            const distance = door.width * 0.75 + 15;
            offsetX = unit.x * distance;
            offsetY = unit.y * distance;
        }

        results.push({
            doorId: door.id,
            position: { ...door.position },
            wallId: door.wallId,
            besideDoor: { x: door.position.x + offsetX, y: door.position.y + offsetY }
        });
    }

    return results;
}

// ---------------------------------------------------------------------------
// Collision avoidance
// ---------------------------------------------------------------------------

/**
 * Nudge a position off any existing component that is too close.
 *
 * Without this, an agent placing a bulb and a fan from the same room centroid
 * stacks them into one unreadable glyph. Spirals outward in small steps and
 * gives up gracefully rather than moving the item somewhere absurd.
 *
 * `edgeClearance` (px) optionally keeps the nudged point that far from the
 * room polygon's edge — ceiling-fan callers pass the fan sweep clearance so
 * de-collision never shoves a fan into a wall.
 */
export function findFreePosition(
    desired: Point,
    existing: LayoutComponent[],
    minDistance = 28,
    room?: Room,
    edgeClearance = 0
): Point {
    const fits = (p: Point) => {
        if (room) {
            if (!isPointInRoom(p, room)) return false;
            if (edgeClearance > 0 && distanceToPolygonEdge(p, room.polygon) < edgeClearance) return false;
        }
        return true;
    };
    const collides = (p: Point) =>
        existing.some(c => Math.hypot(c.position.x - p.x, c.position.y - p.y) < minDistance);

    if (!collides(desired)) return fits(desired) ? desired : spiralSearch(desired, existing, minDistance, room, edgeClearance) ?? desired;

    return spiralSearch(desired, existing, minDistance, room, edgeClearance) ?? desired;
}

function spiralSearch(
    desired: Point,
    existing: LayoutComponent[],
    minDistance: number,
    room?: Room,
    edgeClearance = 0
): Point | null {
    const collides = (p: Point) =>
        existing.some(c => Math.hypot(c.position.x - p.x, c.position.y - p.y) < minDistance);
    const fits = (p: Point) => {
        if (room) {
            if (!isPointInRoom(p, room)) return false;
            if (edgeClearance > 0 && distanceToPolygonEdge(p, room.polygon) < edgeClearance) return false;
        }
        return true;
    };

    const stepCount = 12;
    for (let ring = 1; ring <= 6; ring++) {
        const radius = minDistance * ring;
        for (let i = 0; i < stepCount; i++) {
            const theta = (i / stepCount) * Math.PI * 2;
            const candidate = {
                x: desired.x + Math.cos(theta) * radius,
                y: desired.y + Math.sin(theta) * radius
            };
            if (!fits(candidate)) continue;
            if (!collides(candidate)) return candidate;
        }
    }

    return null;
}

/**
 * Snap a wall-mounted device onto the nearest wall and report the wall's angle,
 * so the symbol can be rotated to sit flush.
 */
export function snapToNearestWall(
    point: Point,
    walls: Wall[],
    maxDistance = 60
): { position: Point; wallId: string; rotation: number } | null {
    let bestWall: Wall | null = null;
    let bestPoint: Point | null = null;
    let bestDistance = maxDistance;

    for (const wall of walls) {
        const closest = closestPointOnWall(point, wall);
        const d = Math.hypot(closest.x - point.x, closest.y - point.y);
        if (d < bestDistance) {
            bestDistance = d;
            bestWall = wall;
            bestPoint = closest;
        }
    }

    if (!bestWall || !bestPoint) return null;

    const rotation = Math.atan2(
        bestWall.endPoint.y - bestWall.startPoint.y,
        bestWall.endPoint.x - bestWall.startPoint.x
    ) * 180 / Math.PI;

    return { position: bestPoint, wallId: bestWall.id, rotation };
}

// ---------------------------------------------------------------------------
// Wall-mounted fitting orientation (bulb / tube_light / switch boards)
// ---------------------------------------------------------------------------
//
// Icon conventions (see /public/layout/*.svg) — every icon below is drawn as
// a wall-mount top view with an explicit base side:
//   - bulb:       LEFT edge (-x) = mounting base on the wall face,
//                 RIGHT (+x) = bulb circle facing the room.
//                 Long axis must sit PERPENDICULAR to the wall.
//   - tube_light, point_switch_board, avg_5a_switch_board:
//                 TOP edge (-y) = mounting base (strip or line) on the wall face,
//                 BOTTOM (+y) = tube / plate face / stem toward the room.
//                 Long axis (x) runs PARALLEL to the wall.
//
// Snapping these types to the wall centreline with `rotation = wallAngle`
// leaves the bulb lying parallel to the wall (base buried) and the tube /
// boards straddling inside the wall body — and on a partition wall there is no
// record of which of the two rooms the fitting serves. These types must
// instead be offset into the served room so the base touches the wall face,
// with the rotation chosen so the "room side" of the icon points at that room.
// Dragging the fitting across the wall re-seats it to face the new side.

/**
 * Component types seated with room-side awareness: base on the wall face,
 * face toward the served room, flipping when dragged across a partition wall.
 * Bulbs seat perpendicular; tube_lights and both switch boards seat parallel.
 */
export const ROOM_SIDE_SEATED_TYPES: ReadonlySet<string> = new Set([
    'bulb',
    'tube_light',
    'point_switch_board',
    'avg_5a_switch_board'
]);

/** True when a type is seated base-on-wall, face-toward-room (see above). */
export function needsRoomSideSeating(type: string): boolean {
    return ROOM_SIDE_SEATED_TYPES.has(type);
}

/**
 * Text-labelled wall units (AC indoor unit, geyser) that must read as mounted
 * in their served room's wall so ownership is obvious, but must NOT flip —
 * a 180° flip would render their "AC" / "G" labels upside down. They seat
 * parallel to the wall, sunk slightly into its room-side face, with the
 * rotation normalised so the label stays upright.
 */
export const UPRIGHT_WALL_SEATED_TYPES: ReadonlySet<string> = new Set([
    'ac_point',
    'geyser_point'
]);

/** True when a type is seated offset-into-room with an upright label. */
export function needsUprightWallSeating(type: string): boolean {
    return UPRIGHT_WALL_SEATED_TYPES.has(type);
}

/**
 * True for every type that seats off the wall face toward its room (flipping
 * types plus upright-label types). Use this at placement call sites.
 */
export function needsWallSeating(type: string): boolean {
    return ROOM_SIDE_SEATED_TYPES.has(type) || UPRIGHT_WALL_SEATED_TYPES.has(type);
}

/**
 * Normalise a wall angle so text-bearing icons stay readable: folds the
 * 180° ambiguity of wall direction (start→end order) into (-90°, 90°], so a
 * horizontal wall always yields 0° (never upside-down 180°) while staying
 * parallel to the wall.
 */
export function uprightWallAngle(wallAngle: number): number {
    let a = wallAngle;
    while (a > 90) a -= 180;
    while (a <= -90) a += 180;
    return a;
}

export interface WallMountOrientation {
    /** Final centre position (already offset off the wall face into the room). */
    position: Point;
    /** Wall the component was seated on. */
    wallId: string;
    /** Rotation in degrees (-180..180], matching snapToNearestWall convention. */
    rotation: number;
}

function wallUnitVector(wall: Wall): Point {
    const dx = wall.endPoint.x - wall.startPoint.x;
    const dy = wall.endPoint.y - wall.startPoint.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-6) return { x: 1, y: 0 };
    return { x: dx / len, y: dy / len };
}

/**
 * Pick the wall normal that points toward the served room.
 *
 * Preference order: explicit room interior point, then the side the cursor /
 * requested point approached from, then a deterministic default. The default
 * matters because getWallMountCandidates returns points exactly ON the wall
 * line, where the approach vector has zero length.
 */
function roomSideNormal(
    snapPoint: Point,
    wall: Wall,
    roomInterior?: Point | null,
    approachVector?: Point | null
): Point {
    const u = wallUnitVector(wall);
    // Two unit normals (screen coords, y down — handedness does not matter,
    // we just need both perpendicular options).
    const n1 = { x: -u.y, y: u.x };
    const n2 = { x: u.y, y: -u.x };

    const pickBy = (vx: number, vy: number): Point | null => {
        if (Math.hypot(vx, vy) < 1e-6) return null;
        const d1 = vx * n1.x + vy * n1.y;
        const d2 = vx * n2.x + vy * n2.y;
        // Ties (point exactly on the line) fall back to n1 deterministically.
        return d2 > d1 ? n2 : n1;
    };

    if (roomInterior) {
        const picked = pickBy(roomInterior.x - snapPoint.x, roomInterior.y - snapPoint.y);
        if (picked) return picked;
    }
    if (approachVector) {
        const picked = pickBy(approachVector.x, approachVector.y);
        if (picked) return picked;
    }
    return n1;
}

/**
 * Seat a wall fitting toward its served room.
 *
 * Seating modes:
 *   - 'bulb': perpendicular, base on the wall face, globe into the room.
 *   - tube_light / switch boards: parallel, base on the wall face, flipping
 *     to face whichever room they serve.
 *   - ac_point / geyser_point: parallel, sunk slightly into the wall face on
 *     the room side so ownership is obvious, but never flipped — rotation is
 *     normalised upright so labels stay readable.
 *   - anything else passes through flush on the wall centreline.
 *
 * @param type          Component type (other types pass through flush)
 * @param snapPoint     Closest point on the wall centreline
 * @param wall          Host wall (thickness used to clear the wall face)
 * @param opts.roomInterior   A point known to be inside the served room
 * @param opts.approach       Raw click/requested point minus snapPoint
 * @param opts.pixelsPerMeter Plan calibration for real-world icon size
 */
export function orientComponentOnWall(
    type: string,
    snapPoint: Point,
    wall: Wall,
    opts: {
        roomInterior?: Point | null;
        approach?: Point | null;
        pixelsPerMeter?: number;
    } = {}
): WallMountOrientation {
    const wallAngle = Math.atan2(
        wall.endPoint.y - wall.startPoint.y,
        wall.endPoint.x - wall.startPoint.x
    ) * 180 / Math.PI;

    if (!needsWallSeating(type)) {
        return { position: { ...snapPoint }, wallId: wall.id, rotation: wallAngle };
    }

    const ppm = opts.pixelsPerMeter && opts.pixelsPerMeter > 0 ? opts.pixelsPerMeter : 50;
    let size = { width: 24, height: 24 };
    try {
        size = getScaledComponentSize(type as any, ppm);
    } catch {
        // Fall back to the default above; orientation still applies.
    }

    const normal = roomSideNormal(snapPoint, wall, opts.roomInterior, opts.approach);
    const clearance = 2; // px gap so the base sits visibly on the wall face
    const halfThickness = (wall.thickness || 0) / 2;

    if (type === 'bulb') {
        // Icon forward (+x, base -> bulb) must equal the room-side normal.
        const rotation = Math.atan2(normal.y, normal.x) * 180 / Math.PI;
        const offset = halfThickness + size.width / 2 + clearance;
        return {
            position: { x: snapPoint.x + normal.x * offset, y: snapPoint.y + normal.y * offset },
            wallId: wall.id,
            rotation
        };
    }

    // ac_point / geyser_point: sunk slightly INTO the wall face on the room
    // side so the unit reads as mounted in that room's wall (and ownership is
    // obvious), but keep the label upright — never flip.
    if (needsUprightWallSeating(type)) {
        const rotation = uprightWallAngle(wallAngle);
        const embed = 4; // px the unit sinks into the wall face — mounted look
        const offset = Math.max(0, halfThickness + size.height / 2 - embed);
        return {
            position: { x: snapPoint.x + normal.x * offset, y: snapPoint.y + normal.y * offset },
            wallId: wall.id,
            rotation
        };
    }

    // tube_light and both switch boards: icon "out of wall" direction
    // (+y, base -> tube / plate face) must equal the room-side normal.
    // Rotating (0,1) by R gives (-sinR, cosR), so R = atan2(-nx, ny).
    // The long axis stays parallel to the wall.
    const rotation = Math.atan2(-normal.x, normal.y) * 180 / Math.PI;
    const offset = halfThickness + size.height / 2 + clearance;
    return {
        position: { x: snapPoint.x + normal.x * offset, y: snapPoint.y + normal.y * offset },
        wallId: wall.id,
        rotation
    };
}

export interface WallSeatingCheck {
    /** True when the fitting is close enough to a wall to read as mounted. */
    seated: boolean;
    /** Distance in px from the fitting centre to the nearest wall centreline. */
    distancePx: number;
    /** Largest distance in px that still counts as mounted for this type. */
    allowedPx: number;
    /** Nearest wall, if any wall exists. */
    wallId: string | null;
}

/**
 * Is this wall-mounted fitting actually ON a wall, or floating in open area?
 *
 * The seating logic only engages near a detected wall line: an agent that
 * hand-picks coordinates mid-room (e.g. to dodge crowding) sails past the snap
 * radius, and the old validator waved it through because it only gated on
 * "inside some room". A 5A board floating mid-office is the observed failure.
 *
 * Allowance mirrors the seating math — wall half-thickness plus the fitting's
 * perpendicular half-extent (bulb length for perpendicular bulbs, icon depth
 * for parallel types, footprint for centred types) plus slack for rounding and
 * manual nudges. A genuinely floating item misses by an order of magnitude
 * more, so this does not false-positive on seated fittings.
 */
export function checkWallSeating(
    position: Point,
    type: string,
    walls: Wall[],
    pixelsPerMeter = 50
): WallSeatingCheck {
    if (!walls || walls.length === 0) {
        // No walls to judge against (degenerate plan) — do not pile on.
        return { seated: true, distancePx: 0, allowedPx: 0, wallId: null };
    }

    let bestWall: Wall | null = null;
    let bestDistance = Number.MAX_VALUE;
    for (const wall of walls) {
        const closest = closestPointOnWall(position, wall);
        const d = Math.hypot(closest.x - position.x, closest.y - position.y);
        if (d < bestDistance) {
            bestDistance = d;
            bestWall = wall;
        }
    }
    if (!bestWall) {
        return { seated: true, distancePx: 0, allowedPx: 0, wallId: null };
    }

    const ppm = pixelsPerMeter > 0 ? pixelsPerMeter : 50;
    let size = { width: 24, height: 24 };
    try {
        size = getScaledComponentSize(type as any, ppm);
    } catch {
        // Keep the default; the distance test still applies.
    }

    // Perpendicular half-extent: what legitimately separates a seated fitting's
    // centre from the wall centreline, beyond the wall's own half-thickness.
    const perpHalf = type === 'bulb'
        ? size.width / 2
        : (needsRoomSideSeating(type) || needsUprightWallSeating(type))
            ? size.height / 2
            : Math.max(size.width, size.height) / 2;

    const allowed = (bestWall.thickness || 0) / 2 + perpHalf + 10;
    return {
        seated: bestDistance <= allowed,
        distancePx: Math.round(bestDistance),
        allowedPx: Math.round(allowed),
        wallId: bestWall.id
    };
}

// ---------------------------------------------------------------------------
// Door / window opening clearance for switch boards
// ---------------------------------------------------------------------------
//
// A switch board concreted over a door or window span is unusable: the opening
// has no wall body to chase conduit into and the board blocks the leaf. The
// observed failure was an agent centring point and 5A boards on door spans.
// Boards belong on clear wall beside openings, never overlapping their spans.
// (Lights are deliberately exempt — a bathroom bulb goes above the door and a
// kitchen tube above the window — as are exhaust fans, which share the window
// wall by design.)

/**
 * Switch-board AND distribution-board types that must keep clear of door and
 * window spans. A board concreted over an opening is unusable — no wall body
 * to fix to, and it blocks the leaf. DBs mount under the wall line but never
 * on an opening.
 */
export const OPENING_CLEAR_TYPES: ReadonlySet<string> = new Set([
    'point_switch_board',
    'avg_5a_switch_board',
    'spn_db',
    'htpn_db',
    'vtpn_db'
]);

/** True when a type must sit on clear wall, off every door/window span. */
export function needsOpeningClearance(type: string): boolean {
    return OPENING_CLEAR_TYPES.has(type);
}

export interface WallOpening {
    id: string;
    kind: 'door' | 'window';
    /** Centre of the opening. */
    position: Point;
    /** Half the opening's span along the wall. */
    halfWidth: number;
}

/**
 * Every door and window on the plan as wall-span blockers.
 */
export function planOpenings(plan: FloorPlan): WallOpening[] {
    return [
        ...(plan.doors || []).map(d => ({
            id: d.id,
            kind: 'door' as const,
            position: { ...d.position },
            halfWidth: (d.width || 0) / 2
        })),
        ...(plan.windows || []).map(w => ({
            id: w.id,
            kind: 'window' as const,
            position: { ...w.position },
            halfWidth: (w.width || 0) / 2
        }))
    ];
}

export interface OpeningClearance {
    /** True when the fitting overlaps no door/window span on this wall. */
    clear: boolean;
    /** Smallest edge-to-edge gap along the wall (negative = overlapping). */
    gapPx: number;
    kind: 'door' | 'window' | null;
    openingId: string | null;
}

function alongWallCoord(p: Point, wall: Wall, unit: Point): number {
    return (p.x - wall.startPoint.x) * unit.x + (p.y - wall.startPoint.y) * unit.y;
}

/**
 * Edge-to-edge gap between a fitting sitting on `wall` and every door/window
 * span on that same wall. Openings far off the wall line are ignored, so a
 * window on the far side of the building never blocks.
 *
 * @param fittingHalfWidth  Half the fitting's extent along the wall.
 * @param margin            Extra clear wall required past the fitting edge.
 */
export function checkOpeningClearance(
    position: Point,
    wall: Wall,
    openings: WallOpening[],
    fittingHalfWidth: number,
    margin = 10
): OpeningClearance {
    const unit = wallUnitVector(wall);
    const s0 = alongWallCoord(position, wall, unit);
    const offWallTolerance = (wall.thickness || 0) / 2 + 20;

    let result: OpeningClearance = { clear: true, gapPx: Number.MAX_VALUE, kind: null, openingId: null };

    for (const opening of openings) {
        const anchor = closestPointOnWall(opening.position, wall);
        if (Math.hypot(anchor.x - opening.position.x, anchor.y - opening.position.y) > offWallTolerance) {
            continue;
        }
        const sc = alongWallCoord(anchor, wall, unit);
        const gap = Math.abs(s0 - sc) - (opening.halfWidth + fittingHalfWidth + margin);
        if (gap < result.gapPx) {
            result = { clear: gap >= 0, gapPx: Math.round(gap), kind: opening.kind, openingId: opening.id };
        }
    }

    if (result.gapPx === Number.MAX_VALUE) {
        return { clear: true, gapPx: Number.MAX_VALUE, kind: null, openingId: null };
    }
    return result;
}

/**
 * Slide a fitting along its wall until it clears every door/window span.
 *
 * Moves to the nearest clear edge, re-checking after each move (openings can
 * cluster). The perpendicular offset off the wall is preserved — this only
 * changes the along-wall coordinate. Gives up past `maxSlide` px and returns
 * best-effort; the validator flags whatever is left.
 */
export function slideClearOfOpenings(
    position: Point,
    wall: Wall,
    openings: WallOpening[],
    fittingHalfWidth: number,
    margin = 10,
    maxSlide = 160
): Point {
    const unit = wallUnitVector(wall);
    const sOrigin = alongWallCoord(position, wall, unit);
    let s = sOrigin;

    for (let i = 0; i < 8; i++) {
        // Measure from the candidate's wall-line anchor so the perpendicular
        // seating offset never leaks into the along-wall gap.
        const probe = { x: position.x + unit.x * (s - sOrigin), y: position.y + unit.y * (s - sOrigin) };
        const check = checkOpeningClearance(probe, wall, openings, fittingHalfWidth, margin);
        if (check.clear) break;

        // Nearest edge of the worst interval wins; ties go room-ward (+s).
        let worst: { sc: number; half: number } | null = null;
        let worstGap = Number.MAX_VALUE;
        const offWallTolerance = (wall.thickness || 0) / 2 + 20;
        for (const opening of openings) {
            const anchor = closestPointOnWall(opening.position, wall);
            if (Math.hypot(anchor.x - opening.position.x, anchor.y - opening.position.y) > offWallTolerance) continue;
            const sc = alongWallCoord(anchor, wall, unit);
            const half = opening.halfWidth + fittingHalfWidth + margin;
            const gap = Math.abs(s - sc) - half;
            if (gap < worstGap) {
                worstGap = gap;
                worst = { sc, half };
            }
        }
        if (!worst || worstGap >= 0) break;
        s = s < worst.sc ? worst.sc - worst.half : worst.sc + worst.half;
        if (Math.abs(s - sOrigin) > maxSlide) {
            s = sOrigin + Math.sign(s - sOrigin) * maxSlide;
            break;
        }
    }

    return { x: position.x + unit.x * (s - sOrigin), y: position.y + unit.y * (s - sOrigin) };
}

/**
 * Is this wall segment on the building's outer boundary, as seen from `room`?
 *
 * Steps perpendicular off the wall, away from the room, and asks what is on the
 * far side. Nothing → boundary (external) wall. Another room → partition wall.
 *
 * This replaces a midpoint-counting heuristic that was wrong in a way that
 * mattered. That version asked "how many rooms is this wall's MIDPOINT near?"
 * and called the wall internal when the answer was 2 or more. On a real flat the
 * long perimeter walls run past several rooms, so their midpoints sit next to two
 * of them and every one of those walls was misclassified as a partition. In an
 * observed agent run an entire bedroom reported zero external walls, which left
 * its AC point with no legal position and cost several turns of retrying.
 *
 * Looking at what is physically on the other side is both more accurate and
 * easier to reason about, and it is inherently per-room: the same wall can be
 * boundary for the room on one side and irrelevant to a room further along.
 */
export function isWallSegmentExternal(
    seg: WallSegmentInfo,
    room: Room,
    plan: FloorPlan
): boolean {
    const dx = seg.end.x - seg.start.x;
    const dy = seg.end.y - seg.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return false;

    // Unit normal to the wall.
    let nx = -dy / len;
    let ny = dx / len;

    // Point it away from the room's interior.
    const inside = getRoomInteriorPoint(room);
    const toInside = { x: inside.x - seg.midpoint.x, y: inside.y - seg.midpoint.y };
    if (nx * toInside.x + ny * toInside.y > 0) {
        nx = -nx;
        ny = -ny;
    }

    // Clear the wall's own thickness plus the slack between detected room
    // polygons and wall centrelines, then a little more so we land solidly in
    // whatever is beyond.
    const probe = Math.max(seg.thickness || 0, 10) / 2 + 34;

    const others = plan.rooms.filter(r => r.id !== room.id && r.polygon && r.polygon.length >= 3);

    let outsideHits = 0;
    let samples = 0;
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const base = {
            x: seg.start.x + dx * t,
            y: seg.start.y + dy * t
        };
        const probePoint = { x: base.x + nx * probe, y: base.y + ny * probe };
        samples++;
        if (!others.some(r => isPointInRoom(probePoint, r))) outsideHits++;
    }

    // Majority rules, so one odd probe (a doorway, a detection artefact) does not
    // flip the answer.
    return outsideHits * 2 > samples;
}

/**
 * Identify walls that lie on the building's outer perimeter.
 *
 * A wall counts as external when at least one room that borders it sees open air
 * on the far side. Walls bordering no room at all are treated as external, since
 * on a detected plan those are usually perimeter or annotation walls.
 */
export function getExternalWalls(plan: FloorPlan): Set<string> {
    const external = new Set<string>();
    const bordered = new Set<string>();

    for (const room of plan.rooms) {
        for (const seg of getRoomWallSegments(room, plan.walls)) {
            bordered.add(seg.wallId);
            if (isWallSegmentExternal(seg, room, plan)) {
                external.add(seg.wallId);
            }
        }
    }

    for (const wall of plan.walls) {
        if (!bordered.has(wall.id)) external.add(wall.id);
    }

    // A plan where nothing looks external means the geometry is degenerate
    // (single room, or rooms not aligned to walls). Returning everything keeps
    // callers working; they surface a warning of their own.
    return external.size > 0 ? external : new Set(plan.walls.map(w => w.id));
}

/**
 * Wall-mount candidates restricted to external (boundary) walls only.
 *
 * Used for AC points and exhaust fans, which MUST be on the building perimeter
 * so the outdoor unit / vent reaches the outside.
 */
export function getExternalWallMountCandidates(
    room: Room,
    plan: FloorPlan,
    perWall = 3
): PlacementCandidate[] {
    // Per-room test rather than the plan-wide set: a wall can be this room's
    // boundary wall while also bordering another room further along its run.
    const segments = getRoomWallSegments(room, plan.walls)
        .filter(seg => isWallSegmentExternal(seg, room, plan));

    const candidates: PlacementCandidate[] = [];
    for (const seg of segments) {
        for (let i = 1; i <= perWall; i++) {
            const t = i / (perWall + 1);
            candidates.push({
                position: {
                    x: seg.start.x + (seg.end.x - seg.start.x) * t,
                    y: seg.start.y + (seg.end.y - seg.start.y) * t
                },
                reason: `External ${seg.side} wall of ${room.name || 'room'} (${Math.round(seg.length)}px run)`
            });
        }
    }

    // If no external walls border this room, fall back to all walls with a warning
    if (candidates.length === 0) {
        return getWallMountCandidates(room, plan.walls, perWall).map(c => ({
            ...c,
            reason: c.reason + ' [WARNING: no external wall found, using internal wall]'
        }));
    }

    return candidates;
}

// ---------------------------------------------------------------------------
// Whole-plan summary
// ---------------------------------------------------------------------------

export interface RoomGeometrySummary {
    roomId: string;
    name: string;
    type: string;
    areaSqm: number;
    areaSqft: number;
    bounds: RoomBounds | null;
    center: Point;
    cornerCount: number;
    /**
     * Raw wall-line vertices in plan pixels (rounded). The agent has coordinate
     * authority: it may do its own arithmetic on these — e.g. centring the
     * largest axis-aligned rectangle that fits inside them for a fan — but
     * anything it places must still pass validation (inside a room, sweep
     * clear of walls/doors/windows).
     */
    polygon: Point[];
    walls: Array<{ wallId: string; side: string; length: number; midpoint: Point; isExternal: boolean }>;
    doors: Array<{ doorId: string; position: Point; besideDoor: Point }>;
    windowCount: number;
    /** Positions of this room's windows (plan pixels) — keep-out for fans. */
    windows: Point[];
    componentCount: number;
    detectedName?: string;
}

const SQFT_PER_SQM = 10.763910416709722;

/**
 * Machine-readable geometry for every room on a plan.
 *
 * This is the agent's primary view of the building. It deliberately includes
 * real-world areas and named wall sides, because those are what the placement
 * rules are written in terms of — an agent reasoning in raw pixel polygons
 * makes worse decisions and cannot explain them.
 */
export function summarizeRoomGeometry(plan: FloorPlan): RoomGeometrySummary[] {
    const ppm = plan.pixelsPerMeter || 50;

    return plan.rooms.map(room => {
        const areaSqm = getRoomAreaSqm(room, ppm);
        const segments = getRoomWallSegments(room, plan.walls);
        const doors = getRoomDoorAdjacencies(plan, room);

        const roomWindows = plan.windows.filter(w =>
            distanceToPolygonEdge(w.position, room.polygon) <= 40
        );

        return {
            roomId: room.id,
            name: room.name || 'Unnamed',
            type: room.type,
            areaSqm: Number(areaSqm.toFixed(2)),
            areaSqft: Number((areaSqm * SQFT_PER_SQM).toFixed(1)),
            bounds: getRoomBounds(room),
            center: getRoomInteriorPoint(room),
            cornerCount: room.polygon.length,
            polygon: room.polygon.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
            // isExternal is judged per room — asked as "what is on the far side of
            // this wall, from inside this room?" — because a single wall run can
            // be a boundary wall here and a partition further along. This used to
            // call getExternalWalls() once per wall per room, which rebuilt the
            // whole-plan classification O(rooms × walls) times.
            walls: segments.map(s => ({
                wallId: s.wallId,
                side: s.side,
                length: Math.round(s.length),
                midpoint: { x: Math.round(s.midpoint.x), y: Math.round(s.midpoint.y) },
                isExternal: isWallSegmentExternal(s, room, plan)
            })),
            doors: doors.map(d => ({
                doorId: d.doorId,
                position: { x: Math.round(d.position.x), y: Math.round(d.position.y) },
                besideDoor: { x: Math.round(d.besideDoor.x), y: Math.round(d.besideDoor.y) }
            })),
            windowCount: roomWindows.length,
            windows: roomWindows.map(w => ({ x: Math.round(w.position.x), y: Math.round(w.position.y) })),
            componentCount: plan.components.filter(c => c.roomId === room.id).length,
            ...(room.detectedName ? { detectedName: room.detectedName } : {})
        };
    });
}
