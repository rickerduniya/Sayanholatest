// Regression tests for the placement geometry an agent run depends on.
//
// These cover the five defects that real agent runs surfaced:
//
//  1. External-wall classification called perimeter walls "internal" because it
//     counted how many rooms a wall's midpoint was near. A bedroom on the
//     building edge reported zero external walls, leaving its AC point with no
//     legal position.
//  2. Room assignment used a strict point-in-polygon test, so every wall-mounted
//     device — which sits ON the polygon edge by design — came back with no room
//     and vanished from per-room load totals.
//  3. Wall-mount candidates have to land on walls that actually border the room.
//  4. Wall-mounted items hand-placed mid-room bypassed the wall snap and passed
//     validation, which only gated on "inside some room". A 5A board floated
//     mid-office. checkWallSeating closes that gap.
//  5. Switch boards centred on door spans: no wall body there to fix to.
//     checkOpeningClearance flags them, slideClearOfOpenings moves them clear.

import { describe, it, expect } from 'vitest';
import {
    getExternalWalls,
    isWallSegmentExternal,
    getRoomWallSegments,
    getWallMountCandidates,
    getExternalWallMountCandidates,
    findRoomForPoint,
    checkWallSeating,
    orientComponentOnWall,
    planOpenings,
    checkOpeningClearance,
    slideClearOfOpenings,
    needsOpeningClearance
} from '../PlacementGeometry';
import { FloorPlan, Room, Wall } from '../../types/layout';

// ---------------------------------------------------------------------------
// Fixture: two rooms side by side inside a 400x200 outer shell.
//
//   (0,0)      (200,0)      (400,0)
//     +-----------+-----------+
//     |           |           |
//     |   LEFT    |   RIGHT   |     <- shared partition at x=200
//     |           |           |
//     +-----------+-----------+
//   (0,200)    (200,200)   (400,200)
//
// Every wall on the outline is a boundary wall. Only x=200 is a partition.
// ---------------------------------------------------------------------------

const wall = (id: string, x1: number, y1: number, x2: number, y2: number): Wall => ({
    id,
    startPoint: { x: x1, y: y1 },
    endPoint: { x: x2, y: y2 },
    thickness: 10
});

const room = (id: string, name: string, pts: Array<[number, number]>): Room => ({
    id,
    name,
    type: 'bedroom',
    polygon: pts.map(([x, y]) => ({ x, y }))
});

function makePlan(): FloorPlan {
    return {
        id: 'plan_test',
        name: 'Test',
        width: 400,
        height: 200,
        pixelsPerMeter: 50,
        isScaleCalibrated: true,
        walls: [
            wall('w_top_left', 0, 0, 200, 0),
            wall('w_top_right', 200, 0, 400, 0),
            wall('w_bottom_left', 0, 200, 200, 200),
            wall('w_bottom_right', 200, 200, 400, 200),
            wall('w_left', 0, 0, 0, 200),
            wall('w_right', 400, 0, 400, 200),
            wall('w_partition', 200, 0, 200, 200)
        ],
        rooms: [
            room('room_left', 'LEFT', [[0, 0], [200, 0], [200, 200], [0, 200]]),
            room('room_right', 'RIGHT', [[200, 0], [400, 0], [400, 200], [200, 200]])
        ],
        doors: [],
        windows: [],
        stairs: [],
        components: [],
        connections: [],
        viewportX: 0,
        viewportY: 0,
        scale: 1
    };
}

const segmentFor = (plan: FloorPlan, r: Room, wallId: string) => {
    const seg = getRoomWallSegments(r, plan.walls).find(s => s.wallId === wallId);
    if (!seg) throw new Error(`no segment for ${wallId} on ${r.name}`);
    return seg;
};

describe('external wall classification', () => {
    it('treats the partition between two rooms as internal', () => {
        const plan = makePlan();
        const left = plan.rooms[0];

        expect(isWallSegmentExternal(segmentFor(plan, left, 'w_partition'), left, plan)).toBe(false);
    });

    it('treats every perimeter wall as external, even when it borders two rooms', () => {
        const plan = makePlan();
        const left = plan.rooms[0];
        const right = plan.rooms[1];

        // The old midpoint-counting heuristic failed exactly here: these walls run
        // along the outline past more than one room.
        expect(isWallSegmentExternal(segmentFor(plan, left, 'w_left'), left, plan)).toBe(true);
        expect(isWallSegmentExternal(segmentFor(plan, left, 'w_top_left'), left, plan)).toBe(true);
        expect(isWallSegmentExternal(segmentFor(plan, left, 'w_bottom_left'), left, plan)).toBe(true);
        expect(isWallSegmentExternal(segmentFor(plan, right, 'w_right'), right, plan)).toBe(true);
    });

    it('excludes the partition from the plan-wide external set', () => {
        const external = getExternalWalls(makePlan());

        expect(external.has('w_partition')).toBe(false);
        expect(external.has('w_left')).toBe(true);
        expect(external.has('w_right')).toBe(true);
    });

    it('never offers a partition-wall position for an AC or exhaust fan', () => {
        const plan = makePlan();
        const candidates = getExternalWallMountCandidates(plan.rooms[0], plan, 3);

        expect(candidates.length).toBeGreaterThan(0);
        // No fallback warning: this room really does have boundary walls.
        expect(candidates.some(c => c.reason.includes('WARNING'))).toBe(false);
        // Nothing on the x=200 partition line.
        expect(candidates.every(c => Math.abs(c.position.x - 200) > 1)).toBe(true);
    });

    it('warns rather than silently using a partition when a room is fully internal', () => {
        const plan = makePlan();
        // Wrap both rooms in a third that surrounds them, so LEFT has no outside.
        plan.rooms.push(room('room_shell', 'SHELL', [[-60, -60], [460, -60], [460, 260], [-60, 260]]));

        const candidates = getExternalWallMountCandidates(plan.rooms[0], plan, 2);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.some(c => c.reason.includes('no external wall found'))).toBe(true);
    });
});

describe('room assignment for wall-mounted devices', () => {
    it('assigns a point sitting exactly on the wall line to that room', () => {
        const plan = makePlan();
        // A flush wall mount, dead on the polygon boundary. Ray casting may call
        // this inside or outside depending on which edge it lands on; either is
        // fine, what matters is that it resolves to the right room instead of null.
        const match = findRoomForPoint({ x: 0, y: 100 }, plan.rooms);

        expect(match).not.toBeNull();
        expect(match!.room.id).toBe('room_left');
    });

    it('assigns a point just outside the wall line to the room it serves', () => {
        const plan = makePlan();
        // Snapped slightly past the wall centreline, as happens when the device
        // footprint is centred on a 230mm wall. Strictly outside the polygon.
        const match = findRoomForPoint({ x: -6, y: 100 }, plan.rooms);

        expect(match).not.toBeNull();
        expect(match!.room.id).toBe('room_left');
        expect(match!.containment).toBe('on_boundary');
    });

    it('assigns every wall-mount candidate to the room it came from', () => {
        const plan = makePlan();
        const left = plan.rooms[0];

        for (const candidate of getWallMountCandidates(left, plan.walls, 3)) {
            const match = findRoomForPoint(candidate.position, plan.rooms);
            expect(match, `no room for ${JSON.stringify(candidate.position)}`).not.toBeNull();
        }
    });

    it('still prefers strict containment over a nearby room', () => {
        const plan = makePlan();
        const inside = { x: 100, y: 100 };

        const match = findRoomForPoint(inside, plan.rooms);
        expect(match!.room.id).toBe('room_left');
        expect(match!.containment).toBe('inside');
    });

    it('returns null for a point outside the building', () => {
        const plan = makePlan();
        expect(findRoomForPoint({ x: -500, y: -500 }, plan.rooms)).toBeNull();
    });

    it('picks the smaller room when polygons overlap', () => {
        const plan = makePlan();
        // Detection does produce overlapping and merged polygons; the smaller one
        // is the more specific answer.
        plan.rooms.push(room('room_overlap', 'OVERLAP', [[80, 80], [130, 80], [130, 130], [80, 130]]));

        const match = findRoomForPoint({ x: 105, y: 105 }, plan.rooms);
        expect(match!.room.id).toBe('room_overlap');
    });
});

describe('wall-seating check', () => {
    it('flags a 5A board hand-placed mid-room as floating', () => {
        const plan = makePlan();
        // The observed defect: (800,255)-style hand coordinates dodge crowding
        // but land far from any wall line. Here, dead centre of LEFT.
        const check = checkWallSeating({ x: 100, y: 100 }, 'avg_5a_switch_board', plan.walls, 50);

        expect(check.seated).toBe(false);
        expect(check.distancePx).toBeGreaterThan(check.allowedPx);
    });

    it('accepts the same board seated by the seating logic', () => {
        const plan = makePlan();
        const partition = plan.walls.find(w => w.id === 'w_partition')!;
        const seated = orientComponentOnWall(
            'avg_5a_switch_board',
            { x: 200, y: 100 },
            partition,
            { roomInterior: { x: 100, y: 100 }, pixelsPerMeter: 50 }
        );

        const check = checkWallSeating(seated.position, 'avg_5a_switch_board', plan.walls, 50);
        expect(check.seated).toBe(true);
    });

    it('accepts a perpendicular bulb and a centred DB', () => {
        const plan = makePlan();
        const top = plan.walls.find(w => w.id === 'w_top_left')!;
        const bulb = orientComponentOnWall(
            'bulb',
            { x: 100, y: 0 },
            top,
            { roomInterior: { x: 100, y: 100 }, pixelsPerMeter: 50 }
        );

        expect(checkWallSeating(bulb.position, 'bulb', plan.walls, 50).seated).toBe(true);
        // Centred types (DBs, switches) live on the centreline itself.
        expect(checkWallSeating({ x: 100, y: 0 }, 'spn_db', plan.walls, 50).seated).toBe(true);
    });

    it('passes through when the plan has no walls to judge against', () => {
        const check = checkWallSeating({ x: 100, y: 100 }, 'bulb', [], 50);

        expect(check.seated).toBe(true);
        expect(check.wallId).toBeNull();
    });
});

describe('switch-board opening clearance', () => {
    // Door centred at (200,100), width 40, on the x=200 partition wall.
    const planWithDoor = () => {
        const plan = makePlan();
        plan.doors = [{
            id: 'd1', position: { x: 200, y: 100 }, width: 40,
            wallId: 'w_partition', rotation: 90, type: 'single'
        }];
        return plan;
    };

    it('covers switch boards and distribution boards, nothing else', () => {
        expect(needsOpeningClearance('point_switch_board')).toBe(true);
        expect(needsOpeningClearance('avg_5a_switch_board')).toBe(true);
        expect(needsOpeningClearance('spn_db')).toBe(true);
        expect(needsOpeningClearance('htpn_db')).toBe(true);
        expect(needsOpeningClearance('vtpn_db')).toBe(true);
        expect(needsOpeningClearance('tube_light')).toBe(false);
        expect(needsOpeningClearance('bulb')).toBe(false);
        expect(needsOpeningClearance('ac_point')).toBe(false);
    });

    it('flags a board centred on a door span', () => {
        const plan = planWithDoor();
        const partition = plan.walls.find(w => w.id === 'w_partition')!;
        // Seated on the LEFT face of the partition, dead level with the door.
        const check = checkOpeningClearance({ x: 186, y: 100 }, partition, planOpenings(plan), 7);

        expect(check.clear).toBe(false);
        expect(check.kind).toBe('door');
        expect(check.gapPx).toBeLessThan(0);
    });

    it('slides the board along the wall until clear, keeping its wall offset', () => {
        const plan = planWithDoor();
        const partition = plan.walls.find(w => w.id === 'w_partition')!;
        const moved = slideClearOfOpenings({ x: 186, y: 100 }, partition, planOpenings(plan), 7);

        // Perpendicular seating offset untouched; only the along-wall coord moves.
        expect(moved.x).toBe(186);
        const after = checkOpeningClearance(moved, partition, planOpenings(plan), 7);
        expect(after.clear).toBe(true);
        // Door half (20) + board half (7) + margin (10) = nearest clear edge.
        expect(Math.abs(moved.y - 100)).toBe(37);
    });

    it('leaves an already-clear board exactly where it is', () => {
        const plan = planWithDoor();
        const partition = plan.walls.find(w => w.id === 'w_partition')!;
        const moved = slideClearOfOpenings({ x: 186, y: 160 }, partition, planOpenings(plan), 7);

        expect(moved).toEqual({ x: 186, y: 160 });
    });

    it('clears a wide distribution board fully off the span', () => {
        const plan = planWithDoor();
        const partition = plan.walls.find(w => w.id === 'w_partition')!;
        // SPN DB centred on the wall line, dead level with the door, half-width
        // 62px as at a real calibration (min display pixels hide this at 50ppm).
        const check = checkOpeningClearance({ x: 200, y: 100 }, partition, planOpenings(plan), 62);
        expect(check.clear).toBe(false);

        const moved = slideClearOfOpenings({ x: 200, y: 100 }, partition, planOpenings(plan), 62);
        expect(checkOpeningClearance(moved, partition, planOpenings(plan), 62).clear).toBe(true);
        // Door half (20) + DB half (62) + margin (10) = nearest clear edge.
        expect(Math.abs(moved.y - 100)).toBe(92);
        expect(moved.x).toBe(200);
    });

    it('ignores openings on other walls', () => {
        const plan = planWithDoor();
        plan.windows = [{
            id: 'win1', position: { x: 100, y: 0 }, width: 60, height: 20,
            wallId: 'w_top_left'
        }];
        const partition = plan.walls.find(w => w.id === 'w_partition')!;
        // Same overlapped point as the door test — the far window must not matter,
        // and with no door it must read clear.
        const planNoDoor = makePlan();
        planNoDoor.windows = plan.windows;
        const check = checkOpeningClearance({ x: 186, y: 100 }, partition, planOpenings(planNoDoor), 7);

        expect(check.clear).toBe(true);
    });
});
