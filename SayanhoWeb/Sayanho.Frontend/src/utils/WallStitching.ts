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

const getDistanceToLine = (pt: Point, lineStart: Point, lineEnd: Point) => {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(pt.x - lineStart.x, pt.y - lineStart.y);
    let t = ((pt.x - lineStart.x) * dx + (pt.y - lineStart.y) * dy) / l2;
    // We strictly want distance to the infinite line, not segment, for collinearity check
    const projX = lineStart.x + t * dx;
    const projY = lineStart.y + t * dy;
    return Math.hypot(pt.x - projX, pt.y - projY);
};

export const stitchWalls = (
    inputWalls: Wall[],
    doors: Door[],
    windows: LayoutWindow[],
    imageWidth?: number,
    imageHeight?: number
): Wall[] => {
    // Clone walls to avoid mutating original array
    let walls = [...inputWalls.map(w => ({ ...w }))];
    const openings: (Door | LayoutWindow)[] = [...doors, ...windows];

    // Dynamic Tolerances
    // Use 10% of min dimension for Gap, 2% for Inline
    // This scales well: 359px -> Gap ~36px, Inline ~7px
    //                  2000px -> Gap ~200px, Inline ~40px
    let maxGap = BASE_GAP_DISTANCE;
    let maxInline = BASE_INLINE_OFFSET;

    if (imageWidth && imageHeight) {
        const minDim = Math.min(imageWidth, imageHeight);
        maxGap = Math.max(25, minDim * 0.10);
        maxInline = Math.max(10, minDim * 0.03);
    }

    // Hard cap to prevent cross-map merging on very large simplistic maps
    maxGap = Math.min(maxGap, 300);

    const MAX_ANGLE_DIFF = 0.5;    // Stricter angle tolerance (was 20) to prevent diagonal stitching

    for (const op of openings) {
        const opRotation = op.rotation || 0;
        const opRad = toRad(opRotation);

        // Door Vector (along the length of the door/window)
        const doorVecX = Math.cos(opRad);
        const doorVecY = Math.sin(opRad);

        // Door "Left" and "Right" frame points (approximate)
        const halfW = op.width / 2;
        const center = op.position;
        const pLeft = { x: center.x - doorVecX * halfW, y: center.y - doorVecY * halfW };
        const pRight = { x: center.x + doorVecX * halfW, y: center.y + doorVecY * halfW };

        // Find Candidates Loop
        let leftWallMatch: { wall: Wall, dist: number } | null = null;
        let rightWallMatch: { wall: Wall, dist: number } | null = null;

        for (const w of walls) {
            // 1. Check Angle Alignment (Collinearity)
            const wAngle = getWallAngle(w.startPoint, w.endPoint);
            let angleDiff = Math.abs(wAngle - opRotation);
            // Normalize angle diff (0 vs 180 is same line)
            if (angleDiff > 180) angleDiff = 360 - angleDiff;
            if (angleDiff > 90) angleDiff = Math.abs(angleDiff - 180); // Treat 180 as 0

            if (angleDiff > MAX_ANGLE_DIFF) continue; // Not parallel

            // 2. Check "Inline" alignment (Perpendicular distance)
            const perpDist = getDistanceToLine(center, w.startPoint, w.endPoint);
            if (perpDist > maxInline) continue; // Not inline

            // 3. Project wall midpoint to see if it's "Left" or "Right" of door
            const midX = (w.startPoint.x + w.endPoint.x) / 2;
            const midY = (w.startPoint.y + w.endPoint.y) / 2;
            const vecToWallX = midX - center.x;
            const vecToWallY = midY - center.y;
            const dot = vecToWallX * doorVecX + vecToWallY * doorVecY;

            // Distance from door CENTER to the CLOSEST endpoint of the wall
            const dStart = Math.hypot(w.startPoint.x - center.x, w.startPoint.y - center.y);
            const dEnd = Math.hypot(w.endPoint.x - center.x, w.endPoint.y - center.y);
            const distToCenter = Math.min(dStart, dEnd);

            if (distToCenter > maxGap) continue; // Too far away

            // Classify as Left or Right
            if (dot < 0) {
                // LEFT Side
                if (!leftWallMatch || distToCenter < leftWallMatch.dist) {
                    leftWallMatch = { wall: w, dist: distToCenter };
                }
            } else {
                // RIGHT Side
                if (!rightWallMatch || distToCenter < rightWallMatch.dist) {
                    rightWallMatch = { wall: w, dist: distToCenter };
                }
            }
        }

        // ACTIONS
        if (leftWallMatch && rightWallMatch && leftWallMatch.wall.id === rightWallMatch.wall.id) {
            // The same wall covers both sides (spans the door). 
            continue;
        }

        if (leftWallMatch && rightWallMatch && leftWallMatch.wall.id !== rightWallMatch.wall.id) {
            // CASE A: MERGE
            const w1 = leftWallMatch.wall;
            const w2 = rightWallMatch.wall;

            const getDot = (p: Point) => (p.x - center.x) * doorVecX + (p.y - center.y) * doorVecY;

            // For Left Wall, pick point with smallest (most negative) dot
            const w1p1Dot = getDot(w1.startPoint);
            const w1p2Dot = getDot(w1.endPoint);
            const farPointLeft = w1p1Dot < w1p2Dot ? w1.startPoint : w1.endPoint;

            // For Right Wall, pick point with largest (most positive) dot
            const w2p1Dot = getDot(w2.startPoint);
            const w2p2Dot = getDot(w2.endPoint);
            const farPointRight = w2p1Dot > w2p2Dot ? w2.startPoint : w2.endPoint;

            const mergedWall: Wall = {
                ...w1,
                id: `wall_stitched_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                startPoint: farPointLeft,
                endPoint: farPointRight,
                thickness: Math.max(w1.thickness, w2.thickness)
            };

            // Update dependencies
            walls = walls.filter(w => w.id !== w1.id && w.id !== w2.id);
            walls.push(mergedWall);

        } else {
            // CASE B / C: Extend Single Side
            if (leftWallMatch) {
                const w = leftWallMatch.wall;
                // Extend logic: Move Near Point to Door Far Edge (pRight)
                // The point with LARGER dot (closer to 0) is near.
                const getDot = (p: Point) => (p.x - center.x) * doorVecX + (p.y - center.y) * doorVecY;
                const dotStart = getDot(w.startPoint);
                const dotEnd = getDot(w.endPoint);
                if (dotStart > dotEnd) { w.startPoint = pRight; }
                else { w.endPoint = pRight; }
            }

            if (rightWallMatch) {
                const w = rightWallMatch.wall;
                const getDot = (p: Point) => (p.x - center.x) * doorVecX + (p.y - center.y) * doorVecY;
                const dotStart = getDot(w.startPoint);
                const dotEnd = getDot(w.endPoint);
                if (dotStart < dotEnd) { w.startPoint = pLeft; }
                else { w.endPoint = pLeft; }
            }
        }
    }

    return walls;
};
