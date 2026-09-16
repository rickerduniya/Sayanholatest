// Regression tests for ceiling-fan placement.
//
// Covers the defects behind an observed bad run ("place only fans"):
// a bedroom fan on the bathroom wall, a bedroom fan on a partition wall,
// and two living/dining fans sharing one line on the passage wall —
// plus under-counting (2 fans for a ~38 m² merged living/dining/office).
//
// Root causes fixed in PlacementGeometry:
//  1. The centre used was a VERTEX average, which drifts toward the end of
//     the room with the most (detection artefact) vertices. Now area-weighted.
//  2. Only "centre inside polygon" was tested. A 1200 mm sweep needs its
//     WHOLE circle inside: centre clearance >= fan radius + margin, plus
//     keep-out around doors/windows. Now enforced.
//  3. Multi-fan grids divided the bounding box, so in a merged concave
//     polygon both fans landed on the mid-height passage strip. Now dense
//     feasible-grid + greedy maximin selection.

import { describe, it, expect } from 'vitest';
import {
    getAreaCentroid,
    getRoomInteriorPoint,
    distributeCeilingPoints,
    checkCeilingFeasibility,
    findFreePosition,
    getCeilingFanRadiusPx,
    getCeilingFanClearancePx,
    recommendedCeilingFanCount,
    summarizeRoomGeometry
} from '../PlacementGeometry';
import { Room, FloorPlan } from '../../types/layout';

const PPM = 50;
const fanD = () => getCeilingFanRadiusPx(PPM) * 2; // 60px sweep
const reqClearance = () => getCeilingFanClearancePx(PPM); // 38px

const room = (id: string, pts: Array<[number, number]>): Room => ({
    id,
    name: id,
    type: 'living_room',
    polygon: pts.map(([x, y]) => ({ x, y }))
});

const rect = (id: string, x1: number, y1: number, x2: number, y2: number): Room =>
    room(id, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);

describe('area centroid vs vertex average', () => {
    it('ignores extra collinear vertices clustered on one side', () => {
        // Same 200x200 square, but detection dropped 4 vertices on the east edge.
        const r = room('clustered', [[0, 0], [200, 0], [200, 50], [200, 100], [200, 150], [200, 200], [0, 200]]);
        const c = getAreaCentroid(r);
        // Vertex average would say x ~= 143 (off-centre, near the east wall).
        expect(c.x).toBeCloseTo(100, 0);
        expect(c.y).toBeCloseTo(100, 0);
    });

    it('interior point of a plain rectangle is its centre (label behaviour unchanged)', () => {
        expect(getRoomInteriorPoint(rect('r', 0, 0, 200, 200))).toEqual({ x: 100, y: 100 });
    });
});

describe('single fan clearance', () => {
    it('stays a full sweep clear of the inner corner of an L-shaped room', () => {
        // Wide 200x200 block with a top strip running east: vertex-average
        // centroid sits near the inner corner, < 1 sweep radius from the wall.
        const l = room('ell', [[0, 0], [300, 0], [300, 60], [200, 60], [200, 200], [0, 200]]);
        const [p] = distributeCeilingPoints(l, 1, { pixelsPerMeter: PPM });
        const check = checkCeilingFeasibility(p, l, { pixelsPerMeter: PPM });
        expect(check.feasible).toBe(true);
        expect(check.edgeClearance).toBeGreaterThanOrEqual(reqClearance());
    });

    it('flags a narrow passage that cannot fit a 1200mm sweep', () => {
        // 40px-tall strip: no 60px fan fits. Best effort + infeasible flag,
        // so the caller warns instead of overlapping walls.
        const passage = rect('passage', 0, 0, 200, 40);
        const pts = distributeCeilingPoints(passage, 1, { pixelsPerMeter: PPM });
        expect(pts.length).toBe(1);
        expect(checkCeilingFeasibility(pts[0], passage, { pixelsPerMeter: PPM }).feasible).toBe(false);
    });

    it('reports fewer points than requested when the room cannot fit them', () => {
        const passage = rect('passage', 0, 0, 200, 40);
        expect(distributeCeilingPoints(passage, 2, { pixelsPerMeter: PPM }).length).toBeLessThan(2);
    });

    it('rejects a centre overlapping a door swing or window symbol', () => {
        const r = rect('r', 0, 0, 200, 200);
        const nearDoor = checkCeilingFeasibility({ x: 100, y: 30 }, r, {
            pixelsPerMeter: PPM,
            doors: [{ position: { x: 100, y: 0 } }]
        });
        expect(nearDoor.feasible).toBe(false);
        expect(nearDoor.issues.join(' ')).toMatch(/door/);

        const nearWindow = checkCeilingFeasibility({ x: 30, y: 100 }, r, {
            pixelsPerMeter: PPM,
            windows: [{ position: { x: 0, y: 100 } }]
        });
        expect(nearWindow.feasible).toBe(false);

        // Same centres with no doors/windows nearby are fine.
        expect(checkCeilingFeasibility({ x: 100, y: 100 }, r, { pixelsPerMeter: PPM }).feasible).toBe(true);
    });
});

describe('merged living + passage + dining polygon (the observed failure)', () => {
    // Top living block + narrow 50px neck (a 1200mm fan needs 76px) +
    // bottom dining block. Fans must stay out of the neck AND stay symmetric
    // on the room axis — not one in the neck, not staggered diagonally.
    const merged = (): Room => room('merged', [
        [0, 0], [400, 0], [400, 100], [250, 100], [250, 150], [400, 150],
        [400, 250], [0, 250], [0, 150], [150, 150], [150, 100], [0, 100]
    ]);

    it('keeps both fans out of the narrow neck, symmetric on one axis', () => {
        const pts = distributeCeilingPoints(merged(), 2, { pixelsPerMeter: PPM });
        expect(pts.length).toBe(2);
        for (const p of pts) {
            expect(checkCeilingFeasibility(p, merged(), { pixelsPerMeter: PPM }).feasible).toBe(true);
        }
        const [a, b] = pts;
        // Same axis (shared y for a wide room)…
        expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(2);
        // …mirrored about the room centre (x=200)…
        expect((a.x + b.x) / 2).toBeCloseTo(200, 0);
        // …sweeps not overlapping.
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(fanD());
    });

    it('is exactly symmetric on a plain rectangle (quarters of the length)', () => {
        const r = rect('hall', 0, 0, 400, 250);
        const pts = distributeCeilingPoints(r, 2, { pixelsPerMeter: PPM });
        expect(pts.length).toBe(2);
        const [a, b] = pts;
        expect(a.y).toBeCloseTo(b.y, 6);
        expect((a.x + b.x) / 2).toBeCloseTo(200, 6);
        expect(Math.min(a.x, b.x)).toBeCloseTo(100, 0);
        expect(Math.max(a.x, b.x)).toBeCloseTo(300, 0);
    });
});

describe('recommended fan quantities (skill Section 3 table)', () => {
    it('gives a 26.8 m² (288 sqft) living-space lobby 2 fans, not 1', () => {
        expect(recommendedCeilingFanCount('living_room', 26.8)).toBe(2);
    });

    it('follows the area thresholds per room type', () => {
        expect(recommendedCeilingFanCount('living_room', 22)).toBe(1);
        expect(recommendedCeilingFanCount('living_room', 22.1)).toBe(2);
        expect(recommendedCeilingFanCount('bedroom', 20)).toBe(1);
        expect(recommendedCeilingFanCount('bedroom', 20.1)).toBe(2);
        expect(recommendedCeilingFanCount('dining', 30)).toBe(1);
        expect(recommendedCeilingFanCount('office', 30)).toBe(1);
    });

    it('gives zero fans to non-habitable rooms', () => {
        for (const t of ['kitchen', 'bathroom', 'toilet', 'balcony', 'corridor', 'staircase', 'storage', 'utility', 'pooja', 'other']) {
            expect(recommendedCeilingFanCount(t, 50)).toBe(0);
        }
    });

    it('fits 2 clear sweeps spread along a 7.2 x 3.8 m lobby', () => {
        // 360x190 px at 50 px/m ~= the observed lobby proportions.
        const lobby = rect('lobby', 0, 0, 360, 190);
        const pts = distributeCeilingPoints(lobby, 2, { pixelsPerMeter: PPM });
        expect(pts.length).toBe(2);
        for (const p of pts) {
            expect(checkCeilingFeasibility(p, lobby, { pixelsPerMeter: PPM }).feasible).toBe(true);
        }
        const [a, b] = pts;
        // Symmetric on the long axis: shared y, mirrored about x=180.
        expect(a.y).toBeCloseTo(b.y, 6);
        expect((a.x + b.x) / 2).toBeCloseTo(180, 6);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(fanD());
    });
});

describe('long-room fan separation', () => {
    it('spreads two fans along the long axis with clear sweeps', () => {
        const pts = distributeCeilingPoints(rect('hall', 0, 0, 400, 200), 2, { pixelsPerMeter: PPM });
        expect(pts.length).toBe(2);
        const [a, b] = pts;
        expect(checkCeilingFeasibility(a, rect('hall', 0, 0, 400, 200), { pixelsPerMeter: PPM }).feasible).toBe(true);
        expect(checkCeilingFeasibility(b, rect('hall', 0, 0, 400, 200), { pixelsPerMeter: PPM }).feasible).toBe(true);
        // Side by side along the length on one axis, mirrored about x=200.
        expect(a.y).toBeCloseTo(b.y, 6);
        expect((a.x + b.x) / 2).toBeCloseTo(200, 6);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(fanD());
    });

    it('stacks fans on one vertical axis in a tall narrow room', () => {
        const pts = distributeCeilingPoints(rect('tall', 0, 0, 200, 400), 2, { pixelsPerMeter: PPM });
        expect(pts.length).toBe(2);
        const [a, b] = pts;
        expect(a.x).toBeCloseTo(b.x, 6);
        expect((a.y + b.y) / 2).toBeCloseTo(200, 6);
    });
});

describe('findFreePosition with wall clearance', () => {    it('pulls an infeasible desired point inside instead of returning it as-is', () => {
        const r = rect('r', 0, 0, 200, 200);
        const got = findFreePosition({ x: 5, y: 5 }, [], 28, r, reqClearance());
        expect(checkCeilingFeasibility(got, r, { pixelsPerMeter: PPM }).feasible).toBe(true);
    });

    it('de-collision keeps the fan off the wall', () => {
        const r = rect('r', 0, 0, 200, 200);
        const blocker = { id: 'c1', type: 'ceiling_fan_point', position: { x: 100, y: 100 }, rotation: 0, properties: {} } as any;
        const got = findFreePosition({ x: 100, y: 100 }, [blocker], fanD(), r, reqClearance());
        expect(Math.hypot(got.x - 100, got.y - 100)).toBeGreaterThanOrEqual(fanD());
        expect(checkCeilingFeasibility(got, r, { pixelsPerMeter: PPM }).feasible).toBe(true);
    });
});

describe('inscribed-body centre on L-rooms (Bed10-class carve-out)', () => {
    // Top bar 200x80 with a leg hanging off the west end. The area centroid
    // (77.5, 77.5) sits 2.5px from the inner notch edge — inside the polygon
    // but useless as a fan point. The fallback must land in the wide lobe.
    const ell = (): Room => room('ell', [[0, 0], [200, 0], [200, 80], [80, 80], [80, 200], [0, 200]]);

    it('abandons a centroid dragged into a notch for the lobe centre', () => {
        const c = getAreaCentroid(ell());
        expect(c.x).toBeCloseTo(77.5, 0);
        const [p] = distributeCeilingPoints(ell(), 1, { pixelsPerMeter: PPM });
        const check = checkCeilingFeasibility(p, ell(), { pixelsPerMeter: PPM });
        expect(check.feasible).toBe(true);
        expect(check.edgeClearance).toBeGreaterThanOrEqual(reqClearance());
        // Clearly moved out of the notch, into the wide top bar.
        expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeGreaterThan(20);
        expect(p.y).toBeLessThan(80);
    });
});

describe('geometry summary exposes agent-computable data', () => {
    const plan = (): FloorPlan => ({
        id: 'plan_test',
        name: 'Test',
        width: 400,
        height: 200,
        pixelsPerMeter: PPM,
        isScaleCalibrated: true,
        walls: [],
        rooms: [rect('r', 0, 0, 200, 200)],
        doors: [],
        windows: [{ id: 'w1', position: { x: 100, y: 5 }, width: 40, height: 10, wallId: 'wx' }],
        stairs: [],
        components: [],
        connections: [],
        viewportX: 0,
        viewportY: 0,
        scale: 1
    });

    it('includes raw polygon vertices and window positions per room', () => {
        const [s] = summarizeRoomGeometry(plan());
        expect(s.polygon).toEqual([
            { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }
        ]);
        expect(s.windowCount).toBe(1);
        expect(s.windows).toEqual([{ x: 100, y: 5 }]);
    });
});
