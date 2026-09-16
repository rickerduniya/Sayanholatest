/**
 * Wire-driven top-down auto-arrange.
 *
 * The layout is derived from the REAL wiring (the connector/edge list), never
 * from what kind of box a node looks like. Two visually identical boxes can
 * therefore land in different tiers when one is wired off a DB and the other
 * off a switch board point — that falls out of the edges, nothing is hardcoded.
 *
 *   Step 1 — Build the real dependency graph from the wire/edge list. Every
 *            node's true parent(s) = whatever it is actually wired FROM.
 *   Step 2 — Tiers by longest path from the source:
 *              tier(node) = 0 for a source, else 1 + max(tier(p)) over parents.
 *            Topological (Kahn) pass outward from in-degree-0 sources, so a
 *            node sits exactly as many hops below the source as its longest
 *            feed path. Same tier = same horizontal line.
  *   Step 3 — Footprint widths, bottom-up. A leaf's footprint is its rendered
  *            width (box + connection-point stubs); a parent's is the span its
  *            whole downstream subtree needs, or its own width if larger.
  *            Adjacent subtree spans pack TOUCHING (zero slack) — spacing is
  *            enforced later per tier from real box widths (Step 5), so a gap
  *            between two neighbours never scales with whole-subtree size.
  *   Step 4 — Minimum centre gap between NEIGHBOUR BOXES (same tier),
  *            using rendered box widths only:
  *              minGap(A,B) = ((widthA + widthB) / 2) * factor
  *            `factor` is the caller-supplied downstream spacing factor (the
  *            persisted user setting, default 1.8). It scales neighbour boxes,
  *            never subtree footprints, so children of different parents sit
  *            exactly as close as two siblings with the same box sizes.
  *   Step 5 — Provisional overlap check: sweep every tier left-to-right and
  *            grow any gap that measures below the Step-4 minimum, shifting
  *            whole subtrees so nothing downstream is left mis-aligned, then
  *            re-run parent centring (Step 7) until stable. The same machinery
  *            also clears spec-label-vs-spec-label collisions horizontally;
  *            current-value labels ("R - 8.70 A") are IGNORED here by design,
  *            so live currents never spread subtrees apart and may overlap
  *            after arrange.
 *   Step 6 — Order each node's children to match the parent's output-port
 *            order (OG1->OG12 / out1->outN, R/Y/B phase grouping on HTPN
 *            boards) so descending wires do not cross to reach their child.
 *   Step 7 — Two-pass placement: bottom-up footprints, then top-down X
 *            positions with each parent centred over its children. Y is NOT
 *            one fixed row height: every inter-tier gap is sized independently
 *            by `sizeBandHeights` below, so each band is exactly as tall as
 *            its own wire/label content needs — no more, no less.
 *   Step 8 — Wires are routed orthogonally (down -> across -> down, never
 *            diagonally) by the connector router at render time, which
 *            staggers shared horizontal bus lines. Arrange-side, this step is
 *            honoured by the port ordering (Step 6), the guaranteed X
 *            separation (Steps 4/5) so parallel trunks never share a column,
 *            and the per-band routing clearance reserved by `sizeBandHeights`.
 *   Step 9 — Final validation scan (node-vs-node over rendered boxes) that
 *            nudges anything still touching apart by the smallest amount that
 *            clears it, plus a wire-lane clearance increment.
 *
 * Vertical band sizing (`sizeBandHeights`, recomputed fresh on every run —
 * never cached between runs):
 *
 *   Band g = the space between the bottom edge of tier-g nodes (the tier's
 *   lowest box bottom) and the top edge of tier-(g+1) nodes. Each band gets
 *   its own minimum height from what must actually render inside it:
 *
  *     content = wire segments crossing the band (each source's staggered
  *               horizontal bus stack: 30px offset + 25px per branch rank —
  *               mirrored from ConnectorUtils so the estimate matches what the
  *               router will draw) plus every cable-spec text label anchored
  *               in the band (on vertical drops and on sideways elbow jogs).
  *               Current-value labels are IGNORED — connecting a Source must
  *               not change band heights.
  *     clusters = spec labels grouped by horizontal overlap only; labels in
  *               different columns render side by side and share one height,
  *               while x-overlapping labels must stack. Each cluster stacks
  *               tightly (rendered text height + a few px pad, never a full
  *               label of buffer) in top-to-bottom reading order.
  *     H[g] = TOP stub/arrowhead clearance + max(floor, bus stacks, tallest
  *            cluster) + BOTTOM arrowhead/entry clearance, floored at an
  *            absolute minimum so empty bands never collapse. The last two
  *            gaps (tail bands) shave a small fixed trim off that height,
  *            floored at the router-safe bus-stack reservation, since they
  *            render mostly short cable-spec labels with room to spare.
  *
  * Priority: legibility beats compactness. Every estimate is conservative
  * (worst-case port positions, superset of candidate labels across refinement
  * rounds), so the formula yields the minimum SAFE height per band. A band
  * carrying cable-spec + elbow labels legitimately stays taller than one
  * carrying a single spec label — expect visibly uneven gaps. Current-value
  * labels never contribute: the same network arranges identically with and
  * without a Source connected.
 */

import { CanvasItem, Connector } from '../types';
import { ApplicationSettings } from './ApplicationSettings';

// ============================================================================
// Types
// ============================================================================

type Edge = {
    from: string;       // Source (upstream) item ID — whatever the wire runs FROM
    to: string;         // Target (downstream) item ID
    sourcePointKey: string;
    targetPointKey: string;
    conn: Connector;    // Full connector: properties/spec text + live currents
};

/** Rendered horizontal/vertical extents of an item, relative to position. */
type RenderBox = {
    dx0: number;        // left edge offset (<= 0) from position.x
    w: number;          // rendered width (box + side port stubs)
    dy0: number;        // top edge offset (<= 0) from position.y
    h: number;          // rendered height (box + top/bottom port stubs)
};

/** Live label-visibility configuration, read fresh on every arrange run.
 *  NOTE: current-value labels ("R - 8.70 A") are intentionally NOT part of
 *  this config — auto-arrange ignores them completely (no vertical room,
 *  no horizontal clearance), so connecting a Source never changes spacing. */
type LabelCfg = {
    specFont: number;   // connector spec-text font size (px)
    showSpecs: boolean; // cable-spec labels enabled
};

/** One text label that must render inside a band (band-local coordinates). */
type BandLabel = {
    band: number;
    x0: number;         // horizontal extent, for collision clustering
    x1: number;
    h: number;          // vertical height contribution when stacked
    top: number;        // estimated top (reading order), band-local
};

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    GROUP_GAP_X: 250,              // Gap between disconnected components
    LANE_PX: 5,                    // Step 8/9: wire-lane clearance increment (px)
    PORT_ICON_R: 6,                // Half of the 12px connection-point marker
    MAX_SWEEPS: 8                  // Convergence cap for centre/expand sweeps
};

/**
 * Mirror of the render-time router (ConnectorUtils) geometry this layout
 * estimates against. Kept as named constants (not imports) so the coupling
 * is explicit; if the router values change, these must follow.
 */
const ROUTER = {
    STUB: 5,                       // port offset stub (getOffsetConnectionPoint, halved twice 20->10->5)
    BUS: 30,                       // bus-bar offset from the source stub exit
    STAGGER: 25                    // vertical stagger per branch rank
};

/** Per-band vertical budget. All values in px, measured from the band top. */
const BAND = {
    TOP: 13,                       // top clearance: 5px exit stub + 8px arrowhead/breathe
    BOT: 13,                       // bottom clearance: 5px entry stub + 8px arrowhead/breathe
    FLOOR_STACK: 24,               // content floor: one wire + one arrowhead + breathing room
    MIN_H: 50,                     // absolute band floor (TOP + FLOOR_STACK + BOT)
    TAIL_TRIM: 10,                 // extra tightening for the last two inter-tier gaps
    TAIL_MIN_H: 40,                // absolute floor for those tail gaps (MIN_H - TAIL_TRIM)
    LABEL_PAD: 6,                  // pad between two stacked labels (edges must not touch)
    SPEC_TEXT_K: 0.45              // spec-text width factor (mirrors ConnectorUtils)
};

/**
 * Default downstream-row spacing factor. The persisted user setting
 * (ApplicationSettings.getSldDownstreamGapFactor) overrides this wherever
 * auto-arrange is invoked; the parameter default keeps direct calls stable.
 */
export const DEFAULT_DOWNSTREAM_GAP_FACTOR = 1.8;

/**
 * Step 4 — required centre-to-centre distance between two adjacent items or
 * subtree footprints: the touching distance scaled by `factor`, so the edge
 * gap is (factor - 1) of the pair's mean width regardless of symbol size.
 * Clamped at 1.0 minimum — below that neighbours would overlap.
 */
const requiredGap = (w1: number, w2: number, factor: number): number =>
    ((w1 + w2) / 2) * Math.max(1, factor);

const clampFactor = (factor: number): number =>
    typeof factor === 'number' && Number.isFinite(factor)
        ? Math.min(3, Math.max(1, factor))
        : DEFAULT_DOWNSTREAM_GAP_FACTOR;

// ============================================================================
// Helpers
// ============================================================================

const getWidth = (item: CanvasItem): number => item.size?.width ?? 100;
const getHeight = (item: CanvasItem): number => item.size?.height ?? 100;

const getConnectionPointX = (item: CanvasItem, pointKey: string): number => {
    return item.connectionPoints?.[pointKey]?.x ?? getWidth(item) / 2;
};

/** Step 3 — rendered box: symbol box grown to cover side/top port markers. */
function renderedBox(item: CanvasItem): RenderBox {
    let minX = 0;
    let maxX = getWidth(item);
    let minY = 0;
    let maxY = getHeight(item);
    const pts = item.connectionPoints ?? {};
    for (const key of Object.keys(pts)) {
        const p = pts[key];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        minX = Math.min(minX, p.x - CONFIG.PORT_ICON_R);
        maxX = Math.max(maxX, p.x + CONFIG.PORT_ICON_R);
        minY = Math.min(minY, p.y - CONFIG.PORT_ICON_R);
        maxY = Math.max(maxY, p.y + CONFIG.PORT_ICON_R);
    }
    return {
        dx0: minX,
        w: Math.max(1, maxX - minX),
        dy0: minY,
        h: Math.max(1, maxY - minY)
    };
}

// --- Step 6: output-port ordering -------------------------------------------

const phaseIdx = (key: string) => {
    const k = (key || '').toLowerCase();
    if (k.includes('red') || k.includes(' r')) return 0;
    if (k.includes('yellow') || k.includes(' y')) return 1;
    if (k.includes('blue') || k.includes(' b')) return 2;
    if (k.includes('_r')) return 0;
    if (k.includes('_y')) return 1;
    if (k.includes('_b')) return 2;
    return 3;
};

/** Numeric way number: OG12 -> 12, out3 -> 3, out1_R -> 1; no digits -> last. */
const wayIdx = (key: string) => {
    const m = (key || '').match(/(\d+)(?!.*\d)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

/**
 * Step 6 — sort a parent's outgoing edges so children are visited left to
 * right in output-port order (OG1->OG12 / out1->outN). HTPN boards keep the
 * legacy R/Y/B phase grouping, then way number. Everything else sorts by way
 * number, then phase suffix, then key, then live geometry as a tiebreak, so
 * descending wires never have to cross to reach their child.
 */
function sortChildEdges(
    parent: CanvasItem | undefined,
    edges: Edge[],
    itemsById: Map<string, CanvasItem>
): Edge[] {
    if (parent && (parent.name || '').includes('HTPN')) {
        return edges.slice().sort((a, b) => {
            const pa = phaseIdx(a.sourcePointKey);
            const pb = phaseIdx(b.sourcePointKey);
            if (pa !== pb) return pa - pb;
            const wa = wayIdx(a.sourcePointKey);
            const wb = wayIdx(b.sourcePointKey);
            if (wa !== wb) return wa - wb;
            if (a.sourcePointKey !== b.sourcePointKey) {
                return a.sourcePointKey < b.sourcePointKey ? -1 : 1;
            }
            return (itemsById.get(a.to)?.position.x ?? 0) - (itemsById.get(b.to)?.position.x ?? 0);
        });
    }
    return edges.slice().sort((a, b) => {
        const wa = wayIdx(a.sourcePointKey);
        const wb = wayIdx(b.sourcePointKey);
        if (wa !== wb) return wa - wb;
        const pa = phaseIdx(a.sourcePointKey);
        const pb = phaseIdx(b.sourcePointKey);
        if (pa !== pb) return pa - pb;
        if (a.sourcePointKey !== b.sourcePointKey) {
            return a.sourcePointKey < b.sourcePointKey ? -1 : 1;
        }
        const fromItem = itemsById.get(a.from);
        const fromItemB = itemsById.get(b.from);
        const fromXA = fromItem ? getConnectionPointX(fromItem, a.sourcePointKey) : 0;
        const fromXB = fromItemB ? getConnectionPointX(fromItemB, b.sourcePointKey) : 0;
        if (fromXA !== fromXB) return fromXA - fromXB;
        const ta = itemsById.get(a.to)?.position.x ?? 0;
        const tb = itemsById.get(b.to)?.position.x ?? 0;
        if (ta !== tb) return ta - tb;
        return a.to < b.to ? -1 : 1;
    });
}

// ============================================================================
// Label inventory — mirror what the canvas will actually render
// ============================================================================

/** Read visibility + font config live on every run (Step 8: never cached).
 *  Current-value labels are deliberately excluded — auto-arrange must not
 *  reserve any space for them. */
function readLabelCfg(): LabelCfg {
    // Outside a browser there is no stored configuration; the getters below
    // would each log a "Failed to load settings" error before falling back,
    // so skip them outright and use the rendering defaults.
    if (typeof localStorage === 'undefined') {
        return { specFont: 10, showSpecs: true };
    }
    let specFont = 10;
    let showSpecs = true;
    try {
        specFont = ApplicationSettings.getConnectorSpecTextFontSize();
        showSpecs = ApplicationSettings.getShowCableSpecs();
    } catch {
        // Storage/rendering settings unavailable — fall back to rendering defaults.
    }
    if (!Number.isFinite(specFont) || specFont <= 0) specFont = 10;
    return { specFont, showSpecs };
}

const SWITCH_BOARD_NAMES = new Set(['Point Switch Board', 'Avg. 5A Switch Board']);

/**
 * Exact text the canvas spec label will show for this connector (mirrors
 * ConnectorUtils.getSpecTextAndPosition), or null when nothing renders.
 */
function specTextFor(conn: Connector, srcName: string, tgtName: string): string | null {
    if (SWITCH_BOARD_NAMES.has(srcName) || SWITCH_BOARD_NAMES.has(tgtName)) {
        return '  3 x 1.5 Sq.Mm. Cu Wire ';
    }
    const props = conn.properties;
    if (props && Object.keys(props).length > 0) {
        const replacements: Record<string, string> = {
            Copper: 'Cu', Aluminum: 'Al', Aluminium: 'Al',
            Armoured: 'Ar', Armored: 'Ar', 'Un-armoured': 'Un-Ar', 'Un-armored': 'Un-Ar'
        };
        const limit = conn.materialType === 'Wiring' ? 3 : 4;
        const display = Object.values(props).slice(0, limit).map(v => {
            const trimmed = (v ?? '').trim();
            return replacements[trimmed] ?? trimmed;
        });
        const text = display.join(',') + (conn.materialType === 'Wiring' ? ', Wire' : ', Cable');
        return text.replace(/core/gi, 'C');
    }
    return null;
}

// NOTE: current-value labels ("R - 8.70 A", 3-phase stacks) are intentionally
// ignored by auto-arrange. They render as a canvas overlay and must never
// affect spacing — otherwise connecting a Source (zero current -> live
// current) would change the layout. No currentTextFor helper exists here
// by design.

// ============================================================================
// Step 2 — tiers by longest path from the source (top-down, wire-driven)
// ============================================================================

/**
 * tier(source) = 0; tier(node) = 1 + max(tier(p)) over true wired parents.
 * Kahn pass outward from in-degree-0 sources over unique parent links, so
 * multi-fed nodes settle on their LONGEST feed path. Cycle leftovers (no
 * in-degree-0 seed, or a backfeed loop) are stacked above the current max in
 * parents-first order instead of looping forever.
 */
function assignTiersTopDown(
    compIds: string[],
    childrenOf: Map<string, string[]>,
    parentsOf: Map<string, string[]>
): Map<string, number> {
    const tier = new Map<string, number>();
    const indeg = new Map<string, number>();
    for (const id of compIds) {
        tier.set(id, -1);
        indeg.set(id, parentsOf.get(id)?.length ?? 0);
    }

    const queue: string[] = [];
    for (const id of compIds) {
        if ((indeg.get(id) ?? 0) === 0) {
            tier.set(id, 0);
            queue.push(id);
        }
    }
    if (queue.length === 0 && compIds.length > 0) {
        // Pure cycle: seed the node closest to a source (fewest parents).
        let best = compIds[0];
        for (const id of compIds) {
            if ((indeg.get(id) ?? 0) < (indeg.get(best) ?? 0)) best = id;
        }
        tier.set(best, 0);
        queue.push(best);
    }

    const bestKnown = new Map<string, number>();
    while (queue.length > 0) {
        const cur = queue.shift()!;
        const ct = tier.get(cur)!;
        for (const child of childrenOf.get(cur) ?? []) {
            bestKnown.set(child, Math.max(bestKnown.get(child) ?? -1, ct));
            const rem = (indeg.get(child) ?? 0) - 1;
            indeg.set(child, rem);
            if (rem <= 0 && (tier.get(child) ?? -1) < 0) {
                tier.set(child, (bestKnown.get(child) ?? -1) + 1);
                queue.push(child);
            }
        }
    }

    // Cycle leftovers: parents-first, each above its best-known parent tier.
    let guard = compIds.length + 5;
    let pending = compIds.filter(id => (tier.get(id) ?? -1) < 0);
    while (pending.length > 0 && guard-- > 0) {
        pending.sort((a, b) => (bestKnown.get(b) ?? -1) - (bestKnown.get(a) ?? -1));
        const id = pending[0];
        const t = Math.max(0, (bestKnown.get(id) ?? -1) + 1);
        tier.set(id, t);
        for (const child of childrenOf.get(id) ?? []) {
            bestKnown.set(child, Math.max(bestKnown.get(child) ?? -1, t));
        }
        pending = compIds.filter(x => (tier.get(x) ?? -1) < 0);
    }
    for (const id of compIds) {
        if ((tier.get(id) ?? -1) < 0) tier.set(id, 0);
    }
    return tier;
}

// ============================================================================
// Step 6 (global part) — per-tier visit order following port-ordered children
// ============================================================================

/**
 * DFS from the tier-0 sources following Step-6-ordered children, bucketing
 * nodes per tier. Siblings therefore appear left-to-right in output-port
 * order, which is what keeps descending wires from crossing.
 */
function computeTierOrderTopDown(
    compIds: string[],
    sortedOut: Map<string, Edge[]>,
    itemsById: Map<string, CanvasItem>,
    tierMap: Map<string, number>
): Map<number, string[]> {
    let maxTier = 0;
    for (const id of compIds) maxTier = Math.max(maxTier, tierMap.get(id) ?? 0);

    const orders = new Map<number, string[]>();
    for (let t = 0; t <= maxTier; t++) orders.set(t, []);
    const visited = new Set<string>();
    const getItemX = (id: string) => itemsById.get(id)?.position.x ?? 0;

    const pushToTier = (id: string) => {
        const arr = orders.get(tierMap.get(id) ?? 0)!;
        if (!arr.includes(id)) arr.push(id);
    };

    const traverse = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        pushToTier(id);
        const seen = new Set<string>();
        for (const e of sortedOut.get(id) ?? []) {
            if (seen.has(e.to)) continue;
            seen.add(e.to);
            traverse(e.to);
        }
    };

    let roots = compIds
        .filter(id => (tierMap.get(id) ?? 0) === 0)
        .sort((a, b) => getItemX(a) - getItemX(b));
    if (roots.length === 0) {
        const minTier = Math.min(...compIds.map(id => tierMap.get(id) ?? 0));
        roots = compIds
            .filter(id => (tierMap.get(id) ?? 0) === minTier)
            .sort((a, b) => getItemX(a) - getItemX(b));
    }
    for (const rid of roots) traverse(rid);

    for (let t = 0; t <= maxTier; t++) {
        const arr = orders.get(t)!;
        const tierSet = new Set(compIds.filter(id => (tierMap.get(id) ?? 0) === t));
        const remaining = [...tierSet].filter(id => !arr.includes(id)).sort((a, b) => getItemX(a) - getItemX(b));
        orders.set(t, [...arr, ...remaining]);
    }
    return orders;
}

// ============================================================================
// Per-band vertical sizing — each gap sized to its own content (Steps 1-8)
// ============================================================================

/**
 * Tallest collision cluster in a label set. Union-find over horizontal
 * overlap: labels whose x-extents intersect must serialize (sum of heights +
 * pads); disjoint labels render in parallel and only the tallest counts.
 */
function maxClusterStack(labels: BandLabel[]): number {
    const n = labels.length;
    if (n === 0) return 0;
    const par = labels.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const a = labels[i];
            const b = labels[j];
            if (a.x0 < b.x1 && b.x0 < a.x1) par[find(i)] = find(j);
        }
    }
    const sum = new Map<number, number>();
    const cnt = new Map<number, number>();
    labels.forEach((l, i) => {
        const r = find(i);
        sum.set(r, (sum.get(r) ?? 0) + l.h);
        cnt.set(r, (cnt.get(r) ?? 0) + 1);
    });
    let best = 0;
    for (const [r, s] of sum) {
        best = Math.max(best, s + BAND.LABEL_PAD * ((cnt.get(r) ?? 1) - 1));
    }
    return best;
}

// ============================================================================
// Steps 3/5/7/9 — two-pass placement for one connected component
// ============================================================================

function layoutComponent(
    compIds: string[],
    compEdges: Edge[],
    itemsById: Map<string, CanvasItem>,
    gapFactor: number,
    labelCfg: LabelCfg
): Map<string, { x: number; y: number }> {
    const compSet = new Set(compIds);
    const boxes = new Map<string, RenderBox>();
    for (const id of compIds) boxes.set(id, renderedBox(itemsById.get(id)!));

    // --- Unique directed adjacency (multi-wire pairs count once for tiers) --
    const childrenOf = new Map<string, string[]>();
    const parentsOf = new Map<string, string[]>();
    for (const id of compIds) {
        childrenOf.set(id, []);
        parentsOf.set(id, []);
    }
    const seenPair = new Set<string>();
    for (const e of compEdges) {
        if (!compSet.has(e.from) || !compSet.has(e.to)) continue;
        if (e.from === e.to) continue;
        const k = e.from + '>' + e.to;
        if (seenPair.has(k)) continue;
        seenPair.add(k);
        childrenOf.get(e.from)!.push(e.to);
        parentsOf.get(e.to)!.push(e.from);
    }

    // --- Step 2: tiers from the source outward ------------------------------
    const tierMap = assignTiersTopDown(compIds, childrenOf, parentsOf);
    let maxTier = 0;
    for (const id of compIds) maxTier = Math.max(maxTier, tierMap.get(id) ?? 0);

    // --- Step 6: port-ordered children --------------------------------------
    // outByFrom keeps EVERY connector in sheet order (including same-tier and
    // multi-wire pairs): the exact sibling set the router ranks for its bus
    // stagger, in the exact order its stable sort preserves on ties.
    const outByFrom = new Map<string, Edge[]>();
    for (const id of compIds) outByFrom.set(id, []);
    for (const e of compEdges) {
        if (compSet.has(e.from) && compSet.has(e.to) && e.from !== e.to) {
            outByFrom.get(e.from)!.push(e);
        }
    }
    const sortedOut = new Map<string, Edge[]>();
    for (const id of compIds) {
        const sorted = sortChildEdges(itemsById.get(id), outByFrom.get(id) ?? [], itemsById);
        const deduped: Edge[] = [];
        const seenChild = new Set<string>();
        for (const e of sorted) {
            if (seenChild.has(e.to)) continue;
            seenChild.add(e.to);
            deduped.push(e);
        }
        sortedOut.set(id, deduped);
    }
    const tierOrders = computeTierOrderTopDown(compIds, sortedOut, itemsById, tierMap);

    // --- Primary parents: each node belongs to exactly one subtree ---------
    // (the closest-to-source feed; port order breaks ties) so shared
    // descendants are measured and placed once instead of once per feed.
    const primaryOf = new Map<string, string | null>();
    for (const id of compIds) {
        const feeders = (sortedOut.size ? parentsOf.get(id) ?? [] : []).slice();
        if (feeders.length === 0) {
            primaryOf.set(id, null);
            continue;
        }
        feeders.sort((a, b) => {
            const ta = tierMap.get(a) ?? 0;
            const tb = tierMap.get(b) ?? 0;
            if (ta !== tb) return ta - tb;
            return a < b ? -1 : 1;
        });
        primaryOf.set(id, feeders[0]);
    }
    const kids = new Map<string, string[]>();
    for (const id of compIds) kids.set(id, []);
    for (const id of compIds) {
        const p = primaryOf.get(id);
        if (p) kids.get(p)!.push(id);
    }
    for (const [pid, list] of kids) {
        const order = new Map((sortedOut.get(pid) ?? []).map((e, i) => [e.to, i] as [string, number]));
        list.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
    }

    // --- Step 3: footprint widths, bottom-up --------------------------------
    // Adjacent subtree spans pack TOUCHING (zero slack). The old formula
    // scaled the slack with whole-subtree size:
    //   edgeGap = requiredGap(fa, fb) - (fa + fb) / 2 = mean * (factor - 1)
    // so two 1200px subtrees at factor 1.8 opened ~960px of dead air between
    // the boundary boxes (the "too big" cross-parent gap in wide SLDs).
    // Spacing authority is Step 5 (settleX), which expands each tier to the
    // BOX-based minimum. Starting touching is safe: settleX only ever shifts
    // rightward to reach that minimum, and parents re-centre afterwards.
    const edgeGap = (fa: number, fb: number): number => 0;
    const spanOf = (widths: number[]): number => {
        if (widths.length === 0) return 0;
        let span = widths[0];
        for (let i = 1; i < widths.length; i++) span += edgeGap(widths[i - 1], widths[i]) + widths[i];
        return span;
    };

    const fp = new Map<string, number>();
    const footprint = (id: string, stack: Set<string>): number => {
        const memo = fp.get(id);
        if (memo !== undefined) return memo;
        if (stack.has(id)) return boxes.get(id)!.w; // cycle guard
        stack.add(id);
        const kl = kids.get(id) ?? [];
        const own = boxes.get(id)!.w;
        const span = kl.length === 0 ? own : Math.max(own, spanOf(kl.map(c => footprint(c, stack))));
        stack.delete(id);
        fp.set(id, span);
        return span;
    };
    for (const id of compIds) footprint(id, new Set());

    // --- Step 7 (pass 1): top-down X placement ------------------------------
    // X never depends on Y, so the full horizontal layout (placement +
    // centre/expand sweeps) settles first; band heights are sized from the
    // final X geometry afterwards.
    const pos = new Map<string, { x: number; y: number }>();
    const centerOf = (id: string): number => {
        const p = pos.get(id)!;
        const b = boxes.get(id)!;
        return p.x + b.dx0 + b.w / 2;
    };
    const place = (id: string, centerX: number, ancestors: Set<string>): void => {
        if (pos.has(id) || ancestors.has(id)) return;
        ancestors.add(id);
        const b = boxes.get(id)!;
        pos.set(id, { x: centerX - b.dx0 - b.w / 2, y: 0 }); // Y assigned after band sizing
        const kl = kids.get(id) ?? [];
        if (kl.length > 0) {
            const fws = kl.map(c => fp.get(c) ?? boxes.get(c)!.w);
            let start = centerX - spanOf(fws) / 2;
            kl.forEach((c, i) => {
                place(c, start + fws[i] / 2, ancestors);
                start += fws[i] + (i + 1 < fws.length ? edgeGap(fws[i], fws[i + 1]) : 0);
            });
        }
        ancestors.delete(id);
    };

    const roots = [...(tierOrders.get(0) ?? compIds.filter(id => (tierMap.get(id) ?? 0) === 0))];
    let cursor = 0;
    roots.forEach((rid, i) => {
        const fw = fp.get(rid) ?? boxes.get(rid)!.w;
        place(rid, cursor + fw / 2, new Set());
        const next = roots[i + 1];
        cursor += fw + (next ? edgeGap(fw, fp.get(next) ?? boxes.get(next)!.w) : 0);
    });
    // Anything unreachable via primary links (cycle fragments): append slots.
    const leftovers = compIds
        .filter(id => !pos.has(id))
        .sort((a, b) => (tierMap.get(a) ?? 0) - (tierMap.get(b) ?? 0));
    for (const id of leftovers) {
        const fw = fp.get(id) ?? boxes.get(id)!.w;
        place(id, cursor + fw / 2, new Set());
        cursor += fw + edgeGap(fw, fw);
    }

    const shiftSubtree = (id: string, dx: number): void => {
        if (dx === 0) return;
        const visited = new Set<string>();
        const stack = [id];
        while (stack.length > 0) {
            const cur = stack.pop()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            pos.get(cur)!.x += dx;
            for (const c of kids.get(cur) ?? []) stack.push(c);
        }
    };

    const tierBuckets = new Map<number, string[]>();
    for (let t = 0; t <= maxTier; t++) {
        tierBuckets.set(t, compIds.filter(id => (tierMap.get(id) ?? 0) === t));
    }
    // All placed children (primary + shared feeds) centre a parent.
    const allChildrenOf = (id: string): string[] => {
        const out = new Set<string>();
        for (const e of sortedOut.get(id) ?? []) {
            if (pos.has(e.to)) out.add(e.to);
        }
        for (const c of kids.get(id) ?? []) {
            if (pos.has(c)) out.add(c);
        }
        return [...out];
    };

    // --- Steps 5 + 7: centre parents, expand tight gaps, repeat to settle --
    // X-only: safe to re-run after any horizontal shift (label clearance).
    const settleX = (): void => {
        for (let sweep = 0; sweep < CONFIG.MAX_SWEEPS; sweep++) {
            let changed = false;
            for (let t = maxTier; t >= 0; t--) {
                // Step 7 — parent X = midpoint of first/last placed child.
                for (const id of tierBuckets.get(t) ?? []) {
                    const ch = allChildrenOf(id);
                    if (ch.length === 0) continue;
                    const xs = ch.map(centerOf);
                    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
                    const dx = mid - centerOf(id);
                    if (Math.abs(dx) > 1e-9) {
                        pos.get(id)!.x += dx;
                        changed = true;
                    }
                }
                // Step 5 — left-to-right: grow any gap below the Step-4 minimum
                // by shifting the whole right subtree, never just the node.
                const ids = (tierBuckets.get(t) ?? []).slice().sort((a, b) => centerOf(a) - centerOf(b));
                for (let i = 1; i < ids.length; i++) {
                    const A = ids[i - 1];
                    const B = ids[i];
                    const need = requiredGap(boxes.get(A)!.w, boxes.get(B)!.w, gapFactor);
                    const have = centerOf(B) - centerOf(A);
                    if (have < need - 1e-9) {
                        shiftSubtree(B, need - have);
                        changed = true;
                    }
                }
            }
            if (!changed) break;
        }
    };
    settleX();

    // --- Leaf-block compaction: slide childless runs, never move larges ----
    // Footprint placement gives every subtree an exclusive X corridor. Pulling
    // a LARGE subtree (one with downstream boards/loads) toward a neighbouring
    // leaf overlaps two large downstream spans in X and crosses DB->board
    // wires in the shared band (the yellow/blue tangle). So large positions
    // from footprint placement are frozen.
    // Only consecutive LEAF siblings (no primary children: AC/Geyser/Avg-5A
    // with no outgoing) slide as a rigid block, preserving port order so
    // wires never cross:
    //   run at list start -> shift whole block right to hug the next large;
    //   run in middle/end -> shift whole block left to hug the previous sib.
    // Internal leaf-leaf gaps are already box-minimal, so the block stays
    // rigid. Edge blocks moving inward is what saves the AC-vs-SPN gaps.
    // Parents re-centre afterwards via settleX(); later label clearance and
    // final validation re-expand only if exact rects touch.
    const isLeaf = (id: string): boolean => (kids.get(id) ?? []).length === 0;
    const compactLeaves = (): void => {
        for (let sweep = 0; sweep < CONFIG.MAX_SWEEPS; sweep++) {
            let moved = false;
            for (const [, list] of kids) {
                if (list.length < 2) continue;
                // Visual order must match port order; otherwise wires already
                // cross — leave that parent alone.
                let ordered = true;
                for (let i = 1; i < list.length; i++) {
                    if (centerOf(list[i]) < centerOf(list[i - 1]) - 1e-9) { ordered = false; break; }
                }
                if (!ordered) continue;
                let i = 0;
                while (i < list.length) {
                    if (!isLeaf(list[i])) { i++; continue; }
                    let j = i;
                    while (j + 1 < list.length && isLeaf(list[j + 1])) j++;
                    // Leaf run list[i..j].
                    if (i === 0 && j === list.length - 1) { i = j + 1; continue; } // all leaves: already minimal
                    if (i > 0) {
                        const P = list[i - 1];
                        const F = list[i];
                        const need = requiredGap(boxes.get(P)!.w, boxes.get(F)!.w, gapFactor);
                        const have = centerOf(F) - centerOf(P);
                        if (have > need + 1e-9) {
                            const dx = -(have - need);
                            for (let k = i; k <= j; k++) shiftSubtree(list[k], dx);
                            moved = true;
                        }
                    } else {
                        const L = list[j];
                        const N = list[j + 1];
                        const need = requiredGap(boxes.get(L)!.w, boxes.get(N)!.w, gapFactor);
                        const have = centerOf(N) - centerOf(L);
                        if (have > need + 1e-9) {
                            const dx = have - need;
                            for (let k = i; k <= j; k++) shiftSubtree(list[k], dx);
                            moved = true;
                        }
                    }
                    i = j + 1;
                }
            }
            if (!moved) break;
            settleX();
        }
    };
    compactLeaves();

    // --- Step 7 (pass 2): per-band heights from band content ----------------
    // Band g spans tier-g's lowest box bottom to tier-(g+1)'s tops. All
    // vertical offsets below are measured from the band top under the
    // worst-case assumption that a source port sits exactly on the lowest
    // box bottom (taller neighbours only ever push a source's stack higher,
    // i.e. into MORE room — the safe direction).
    // lowest rendered bottom edge in the tier (box bottom plus any downward
    // port-marker overhang). Band g is measured from this edge.
    const tierBot: number[] = [];
    for (let t = 0; t <= maxTier; t++) {
        let mb = 0;
        for (const id of tierBuckets.get(t) ?? []) {
            const b = boxes.get(id)!;
            mb = Math.max(mb, b.dy0 + b.h);
        }
        tierBot.push(mb > 0 ? mb : 100);
    }

    // Final-geometry port X, mirroring the router (own key, else box centre).
    const srcPortX = (e: Edge): number => {
        const p = pos.get(e.from)!;
        const it = itemsById.get(e.from)!;
        const cp = it.connectionPoints?.[e.sourcePointKey];
        return p.x + (cp?.x ?? getWidth(it) / 2);
    };
    const tgtPortX = (e: Edge): number => {
        const p = pos.get(e.to)!;
        const it = itemsById.get(e.to)!;
        const cp = it.connectionPoints?.[e.targetPointKey];
        return p.x + (cp?.x ?? getWidth(it) / 2);
    };

    type WireEst = {
        edge: Edge;
        s: number;
        t: number;
        sx: number;
        tx: number;
        rank: number;
        busLen: number;
        specText: string | null;
        specW: number;
    };
    const wires: WireEst[] = [];
    // Exact router rank replication, recomputable after any X shift: per
    // source, siblings in sheet order, each measured from the current wire's
    // own source port with a stable farthest-first sort (mirrors
    // ConnectorUtils.calculateTargetXRank, including its per-wire rankings —
    // two wires CAN share a bus level; only spec labels get horizontal
    // clearance in Step 5, current-value labels are ignored by design).
    const computeRanks = (): Map<Edge, number> => {
        const rankOf = new Map<Edge, number>();
        for (const [, list] of outByFrom) {
            if (list.length === 0) continue;
            list.forEach((e, idx) => {
                (e as { __i?: number }).__i = idx;
            });
            for (const cur of list) {
                const ox = srcPortX(cur);
                const ordered = list.slice().sort((a, b) => {
                    const da = Math.abs(tgtPortX(a) - ox);
                    const db = Math.abs(tgtPortX(b) - ox);
                    if (da !== db) return db - da;
                    return ((a as { __i?: number }).__i ?? 0) - ((b as { __i?: number }).__i ?? 0);
                });
                rankOf.set(cur, ordered.indexOf(cur));
            }
            for (const e of list) {
                delete (e as { __i?: number }).__i;
            }
        }
        return rankOf;
    };
    let rankOf = computeRanks();
    if (maxTier > 0) {
        for (const e of compEdges) {
            const s = tierMap.get(e.from) ?? 0;
            const t = tierMap.get(e.to) ?? 0;
            if (t <= s) continue; // same-tier/backfeed wires route inside the row, not bands
            const sx = srcPortX(e);
            const tx = tgtPortX(e);
            const srcName = itemsById.get(e.from)?.name ?? '';
            const tgtName = itemsById.get(e.to)?.name ?? '';
            const specText = labelCfg.showSpecs ? specTextFor(e.conn, srcName, tgtName) : null;
            wires.push({
                edge: e, s, t, sx, tx,
                rank: rankOf.get(e) ?? 0,
                busLen: Math.abs(sx - tx),
                specText,
                specW: specText ? specText.length * labelCfg.specFont * BAND.SPEC_TEXT_K : 0
            });
        }
    }

    // Per-source bus-stack reservation in its origin band: the staggered
    // horizontal bus lines occupy 30px offset + 25px per branch rank below
    // the stub exit, i.e. (relative to the content zone below TOP) 22px for
    // the first bus plus a 22px elbow-label tail — 40px + 25px per rank.
    // Depth uses the SIBLING COUNT (not the observed max rank): ranks are
    // per-wire orderings, so any down wire can in principle take any rank up
    // to siblings-1, and the reservation must hold under every permutation.
    // Sizing every band to fit its stacks guarantees the router never has to
    // abandon bus routing for an L-fallback, so these estimates stay valid.
    const srcStack: number[] = new Array<number>(Math.max(0, maxTier)).fill(0);
    for (const w of wires) {
        const sibs = outByFrom.get(w.edge.from)?.length ?? 1;
        srcStack[w.s] = Math.max(srcStack[w.s], 40 + Math.max(0, sibs - 1) * ROUTER.STAGGER);
    }

    const bandLabels: BandLabel[][] = new Array<BandLabel[]>(Math.max(0, maxTier));
    for (let g = 0; g < bandLabels.length; g++) bandLabels[g] = [];

    // NOTE: no current-value labels are added here by design. Only spec
    // labels participate in vertical band sizing, so live currents never
    // push rows apart.

    const sizeBands = (): number[] => {
        const H: number[] = [];
        for (let g = 0; g < maxTier; g++) {
            const content = Math.max(BAND.FLOOR_STACK, srcStack[g] ?? 0, maxClusterStack(bandLabels[g]));
            const base = Math.max(BAND.MIN_H, BAND.TOP + content + BAND.BOT);
            // Tail tightening: the last two inter-tier gaps render mostly short
            // cable-spec / current-value labels, so shave a small fixed trim.
            // Never cut into the router's bus-stack reservation
            // (TOP + srcStack + BOT) — that would force an L-fallback — nor
            // below the tail absolute floor.
            if (g >= maxTier - 2 && maxTier >= 2) {
                const routerSafe = BAND.TOP + (srcStack[g] ?? 0) + BAND.BOT;
                H.push(Math.max(routerSafe, BAND.TAIL_MIN_H, base - BAND.TAIL_TRIM));
            } else {
                H.push(base);
            }
        }
        return H;
    };

    // Spec-label refinement rounds. The router draws a spec label on the
    // LONGEST segment that fits its width; longer bands only ever make more
    // candidates fit, so labels accumulate monotonically and anchors frozen
    // on first placement stay valid as bands grow. Re-choosing every round
    // (instead of locking the first pick) keeps the superset valid even when
    // growth flips which segment is longest.
    let H = sizeBands();
    const addedChoice = new Set<string>();
    wires.forEach((w, i) => ((w as unknown as { __wi: number }).__wi = i));
    for (let round = 0; round < 4; round++) {
        const tops = [0];
        for (let g = 0; g < maxTier; g++) tops.push(tops[g] + tierBot[g] + H[g]);
        let added = false;
        const addSpec = (w: WireEst, choice: string, label: BandLabel) => {
            const wi = (w as unknown as { __wi: number }).__wi;
            const key = wi + ':' + choice;
            if (addedChoice.has(key)) return;
            addedChoice.add(key);
            bandLabels[label.band].push(label);
            added = true;
        };
        for (const w of wires) {
            if (!w.specText || w.specW <= 0) continue;
            if (w.t === w.s + 1) {
                // Vertical room below this wire's own bus line (conservative
                // port-at-lowest-bottom) versus the sideways elbow length.
                const drop = H[w.s] - BAND.TOP - (ROUTER.STUB + ROUTER.BUS + w.rank * ROUTER.STAGGER) - BAND.BOT;
                const srcVert = ROUTER.BUS + w.rank * ROUTER.STAGGER;
                const cands = [
                    { len: srcVert, kind: 'src' },
                    { len: w.busLen, kind: 'elbow' },
                    { len: drop, kind: 'drop' }
                ].filter(c => c.len >= w.specW);
                if (cands.length === 0) continue; // router skips it too — no room
                // Longest wins; ties follow path order (source stub, bus, drop).
                const order = (k: string) => (k === 'src' ? 0 : k === 'elbow' ? 1 : 2);
                cands.sort((a, b) => (b.len !== a.len ? b.len - a.len : order(a.kind) - order(b.kind)));
                const win = cands[0].kind;
                if (win === 'src') {
                    addSpec(w, 'src', {
                        band: w.s, x0: w.sx + 3, x1: w.sx + 5 + labelCfg.specFont * 1.2,
                        h: w.specW, top: BAND.TOP
                    });
                } else if (win === 'elbow') {
                    const mid = (w.sx + w.tx) / 2;
                    addSpec(w, 'elbow', {
                        band: w.s, x0: mid - w.specW / 2, x1: mid + w.specW / 2,
                        h: labelCfg.specFont * 1.2,
                        top: ROUTER.STUB + ROUTER.BUS + w.rank * ROUTER.STAGGER + 5
                    });
                } else {
                    addSpec(w, 'drop', {
                        band: w.s, x0: w.tx + 3, x1: w.tx + 5 + labelCfg.specFont * 1.2,
                        h: w.specW, top: BAND.TOP + (H[w.s] - BAND.TOP - BAND.BOT) / 2 - w.specW / 2
                    });
                }
            } else {
                // Skip-tier feed: the drop dwarfs every band; anchor the
                // rotated spec where the router centres it — mid-drop — in
                // whichever band that falls in (frozen on first placement).
                const busAbs = tops[w.s] + tierBot[w.s] + ROUTER.STUB + ROUTER.BUS + w.rank * ROUTER.STAGGER;
                const tgtAbs = tops[w.t];
                const dropLen = tgtAbs - busAbs;
                if (dropLen < w.specW) continue; // router skips it too
                const midY = (busAbs + tgtAbs) / 2;
                let m = w.s;
                for (let g = w.s; g < w.t; g++) {
                    const gTop = tops[g] + tierBot[g];
                    if (midY >= gTop && midY <= gTop + H[g]) {
                        m = g;
                        break;
                    }
                    if (g === w.t - 1) m = g;
                }
                addSpec(w, 'drop' + m, {
                    band: m, x0: w.tx + 3, x1: w.tx + 5 + labelCfg.specFont * 1.2,
                    h: w.specW, top: 0
                });
            }
        }
        if (!added) break;
        H = sizeBands();
    }
    for (const w of wires) delete (w as unknown as { __wi?: number }).__wi;

    // --- Y assignment: tier tops + per-tier box heights + per-band heights --
    const tierTop = [0];
    for (let g = 0; g < maxTier; g++) tierTop.push(tierTop[g] + tierBot[g] + H[g]);
    for (const id of compIds) {
        pos.get(id)!.y = tierTop[tierMap.get(id) ?? 0];
    }

    // --- Step 5 (horizontal label clearance, spec labels only) --------------
    // Vertical room is settled; what remains are spec labels sharing a
    // height. Current-value labels are ignored here by design (they may
    // overlap after arrange — the canvas overlay draws them regardless).
    // With final X and final Y known — and bus routing guaranteed by the
    // stack reservations — every spec label rect below is EXACT, so any
    // strict overlap is resolved by shifting an anchor subtree right (whole
    // subtrees only, never bare nodes), then re-settling X. Same-anchor
    // labels share a column by construction; the band stacks already fit
    // them, so they are left alone.
    const offsetPt = (id: string, key: string): { x: number; y: number } => {
        const it = itemsById.get(id)!;
        const p = pos.get(id)!;
        const w = getWidth(it);
        const h = getHeight(it);
        const cp = it.connectionPoints?.[key];
        const ox = p.x + (cp?.x ?? w / 2);
        const oy = p.y + (cp?.y ?? h / 2);
        const dl = Math.abs(ox - p.x);
        const dr = Math.abs(ox - (p.x + w));
        const dt = Math.abs(oy - p.y);
        const db = Math.abs(oy - (p.y + h));
        const m = Math.min(dl, dr, dt, db);
        if (m === dl) return { x: ox - ROUTER.STUB, y: oy };
        if (m === dr) return { x: ox + ROUTER.STUB, y: oy };
        if (m === dt) return { x: ox, y: oy - ROUTER.STUB };
        return { x: ox, y: oy + ROUTER.STUB };
    };

    type LabelRect = { x0: number; y0: number; x1: number; y1: number; anchor: string };

    const buildLabelRects = (): LabelRect[] => {
        rankOf = computeRanks();
        const rects: LabelRect[] = [];
        for (const w of wires) {
            const e = w.edge;
            const rank = rankOf.get(e) ?? 0;
            const start = offsetPt(e.from, e.sourcePointKey);
            const end = offsetPt(e.to, e.targetPointKey);
            const busY = start.y + ROUTER.BUS + rank * ROUTER.STAGGER;
            // NOTE: current-value labels intentionally skipped — no rects,
            // no clearance, so live currents never spread subtrees apart.
            if (!w.specText || w.specW <= 0) continue;
            const dropLen = end.y - busY;
            const busLen = Math.abs(start.x - end.x);
            const srcLen = ROUTER.BUS + rank * ROUTER.STAGGER;
            const cands = [
                { len: srcLen, kind: 'src' },
                { len: busLen, kind: 'elbow' },
                { len: dropLen, kind: 'drop' }
            ].filter(c => c.len >= w.specW);
            if (cands.length === 0) continue; // router skips it too
            const order = (k: string) => (k === 'src' ? 0 : k === 'elbow' ? 1 : 2);
            cands.sort((a, b) => (b.len !== a.len ? b.len - a.len : order(a.kind) - order(b.kind)));
            const win = cands[0].kind;
            const sh = labelCfg.specFont * 1.2;
            if (win === 'src') {
                const mid = (start.y + busY) / 2;
                rects.push({
                    x0: start.x + 5, y0: mid - w.specW / 2,
                    x1: start.x + 5 + sh, y1: mid + w.specW / 2,
                    anchor: e.from
                });
            } else if (win === 'elbow') {
                const mid = (start.x + end.x) / 2;
                rects.push({
                    x0: mid - w.specW / 2, y0: busY + 5,
                    x1: mid + w.specW / 2, y1: busY + 5 + sh,
                    anchor: e.to
                });
            } else {
                const mid = (busY + end.y) / 2;
                rects.push({
                    x0: end.x + 5, y0: mid - w.specW / 2,
                    x1: end.x + 5 + sh, y1: mid + w.specW / 2,
                    anchor: e.to
                });
            }
        }
        return rects;
    };

    const descMemo = new Map<string, Set<string>>();
    const descendantsOf = (id: string): Set<string> => {
        const hit = descMemo.get(id);
        if (hit) return hit;
        const out = new Set<string>([id]);
        const stack = [id];
        while (stack.length > 0) {
            const cur = stack.pop()!;
            for (const c of kids.get(cur) ?? []) {
                if (!out.has(c)) {
                    out.add(c);
                    stack.push(c);
                }
            }
        }
        descMemo.set(id, out);
        return out;
    };

    const clearLabels = (): void => {
        for (let round = 0; round < 10; round++) {
            const rects = buildLabelRects()
                .sort((a, b) => (a.x0 !== b.x0 ? a.x0 - b.x0 : a.y0 - b.y0));
            const need = new Map<string, number>();
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    const A = rects[i];
                    const B = rects[j];
                    if (B.x0 >= A.x1) break;
                    if (!(A.x0 < B.x1 && A.y0 < B.y1 && B.y0 < A.y1)) continue;
                    const overlapX = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
                    let moveId = B.anchor;
                    if (moveId !== A.anchor && descendantsOf(moveId).has(A.anchor)) {
                        moveId = A.anchor; // shifting B would carry A along — move A instead
                    }
                    if (moveId === A.anchor && moveId === B.anchor) continue; // same column by construction
                    need.set(moveId, Math.max(need.get(moveId) ?? 0, overlapX + CONFIG.LANE_PX));
                }
            }
            if (need.size === 0) break;
            for (const [id, dx] of need) shiftSubtree(id, dx);
        }
    };

    const xSignature = (): number => {
        let sig = 0;
        for (const id of compIds) sig += pos.get(id)!.x;
        return sig;
    };
    for (let outer = 0; outer < 3; outer++) {
        const before = xSignature();
        clearLabels();
        settleX();
        if (xSignature() === before) break;
    }

    // --- Step 9: final validation — rendered boxes must not touch -----------
    // Same-tier adjacency is already exact and cross-tier rows are separated
    // by floored bands; this catches pathological leftovers (cycle stacks,
    // unusually wide port stubs). Nudge the right subtree by the overlap
    // plus one wire-lane increment — the smallest move that clears.
    const left = (id: string) => pos.get(id)!.x + boxes.get(id)!.dx0;
    const right = (id: string) => left(id) + boxes.get(id)!.w;
    const top = (id: string) => pos.get(id)!.y + boxes.get(id)!.dy0;
    const bottom = (id: string) => top(id) + boxes.get(id)!.h;
    for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        const ordered = compIds.slice().sort((a, b) => left(a) - left(b));
        for (let i = 0; i < ordered.length; i++) {
            for (let j = i + 1; j < ordered.length; j++) {
                if (left(ordered[j]) >= right(ordered[i])) break;
                const A = ordered[i];
                const B = ordered[j];
                if (top(B) < bottom(A) && top(A) < bottom(B)) {
                    shiftSubtree(B, right(A) - left(B) + CONFIG.LANE_PX);
                    moved = true;
                }
            }
        }
        if (!moved) break;
    }

    return pos;
}

// ============================================================================
// Main entry
// ============================================================================

export const applyAutoArrange = (
    items: CanvasItem[],
    connectors: Connector[],
    downstreamGapFactor: number = DEFAULT_DOWNSTREAM_GAP_FACTOR
): CanvasItem[] => {
    if (items.length === 0) return items;
    const gapFactor = clampFactor(downstreamGapFactor);
    const labelCfg = readLabelCfg();

    const itemsById = new Map(items.map(i => [i.uniqueID, i]));

    // === STEP 1: real dependency graph from the wire list ===================
    // Parents = whatever each node is actually wired FROM. Node kind is
    // never consulted here.
    const edges: Edge[] = [];
    for (const conn of connectors) {
        const from = conn.sourceItem?.uniqueID;
        const to = conn.targetItem?.uniqueID;
        if (!from || !to) continue;
        if (!itemsById.has(from) || !itemsById.has(to)) continue;
        edges.push({
            from,
            to,
            sourcePointKey: conn.sourcePointKey,
            targetPointKey: conn.targetPointKey,
            conn
        });
    }

    if (edges.length === 0) return items;

    // === Connected components (union-find over undirected wiring) ===========
    const connectedIds = new Set<string>();
    for (const e of edges) {
        connectedIds.add(e.from);
        connectedIds.add(e.to);
    }

    const connectedArr = Array.from(connectedIds);
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < connectedArr.length; i++) {
        idToIdx.set(connectedArr[i], i);
    }

    const parent = new Array<number>(connectedArr.length);
    for (let i = 0; i < connectedArr.length; i++) {
        parent[i] = i;
    }

    const find = (i: number): number => {
        if (parent[i] !== i) {
            parent[i] = find(parent[i]);
        }
        return parent[i];
    };

    const union = (a: number, b: number) => {
        parent[find(a)] = find(b);
    };

    for (const e of edges) {
        const a = idToIdx.get(e.from);
        const b = idToIdx.get(e.to);
        if (a !== undefined && b !== undefined) {
            union(a, b);
        }
    }

    const groups = new Map<number, string[]>();
    for (let i = 0; i < connectedArr.length; i++) {
        const r = find(i);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(connectedArr[i]);
    }

    const components: string[][] = Array.from(groups.values());

    // Sort components by leftmost item X position
    const componentMinX = (ids: string[]): number => {
        let min = Infinity;
        for (const id of ids) {
            const it = itemsById.get(id);
            if (it && it.position.x < min) min = it.position.x;
        }
        return min === Infinity ? 0 : min;
    };

    components.sort((a, b) => componentMinX(a) - componentMinX(b));

    // Calculate global base position
    let globalBaseX = Infinity;
    let globalBaseY = Infinity;
    for (const c of components) {
        globalBaseX = Math.min(globalBaseX, componentMinX(c));
        let minY = Infinity;
        for (const id of c) {
            const it = itemsById.get(id);
            if (it && it.position.y < minY) minY = it.position.y;
        }
        globalBaseY = Math.min(globalBaseY, minY === Infinity ? 0 : minY);
    }
    if (globalBaseX === Infinity) globalBaseX = 0;
    if (globalBaseY === Infinity) globalBaseY = 0;

    // === Lay out each component (Steps 2-9) and pack side by side ===========
    const finalPos = new Map<string, { x: number; y: number }>();
    let packX = globalBaseX;

    for (const compIds of components) {
        const compSet = new Set(compIds);
        const compEdges = edges.filter(e => compSet.has(e.from) && compSet.has(e.to));

        const localPositions = layoutComponent(compIds, compEdges, itemsById, gapFactor, labelCfg);

        // Component bounding box (rendered extents, so port stubs stay packed)
        let minLX = Infinity;
        let maxRX = -Infinity;
        let minLY = Infinity;
        for (const id of compIds) {
            const p = localPositions.get(id);
            const item = itemsById.get(id)!;
            if (p) {
                const b = renderedBox(item);
                minLX = Math.min(minLX, p.x + b.dx0);
                minLY = Math.min(minLY, p.y + b.dy0);
                maxRX = Math.max(maxRX, p.x + b.dx0 + b.w);
            }
        }

        const compWidth = maxRX - minLX;

        // Translate to pack position
        for (const id of compIds) {
            const localPos = localPositions.get(id);
            if (localPos) {
                finalPos.set(id, {
                    x: packX + (localPos.x - minLX),
                    y: globalBaseY + (localPos.y - minLY)
                });
            }
        }

        packX += compWidth + CONFIG.GROUP_GAP_X;
    }

    // === Apply positions (locked items stay where the user put them) ========
    return items.map(it => {
        const p = finalPos.get(it.uniqueID);
        if (!p) return it;
        if (it.locked) return it;
        return { ...it, position: { x: p.x, y: p.y } };
    });
};
