// LayoutAgentTools — the Layout Designer half of the agent's tool surface.
//
// The SLD side already had tools (see ChatService). The Layout side had none, so
// an agent could design a schematic but could not place a single light on a floor
// plan. These tools close that gap.
//
// Design decisions worth knowing:
//
//  - Tools talk to the Zustand stores directly via `getState()` rather than
//    through injected callbacks. The stores are the same ones the UI mutates, so
//    agent edits land in undo history, trigger the Layout→SLD sync effects, and
//    are immediately visible and editable by hand. That is what makes "stop the
//    agent and continue manually" work at any moment.
//
//  - Geometry questions are answered by PlacementGeometry, not by the model.
//    The agent chooses *which* room and *how many* fittings; it asks for
//    concrete coordinates. Polygon maths performed by an LLM puts lights outside
//    rooms and boards in mid-air.
//
//  - Every write tool returns the resulting ids. The agent needs them to connect
//    things afterwards, and returning them avoids a re-read round trip.
//
//  - Tool results are deliberately compact. A 5-room flat has ~60 components;
//    echoing full objects for each would swamp the context window.

import { useLayoutStore } from '../store/useLayoutStore';
import { useStore } from '../store/useStore';
import {
    FloorPlan,
    LayoutComponent,
    LayoutComponentType,
    RoomType,
    Point
} from '../types/layout';
import {
    LAYOUT_COMPONENT_DEFINITIONS,
    getScaledComponentSize
} from '../utils/LayoutComponentDefinitions';
import { LAYOUT_TO_SLD_MAP } from '../utils/ComponentMapping';
import { ApplicationSettings } from '../utils/ApplicationSettings';
import { applyAutoArrange } from '../utils/AutoArrange';
import {
    summarizeRoomGeometry,
    distributeCeilingPoints,
    getWallMountCandidates,
    getExternalWallMountCandidates,
    getRoomDoorAdjacencies,
    getRoomInteriorPoint,
    findRoomForPoint,
    findFreePosition,
    snapToNearestWall,
    orientComponentOnWall,
    needsWallSeating,
    checkWallSeating,
    planOpenings,
    checkOpeningClearance,
    slideClearOfOpenings,
    needsOpeningClearance,
    getRoomAreaSqm,
    checkCeilingFeasibility,
    getCeilingFanClearancePx,
    getCeilingFanRadiusPx,
    recommendedCeilingFanCount
} from '../utils/PlacementGeometry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolError = { error: string };

const layout = () => useLayoutStore.getState();
const sld = () => useStore.getState();

const round = (n: number) => Math.round(n * 10) / 10;
const roundPoint = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) });
const normAngle = (deg: number): number => ((deg % 360) + 360) % 360;

function requirePlan(planId?: string): FloorPlan | ToolError {
    const state = layout();
    const plan = planId
        ? state.floorPlans.find(p => p.id === planId)
        : state.getCurrentFloorPlan();

    if (!plan) {
        return {
            error: planId
                ? `Floor plan not found: ${planId}`
                : 'No active floor plan. Ask the user to upload a floor plan first, or call layout_list_floor_plans.'
        };
    }
    return plan;
}

function isError<T>(v: T | ToolError): v is ToolError {
    return !!v && typeof v === 'object' && 'error' in (v as any);
}

/** Resolve a possibly-abbreviated id against a list of known ids. */
function resolveId(query: string, ids: string[], label: string): { id: string } | ToolError {
    const q = (query || '').trim();
    if (!q) return { error: `${label} is required.` };
    if (ids.includes(q)) return { id: q };

    const matches = ids.filter(id => id.startsWith(q));
    if (matches.length === 1) return { id: matches[0] };
    if (matches.length === 0) return { error: `${label} not found: ${q}` };
    return { error: `Ambiguous ${label} prefix "${q}" matches ${matches.length} items.` };
}

const isValidComponentType = (t: string): t is LayoutComponentType =>
    Object.prototype.hasOwnProperty.call(LAYOUT_COMPONENT_DEFINITIONS, t);

// ---------------------------------------------------------------------------
// Public tool surface
// ---------------------------------------------------------------------------

export interface PlaceComponentArgs {
    type: string;
    x?: number;
    y?: number;
    roomId?: string;
    /**
     * 'center' | 'wall' | 'external_wall' | 'beside_door' — resolved against the
     * room when x/y are omitted. 'external_wall' restricts to boundary walls and
     * is forced automatically for ac_point and exhaust_fan.
     */
    anchor?: 'center' | 'wall' | 'external_wall' | 'beside_door';
    rotation?: number;
    /**
     * Snap onto the nearest wall and seat the fitting. Defaults to true for
     * wall-mounted types. Bulbs seat perpendicular (base on the wall face,
     * globe into the room); tube_lights and both switch boards seat parallel,
     * offset so the base touches the wall face; AC and geyser points seat
     * parallel, sunk slightly into the room-side wall face with labels upright.
     * Seating owns rotation unconditionally for these types — an explicit
     * rotation is ignored (reported back as rotationNote). Omit rotation.
     */
    snapToWall?: boolean;
    label?: string;
    wattage?: number;
    properties?: Record<string, string>;
    planId?: string;
}

export class LayoutAgentTools {

    // =======================================================================
    // READ TOOLS
    // =======================================================================

    /**
     * All floor plans in the project, with calibration status.
     *
     * Calibration is surfaced prominently because every area-driven decision
     * (how many lights for 12 m²) is meaningless on an uncalibrated plan, and
     * the agent should refuse to guess rather than produce confident nonsense.
     */
    listFloorPlans(): any {
        const state = layout();
        return {
            activeFloorPlanId: state.activeFloorPlanId,
            count: state.floorPlans.length,
            floorPlans: state.floorPlans.map(p => ({
                id: p.id,
                name: p.name,
                isActive: p.id === state.activeFloorPlanId,
                widthPx: p.width,
                heightPx: p.height,
                pixelsPerMeter: round(p.pixelsPerMeter || 50),
                measurementUnit: p.measurementUnit || 'm',
                isScaleCalibrated: Boolean(p.isScaleCalibrated),
                hasBackgroundImage: Boolean(p.backgroundImageId),
                counts: {
                    walls: p.walls.length,
                    rooms: p.rooms.length,
                    doors: p.doors.length,
                    windows: p.windows.length,
                    components: p.components.length,
                    connections: p.connections.length
                }
            }))
        };
    }

    setActiveFloorPlan(planId: string): any {
        const state = layout();
        const ids = state.floorPlans.map(p => p.id);
        const resolved = resolveId(planId, ids, 'planId');
        if (isError(resolved)) return resolved;

        state.setActiveFloorPlan(resolved.id);
        return { success: true, activeFloorPlanId: resolved.id };
    }

    /**
     * Room-by-room geometry for a plan: real areas, wall sides, doors, windows.
     *
     * This is the agent's main view of the building and is intended to be read
     * once per plan before placing anything.
     */
    getPlanGeometry(planId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const rooms = summarizeRoomGeometry(plan);
        const totalAreaSqm = rooms.reduce((sum, r) => sum + r.areaSqm, 0);

        return {
            planId: plan.id,
            name: plan.name,
            pixelsPerMeter: round(plan.pixelsPerMeter || 50),
            measurementUnit: plan.measurementUnit || 'm',
            isScaleCalibrated: Boolean(plan.isScaleCalibrated),
            ...(plan.isScaleCalibrated ? {} : {
                calibrationWarning:
                    'Scale is NOT calibrated. Areas below are derived from the default 50 px/m and may be wrong. ' +
                    'Ask the user to calibrate before sizing circuits by area.'
            }),
            canvas: { widthPx: plan.width, heightPx: plan.height },
            roomCount: rooms.length,
            totalAreaSqm: round(totalAreaSqm),
            wallCount: plan.walls.length,
            unassignedComponentCount: plan.components.filter(c => !c.roomId).length,
            rooms
        };
    }

    /** Components already placed on a plan. */
    getPlacedComponents(planId?: string, roomId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const roomNameById = new Map(plan.rooms.map(r => [r.id, r.name || 'Unnamed']));
        let components = plan.components;
        if (roomId) components = components.filter(c => c.roomId === roomId);

        return {
            planId: plan.id,
            count: components.length,
            components: components.map(c => {
                const def = LAYOUT_COMPONENT_DEFINITIONS[c.type];
                return {
                    id: c.id,
                    type: c.type,
                    name: c.properties?.name || def?.name || c.type,
                    position: roundPoint(c.position),
                    rotation: Math.round(c.rotation || 0),
                    roomId: c.roomId || null,
                    roomName: c.roomId ? (roomNameById.get(c.roomId) || null) : null,
                    wattage: Number(c.properties?.wattage ?? def?.defaultWattage ?? 0),
                    sldItemId: c.sldItemId || null,
                    category: def?.category || 'unknown'
                };
            }),
            connections: plan.connections.map(conn => ({
                id: conn.id,
                sourceId: conn.sourceId,
                targetId: conn.targetId,
                type: conn.type
            })),
            texts: (plan.textItems || []).map(t => ({
                id: t.id,
                text: t.text,
                position: roundPoint(t.position)
            }))
        };
    }

    /**
     * The Layout component library.
     *
     * Includes each type's category, physical size, default wattage, intended
     * mounting surface and SLD counterpart, so the agent picks real types rather
     * than inventing names, and knows which items are ceiling vs wall mounted.
     */
    getComponentCatalog(): any {
        return {
            count: Object.keys(LAYOUT_COMPONENT_DEFINITIONS).length,
            components: Object.values(LAYOUT_COMPONENT_DEFINITIONS).map(def => ({
                type: def.type,
                name: def.name,
                category: def.category,
                placementType: def.placementType || 'any',
                defaultWattage: def.defaultWattage ?? 0,
                realSizeMm: def.realSizeMm,
                sldEquivalent: def.sldEquivalent || LAYOUT_TO_SLD_MAP[def.type] || null,
                description: def.description || ''
            }))
        };
    }

    /**
     * Concrete coordinates for a placement intent.
     *
     * `purpose` selects the strategy:
     *   ceiling       — evenly distributed interior points. Ceiling fans only.
     *   wall          — points along the room's bounding walls (lights, boards)
     *   external_wall — points on boundary walls only (AC points, exhaust fans)
     *   beside_door   — next to each door, the conventional switch board spot
     *
     * Lights use `wall`, not `ceiling`: Indian domestic practice mounts both
     * battens and bulbs on walls. See agent/skills/load-placement.md Section 2.1.
     *
     * `count` is honoured where the geometry allows; fewer points are returned
     * for rooms that cannot fit them, which is information the agent should use
     * rather than forcing overlaps.
     */
    suggestPositions(args: {
        roomId: string;
        purpose?: 'ceiling' | 'wall' | 'external_wall' | 'beside_door';
        count?: number;
        planId?: string;
    }): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const resolved = resolveId(args.roomId, plan.rooms.map(r => r.id), 'roomId');
        if (isError(resolved)) return resolved;

        const room = plan.rooms.find(r => r.id === resolved.id)!;
        // Default is 'wall', not 'ceiling': almost everything in the catalog is
        // wall mounted now that lights are, so an omitted purpose should fall
        // back to the common case rather than stranding a fitting mid-room.
        const purpose = args.purpose || 'wall';
        const count = Math.max(1, Math.min(24, Math.floor(args.count ?? 1)));
        const existing = plan.components;

        if (purpose === 'beside_door') {
            const doors = getRoomDoorAdjacencies(plan, room);
            return {
                roomId: room.id,
                roomName: room.name,
                purpose,
                positions: doors.slice(0, count).map(d => ({
                    position: roundPoint(findFreePosition(d.besideDoor, existing, 24)),
                    reason: `Beside door ${d.doorId.slice(0, 12)}`
                })),
                ...(doors.length === 0 ? {
                    note: 'No doors border this room. Use purpose="wall" instead.'
                } : {})
            };
        }

        if (purpose === 'wall' || purpose === 'external_wall') {
            const externalOnly = purpose === 'external_wall';
            const candidates = externalOnly
                ? getExternalWallMountCandidates(room, plan, 3)
                : getWallMountCandidates(room, plan.walls, 3);
            if (candidates.length === 0) {
                return {
                    roomId: room.id,
                    roomName: room.name,
                    purpose,
                    positions: [],
                    note: 'No walls detected bordering this room. Place by explicit coordinates, and tell the user the wall detection looks wrong.'
                };
            }
            const noExternal = externalOnly && candidates.some(c => c.reason.includes('no external wall found'));
            return {
                roomId: room.id,
                roomName: room.name,
                purpose,
                positions: candidates.slice(0, count).map(c => ({
                    position: roundPoint(findFreePosition(c.position, existing, 24, undefined)),
                    reason: c.reason
                })),
                ...(noExternal ? {
                    note: 'This room borders no external wall, so these points are on partition walls. An AC point or exhaust fan here needs a duct/pipe run — tell the user rather than placing it silently.'
                } : {})
            };
        }

        const ppm = plan.pixelsPerMeter || 50;
        const fanOpts = {
            pixelsPerMeter: ppm,
            doors: plan.doors.map(d => ({ position: d.position })),
            windows: plan.windows.map(w => ({ position: w.position }))
        };
        const fanClearance = getCeilingFanClearancePx(ppm);
        // Two fan sweeps must not overlap each other.
        const fanGap = Math.max(28, getCeilingFanRadiusPx(ppm) * 2);
        const points = distributeCeilingPoints(room, count, fanOpts);
        const positions = points.map((p, i) => {
            const free = findFreePosition(p, existing, fanGap, room, fanClearance);
            const check = checkCeilingFeasibility(free, room, fanOpts);
            return {
                position: roundPoint(free),
                reason: (points.length > 1
                    ? `Fan zone ${i + 1} of ${points.length} along room long axis (symmetric layout)`
                    : 'Room centre (symmetric layout)') +
                    (check.feasible ? '' : ` [WARNING: fan sweep overlaps ${check.issues.join('; ')}]`)
            };
        });
        const infeasibleCount = positions.filter(pos => pos.reason.includes('[WARNING')).length;
        const areaSqm = round(getRoomAreaSqm(room, plan.pixelsPerMeter || 50));
        // Skill-derived default quantity. Agents under-count from qualitative
        // caution ("safest: 1 fan") — e.g. a 26.8 m² lobby got 1 fan when the
        // table says 2 above 22 m². Flag the shortfall so it gets corrected.
        const recommendedCount = recommendedCeilingFanCount(room.type, areaSqm);
        return {
            roomId: room.id,
            roomName: room.name,
            purpose: 'ceiling',
            requestedCount: count,
            returnedCount: points.length,
            areaSqm,
            recommendedCount,
            positions,
            note: 'Ceiling positions are for ceiling_fan_point only. Lights (bulb, tube_light) are wall mounted — use purpose="wall".',
            ...(recommendedCount > count ? {
                quantityNote: `This ${areaSqm} m² ${room.type} room defaults to ${recommendedCount} fan(s) per the placement skill ` +
                    `(living_room: 2 above 22 m²; bedroom: 2 above 20 m²), but only ${count} were requested. ` +
                    `You have coordinate and quantity authority: re-request with count=${recommendedCount}, or keep fewer and state your reason ` +
                    `(e.g. AC-first room, furniture zones) — but resolve this deliberately, never silently.`
            } : {}),
            ...(points.length < count ? {
                geometryNote: `Room geometry only fits ${points.length} full ${Math.round(getCeilingFanRadiusPx(ppm) * 2)}px fan sweep(s) with wall/door/window clearance; requested ${count}. ` +
                    `Do not force more fans here — split the detected room or ask the user to fix the wall detection.`
            } : {}),
            ...(infeasibleCount > 0 ? {
                placementWarning: `${infeasibleCount} position(s) cannot fit a full fan sweep clear of walls/doors/windows. ` +
                    `Verify on the annotated overlay and drag clear, or fix the room detection — never leave a fan overlapping a wall, door or window.`
            } : {})
        };
    }

    /**
     * Several position requests in one call.
     *
     * `layout_suggest_positions` was by far the most-called tool in an observed
     * run — 37 of 158 calls — and each one cost a full model round trip because
     * the agent needs the coordinates before it can decide anything. Asking for
     * every purpose in a room, or every room's switch-board point, in one call
     * removes most of that latency without changing how the agent reasons.
     *
     * Each request is resolved independently so one bad roomId does not lose the
     * rest of the batch.
     */
    suggestPositionsBatch(
        requests: Array<{ roomId: string; purpose?: 'ceiling' | 'wall' | 'external_wall' | 'beside_door'; count?: number }>,
        planId?: string
    ): any {
        if (!Array.isArray(requests) || requests.length === 0) {
            return { error: 'requests must be a non-empty array of { roomId, purpose, count }.' };
        }
        if (requests.length > 40) {
            return { error: `Too many requests in one call (${requests.length}). Split into batches of 40 or fewer.` };
        }

        const results = requests.map(req => {
            const res = this.suggestPositions({ ...req, planId });
            return isError(res)
                ? { roomId: req.roomId, purpose: req.purpose ?? 'wall', error: res.error }
                : res;
        });

        return {
            success: results.every(r => !('error' in r)),
            count: results.length,
            results
        };
    }

    // =======================================================================
    // WRITE TOOLS
    // =======================================================================

    /**
     * Place one component.
     *
     * Position resolution order:
     *   1. explicit x/y
     *   2. roomId + anchor strategy
     *   3. error — we never silently drop a component at (0,0)
     *
     * Wall-mounted types snap to the nearest wall unless the caller opts out,
     * matching what happens when a human places them. Bulbs seat perpendicular
     * (base on the wall face, globe into the served room); tube_lights and both
     * switch boards seat parallel, offset so the base touches the wall face;
     * AC and geyser points seat parallel, sunk slightly into the room-side wall
     * face with labels upright — all read as belonging to that room. Seating
     * owns rotation unconditionally for these types: an explicit rotation is
     * ignored (reported back as rotationNote), so omit it.
     */
    placeComponent(args: PlaceComponentArgs): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        if (!args.type || !isValidComponentType(args.type)) {
            return {
                error: `Unknown component type "${args.type}". Call layout_get_component_catalog for valid types.`
            };
        }

        const def = LAYOUT_COMPONENT_DEFINITIONS[args.type];

        // ---------------------------------------------------------------
        // Placement guards — enforce physical constraints the LLM may ignore
        // ---------------------------------------------------------------

        // Ceiling-only items (ceiling fans) must never snap to walls.
        // Note: bulb and tube_light are placementType 'wall' — Indian domestic
        // practice mounts both on walls, so they are deliberately not here.
        if (def.placementType === 'ceiling') {
            if (args.anchor === 'wall' || args.snapToWall === true) {
                args.anchor = 'center';
                args.snapToWall = false;
            }
        }

        // AC points and exhaust fans MUST go on external (boundary) walls,
        // never on internal partition walls — the refrigerant pipes, condensate
        // drain and vent all have to reach outdoors. Override the anchor so the
        // external-wall candidate logic is used below.
        const requiresExternalWall = args.type === 'ac_point' || args.type === 'exhaust_fan';
        const hasExplicitPosition = typeof args.x === 'number' && typeof args.y === 'number';
        if (requiresExternalWall && !hasExplicitPosition) {
            args.anchor = 'external_wall';   // boundary walls only
            args.snapToWall = true;
        }
        const state = layout();

        // Make sure writes land on the plan the caller named.
        if (args.planId && state.activeFloorPlanId !== plan.id) {
            state.setActiveFloorPlan(plan.id);
        }

        let position: Point | null = null;
        let room = args.roomId ? plan.rooms.find(r => r.id === args.roomId || r.id.startsWith(args.roomId!)) : undefined;

        if (typeof args.x === 'number' && typeof args.y === 'number') {
            position = { x: args.x, y: args.y };
        } else if (room) {
            const anchor = args.anchor || (def.placementType === 'wall' ? 'wall' : 'center');
            if (anchor === 'beside_door') {
                const doors = getRoomDoorAdjacencies(plan, room);
                position = doors[0]?.besideDoor ?? null;
                if (!position) {
                    const walls = getWallMountCandidates(room, plan.walls, 1);
                    position = walls[0]?.position ?? getRoomInteriorPoint(room);
                }
            } else if (anchor === 'wall' || anchor === 'external_wall') {
                // AC points and exhaust fans must go on external (boundary) walls
                const useExternal = anchor === 'external_wall' || requiresExternalWall;
                const walls = useExternal
                    ? getExternalWallMountCandidates(room, plan, 1)
                    : getWallMountCandidates(room, plan.walls, 1);
                position = walls[0]?.position ?? getRoomInteriorPoint(room);
            } else {
                position = getRoomInteriorPoint(room);
            }
        }

        if (!position) {
            return {
                error: 'Provide either x/y coordinates or a roomId. Use layout_suggest_positions to get coordinates.'
            };
        }

        // Keep symbols from stacking on top of each other. A ceiling fan's
        // 1200 mm sweep must clear neighbouring symbols entirely, and
        // de-collision must never shove it into a wall, so ceiling types use
        // the full sweep diameter as the gap plus the wall clearance.
        const isCeilingType = def.placementType === 'ceiling';
        const ppm = plan.pixelsPerMeter || 50;
        const minGap = isCeilingType
            ? Math.max(28, getCeilingFanRadiusPx(ppm) * 2)
            : Math.max(20, Math.min(40, getScaledComponentSize(args.type, ppm).width));
        const edgeClearance = isCeilingType ? getCeilingFanClearancePx(ppm) : 0;
        position = findFreePosition(position, plan.components, minGap, room, edgeClearance);

        let rotation = args.rotation ?? 0;
        let rotationNote: string | undefined;
        const shouldSnap = args.snapToWall ?? (def.placementType === 'wall');
        if (shouldSnap) {
            const preSnap = { ...position };
            const snap = snapToNearestWall(position, plan.walls, 60);
            if (snap) {
                const wall = plan.walls.find(w => w.id === snap.wallId);
                // Room-side fittings seat off the wall face toward the served
                // room (lights/boards face it; AC/geyser sink into it upright)
                // instead of straddling inside the wall body. Seating owns the
                // rotation unconditionally — asymmetric icons make any hand
                // angle near-certainly wrong (observed: blanket rotation 0 left
                // point-board bases off the wall; nudging fixed them only
                // because drag re-seats).
                if (wall && needsWallSeating(args.type)) {
                    const interiorRoom = room ?? findRoomForPoint(preSnap, plan.rooms)?.room
                        ?? findRoomForPoint(snap.position, plan.rooms)?.room;
                    const oriented = orientComponentOnWall(args.type, snap.position, wall, {
                        roomInterior: interiorRoom ? getRoomInteriorPoint(interiorRoom) : null,
                        approach: { x: preSnap.x - snap.position.x, y: preSnap.y - snap.position.y },
                        pixelsPerMeter: plan.pixelsPerMeter || 50
                    });
                    position = oriented.position;
                    rotation = oriented.rotation;
                    if (args.rotation !== undefined &&
                        Math.round(normAngle(args.rotation)) !== Math.round(normAngle(oriented.rotation))) {
                        rotationNote = `Explicit rotation ${args.rotation}° ignored for ${args.type}; wall seating sets orientation automatically. Omit rotation for this type.`;
                    }
                } else {
                    position = snap.position;
                    if (args.rotation === undefined) rotation = snap.rotation;
                }
                // Switch boards and distribution boards must sit on clear wall
                // spans, never over a door/window opening — slide along the wall
                // until clear. Runs for seated and flush-centred types alike; the
                // slide only changes the along-wall coordinate, never the
                // seating offset or rotation.
                if (wall && needsOpeningClearance(args.type)) {
                    const size = getScaledComponentSize(args.type, plan.pixelsPerMeter || 50);
                    position = slideClearOfOpenings(position, wall, planOpenings(plan), size.width / 2);
                }
            }
        }

        const properties: Record<string, string> = { ...(args.properties || {}) };
        if (args.label) properties.name = args.label;
        if (typeof args.wattage === 'number') properties.wattage = String(args.wattage);

        // Room assignment tolerates a point sitting exactly on the wall line.
        // A strict containment test rejected every wall-mounted device — the
        // switch boards, AC points and lights all came back roomId: null, which
        // drops them from per-room load totals and makes layout_validate report
        // them as floating outside the building.
        const roomMatch = room
            ? { room, containment: 'inside' as const }
            : findRoomForPoint(position, plan.rooms);
        const resolvedRoom = roomMatch?.room;

        // The agent has coordinate authority and may place by its own numbers
        // (image reading, inscribed-rectangle arithmetic). The safety net is
        // validation: a ceiling fan outside every detected room is never
        // legitimate, so refuse it outright instead of filing it as unassigned.
        // Wall-mounted types stay lenient (warning below) — they sit on the
        // polygon boundary by design, where detection slack applies.
        if (isCeilingType && !findRoomForPoint(position, plan.rooms)) {
            return {
                error: `Ceiling fan at (${Math.round(position.x)}, ${Math.round(position.y)}) is outside every detected room. ` +
                    `Recompute inside the room's wall lines (centre of the largest inscribed rectangle is the default) ` +
                    `or ask the user to fix the room detection — it was not placed.`
            };
        }

        // Ceiling fans must never overlap a wall, door or window: the sweep
        // circle has to fit whole. Report it so the agent drags the fan clear
        // (or fixes the detection) instead of leaving an overlap.
        let placementWarning: string | undefined;
        if (isCeilingType && resolvedRoom) {
            const check = checkCeilingFeasibility(position, resolvedRoom, {
                pixelsPerMeter: ppm,
                doors: plan.doors.map(d => ({ position: d.position })),
                windows: plan.windows.map(w => ({ position: w.position }))
            });
            if (!check.feasible) {
                placementWarning = `Fan sweep overlaps ${check.issues.join('; ')}. ` +
                    `Move it clear with layout_update_component and verify on the overlay — no fan may overlap a wall, door or window.`;
            }
        }

        const id = state.addComponent({
            type: args.type,
            position,
            rotation,
            properties,
            roomId: resolvedRoom?.id
        });

        return {
            success: true,
            id,
            type: args.type,
            name: properties.name || def.name,
            position: roundPoint(position),
            rotation: Math.round(rotation),
            roomId: resolvedRoom?.id || null,
            roomName: resolvedRoom?.name || null,
            snappedToWall: shouldSnap,
            ...(placementWarning ? { placementWarning } : {}),
            ...(rotationNote ? { rotationNote } : {}),
            ...(resolvedRoom
                ? {}
                : { warning: 'This position is not inside or adjacent to any detected room, so it will not appear in per-room load totals. Use layout_suggest_positions for this room.' })
        };
    }

    /**
     * Place many components in one call.
     *
     * Batching matters here: a two-bedroom flat needs 40-60 fittings, and one
     * tool call each would exhaust the turn limit and the user's patience. Each
     * entry is resolved independently so a single bad entry does not lose the
     * rest of the batch.
     */
    placeComponents(components: PlaceComponentArgs[], planId?: string): any {
        if (!Array.isArray(components) || components.length === 0) {
            return { error: 'components must be a non-empty array.' };
        }
        if (components.length > 120) {
            return { error: `Too many components in one call (${components.length}). Split into batches of 120 or fewer.` };
        }

        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const placed: any[] = [];
        const failed: any[] = [];

        for (const spec of components) {
            const result = this.placeComponent({ ...spec, planId: planId ?? plan.id });
            if (isError(result)) {
                failed.push({ type: spec.type, roomId: spec.roomId, error: result.error });
            } else {
                placed.push({
                    id: result.id,
                    type: result.type,
                    roomId: result.roomId,
                    position: result.position
                });
            }
        }

        return {
            success: failed.length === 0,
            placedCount: placed.length,
            failedCount: failed.length,
            placed,
            ...(failed.length > 0 ? { failed } : {})
        };
    }

    updateComponent(args: {
        id: string;
        x?: number;
        y?: number;
        rotation?: number;
        label?: string;
        wattage?: number;
        properties?: Record<string, string>;
        planId?: string;
    }): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const resolved = resolveId(args.id, plan.components.map(c => c.id), 'component id');
        if (isError(resolved)) return resolved;

        const existing = plan.components.find(c => c.id === resolved.id)!;
        const updates: Partial<LayoutComponent> = {};
        let roomMatch: ReturnType<typeof findRoomForPoint> = null;
        let rotationNote: string | undefined;
        let seatingOwnedRotation = false;

        if (typeof args.x === 'number' || typeof args.y === 'number') {
            let next = {
                x: typeof args.x === 'number' ? args.x : existing.position.x,
                y: typeof args.y === 'number' ? args.y : existing.position.y
            };
            // Same hard gate as placement: a ceiling fan dragged outside every
            // room is refused before anything mutates, so the check-then-act
            // order matters here.
            if (existing.type === 'ceiling_fan_point' && !findRoomForPoint(next, plan.rooms)) {
                return {
                    error: `Ceiling fan move to (${Math.round(next.x)}, ${Math.round(next.y)}) is outside every detected room. ` +
                        `Pick a point inside the room's wall lines — it was not moved.`
                };
            }
            // Wall fittings re-seat on every move — snap, orient, opening slide —
            // owning rotation unconditionally, exactly like placement. This is
            // what makes "move it with layout_update_component (omit rotation)"
            // actually repair a misoriented board, and it keeps canvas drags
            // idempotent (they arrive pre-seated and re-seat to the same values).
            if (needsWallSeating(existing.type)) {
                const snap = snapToNearestWall(next, plan.walls, 60);
                const wall = snap ? plan.walls.find(w => w.id === snap.wallId) : undefined;
                if (snap && wall) {
                    const interiorRoom = findRoomForPoint(next, plan.rooms)?.room
                        ?? (existing.roomId ? plan.rooms.find(r => r.id === existing.roomId) : undefined);
                    const oriented = orientComponentOnWall(existing.type, snap.position, wall, {
                        roomInterior: interiorRoom ? getRoomInteriorPoint(interiorRoom) : null,
                        approach: { x: next.x - snap.position.x, y: next.y - snap.position.y },
                        pixelsPerMeter: plan.pixelsPerMeter || 50
                    });
                    next = oriented.position;
                    updates.rotation = oriented.rotation;
                    seatingOwnedRotation = true;
                    if (typeof args.rotation === 'number' &&
                        Math.round(normAngle(args.rotation)) !== Math.round(normAngle(oriented.rotation))) {
                        rotationNote = `Explicit rotation ${args.rotation}° ignored for ${existing.type}; wall seating sets orientation automatically.`;
                    }
                    if (needsOpeningClearance(existing.type)) {
                        const size = getScaledComponentSize(existing.type, plan.pixelsPerMeter || 50);
                        next = slideClearOfOpenings(next, wall, planOpenings(plan), size.width / 2);
                    }
                }
            }
            updates.position = next;
            // Keep the room link truthful after a move, otherwise per-room load
            // totals silently drift. Boundary-tolerant, because wall-mounted
            // devices sit on the polygon edge by design.
            roomMatch = findRoomForPoint(next, plan.rooms);
            updates.roomId = roomMatch?.room.id;
        }
        if (typeof args.rotation === 'number' && !seatingOwnedRotation) {
            if (needsWallSeating(existing.type)) {
                rotationNote = `Explicit rotation ${args.rotation}° ignored for ${existing.type}; wall seating sets orientation automatically. Move it to re-seat.`;
            } else {
                updates.rotation = normAngle(args.rotation);
            }
        }
        if (args.label !== undefined || args.wattage !== undefined || args.properties) {
            updates.properties = {
                ...existing.properties,
                ...(args.properties || {}),
                ...(args.label !== undefined ? { name: args.label } : {}),
                ...(args.wattage !== undefined ? { wattage: String(args.wattage) } : {})
            };
        }

        if (Object.keys(updates).length === 0) {
            return { error: 'Nothing to update. Provide x/y, rotation, label, wattage or properties.' };
        }

        const state = layout();
        state.takeSnapshot();
        state.updateComponent(resolved.id, updates);

        return {
            success: true,
            id: resolved.id,
            updated: Object.keys(updates),
            ...(rotationNote ? { rotationNote } : {}),
            ...(updates.position
                ? {
                    roomId: roomMatch?.room.id || null,
                    roomName: roomMatch?.room.name || null,
                    ...(roomMatch
                        ? {}
                        : { warning: 'The new position is not inside or adjacent to any detected room.' }),
                    ...(() => {
                        // Moving a ceiling fan onto a wall/door/window is the
                        // exact failure this guard exists for — report it.
                        if (existing.type !== 'ceiling_fan_point' || !roomMatch?.room) return {};
                        const check = checkCeilingFeasibility(updates.position!, roomMatch.room, {
                            pixelsPerMeter: plan.pixelsPerMeter || 50,
                            doors: plan.doors.map(d => ({ position: d.position })),
                            windows: plan.windows.map(w => ({ position: w.position }))
                        });
                        return check.feasible ? {} : {
                            placementWarning: `Fan sweep overlaps ${check.issues.join('; ')}. ` +
                                `Move it clear — no fan may overlap a wall, door or window.`
                        };
                    })()
                }
                : {})
        };
    }

    /**
     * Update many components in one call.
     *
     * The fix-up counterpart to placeComponents: validation findings come in
     * groups (four floaters, three unfed loads), and one call per fix burns a
     * full turn each against the 8-calls-per-turn budget. Each entry resolves
     * independently — same shape as layout_update_component — so a single bad
     * id does not lose the rest of the batch.
     */
    updateComponents(updates: Array<{
        id: string;
        x?: number;
        y?: number;
        rotation?: number;
        label?: string;
        wattage?: number;
        properties?: Record<string, string>;
    }>, planId?: string): any {
        if (!Array.isArray(updates) || updates.length === 0) {
            return { error: 'updates must be a non-empty array.' };
        }
        if (updates.length > 120) {
            return { error: `Too many updates in one call (${updates.length}). Split into batches of 120 or fewer.` };
        }

        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const updated: any[] = [];
        const failed: any[] = [];

        for (const spec of updates) {
            const result = this.updateComponent({ ...spec, planId: planId ?? plan.id });
            if (isError(result)) {
                failed.push({ id: (spec as any)?.id, error: result.error });
            } else {
                updated.push({
                    id: result.id,
                    updated: result.updated,
                    ...(result.roomId !== undefined ? { roomId: result.roomId } : {}),
                    ...(result.rotationNote ? { rotationNote: result.rotationNote } : {})
                });
            }
        }

        return {
            success: failed.length === 0,
            updatedCount: updated.length,
            failedCount: failed.length,
            updated,
            ...(failed.length > 0 ? { failed } : {})
        };
    }

    deleteComponent(id: string, planId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const resolved = resolveId(id, plan.components.map(c => c.id), 'component id');
        if (isError(resolved)) return resolved;

        // removeComponent also deletes the linked SLD item, keeping the two
        // views in agreement.
        layout().removeComponent(resolved.id);
        return { success: true, deletedId: resolved.id };
    }

    /**
     * Add a free text label to the floor plan (room names, area tags, notes).
     *
     * Position from explicit x/y, else the interior point of roomId. Unlike
     * components, text never snaps to walls and never enters load totals.
     */
    addText(args: {
        text: string;
        x?: number;
        y?: number;
        roomId?: string;
        fontSize?: number;
        color?: string;
        planId?: string;
    }): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const text = (args.text || '').trim();
        if (!text) return { error: 'text is required.' };

        let position: Point | null = null;
        if (typeof args.x === 'number' && typeof args.y === 'number') {
            position = { x: args.x, y: args.y };
        } else if (args.roomId) {
            const room = plan.rooms.find(r => r.id === args.roomId || r.id.startsWith(args.roomId!));
            if (!room) return { error: `Room not found: ${args.roomId}` };
            position = getRoomInteriorPoint(room);
        }
        if (!position) {
            return { error: 'Provide either x/y coordinates or a roomId.' };
        }

        const state = layout();
        if (args.planId && state.activeFloorPlanId !== plan.id) {
            state.setActiveFloorPlan(plan.id);
        }

        const id = state.addTextItem({
            text,
            position,
            fontSize: typeof args.fontSize === 'number' && args.fontSize > 0 ? Math.round(args.fontSize) : 14,
            fontFamily: 'Arial',
            color: args.color || '#000000',
            align: 'left',
            width: 100
        });

        return { success: true, id, text, position: roundPoint(position) };
    }

    /**
     * Edit a floor-plan text label's content, position or styling.
     */
    updateText(args: {
        id: string;
        text?: string;
        x?: number;
        y?: number;
        fontSize?: number;
        color?: string;
        planId?: string;
    }): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const texts = plan.textItems || [];
        const resolved = resolveId(args.id, texts.map(t => t.id), 'text id');
        if (isError(resolved)) return resolved;

        const existing = texts.find(t => t.id === resolved.id)!;
        const updates: Record<string, any> = {};
        if (args.text !== undefined) {
            if (!args.text.trim()) return { error: 'text must not be empty. Delete the label instead.' };
            updates.text = args.text;
        }
        if (typeof args.x === 'number' || typeof args.y === 'number') {
            updates.position = {
                x: typeof args.x === 'number' ? args.x : existing.position.x,
                y: typeof args.y === 'number' ? args.y : existing.position.y
            };
        }
        if (typeof args.fontSize === 'number') {
            if (args.fontSize <= 0) return { error: 'fontSize must be positive.' };
            updates.fontSize = Math.round(args.fontSize);
        }
        if (args.color !== undefined) updates.color = args.color;

        if (Object.keys(updates).length === 0) {
            return { error: 'Nothing to update. Provide text, x/y, fontSize or color.' };
        }

        const state = layout();
        state.takeSnapshot();
        state.updateTextItem(resolved.id, updates);

        return { success: true, id: resolved.id, updated: Object.keys(updates) };
    }

    /**
     * Delete a floor-plan text label.
     */
    deleteText(id: string, planId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const resolved = resolveId(id, (plan.textItems || []).map(t => t.id), 'text id');
        if (isError(resolved)) return resolved;

        layout().removeTextItem(resolved.id);
        return { success: true, deletedId: resolved.id };
    }

    /**
     * Name a room and set its type.
     *
     * Detected plans often produce "Room 3" with an OCR hint like "BED ROOM".
     * Letting the agent commit that interpretation makes the rest of its
     * reasoning (and its explanation to the user) legible.
     */
    setRoomInfo(args: { roomId: string; name?: string; type?: string; planId?: string }): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const resolved = resolveId(args.roomId, plan.rooms.map(r => r.id), 'roomId');
        if (isError(resolved)) return resolved;

        const validTypes: RoomType[] = [
            'bedroom', 'living_room', 'kitchen', 'bathroom', 'toilet', 'balcony',
            'corridor', 'staircase', 'utility', 'office', 'dining', 'storage',
            'pooja', 'other'
        ];

        const updates: { name?: string; type?: RoomType } = {};
        if (args.name) updates.name = args.name;
        if (args.type) {
            if (!validTypes.includes(args.type as RoomType)) {
                return { error: `Invalid room type "${args.type}". Valid: ${validTypes.join(', ')}` };
            }
            updates.type = args.type as RoomType;
        }

        if (Object.keys(updates).length === 0) {
            return { error: 'Provide name and/or type.' };
        }

        const state = layout();
        state.takeSnapshot();
        state.updateRoom(resolved.id, updates);

        return { success: true, roomId: resolved.id, ...updates };
    }

    /**
     * Name several rooms in one call.
     *
     * Naming is inherently per-room, so an agent without a batch tool here emits
     * one call per room — seven of them on a typical flat. Combined with anything
     * else in the same turn that is enough to overrun a model's output token
     * limit, truncating the reply so that *nothing* executes. Batching removes the
     * most common cause of that failure.
     */
    setRoomsInfo(
        rooms: Array<{ roomId: string; name?: string; type?: string }>,
        planId?: string
    ): any {
        if (!Array.isArray(rooms) || rooms.length === 0) {
            return { error: 'rooms must be a non-empty array of { roomId, name?, type? }.' };
        }

        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const updated: any[] = [];
        const failed: any[] = [];

        for (const entry of rooms) {
            const result = this.setRoomInfo({ ...entry, planId: planId ?? plan.id });
            if (isError(result)) {
                failed.push({ roomId: entry.roomId, error: result.error });
            } else {
                updated.push({ roomId: result.roomId, name: result.name, type: result.type });
            }
        }

        return {
            success: failed.length === 0,
            updatedCount: updated.length,
            failedCount: failed.length,
            updated,
            ...(failed.length > 0 ? { failed } : {})
        };
    }

    /**
     * Draw a physical route between two placed components on the floor plan.
     *
     * This is the conduit/wire route drawn on the plan. It is NOT the electrical
     * connection — that lives in the SLD and is created with connect_items. The
     * distinction is deliberate: the SLD is the single source of truth for
     * connectivity, and the Layout renders it as "magic wires". Use this only
     * when the user wants an explicit drawn route.
     */
    connectComponents(args: {
        sourceId: string;
        targetId: string;
        type?: 'power' | 'control' | 'data';
        planId?: string;
    }): any {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const ids = plan.components.map(c => c.id);
        const src = resolveId(args.sourceId, ids, 'sourceId');
        if (isError(src)) return src;
        const dst = resolveId(args.targetId, ids, 'targetId');
        if (isError(dst)) return dst;
        if (src.id === dst.id) return { error: 'sourceId and targetId must differ.' };

        const source = plan.components.find(c => c.id === src.id)!;
        const target = plan.components.find(c => c.id === dst.id)!;

        const duplicate = plan.connections.find(c =>
            (c.sourceId === src.id && c.targetId === dst.id) ||
            (c.sourceId === dst.id && c.targetId === src.id)
        );
        if (duplicate) {
            return { success: true, alreadyConnected: true, connectionId: duplicate.id };
        }

        layout().addConnection({
            sourceId: src.id,
            targetId: dst.id,
            path: [source.position, target.position],
            type: args.type || 'power'
        });

        return { success: true, sourceId: src.id, targetId: dst.id };
    }

    /**
     * Delete a conduit route between placed components. Ids come from
     * layout_get_placed_components (connections array). This only removes the
     * plan overlay — the electrical connection lives in the SLD, where
     * delete_connector removes it.
     */
    deleteConnection(id: string, planId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const resolved = resolveId(id, plan.connections.map(c => c.id), 'connection id');
        if (isError(resolved)) return resolved;

        layout().removeConnection(resolved.id);
        return { success: true, deletedId: resolved.id };
    }

    /**
     * Per-room load tally.
     *
     * The agent needs this to size boards and balance phases. Computing it here
     * rather than asking the model to add up wattages avoids arithmetic slips on
     * 60-item plans.
     */
    getLoadSummary(planId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const byRoom = new Map<string, { name: string; watts: number; counts: Record<string, number> }>();
        const byCategory: Record<string, { count: number; watts: number }> = {};
        let totalWatts = 0;

        for (const comp of plan.components) {
            const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
            const watts = Number(comp.properties?.wattage ?? def?.defaultWattage ?? 0);
            const category = def?.category || 'unknown';

            totalWatts += watts;

            if (!byCategory[category]) byCategory[category] = { count: 0, watts: 0 };
            byCategory[category].count += 1;
            byCategory[category].watts += watts;

            const key = comp.roomId || '__unassigned';
            if (!byRoom.has(key)) {
                const room = plan.rooms.find(r => r.id === comp.roomId);
                byRoom.set(key, { name: room?.name || 'Unassigned', watts: 0, counts: {} });
            }
            const entry = byRoom.get(key)!;
            entry.watts += watts;
            entry.counts[comp.type] = (entry.counts[comp.type] || 0) + 1;
        }

        return {
            planId: plan.id,
            totalWatts,
            totalComponents: plan.components.length,
            byCategory,
            byRoom: Array.from(byRoom.entries()).map(([roomId, v]) => ({
                roomId: roomId === '__unassigned' ? null : roomId,
                roomName: v.name,
                watts: v.watts,
                counts: v.counts
            }))
        };
    }

    // =======================================================================
    // LAYOUT → SLD MATERIALIZATION
    // =======================================================================

    /**
     * Turn placed Layout components into SLD symbols on the active sheet.
     *
     * Normally Layout→SLD sync drops new items into the "Unplaced" staging tray
     * for the user to position by hand. That is the right behaviour for manual
     * work but a dead end for an agent, which has no hands. This places them
     * directly, arranged in hierarchy tiers (source at top, loads at bottom),
     * and returns the ids so the agent can immediately wire them with
     * connect_items.
     *
     * Three distinct cases have to be handled, and conflating them is what made
     * this tool lie to the agent:
     *
     *   1. Already on a sheet          → nothing to do, just re-assert the link.
     *   2. Sitting in the staging tray → ADOPT it: move it onto the sheet and
     *      clear it from staging. The auto-sync in LayoutDesigner stages items
     *      the moment components are added, so by the time the agent calls this
     *      the tray is usually full. Treating "staged" as "already has a symbol"
     *      reported success while leaving the sheet empty, which is what pushed
     *      the agent into hand-building a parallel set of unlinked items.
     *   3. Not represented at all      → generate a fresh symbol.
     *
     * The Layout→SLD links are written back in every case, including when
     * nothing new was generated. Previously the early return skipped the
     * write-back, so `sldItemId` stayed null and the layout components kept
     * showing up as unplaced forever.
     */
    async buildSldFromLayout(args: { planId?: string; onProgress?: (msg: string) => void } = {}): Promise<any> {
        const plan = requirePlan(args.planId);
        if (isError(plan)) return plan;

        const { syncEngine } = await import('../utils/SyncEngine');
        const sldState = sld();
        const sheet = sldState.getCurrentSheet();
        if (!sheet) return { error: 'No active SLD sheet.' };

        // ---------------------------------------------------------------
        // Step 1 — adopt anything already waiting in the staging tray
        // ---------------------------------------------------------------
        const layoutComponentIds = new Set(plan.components.map(c => c.id));
        const onSheetIds = new Set(sldState.sheets.flatMap(s => s.canvasItems.map(i => i.uniqueID)));

        const adoptable = sldState.stagingItems.filter(item => {
            if (onSheetIds.has(item.uniqueID)) return false;
            const linkedLayoutId = item.properties?.[0]?.['_layoutComponentId'];
            return Boolean(linkedLayoutId && layoutComponentIds.has(linkedLayoutId));
        });

        const adopted: Array<{ sldItemId: string; name: string; layoutComponentId: string }> = [];
        if (adoptable.length > 0) {
            sldState.takeSnapshot();
            for (const item of adoptable) {
                sldState.addItem(item);
                sldState.removeStagingItem(item.uniqueID);
                onSheetIds.add(item.uniqueID);
                adopted.push({
                    sldItemId: item.uniqueID,
                    name: item.name,
                    layoutComponentId: item.properties?.[0]?.['_layoutComponentId'] || ''
                });
            }
        }

        // ---------------------------------------------------------------
        // Step 2 — generate symbols for anything still unrepresented
        // ---------------------------------------------------------------
        const stillStagedIds = new Set(
            sld().stagingItems.map(i => i.uniqueID)
        );
        const existing = new Set([...onSheetIds, ...stillStagedIds]);

        const result = await syncEngine.syncLayoutToSld(plan, args.onProgress, {
            existingSldItemIds: existing
        });

        if (result.items.length > 0) {
            sldState.takeSnapshot();
            for (const item of result.items) {
                sldState.addItem(item);
            }
        }

        // ---------------------------------------------------------------
        // Step 3 — write the Layout→SLD links back, unconditionally
        // ---------------------------------------------------------------
        const layoutState = layout();
        const linkedIds = new Set<string>();
        for (const [layoutId, sldId] of result.syncLinks.entries()) {
            layoutState.updateComponent(layoutId, { sldItemId: sldId });
            linkedIds.add(layoutId);
        }
        // syncLinks only covers what the generator walked. Adopted items are
        // linked here so an adoption-only run still repairs the link.
        for (const a of adopted) {
            if (a.layoutComponentId && !linkedIds.has(a.layoutComponentId)) {
                layoutState.updateComponent(a.layoutComponentId, { sldItemId: a.sldItemId });
                linkedIds.add(a.layoutComponentId);
            }
        }

        const created = result.items.map(i => ({
            sldItemId: i.uniqueID,
            name: i.name,
            layoutComponentId: i.properties?.[0]?.['_layoutComponentId'] || null,
            position: roundPoint(i.position),
            connectionPointKeys: Object.keys(i.connectionPoints || {})
        }));

        // Report what is still unrepresented rather than claiming completeness.
        const refreshedPlan = requirePlan(args.planId);
        const unlinked = isError(refreshedPlan)
            ? []
            : refreshedPlan.components
                .filter(c => !c.sldItemId)
                .map(c => ({ id: c.id, type: c.type, name: c.properties?.name || c.type }));

        return {
            success: true,
            createdCount: created.length,
            adoptedCount: adopted.length,
            linkedCount: linkedIds.size,
            sheetId: sheet.sheetId,
            sheetItemCount: (sld().getCurrentSheet()?.canvasItems.length) ?? 0,
            ...(created.length > 0 ? { created } : {}),
            ...(adopted.length > 0 ? { adopted } : {}),
            ...(unlinked.length > 0 ? { stillWithoutSymbol: unlinked } : {}),
            warnings: result.warnings,
            message: created.length === 0 && adopted.length === 0
                ? `No new symbols were needed; the active sheet holds ${(sld().getCurrentSheet()?.canvasItems.length) ?? 0} item(s).`
                : `${created.length} symbol(s) created, ${adopted.length} adopted from the unplaced tray.`,
            note: 'Symbols are placed but NOT wired. Read get_diagram_state_json for exact point keys, then connect with connect_items. Do NOT use add_item_to_diagram for anything that exists in the layout — that creates an unlinked duplicate.'
        };
    }

    /**
     * Auto-arrange the SLD sheet into readable tiers.
     *
     * Thin wrapper so the agent can tidy up without leaving the layout tool
     * namespace mid-workflow. gapFactor optionally overrides the user's stored
     * downstream-row spacing for this run only (clamped to [1, 3]).
     */
    arrangeSld(gapFactor?: number): any {
        const sldState = sld();
        const sheet = sldState.getCurrentSheet();
        if (!sheet) return { error: 'No active SLD sheet.' };

        let factor = ApplicationSettings.getSldDownstreamGapFactor();
        if (typeof gapFactor === 'number' && Number.isFinite(gapFactor)) {
            factor = Math.min(3, Math.max(1, gapFactor));
        }

        sldState.takeSnapshot();
        const arranged = applyAutoArrange(sheet.canvasItems, sheet.storedConnectors, factor);
        sldState.updateSheet({ canvasItems: arranged });
        sldState.calculateNetwork();
        return { success: true, itemCount: arranged.length, gapFactor: factor };
    }

    /**
     * Cross-check the Layout against the SLD.
     *
     * Catches the failure modes that matter after an agent run: fittings with no
     * schematic symbol, loads that are not fed by anything, components floating
     * outside every room, wall-mounted fittings floating off every wall (hand-
     * picked mid-room coordinates bypass the wall snap — observed with a 5A
     * board placed mid-office), switch boards seated over door/window spans,
     * and — added after a run went wrong exactly this way — schematic symbols
     * that exist but are not linked to any Layout component.
     *
     * That last check is the important one. An agent that hand-builds symbols
     * with `add_item_to_diagram` produces a schematic that looks complete and
     * validates clean on the SLD side, while the layout has no idea those symbols
     * exist. Both views then show every device as "Unplaced" and the connections
     * drawn in the schematic have no counterpart on the floor plan. Nothing in the
     * old validator noticed.
     */
    validateLayout(planId?: string): any {
        const plan = requirePlan(planId);
        if (isError(plan)) return plan;

        const sldState = sld();
        const allSldItems = sldState.sheets.flatMap(s => s.canvasItems);
        const sldById = new Map(allSldItems.map(i => [i.uniqueID, i]));
        const connectors = sldState.sheets.flatMap(s => s.storedConnectors);

        // Which SLD items are fed by something?
        const fedSldIds = new Set(connectors.map(c => c.targetItem?.uniqueID).filter(Boolean) as string[]);

        const issues: Array<{ severity: 'error' | 'warning'; message: string; componentId?: string; sldItemId?: string }> = [];

        const loadCategories = new Set(['lighting', 'fans', 'appliances', 'others']);

        for (const comp of plan.components) {
            const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
            const label = comp.properties?.name || def?.name || comp.type;

            if (!comp.roomId) {
                issues.push({
                    severity: 'warning',
                    message: `${label} is not inside any room — it will not appear in per-room load totals.`,
                    componentId: comp.id
                });
            }

            // Wall-seating gate: a wall-mounted fitting far from every wall is
            // floating in open area, not mounted. Seating auto-engages only near
            // a detected wall line, so hand-picked mid-room coordinates sail
            // past it — and "inside a room" alone waved them through. This is
            // the check that makes agent coordinate authority safe.
            if (def?.placementType === 'wall' && plan.walls.length > 0) {
                const seat = checkWallSeating(
                    comp.position, comp.type, plan.walls, plan.pixelsPerMeter || 50
                );
                if (!seat.seated) {
                    issues.push({
                        severity: 'error',
                        message: `${label} floats ~${seat.distancePx}px off the nearest wall — a wall-mounted ${comp.type} must sit on a wall, not in open room area. Move it onto a wall with layout_update_component (omit rotation; seating is automatic) or delete it and re-place with a wall purpose ("wall" / "external_wall" / "beside_door"). Audit your other hand-placed coordinates for the same defect.`,
                        componentId: comp.id
                    });
                } else if (needsOpeningClearance(comp.type) && seat.wallId) {
                    // Seated but possibly over an opening: a board concreted over
                    // a door/window span is unusable. Only meaningful once the
                    // floating check above passes — off-wall geometry would be noise.
                    const hostWall = plan.walls.find(w => w.id === seat.wallId);
                    if (hostWall) {
                        const size = getScaledComponentSize(comp.type, plan.pixelsPerMeter || 50);
                        const oc = checkOpeningClearance(comp.position, hostWall, planOpenings(plan), size.width / 2);
                        if (!oc.clear) {
                            issues.push({
                                severity: 'error',
                                message: `${label} sits over a ${oc.kind} opening — switch boards and distribution boards must be on clear wall beside doors and windows, never overlapping their spans. Move it along the wall with layout_update_component (omit rotation) or delete it and re-place with purpose "beside_door" / "wall".`,
                                componentId: comp.id
                            });
                        }
                    }
                }
            }

            // Fan sweep gate: a 1200 mm ceiling fan whose blades overlap a
            // wall, door swing or window is a hard error no matter who chose
            // the coordinates — tool suggestion or the agent's own arithmetic.
            // This is the check that makes agent coordinate authority safe.
            if (comp.type === 'ceiling_fan_point' && comp.roomId) {
                const fanRoom = plan.rooms.find(r => r.id === comp.roomId);
                if (fanRoom) {
                    const ppm = plan.pixelsPerMeter || 50;
                    const check = checkCeilingFeasibility(comp.position, fanRoom, {
                        pixelsPerMeter: ppm,
                        doors: plan.doors.map(d => ({ position: d.position })),
                        windows: plan.windows.map(w => ({ position: w.position }))
                    });
                    if (!check.feasible) {
                        issues.push({
                            severity: 'error',
                            message: `${label} sweep overlaps ${check.issues.join('; ')}. ` +
                                `Move it clear with layout_update_component — no fan may overlap a wall, door or window.`,
                            componentId: comp.id
                        });
                    }
                }
            }

            if (!comp.sldItemId || !sldById.has(comp.sldItemId)) {
                issues.push({
                    severity: 'error',
                    message: `${label} has no SLD symbol. Run layout_build_sld.`,
                    componentId: comp.id
                });
                continue;
            }

            if (loadCategories.has(def?.category || '') && !fedSldIds.has(comp.sldItemId)) {
                issues.push({
                    severity: 'error',
                    message: `${label} is not fed by anything in the SLD. Connect it to a Point Switch Board output.`,
                    componentId: comp.id
                });
            }
        }

        // ---------------------------------------------------------------
        // SLD side: symbols with no Layout counterpart
        // ---------------------------------------------------------------
        const layoutComponentIds = new Set(plan.components.map(c => c.id));
        const linkedSldIds = new Set(
            plan.components.map(c => c.sldItemId).filter(Boolean) as string[]
        );
        // Items that legitimately have no floor-plan presence.
        const nonPhysical = new Set(['Portal', 'Text Box', 'Note', 'Connector']);

        const orphanSldItems: Array<{ sldItemId: string; name: string }> = [];
        for (const item of allSldItems) {
            if (nonPhysical.has(item.name)) continue;
            if (linkedSldIds.has(item.uniqueID)) continue;

            const linkedLayoutId = item.properties?.[0]?.['_layoutComponentId'];
            if (linkedLayoutId && layoutComponentIds.has(linkedLayoutId)) continue;

            orphanSldItems.push({ sldItemId: item.uniqueID, name: item.name });
        }

        if (orphanSldItems.length > 0) {
            issues.push({
                severity: 'error',
                message: `${orphanSldItems.length} schematic symbol(s) have no Layout component: ${orphanSldItems.slice(0, 8).map(o => `${o.name} (${o.sldItemId.slice(0, 8)})`).join(', ')}${orphanSldItems.length > 8 ? ', …' : ''}. These were added directly to the SLD instead of via layout_build_sld, so the floor plan and the schematic disagree and both views will list the devices as Unplaced. Delete them with delete_item_from_diagram and run layout_build_sld, which creates linked symbols.`
            });
        }

        // ---------------------------------------------------------------
        // Staging trays: work that never made it onto either canvas
        // ---------------------------------------------------------------
        const stagedSld = sldState.stagingItems.filter(i => {
            const linkedLayoutId = i.properties?.[0]?.['_layoutComponentId'];
            return Boolean(linkedLayoutId && layoutComponentIds.has(linkedLayoutId));
        });
        if (stagedSld.length > 0) {
            issues.push({
                severity: 'warning',
                message: `${stagedSld.length} symbol(s) are sitting in the SLD "Unplaced" tray rather than on a sheet. Run layout_build_sld — it adopts staged symbols onto the active sheet.`
            });
        }

        const stagedLayout = layout().stagingComponents;
        if (stagedLayout.length > 0) {
            issues.push({
                severity: 'warning',
                message: `${stagedLayout.length} component(s) are in the Layout "Unplaced" tray. They came from SLD symbols with no floor-plan position; either place them or delete the SLD items that produced them.`
            });
        }

        if (plan.rooms.length === 0) {
            issues.push({
                severity: 'warning',
                message: 'No rooms detected on this plan. Run Detect Rooms, or the agent cannot reason about placement per room.'
            });
        }
        if (!plan.isScaleCalibrated) {
            issues.push({
                severity: 'warning',
                message: 'Scale is not calibrated; area-based decisions are unreliable.'
            });
        }

        // Collapse the repetitive per-component issues.
        //
        // "X has no SLD symbol" once per component produced 26 near-identical
        // lines in an observed run — several KB of context per call, and the
        // single actionable instruction ("run layout_build_sld") buried inside
        // each copy. Grouping keeps the ids available without the repetition.
        const groupOf = (message: string): string | null => {
            if (message.includes('has no SLD symbol')) return 'no_sld_symbol';
            if (message.includes('is not fed by anything')) return 'not_fed';
            if (message.includes('is not inside any room')) return 'no_room';
            if (message.includes('sweep overlaps')) return 'fan_overlap';
            if (message.includes('floats')) return 'floating_wall_item';
            if (message.includes('sits over a')) return 'blocked_opening';
            return null;
        };

        const grouped = new Map<string, { severity: 'error' | 'warning'; componentIds: string[] }>();
        const ungrouped: typeof issues = [];

        for (const issue of issues) {
            const key = groupOf(issue.message);
            if (!key || !issue.componentId) {
                ungrouped.push(issue);
                continue;
            }
            const bucket = grouped.get(key);
            if (bucket) bucket.componentIds.push(issue.componentId);
            else grouped.set(key, { severity: issue.severity, componentIds: [issue.componentId] });
        }

        const GROUP_TEXT: Record<string, string> = {
            no_sld_symbol: 'component(s) have no SLD symbol. Run layout_build_sld — do not add them with add_item_to_diagram, which creates unlinked duplicates.',
            not_fed: 'load(s) are not fed by anything in the SLD. Connect each to a Point Switch Board output (lights/fans/bell) or an HTPN way (AC/geyser).',
            no_room: 'component(s) are not inside or adjacent to any room, so they are missing from per-room load totals. Re-place them inside a room (suggested coordinates or your own computed point).',
            fan_overlap: 'ceiling fan(s) overlap a wall, door or window sweep. Move each clear with layout_update_component — agent-chosen coordinates must satisfy this like any suggestion.',
            floating_wall_item: 'wall-mounted item(s) float in open room area instead of sitting on a wall — hand-picked coordinates bypassed the wall snap. Move them all in one layout_update_components call (omit rotation; seating is automatic) or delete and re-place with purpose "wall" / "external_wall" / "beside_door". Audit every other hand-placed coordinate from the same turn for the same defect.',
            blocked_opening: 'switch board(s) or distribution board(s) sit over a door/window opening instead of on clear wall beside it. Move them all in one layout_update_components call (omit rotation; clearance is automatic) or delete and re-place with purpose "beside_door" / "wall".'
        };

        const collapsed: Array<{ severity: 'error' | 'warning'; message: string; componentIds?: string[] }> = [];
        for (const [key, bucket] of grouped) {
            collapsed.push({
                severity: bucket.severity,
                message: `${bucket.componentIds.length} ${GROUP_TEXT[key]}`,
                componentIds: bucket.componentIds.slice(0, 30)
            });
        }
        for (const issue of ungrouped) {
            collapsed.push({ severity: issue.severity, message: issue.message });
        }

        const errorCount = issues.filter(i => i.severity === 'error').length;
        const warningCount = issues.filter(i => i.severity === 'warning').length;

        return {
            planId: plan.id,
            ok: errorCount === 0,
            errorCount,
            warningCount,
            componentCount: plan.components.length,
            sldItemCount: allSldItems.length,
            connectorCount: connectors.length,
            issues: collapsed
        };
    }

    undo(): any {
        layout().undo();
        return { success: true };
    }

    redo(): any {
        layout().redo();
        return { success: true };
    }
}

export const layoutAgentTools = new LayoutAgentTools();
