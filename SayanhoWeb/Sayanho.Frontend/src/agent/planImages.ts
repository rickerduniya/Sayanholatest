// Plan image capture for the design agent.
//
// The agent's geometric view of the building comes from detected vectors (room
// polygons, walls, doors). That view is only as good as the detection was: a
// missed wall silently merges two rooms, and OCR that fails on a label leaves a
// room called "Room 3". The agent cannot notice either problem from vectors
// alone, because the vectors *are* its ground truth.
//
// Sending the actual floor plan image with the opening message gives it a second,
// independent source it can cross-check against — and lets it read anything only
// present in the drawing: room labels OCR missed, dimension annotations, which
// walls are external, furniture hinting at how a room is used.
//
// Once the agent has placed something, the drawing alone is no longer the whole
// truth either. Asked to "reposition these", it previously received the bare
// source image and a JSON list of coordinates, and had to imagine where those
// coordinates fell — so it moved symbols by arithmetic and could not see that a
// fan sat in a doorway or a tube light ran across a wall. When the plan already
// has components we therefore draw them onto the image, so it sees its own work
// in the same frame as the building.
//
// Downscaling is not optional. Vision tokens scale with pixel count, and a phone
// photo of a plan is routinely 4000px wide. A run that sends three of those at
// full size can cost more than the entire rest of the design.

import { FloorPlan, LayoutComponentType } from '../types/layout';
import { layoutImageStore } from '../utils/LayoutImageStore';
import { LAYOUT_COMPONENT_DEFINITIONS, getScaledComponentSize } from '../utils/LayoutComponentDefinitions';
import { api } from '../services/api';

/**
 * Longest edge, in pixels, of the image we send.
 *
 * 1400px keeps room labels and dimension text legible to current vision models
 * while capping a single image at roughly 1.1k-1.6k tokens depending on provider
 * tiling. Going higher mostly buys detail the model does not use.
 */
const MAX_EDGE_PX = 1400;

/** JPEG quality. Line drawings tolerate 0.85 without text becoming mushy. */
const JPEG_QUALITY = 0.85;

/**
 * How many plans we illustrate.
 *
 * A four-storey building would otherwise put four large images in one request.
 * Beyond this cap the agent still gets full vector geometry for every plan and
 * is told which ones it could not see.
 */
const MAX_IMAGES = 3;

/**
 * Short tags drawn next to each symbol.
 *
 * The symbols are CPWD line art: a tube light and a busbar chamber are both a
 * thin black rectangle at 1400px, and the model has no legend. A two-to-four
 * character tag removes the guesswork and lets it name what it is looking at in
 * its own reply, which is also how the user checks that it read the plan right.
 */
const SYMBOL_TAGS: Record<LayoutComponentType, string> = {
    spn_db: 'SPN',
    vtpn_db: 'VTPN',
    htpn_db: 'HTPN',
    lt_cubical_panel: 'LTP',
    busbar_chamber: 'BUS',
    main_switch: 'MSW',
    changeover_switch: 'COS',
    ac_point: 'AC',
    geyser_point: 'GEY',
    bulb: 'L',
    tube_light: 'TL',
    ceiling_fan_point: 'FAN',
    exhaust_fan: 'EF',
    point_switch_board: 'PSB',
    avg_5a_switch_board: '5A',
    source: 'SRC',
    call_bell: 'BELL'
};

/**
 * Overlay colour.
 *
 * Architectural plans are black on white, so a black overlay is invisible in
 * exactly the places that matter — a symbol sitting on a wall line. Red reads as
 * "added on top" at a glance and survives JPEG compression at this size.
 */
const OVERLAY_COLOR = '#d81e2c';

/** Cache of decoded symbol artwork, keyed by component type. */
const symbolCache = new Map<LayoutComponentType, HTMLImageElement | null>();

export interface PlanImage {
    planId: string;
    planName: string;
    dataUri: string;
    widthPx: number;
    heightPx: number;
    approxKb: number;
    /** Placed components drawn onto this image. 0 when it is the bare drawing. */
    annotatedComponents: number;
    /** Component types actually drawn, so the legend lists only what is visible. */
    annotatedTypes: LayoutComponentType[];
}

export interface PlanImageResult {
    images: PlanImage[];
    /** Plans that have no background image (drawn by hand rather than uploaded). */
    plansWithoutImage: string[];
    /** Plans skipped because of MAX_IMAGES. */
    skipped: string[];
}

/**
 * Give an SVG an intrinsic size.
 *
 * The symbol files carry only a viewBox. An <img> holding a viewBox-only SVG has
 * no intrinsic size, which some browsers report as naturalWidth 0 and refuse to
 * rasterise. Stamping width/height from the viewBox costs nothing and removes a
 * browser-dependent failure that would silently drop the overlay.
 */
function withIntrinsicSize(svg: string): string {
    if (/<svg[^>]*\swidth\s*=/i.test(svg)) return svg;

    const viewBox = svg.match(/viewBox\s*=\s*"([^"]+)"/i)?.[1];
    if (!viewBox) return svg;

    const nums = viewBox.trim().split(/[\s,]+/).map(Number);
    if (nums.length !== 4 || nums.some(n => !Number.isFinite(n))) return svg;

    const [, , vbWidth, vbHeight] = nums;
    if (vbWidth <= 0 || vbHeight <= 0) return svg;

    return svg.replace(/<svg\b/i, `<svg width="${vbWidth}" height="${vbHeight}"`);
}

/**
 * Load one component symbol as a canvas-safe image.
 *
 * The icons are fetched as text and re-encoded as a data URI rather than pointed
 * at with `img.src = <api url>`. A cross-origin image taints the canvas, and a
 * tainted canvas makes toDataURL throw — which would lose the whole overlay for
 * a reason that has nothing to do with drawing.
 */
async function loadSymbol(type: LayoutComponentType): Promise<HTMLImageElement | null> {
    if (symbolCache.has(type)) return symbolCache.get(type) ?? null;

    const def = LAYOUT_COMPONENT_DEFINITIONS[type];
    if (!def?.svgIcon) {
        symbolCache.set(type, null);
        return null;
    }

    try {
        const response = await fetch(api.getIconUrl(def.svgIcon));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const svg = withIntrinsicSize(await response.text());

        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('svg decode failed'));
            el.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        });

        symbolCache.set(type, img);
        return img;
    } catch (error) {
        console.warn(`[planImages] Could not load symbol for ${type}`, error);
        symbolCache.set(type, null);
        return null;
    }
}

/**
 * Recolour black line art to the overlay colour.
 *
 * Done once per symbol size via an offscreen canvas and `source-in`, because the
 * SVGs hard-code #000 and we cannot restyle them through an <img>.
 */
function tintSymbol(img: HTMLImageElement, width: number, height: number): HTMLCanvasElement | null {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));

    const buffer = document.createElement('canvas');
    buffer.width = w;
    buffer.height = h;

    const bctx = buffer.getContext('2d');
    if (!bctx) return null;

    bctx.drawImage(img, 0, 0, w, h);
    bctx.globalCompositeOperation = 'source-in';
    bctx.fillStyle = OVERLAY_COLOR;
    bctx.fillRect(0, 0, w, h);

    return buffer;
}

/**
 * Draw the placed components over an already-rendered background.
 *
 * Coordinates are plan-space pixels, the same space `layout_suggest_positions`
 * returns and `component.position` stores, so the overlay lands exactly where
 * the Layout view shows it. Walls, rooms, doors and windows are deliberately not
 * drawn: they are detected vectors the agent already has as JSON, and drawing
 * them would bury the source drawing it is supposed to be checking against.
 *
 * Returns how many symbols were drawn, and which types.
 */
async function drawComponents(
    ctx: CanvasRenderingContext2D,
    plan: FloorPlan,
    scale: number
): Promise<{ drawn: number; types: LayoutComponentType[] }> {
    const components = plan.components || [];
    if (components.length === 0) return { drawn: 0, types: [] };

    const ppm = plan.pixelsPerMeter || 50;
    const types = Array.from(new Set(components.map(c => c.type)));
    const symbols = new Map<LayoutComponentType, HTMLImageElement | null>();
    await Promise.all(types.map(async t => symbols.set(t, await loadSymbol(t))));

    // Label size is fixed in output pixels, not scaled with the plan: a tag that
    // shrinks with the drawing stops being readable on a large plan, which is
    // exactly when the agent needs it most.
    const labelPx = 11;
    let drawn = 0;

    for (const comp of components) {
        const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
        const sizePlan = def?.realSizeMm
            ? getScaledComponentSize(comp.type, ppm)
            : (def?.size ?? { width: 24, height: 24 });

        const w = Math.max(6, sizePlan.width * scale);
        const h = Math.max(6, sizePlan.height * scale);
        const cx = comp.position.x * scale;
        const cy = comp.position.y * scale;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(((comp.rotation || 0) * Math.PI) / 180);

        // Lift the symbol off the drawing without hiding it. Plans are dense with
        // black linework; an untinted symbol on top of a wall is unreadable.
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);
        ctx.globalAlpha = 1;

        const art = symbols.get(comp.type) || null;
        const tinted = art ? tintSymbol(art, w, h) : null;

        if (tinted) {
            ctx.drawImage(tinted, -w / 2, -h / 2, w, h);
        } else {
            // No artwork: an outlined box still shows position, size and angle,
            // which is the point of the overlay.
            ctx.strokeStyle = OVERLAY_COLOR;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(-w / 2, -h / 2, w, h);
        }
        ctx.restore();

        // Tags are drawn unrotated so they stay readable on a wall-mounted item
        // that inherited a wall's angle.
        const tag = SYMBOL_TAGS[comp.type] || comp.type;
        ctx.save();
        ctx.font = `bold ${labelPx}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(tag, cx, cy + Math.max(h, w) / 2 + 1);
        ctx.fillStyle = OVERLAY_COLOR;
        ctx.fillText(tag, cx, cy + Math.max(h, w) / 2 + 1);
        ctx.restore();

        drawn += 1;
    }

    return { drawn, types };
}

/**
 * Load, downscale and re-encode a stored plan image, optionally with the placed
 * components drawn on top.
 *
 * Returns null rather than throwing: a missing or corrupt image should degrade
 * the run to vector-only, not abort it.
 */
async function prepareImage(plan: FloorPlan, annotate: boolean): Promise<PlanImage | null> {
    if (!plan.backgroundImageId) return null;

    try {
        const dataUrl = await layoutImageStore.getImageAsDataUrl(plan.backgroundImageId);
        if (!dataUrl) return null;

        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('decode failed'));
            el.src = dataUrl;
        });

        // Draw in plan space, not image space. The Layout view stretches the
        // background to plan.width × plan.height, and component coordinates are
        // in that same space — using the image's own pixels would put every
        // symbol in the wrong place on any plan whose stored size differs.
        const planW = plan.width || img.naturalWidth;
        const planH = plan.height || img.naturalHeight;

        const longEdge = Math.max(planW, planH);
        const scale = longEdge > MAX_EDGE_PX ? MAX_EDGE_PX / longEdge : 1;
        const width = Math.max(1, Math.round(planW * scale));
        const height = Math.max(1, Math.round(planH * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Flatten onto white. Plans are often PNGs with transparency, and
        // transparent-as-black renders the drawing unreadable to the model.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        const overlay = annotate
            ? await drawComponents(ctx, plan, scale)
            : { drawn: 0, types: [] as LayoutComponentType[] };

        const encoded = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        const approxKb = Math.round((encoded.length * 0.75) / 1024);

        return {
            planId: plan.id,
            planName: plan.name,
            dataUri: encoded,
            widthPx: width,
            heightPx: height,
            approxKb,
            annotatedComponents: overlay.drawn,
            annotatedTypes: overlay.types
        };
    } catch (error) {
        console.warn(`[planImages] Could not prepare image for plan "${plan.name}"`, error);
        return null;
    }
}

/**
 * Collect images for the plans the agent is about to work on.
 *
 * The active plan is always first, so a single-image request is the one the user
 * is actually looking at.
 *
 * `annotate` draws the already-placed components on top. Pass it whenever the
 * plan is not empty: a correction request ("these are badly positioned") is
 * unanswerable from the bare drawing plus a coordinate list, because the agent
 * cannot see which coordinate landed in a doorway.
 */
export async function collectPlanImages(
    plans: FloorPlan[],
    activePlanId: string | null,
    options: { annotate?: boolean } = {}
): Promise<PlanImageResult> {
    const ordered = [...plans].sort((a, b) => {
        if (a.id === activePlanId) return -1;
        if (b.id === activePlanId) return 1;
        return 0;
    });

    const withImage = ordered.filter(p => Boolean(p.backgroundImageId));
    const plansWithoutImage = ordered.filter(p => !p.backgroundImageId).map(p => p.name);

    const selected = withImage.slice(0, MAX_IMAGES);
    const skipped = withImage.slice(MAX_IMAGES).map(p => p.name);

    const annotate = options.annotate !== false;
    const prepared = await Promise.all(selected.map(p => prepareImage(p, annotate)));
    const images = prepared.filter((i): i is PlanImage => i !== null);

    return { images, plansWithoutImage, skipped };
}

/**
 * Prose describing the attached images, appended to the agent's goal.
 *
 * Without this the model receives images with no explanation of what they are or
 * what to do with them, and typically ignores them in favour of the tool data.
 * The instruction to *report* discrepancies rather than silently pick a side is
 * the important part: a mismatch between drawing and detection is something the
 * user needs to fix, not something the agent should paper over.
 */
export function describePlanImages(result: PlanImageResult): string {
    if (result.images.length === 0) {
        const reasons: string[] = [];
        if (result.plansWithoutImage.length > 0) {
            reasons.push(`${result.plansWithoutImage.length} plan(s) were drawn by hand and have no source image`);
        }
        return [
            'NO FLOOR PLAN IMAGE IS ATTACHED.',
            reasons.length > 0 ? `(${reasons.join('; ')}.)` : '',
            'Work from the vector geometry returned by layout_get_plan_geometry alone, and',
            'tell the user you could not visually verify the detected walls and rooms.'
        ].filter(Boolean).join(' ');
    }

    const annotated = result.images.filter(i => i.annotatedComponents > 0);
    const lines: string[] = [];

    lines.push(
        result.images.length === 1
            ? 'ATTACHED IMAGE: the source floor plan drawing for this project.'
            : `ATTACHED IMAGES (${result.images.length}), in order:`
    );

    result.images.forEach((img, i) => {
        const overlay = img.annotatedComponents > 0
            ? ` — with the ${img.annotatedComponents} component(s) you have already placed drawn on top in red`
            : '';
        lines.push(`  ${i + 1}. "${img.planName}" (planId ${img.planId}) — ${img.widthPx}×${img.heightPx}px${overlay}`);
    });

    lines.push('');
    lines.push('How to use the image:');
    lines.push('- Read room labels and dimension text from the drawing. Detection OCR often misses these, so a room named "Room 3" in the tool data may be clearly labelled in the image. Use layout_set_room_info to record what you read.');
    lines.push('- Judge room purpose from the drawing where the label is absent: fixtures indicate a bathroom or kitchen, a bed indicates a bedroom.');
    lines.push('- Identify boundary (external) walls — the walls forming the outer outline of the building. Exhaust fans and AC points MUST go on these, never on a partition wall shared between two rooms.');
    lines.push('- Cross-check the detected geometry. If the image shows a wall or room that layout_get_plan_geometry does not, or the detected room count differs from what you can see, SAY SO EXPLICITLY and ask the user to fix the detection. Do not silently design around a detection error.');

    if (annotated.length > 0) {
        // Legend covers only the types actually on the image. Listing all 17
        // invites the model to reason about symbols that are not there.
        const shown = Array.from(new Set(annotated.flatMap(i => i.annotatedTypes)));
        lines.push('');
        lines.push('The red symbols are YOUR OWN placements, drawn at their real size and rotation:');
        lines.push(`  ${shown.map(t => `${SYMBOL_TAGS[t] || t}=${t}`).join(', ')}`);
        lines.push('- This is what the user is looking at. Judge your work from it: a fitting in a doorway, two symbols stacked, a wall-mounted item floating mid-room, a light or an exhaust fan that ended up mid-ceiling instead of on a wall, or an exhaust fan / AC point on an internal partition wall are all visible here and not in the JSON.');
        lines.push('- Only the placed electrical items are drawn. Detected walls, rooms, doors and windows are NOT overlaid — read those from layout_get_plan_geometry and from the drawing itself.');
        lines.push('- To fix something, call layout_get_placed_components for the ids, then layout_update_component. Match what you see to a component by its tag, room and position.');
        lines.push('- Rotation is in degrees, clockwise, 0 = the symbol upright as drawn. Most wall-mounted items sit on the wall line and share its angle; only the ceiling fan sits mid-room, unrotated. Seated exceptions face the served room: bulb icons point perpendicular out of the wall (base on the wall, globe into the room); tube_light battens plus both switch boards run parallel but offset so the base touches the wall face; AC and geyser points sit slightly sunk into the room-side wall face with upright labels. All are seated automatically — judge them by whether they read as belonging to the room.');
    }

    lines.push('');
    lines.push('Important: use the image to judge placement and orientation — and you may originate coordinates from it (room centres, inscribed-rectangle centres, furniture-aware nudges) or from your own arithmetic on the room `polygon` vertices. layout_suggest_positions remains the vetted default. Whichever source you use, every placement is validated (inside-a-room, fan sweep clear of walls/doors/windows) and layout_validate must pass: fix or justify any rejected point.');

    if (result.skipped.length > 0) {
        lines.push('');
        lines.push(`Not shown (image limit): ${result.skipped.join(', ')}. You still have full vector geometry for these; say that you could not visually verify them.`);
    }
    if (result.plansWithoutImage.length > 0) {
        lines.push('');
        lines.push(`Drawn by hand, no source image: ${result.plansWithoutImage.join(', ')}.`);
    }

    return lines.join('\n');
}
