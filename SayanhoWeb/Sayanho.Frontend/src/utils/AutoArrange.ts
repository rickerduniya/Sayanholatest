/**
 * Bottom-Up Auto Arrange Algorithm
 * 
 * Algorithm Overview:
 * 1. Assign tiers from bottom-up (leaf nodes = tier 0, their parents = tier 1, etc.)
 * 2. Place extreme downstream items first (tier 0) at the bottom
 * 3. Place upstream items centered horizontally between their connected downstream items
 * 4. Dynamic vertical gaps between tiers based on connector count passing through
 * 
 * This approach naturally minimizes crossings by centering parents above children.
 */

import { CanvasItem, Connector } from '../types';

// ============================================================================
// Types
// ============================================================================

type Edge = {
    from: string;       // Source (upstream) item ID
    to: string;         // Target (downstream) item ID
    sourcePointKey: string;
    targetPointKey: string;
};

type TierInfo = {
    tier: number;
    ids: string[];
};

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    GAP_X: 100,                    // Horizontal gap between items in same tier
    BASE_GAP_Y: 120,               // Minimum vertical gap between tiers
    GAP_Y_PER_CONNECTOR: 15,       // Additional gap per connector passing through
    MAX_GAP_Y: 400,                // Maximum vertical gap between tiers
    GROUP_GAP_X: 250               // Gap between disconnected components
};

// ============================================================================
// Helper Functions
// ============================================================================

const getWidth = (item: CanvasItem): number => item.size?.width ?? 100;
const getHeight = (item: CanvasItem): number => item.size?.height ?? 100;

const getConnectionPointX = (item: CanvasItem, pointKey: string): number => {
    return item.connectionPoints?.[pointKey]?.x ?? getWidth(item) / 2;
};

function computeTierOrdersTopDown(
    compIds: string[],
    compEdges: Edge[],
    itemsById: Map<string, CanvasItem>,
    tierMap: Map<string, number>
): Map<number, string[]> {
    const compSet = new Set(compIds);
    const outByFrom = new Map<string, Edge[]>();
    let maxTier = 0;
    for (const id of compIds) {
        outByFrom.set(id, []);
        maxTier = Math.max(maxTier, tierMap.get(id) ?? 0);
    }
    for (const e of compEdges) {
        if (!compSet.has(e.from) || !compSet.has(e.to)) continue;
        outByFrom.get(e.from)!.push(e);
    }

    const getItemX = (id: string) => itemsById.get(id)?.position.x ?? 0;

    const phaseIdx = (key: string) => {
        const k = (key || '').toLowerCase();
        if (k.includes('red') || k.includes(' r')) return 0;
        if (k.includes('yellow') || k.includes(' y')) return 1;
        if (k.includes('blue') || k.includes(' b')) return 2;
        if (k.includes('_r')) return 0;
        if (k.includes('_y')) return 1;
        if (k.includes('_b')) return 2;
        return 0;
    };
    const wayIdx = (key: string) => {
        const m = (key || '').match(/out(\d+)/i);
        return m ? parseInt(m[1], 10) : 9999;
    };

    const sortEdges = (parentId: string, edges: Edge[]) => {
        const parent = itemsById.get(parentId);
        if (parent && (parent.name || '').includes('HTPN')) {
            return edges.slice().sort((a, b) => {
                const pa = phaseIdx(a.sourcePointKey);
                const pb = phaseIdx(b.sourcePointKey);
                if (pa !== pb) return pa - pb;
                return wayIdx(a.sourcePointKey) - wayIdx(b.sourcePointKey);
            });
        }
        return edges.slice().sort((a, b) => {
            const fromItem = itemsById.get(a.from);
            const toItemA = itemsById.get(a.to);
            const fromXA = fromItem ? getConnectionPointX(fromItem, a.sourcePointKey) : 0;
            const toXA = toItemA ? getConnectionPointX(toItemA, a.targetPointKey) : 0;

            const fromItemB = itemsById.get(b.from);
            const toItemB = itemsById.get(b.to);
            const fromXB = fromItemB ? getConnectionPointX(fromItemB, b.sourcePointKey) : 0;
            const toXB = toItemB ? getConnectionPointX(toItemB, b.targetPointKey) : 0;

            if (fromXA !== fromXB) return fromXA - fromXB;
            return toXA - toXB;
        });
    };

    const orders = new Map<number, string[]>();
    for (let t = 0; t <= maxTier; t++) orders.set(t, []);
    const visited = new Set<string>();

    const pushToTier = (id: string) => {
        const t = tierMap.get(id) ?? 0;
        const arr = orders.get(t)!;
        if (!arr.includes(id)) arr.push(id);
    };

    const traverse = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        pushToTier(id);
        const children = sortEdges(id, outByFrom.get(id) || []);
        for (const e of children) {
            traverse(e.to);
        }
    };

    const topIds = compIds.filter(id => (tierMap.get(id) ?? 0) === maxTier).sort((a, b) => getItemX(a) - getItemX(b));
    const fallbackTop = topIds.length > 0 ? topIds : compIds.filter(id => (outByFrom.get(id) || []).length === 0).sort((a, b) => getItemX(a) - getItemX(b));
    const roots = fallbackTop.length > 0 ? fallbackTop : [...compIds].sort((a, b) => getItemX(a) - getItemX(b));

    for (const rid of roots) {
        traverse(rid);
    }

    for (let t = 0; t <= maxTier; t++) {
        const arr = orders.get(t)!;
        const tierSet = new Set(compIds.filter(id => (tierMap.get(id) ?? 0) === t));
        const remaining = [...tierSet].filter(id => !arr.includes(id)).sort((a, b) => getItemX(a) - getItemX(b));
        orders.set(t, [...arr, ...remaining]);
    }

    return orders;
}

// ============================================================================
// Tier Assignment (Bottom-Up)
// ============================================================================

/**
 * Assign tiers from bottom-up:
 * - Tier 0: Items with no outgoing connections (leaves/loads)
 * - Tier 1: Items that only connect to Tier 0
 * - Tier N: Items that connect to Tier N-1 or lower
 * 
 * This is the reverse of typical topological level - we start from the leaves.
 */
function assignTiersBottomUp(
    compIds: string[],
    outEdges: Map<string, Edge[]>,
    inEdges: Map<string, Edge[]>
): Map<string, number> {
    const tier = new Map<string, number>();
    const compSet = new Set(compIds);

    // Initialize all to -1 (unassigned)
    for (const id of compIds) {
        tier.set(id, -1);
    }

    // Find leaf nodes (no outgoing edges within component)
    const leaves: string[] = [];
    for (const id of compIds) {
        const outgoing = (outEdges.get(id) || []).filter(e => compSet.has(e.to));
        if (outgoing.length === 0) {
            leaves.push(id);
            tier.set(id, 0);
        }
    }

    // If no leaves found (cycle), pick nodes with minimum outgoing edges
    if (leaves.length === 0 && compIds.length > 0) {
        let minOut = Infinity;
        for (const id of compIds) {
            const outCount = (outEdges.get(id) || []).filter(e => compSet.has(e.to)).length;
            minOut = Math.min(minOut, outCount);
        }
        for (const id of compIds) {
            const outCount = (outEdges.get(id) || []).filter(e => compSet.has(e.to)).length;
            if (outCount === minOut) {
                leaves.push(id);
                tier.set(id, 0);
            }
        }
    }

    // BFS from leaves upward (reverse direction - from children to parents)
    const queue = [...leaves];

    while (queue.length > 0) {
        const current = queue.shift()!;
        const currentTier = tier.get(current)!;

        // Find parents (nodes that have edges TO current node)
        const parents = (inEdges.get(current) || [])
            .filter(e => compSet.has(e.from))
            .map(e => e.from);

        for (const parentId of parents) {
            const existingTier = tier.get(parentId)!;
            const newTier = currentTier + 1;

            // Assign the maximum tier (parent must be above ALL its children)
            if (existingTier < newTier) {
                tier.set(parentId, newTier);
                // Re-queue to propagate upward
                if (!queue.includes(parentId)) {
                    queue.push(parentId);
                }
            }
        }
    }

    // Handle any unassigned nodes (disconnected within component)
    for (const id of compIds) {
        if (tier.get(id) === -1) {
            tier.set(id, 0);
        }
    }

    return tier;
}

// ============================================================================
// Calculate Connectors Passing Through Each Tier Gap
// ============================================================================

/**
 * Count how many connectors pass through the gap between tier N and tier N+1.
 * A connector "passes through" if its source tier > N+1 and target tier <= N,
 * or if it spans more than one tier.
 */
function countConnectorsThroughGap(
    tierGap: number,  // The gap is between tier `tierGap` and tier `tierGap + 1`
    edges: Edge[],
    tierMap: Map<string, number>
): number {
    let count = 0;

    for (const edge of edges) {
        const sourceTier = tierMap.get(edge.from) ?? 0;
        const targetTier = tierMap.get(edge.to) ?? 0;

        // Source is upstream (higher tier), target is downstream (lower tier)
        // Edge passes through gap if: targetTier <= tierGap < sourceTier
        if (targetTier <= tierGap && sourceTier > tierGap) {
            count++;
        }
    }

    return count;
}

// ============================================================================
// Horizontal Positioning - Center Parent Above Children
// ============================================================================

/**
 * Position items so that upstream items are centered above their downstream children.
 * Process tiers from bottom (0) to top, placing children first, then centering parents.
 */
function positionItemsBottomUp(
    tiers: Map<number, string[]>,
    maxTier: number,
    edges: Edge[],
    itemsById: Map<string, CanvasItem>,
    tierMap: Map<string, number>,
    bottomTierOrder?: string[]
): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();

    // Build outgoing edges map for quick lookup
    const outEdges = new Map<string, Edge[]>();
    for (const [, ids] of tiers) {
        for (const id of ids) {
            outEdges.set(id, []);
        }
    }
    for (const e of edges) {
        if (outEdges.has(e.from)) {
            outEdges.get(e.from)!.push(e);
        }
    }

    // Calculate Y positions for each tier (bottom-up)
    // Tier 0 is at the bottom, higher tiers are above
    const tierY = new Map<number, number>();
    let currentY = 0;

    // First pass: calculate tier heights
    const tierHeights = new Map<number, number>();
    for (let t = 0; t <= maxTier; t++) {
        const ids = tiers.get(t) || [];
        let maxH = 0;
        for (const id of ids) {
            const item = itemsById.get(id);
            if (item) maxH = Math.max(maxH, getHeight(item));
        }
        tierHeights.set(t, maxH || 100);
    }

    // Calculate Y from bottom (tier 0) to top (maxTier)
    // But we render with Y increasing downward, so tier 0 should have HIGHEST Y
    // Actually, let's flip: maxTier at top (low Y), tier 0 at bottom (high Y)

    // Calculate total height first
    let totalHeight = 0;
    for (let t = 0; t <= maxTier; t++) {
        totalHeight += tierHeights.get(t) || 100;
        if (t < maxTier) {
            const connectorsThrough = countConnectorsThroughGap(t, edges, tierMap);
            const gap = Math.min(
                CONFIG.BASE_GAP_Y + connectorsThrough * CONFIG.GAP_Y_PER_CONNECTOR,
                CONFIG.MAX_GAP_Y
            );
            totalHeight += gap;
        }
    }

    // Now assign Y positions from top (maxTier) to bottom (tier 0)
    currentY = 0;
    for (let t = maxTier; t >= 0; t--) {
        tierY.set(t, currentY);
        currentY += tierHeights.get(t) || 100;

        if (t > 0) {
            const connectorsThrough = countConnectorsThroughGap(t - 1, edges, tierMap);
            const gap = Math.min(
                CONFIG.BASE_GAP_Y + connectorsThrough * CONFIG.GAP_Y_PER_CONNECTOR,
                CONFIG.MAX_GAP_Y
            );
            currentY += gap;
        }
    }

    // Process tiers from bottom (tier 0) to top (maxTier)
    // This ensures children are placed before parents
    for (let t = 0; t <= maxTier; t++) {
        const ids = tiers.get(t) || [];
        if (ids.length === 0) continue;

        let idsToPlace = ids;
        if (t === 0 && bottomTierOrder && bottomTierOrder.length > 0) {
            const tier0Set = new Set(ids);
            const ordered = bottomTierOrder.filter(id => tier0Set.has(id));
            const orderedSet = new Set(ordered);
            const remaining = ids
                .filter(id => !orderedSet.has(id))
                .sort((a, b) => {
                    const aItem = itemsById.get(a);
                    const bItem = itemsById.get(b);
                    return (aItem?.position.x ?? 0) - (bItem?.position.x ?? 0);
                });
            idsToPlace = [...ordered, ...remaining];
        }

        const y = tierY.get(t) || 0;
        const itemData: { id: string; centerX: number; width: number }[] = [];
        let leafCursorX = 0;

        for (const id of idsToPlace) {
            const item = itemsById.get(id)!;
            const width = getWidth(item);

            // Find the downstream items this item connects to
            const downstreamEdges = (outEdges.get(id) || []);
            const downstreamPositions: number[] = [];

            for (const edge of downstreamEdges) {
                const targetPos = positions.get(edge.to);
                const targetItem = itemsById.get(edge.to);

                if (targetPos && targetItem) {
                    // Get the X position of the target's connection point
                    const targetConnX = targetPos.x + getConnectionPointX(targetItem, edge.targetPointKey);
                    downstreamPositions.push(targetConnX);
                }
            }

            let centerX: number;

            if (downstreamPositions.length > 0) {
                // Center between leftmost and rightmost downstream connection points
                const leftmost = Math.min(...downstreamPositions);
                const rightmost = Math.max(...downstreamPositions);
                centerX = (leftmost + rightmost) / 2;
            } else {
                if (t === 0) {
                    centerX = leafCursorX + width / 2;
                    leafCursorX += width + CONFIG.GAP_X;
                } else {
                    centerX = itemData.length * (width + CONFIG.GAP_X) + width / 2;
                }
            }

            itemData.push({ id, centerX, width });
        }

        // Sort by centerX to maintain left-to-right order
        itemData.sort((a, b) => a.centerX - b.centerX);

        // Assign X positions, preventing overlaps
        let cursorX = 0;
        for (const item of itemData) {
            // Ideal X places item center at centerX
            const idealX = item.centerX - item.width / 2;
            const x = Math.max(idealX, cursorX);

            positions.set(item.id, { x, y });
            cursorX = x + item.width + CONFIG.GAP_X;
        }
    }

    return positions;
}

// ============================================================================
// Main Algorithm
// ============================================================================

export const applyAutoArrange = (items: CanvasItem[], connectors: Connector[]): CanvasItem[] => {
    if (items.length === 0) return items;

    const itemsById = new Map(items.map(i => [i.uniqueID, i]));

    // === STEP 1: Build Edge List ===
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
            targetPointKey: conn.targetPointKey
        });
    }

    if (edges.length === 0) return items;

    // Build adjacency maps
    const outEdges = new Map<string, Edge[]>();
    const inEdges = new Map<string, Edge[]>();
    for (const item of items) {
        outEdges.set(item.uniqueID, []);
        inEdges.set(item.uniqueID, []);
    }
    for (const e of edges) {
        outEdges.get(e.from)?.push(e);
        inEdges.get(e.to)?.push(e);
    }

    // === STEP 2: Find Connected Components (Union-Find) ===
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

    // === STEP 3: Process Each Component ===
    const finalPos = new Map<string, { x: number; y: number }>();
    let packX = globalBaseX;

    for (const compIds of components) {
        const compSet = new Set(compIds);

        // Filter edges for this component
        const compEdges = edges.filter(e => compSet.has(e.from) && compSet.has(e.to));

        // === Assign Tiers (Bottom-Up) ===
        const tierMap = assignTiersBottomUp(compIds, outEdges, inEdges);

        // Group by tier
        const tiers = new Map<number, string[]>();
        let maxTier = 0;
        for (const id of compIds) {
            const t = tierMap.get(id) || 0;
            maxTier = Math.max(maxTier, t);
            if (!tiers.has(t)) tiers.set(t, []);
            tiers.get(t)!.push(id);
        }

        const tierOrders = computeTierOrdersTopDown(compIds, compEdges, itemsById, tierMap);

        // Sort each tier top-down (mapping only, no placement yet)
        for (const [t, ids] of tiers) {
            const ordered = tierOrders.get(t);
            if (ordered && ordered.length > 0) {
                tiers.set(t, ordered.filter(id => ids.includes(id)));
                continue;
            }
            ids.sort((a, b) => {
                const aItem = itemsById.get(a)!;
                const bItem = itemsById.get(b)!;
                return aItem.position.x - bItem.position.x;
            });
        }

        // === Position Items (Bottom-Up with Centering) ===
        const localPositions = positionItemsBottomUp(
            tiers,
            maxTier,
            compEdges,
            itemsById,
            tierMap,
            tierOrders.get(0) || tiers.get(0)
        );

        // Calculate component bounding box
        let minLX = Infinity;
        let maxRX = -Infinity;
        let minLY = Infinity;
        for (const id of compIds) {
            const pos = localPositions.get(id);
            const item = itemsById.get(id)!;
            if (pos) {
                minLX = Math.min(minLX, pos.x);
                minLY = Math.min(minLY, pos.y);
                maxRX = Math.max(maxRX, pos.x + getWidth(item));
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

    // === STEP 4: Apply Positions ===
    return items.map(it => {
        const p = finalPos.get(it.uniqueID);
        if (!p) return it;
        if (it.locked) return it;
        return { ...it, position: { x: p.x, y: p.y } };
    });
};
