import { Wall, Door, LayoutWindow, Point } from '../types/layout';

// CONSTANTS for Robustness (Base defaults if no dimensions provided)
const BASE_GAP_DISTANCE = 50;
const BASE_INLINE_OFFSET = 20;

// Geometry Helpers
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

const getWallAngle = (start: Point, end: Point) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return toDeg(Math.atan2(dy, dx));
};

export const getDistanceToLine = (pt: Point, lineStart: Point, lineEnd: Point) => {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(pt.x - lineStart.x, pt.y - lineStart.y);
    let t = ((pt.x - lineStart.x) * dx + (pt.y - lineStart.y) * dy) / l2;
    // We strictly want distance to the infinite line, not segment, for collinearity check
    // However, for item attachment, we probably want segment distance if we want to ensure it's ON the wall.
    // For now, let's keep the projection logic for infinite line but we might need a segment constraint for attachment.
    const projX = lineStart.x + t * dx;
    const projY = lineStart.y + t * dy;
    return Math.hypot(pt.x - projX, pt.y - projY);
};

export const remapAttachedItems = <T extends { id: string, position: Point, wallId: string }>(
    items: T[],
    newWalls: Wall[],
    maxDist: number = 25
): T[] => {
    return items.map(item => {
        let bestWallId = item.wallId;
        let minInfo = Infinity;
        let found = false;

        // check all new walls
        for (const wall of newWalls) {
            // Check if point projects onto segment t in [0,1]
            const dx = wall.endPoint.x - wall.startPoint.x;
            const dy = wall.endPoint.y - wall.startPoint.y;
            const l2 = dx * dx + dy * dy;
            let t = 0;
            if (l2 !== 0) {
                t = ((item.position.x - wall.startPoint.x) * dx + (item.position.y - wall.startPoint.y) * dy) / l2;
            }

            // If strictly on segment or close
            // Allow small buffer for t?
            if (t >= -0.1 && t <= 1.1) {
                const dist = getDistanceToLine(item.position, wall.startPoint, wall.endPoint);
                if (dist < maxDist && dist < minInfo) {
                    minInfo = dist;
                    bestWallId = wall.id;
                    found = true;
                }
            }
        }

        // If we found a valid new wall, update. Else keep old ID (it will be orphaned, but safer than random)
        // Or should we remove items that lost their wall? 
        // User probably prefers keeping them even if detached vs deleting.
        return {
            ...item,
            wallId: found ? bestWallId : item.wallId
        };
    });
};

export const stitchWalls = (
    inputWalls: Wall[],
    doors: Door[],       // unused in new logic but kept for signature compatibility
    windows: LayoutWindow[], // unused
    imageWidth?: number,
    imageHeight?: number
): Wall[] => {
    // 1. Filter out valid walls and clone
    let walls = inputWalls.map(w => ({ ...w }));

    // 2. Separate into Horizontal and Vertical
    const horz: Wall[] = [];
    const vert: Wall[] = [];
    const other: Wall[] = []; // Diagonal or odd walls - pass through

    walls.forEach(w => {
        const dx = Math.abs(w.endPoint.x - w.startPoint.x);
        const dy = Math.abs(w.endPoint.y - w.startPoint.y);
        if (dx > dy && dy < 20) horz.push(w);
        else if (dy > dx && dx < 20) vert.push(w);
        else other.push(w);
    });

    const mergeGroup = (group: Wall[], isHorizontal: boolean): Wall[] => {
        if (group.length === 0) return [];

        // Sort by primary axis position (Y for horz, X for vert) to cluster lines
        // Then sort by secondary axis (Start X, or Start Y)

        // Step A: Cluster by Alignment (e.g. Y=100 and Y=105 are same line?)
        // User requested strict overlap. But for *Line Alignment* we need tolerance.
        const ALIGN_TOLERANCE = 15;

        // Helper to get alignment coord
        const getCoord = (w: Wall) => isHorizontal ? (w.startPoint.y + w.endPoint.y) / 2 : (w.startPoint.x + w.endPoint.x) / 2;

        // Sort by alignment coord
        group.sort((a, b) => getCoord(a) - getCoord(b));

        const clusters: Wall[][] = [];
        let currentCluster: Wall[] = [group[0]];

        for (let i = 1; i < group.length; i++) {
            const w = group[i];
            const prev = currentCluster[currentCluster.length - 1];
            if (Math.abs(getCoord(w) - getCoord(prev)) < ALIGN_TOLERANCE) {
                currentCluster.push(w);
            } else {
                clusters.push(currentCluster);
                currentCluster = [w];
            }
        }
        clusters.push(currentCluster);

        // Step B: Merge within clusters
        const merged: Wall[] = [];

        for (const cluster of clusters) {
            // Sort by Start Position along the line
            const getStart = (w: Wall) => isHorizontal ? Math.min(w.startPoint.x, w.endPoint.x) : Math.min(w.startPoint.y, w.endPoint.y);
            const getEnd = (w: Wall) => isHorizontal ? Math.max(w.startPoint.x, w.endPoint.x) : Math.max(w.startPoint.y, w.endPoint.y);
            const getThickness = (w: Wall) => w.thickness;

            cluster.sort((a, b) => getStart(a) - getStart(b));

            let active = cluster[0];

            // Should we normalize the "Alignment Coordinate" for the active wall?
            // Yes, take weighted average of Y for all merged segments to start?
            // For simplicity, we keep the first one's Y, or refine as we merge.
            // Let's refine: Keep running weighted average for the alignment axis.

            // We need to track the "Geometric Interval" [min, max]
            let minPos = getStart(active);
            let maxPos = getEnd(active);
            let alignPosSum = getCoord(active) * (maxPos - minPos);
            let totalLen = maxPos - minPos;
            let maxThickness = getThickness(active);

            for (let i = 1; i < cluster.length; i++) {
                const next = cluster[i];
                const nextMin = getStart(next);
                const nextMax = getEnd(next);

                // Strict Overlap Check (using Thickness)
                // Interval A: [minPos, maxPos] (1D projection)
                // Interval B: [nextMin, nextMax]
                // 
                // But wait, the USER's strict check was: 
                // "Perpendicular Distance <= (t1+t2)/2" (This is alignment check, handled by cluster)
                // AND "Edges Overlap": (minEdge < maxEdge)

                // Since we are in 1D sorted list:
                // If nextMin < maxPos, they overlap (or touch if equal).
                // User said "overlapping coordinate". So strict inequality?
                // Let's allow a tiny epsilon or strict <.

                // IMPORTANT: We must also check the *Thickness Interval* if they are offset?
                // No, we already clustered by alignment. "Alignment" implies they are roughly on the same line.
                // The "Strict Overlap" condition was for for *merging offset lines*.
                // Here we have segments on the *same* line.
                // WE MERGE IF: They overlap in 1D.
                // i.e. nextMin < maxPos - overlap_buffer?
                // If user wants CONTINUOUS walls, we should merge TOUCHING (nextMin <= maxPos + epsilon).
                // User said "overlapping coordinate".
                // If I have Wall A (0-100) and Wall B (105-200), do I merge?
                // User said "no wall extension". So NO.
                // So strictly: nextMin < maxPos (they physically touch/overlap).

                // Allow small gap bridging (Extension Logic restored)
                // If gap is small (e.g. < 45px ~ <1m), merge them.
                if (nextMin <= maxPos + 45.0) {
                    // MERGE
                    maxPos = Math.max(maxPos, nextMax);
                    maxThickness = Math.max(maxThickness, getThickness(next));

                    // Update alignment weighted avg
                    const segLen = nextMax - nextMin;
                    if (segLen > 0) {
                        alignPosSum += getCoord(next) * segLen;
                        totalLen += segLen;
                    }
                } else {
                    // GAP Deteced -> Push active and start new
                    const avgAlign = totalLen > 0 ? alignPosSum / totalLen : getCoord(active);
                    merged.push(createMergedWall(active, minPos, maxPos, avgAlign, maxThickness, isHorizontal));

                    active = next;
                    minPos = nextMin;
                    maxPos = nextMax;
                    alignPosSum = getCoord(next) * (maxPos - minPos);
                    totalLen = maxPos - minPos;
                    maxThickness = getThickness(next);
                }
            }
            // Push final
            const avgAlign = totalLen > 0 ? alignPosSum / totalLen : getCoord(active);
            merged.push(createMergedWall(active, minPos, maxPos, avgAlign, maxThickness, isHorizontal));
        }
        return merged;
    };

    const createMergedWall = (base: Wall, start: number, end: number, alignAnd: number, thick: number, isHorz: boolean): Wall => {
        return {
            ...base,
            id: `wall_merged_${Math.random().toString(36).substr(2, 5)}`,
            startPoint: isHorz ? { x: start, y: alignAnd } : { x: alignAnd, y: start },
            endPoint: isHorz ? { x: end, y: alignAnd } : { x: alignAnd, y: end },
            thickness: thick
        };
    };

    // Run Merge
    const mergedHorz = mergeGroup(horz, true);
    const mergedVert = mergeGroup(vert, false);

    return [...mergedHorz, ...mergedVert, ...other];
};
