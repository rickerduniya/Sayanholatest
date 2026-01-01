import { CanvasItem, Connector } from '../types';
import { ApplicationSettings } from './ApplicationSettings';

// Types corresponding to C# structures
export interface Point {
    x: number;
    y: number;
}

export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface PathAttempt {
    points: Point[];
    isSuccessful: boolean;
    obstacleTop?: number;
    obstacleBottom?: number;
    obstacleLeft?: number;
    obstacleRight?: number;
    f_parallel: boolean;
    s_parallel: boolean;
    f_obstacle: boolean;
    s_obstacle: boolean;
    tryHorizontalFirst: boolean;
}

export interface ConnectionPath {
    specText: string;
    specTextPosition: Point;
    isHorizontal: boolean;
}

// Constants from C#
const MARGIN_OFFSET = 10;
const OFFSET = 20;
const OBSTACLE_AVOIDANCE_OFFSET = 5;
const PARALLEL_LINE_THRESHOLD = 8;

// Bus-bar routing constants
const BUS_OFFSET = 30; // Fixed offset from source item for horizontal bus line
const STAGGER_SPACING = 25; // Gap between staggered bus lines to prevent overlap (increased from 15)

export class ConnectorUtils {

    static calculateConnectorPath(
        connector: Connector,
        canvasItems: CanvasItem[],
        existingPaths: Point[][],
        scale: number,
        allConnectors?: Connector[] // All connectors from the sheet for X-position ordering
    ): { points: Point[], specText?: ConnectionPath } {
        const sourceItem = connector.sourceItem;
        const targetItem = connector.targetItem;
        const sourcePointKey = connector.sourcePointKey;
        const targetPointKey = connector.targetPointKey;

        // Get original connection points
        const originalStart = {
            x: sourceItem.position.x + sourceItem.connectionPoints[sourcePointKey].x,
            y: sourceItem.position.y + sourceItem.connectionPoints[sourcePointKey].y
        };
        const originalEnd = {
            x: targetItem.position.x + targetItem.connectionPoints[targetPointKey].x,
            y: targetItem.position.y + targetItem.connectionPoints[targetPointKey].y
        };

        // Get offset connection points
        const startPoint = this.getOffsetConnectionPoint(sourceItem, scale, originalStart);
        const endPoint = this.getOffsetConnectionPoint(targetItem, scale, originalEnd);

        let finalPoints: Point[] = [];
        let specText: ConnectionPath | undefined;

        // Step 1: Check for direct horizontal/vertical connection
        if (this.canConnectDirectly(startPoint, endPoint, canvasItems, scale)) {
            const directPath = [originalStart, startPoint, endPoint, originalEnd];
            specText = this.getSpecTextAndPosition(connector, directPath, scale, canvasItems, existingPaths);
            finalPoints = this.addJumperIndicationsToPath(directPath, existingPaths, scale);
            return { points: finalPoints, specText };
        }

        // Step 2: Try Bus-Bar Style Routing (vertical → horizontal bus → vertical)
        // This creates cleaner SLD-style paths with shared horizontal bus lines
        const busPath = this.calculateBusBarPath(
            originalStart, originalEnd, startPoint, endPoint,
            sourceItem, targetItem, canvasItems, existingPaths, scale,
            connector, allConnectors
        );

        if (busPath && this.isPathClearForBusRouting(busPath, canvasItems, sourceItem, targetItem, scale)) {
            specText = this.getSpecTextAndPosition(connector, busPath, scale, canvasItems, existingPaths);
            finalPoints = this.addJumperIndicationsToPath(busPath, existingPaths, scale);
            return { points: finalPoints, specText };
        }

        // Step 3: Fallback to L-shape routing (original algorithm)
        const attempts = this.calculatePath(startPoint, endPoint, canvasItems, existingPaths, scale);
        let lastAttemptPoints = [startPoint];

        if (attempts.length > 0) {
            const lastAttempt = attempts[attempts.length - 1];
            lastAttemptPoints = [...lastAttempt.points];
            if (lastAttempt.isSuccessful) {
                lastAttemptPoints.push(originalEnd);
            }
        }
        lastAttemptPoints.unshift(originalStart);

        specText = this.getSpecTextAndPosition(connector, lastAttemptPoints, scale, canvasItems, existingPaths);
        finalPoints = this.addJumperIndicationsToPath(lastAttemptPoints, existingPaths, scale);

        return { points: finalPoints, specText };
    }

    /**
     * Calculate Bus-Bar style path: creates a 3-segment path (vertical → horizontal → vertical)
     * This produces cleaner SLD-style routing with shared horizontal bus lines.
     * 
     * Path structure:
     * - originalStart → startPoint (offset from source)
     * - startPoint → bus junction point (vertical segment to bus level)
     * - bus junction → target junction (horizontal segment along bus)
     * - target junction → endPoint (vertical segment to target offset)
     * - endPoint → originalEnd (into target)
     */
    private static calculateBusBarPath(
        originalStart: Point,
        originalEnd: Point,
        startPoint: Point,
        endPoint: Point,
        sourceItem: CanvasItem,
        targetItem: CanvasItem,
        canvasItems: CanvasItem[],
        existingPaths: Point[][],
        scale: number,
        currentConnector?: Connector,
        allConnectors?: Connector[]
    ): Point[] | null {
        // Determine the direction of connection
        const isDownward = startPoint.y < endPoint.y;  // Source is above target
        const isUpward = startPoint.y > endPoint.y;    // Source is below target
        const isHorizontal = Math.abs(startPoint.y - endPoint.y) < 1; // Same level

        // If nearly horizontal (same Y level), skip bus routing - use L-shape
        if (isHorizontal) {
            return null;
        }

        // Calculate base bus Y position based on direction
        let baseBusY: number;
        let minBusY: number;
        let maxBusY: number;

        if (isDownward) {
            // Source above target: bus is below source connection point
            // Use startPoint.y (actual connection point) for rotation-aware calculation
            const sourceConnectionY = startPoint.y;
            const targetTop = targetItem.position.y;

            baseBusY = sourceConnectionY + BUS_OFFSET;
            minBusY = sourceConnectionY + 10;
            maxBusY = targetTop - OFFSET;

            // If not enough space, fall back to L-shape
            if (baseBusY >= maxBusY) {
                baseBusY = (sourceConnectionY + targetTop) / 2;
                if (baseBusY >= maxBusY || baseBusY <= minBusY) {
                    return null;
                }
            }
        } else {
            // Source below target: bus is above source connection point
            // Use startPoint.y (actual connection point) for rotation-aware calculation
            const sourceConnectionY = startPoint.y;
            const targetBottom = targetItem.position.y + targetItem.size.height;

            baseBusY = sourceConnectionY - BUS_OFFSET;
            minBusY = targetBottom + OFFSET;
            maxBusY = sourceConnectionY - 10;

            // If not enough space, fall back to L-shape
            if (baseBusY <= minBusY) {
                baseBusY = (sourceConnectionY + targetBottom) / 2;
                if (baseBusY <= minBusY || baseBusY >= maxBusY) {
                    return null;
                }
            }
        }

        // Calculate bus Y based on target X position rank (to prevent crossing)
        let busY: number | null;

        if (currentConnector && allConnectors && allConnectors.length > 0) {
            // Use X-position-based ranking for consistent ordering
            const rank = this.calculateTargetXRank(currentConnector, allConnectors, canvasItems);
            const staggerDirection = isDownward ? 1 : -1;
            busY = baseBusY + (rank * STAGGER_SPACING * staggerDirection);

            // Check bounds
            if (isDownward && busY > maxBusY) {
                busY = null;
            } else if (!isDownward && busY < minBusY) {
                busY = null;
            }
        } else {
            // Fallback: use collision-based staggering (original behavior)
            busY = this.findNonOverlappingBusY(
                baseBusY, existingPaths, startPoint.x, endPoint.x,
                minBusY, maxBusY, isDownward, scale
            );
        }

        // If no valid bus Y found within bounds, fall back to L-shape
        if (busY === null) {
            return null;
        }

        // Construct the bus-bar path:
        // originalStart → startPoint → (startPoint.x, busY) → (endPoint.x, busY) → endPoint → originalEnd
        const busPath: Point[] = [
            originalStart,          // Inside source component
            startPoint,             // Offset point from source
            { x: startPoint.x, y: busY },   // Vertical drop/rise to bus level
            { x: endPoint.x, y: busY },     // Horizontal along bus line
            endPoint,               // Offset point to target  
            originalEnd             // Inside target component
        ];

        return busPath;
    }

    /**
     * Find a bus Y position that doesn't overlap with existing horizontal segments.
     * Staggers the bus Y by STAGGER_SPACING until no overlap is found.
     * 
     * @param baseBusY - The initial bus Y position to try
     * @param existingPaths - Previously calculated connector paths
     * @param startX - X coordinate of the start of horizontal segment
     * @param endX - X coordinate of the end of horizontal segment
     * @param minBusY - Minimum allowed bus Y (boundary)
     * @param maxBusY - Maximum allowed bus Y (boundary)
     * @param isDownward - Direction of connector (affects stagger direction)
     * @param scale - Current canvas scale
     * @returns Non-overlapping bus Y, or null if none found within bounds
     */
    private static findNonOverlappingBusY(
        baseBusY: number,
        existingPaths: Point[][],
        startX: number,
        endX: number,
        minBusY: number,
        maxBusY: number,
        isDownward: boolean,
        scale: number
    ): number | null {
        const OVERLAP_THRESHOLD = STAGGER_SPACING / 2; // Y distance to consider as overlap
        let currentBusY = baseBusY;
        const staggerDirection = isDownward ? 1 : -1; // Stagger downward or upward

        // Calculate the X range for our horizontal segment
        const ourMinX = Math.min(startX, endX);
        const ourMaxX = Math.max(startX, endX);

        // Collect all horizontal segments from existing paths and their Y levels
        const existingHorizontalSegments: { y: number, minX: number, maxX: number }[] = [];

        for (const path of existingPaths) {
            for (let i = 0; i < path.length - 1; i++) {
                const p1 = path[i];
                const p2 = path[i + 1];

                // Check if this is a horizontal segment
                if (Math.abs(p1.y - p2.y) < 0.1) {
                    existingHorizontalSegments.push({
                        y: p1.y,
                        minX: Math.min(p1.x, p2.x),
                        maxX: Math.max(p1.x, p2.x)
                    });
                }
            }
        }

        // Try to find a non-overlapping Y position
        const MAX_ATTEMPTS = 20; // Prevent infinite loop
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            let hasOverlap = false;

            for (const segment of existingHorizontalSegments) {
                // Check if Y levels are close enough to overlap
                const yOverlap = Math.abs(currentBusY - segment.y) < OVERLAP_THRESHOLD;

                // Check if X ranges overlap
                const xOverlap = !(ourMaxX < segment.minX || ourMinX > segment.maxX);

                if (yOverlap && xOverlap) {
                    hasOverlap = true;
                    break;
                }
            }

            if (!hasOverlap) {
                // Check if within bounds
                if (isDownward && currentBusY >= minBusY && currentBusY <= maxBusY) {
                    return currentBusY;
                } else if (!isDownward && currentBusY >= minBusY && currentBusY <= maxBusY) {
                    return currentBusY;
                }
            }

            // Stagger to next position
            currentBusY += staggerDirection * STAGGER_SPACING;

            // Check if we've exceeded bounds
            if (isDownward && currentBusY > maxBusY) {
                return null; // No valid position found
            } else if (!isDownward && currentBusY < minBusY) {
                return null;
            }
        }

        return null; // No valid position found after MAX_ATTEMPTS
    }

    /**
     * Calculate the rank of a connector based on its horizontal distance from source.
     * Closer targets get lower rank (topmost bus), farther targets get higher rank.
     * This ensures consistent ordering regardless of whether targets are left or right of source.
     * 
     * @param currentConnector - The connector to find the rank for
     * @param allConnectors - All connectors in the sheet
     * @param canvasItems - All canvas items (for getting current positions)
     * @returns Rank (0-indexed): 0 for closest target, increasing with distance
     */
    private static calculateTargetXRank(
        currentConnector: Connector,
        allConnectors: Connector[],
        canvasItems: CanvasItem[]
    ): number {
        // Find the current source item's ID
        const sourceId = currentConnector.sourceItem.uniqueID;
        const sourcePointKey = currentConnector.sourcePointKey;

        // Find all connectors from the same source
        const siblingsFromSameSource = allConnectors.filter(
            c => c.sourceItem.uniqueID === sourceId
        );

        if (siblingsFromSameSource.length <= 1) {
            return 0; // Only one connector, no staggering needed
        }

        // Get source item and calculate source X position
        const sourceItem = canvasItems.find(ci => ci.uniqueID === sourceId) || currentConnector.sourceItem;
        let sourceX = sourceItem.position.x + sourceItem.size.width / 2; // Default: center
        if (sourceItem.connectionPoints && sourceItem.connectionPoints[sourcePointKey]) {
            sourceX = sourceItem.position.x + sourceItem.connectionPoints[sourcePointKey].x;
        }

        // Calculate target X position and DISTANCE from source for each sibling connector
        interface ConnectorWithDistance {
            connector: Connector;
            targetX: number;
            distance: number; // Horizontal distance from source
        }

        const connectorsWithDistance: ConnectorWithDistance[] = siblingsFromSameSource.map(c => {
            // Get the current target item position (may have moved since connector was created)
            const targetItem = canvasItems.find(ci => ci.uniqueID === c.targetItem.uniqueID) || c.targetItem;
            const targetPointKey = c.targetPointKey;

            // Calculate target X position (connection point X on target)
            let targetX = targetItem.position.x;
            if (targetItem.connectionPoints && targetItem.connectionPoints[targetPointKey]) {
                targetX = targetItem.position.x + targetItem.connectionPoints[targetPointKey].x;
            } else {
                // Fallback: use center of target item
                targetX = targetItem.position.x + targetItem.size.width / 2;
            }

            // Calculate horizontal distance from source
            const distance = Math.abs(targetX - sourceX);

            return { connector: c, targetX, distance };
        });

        // Sort by DISTANCE from source (FARTHER first = topmost bus)
        // This prevents crossing: longer horizontal spans on top, shorter below
        connectorsWithDistance.sort((a, b) => b.distance - a.distance);

        // Find the rank of the current connector
        const rank = connectorsWithDistance.findIndex(
            item => item.connector.sourceItem.uniqueID === currentConnector.sourceItem.uniqueID &&
                item.connector.targetItem.uniqueID === currentConnector.targetItem.uniqueID &&
                item.connector.sourcePointKey === currentConnector.sourcePointKey &&
                item.connector.targetPointKey === currentConnector.targetPointKey
        );

        return rank >= 0 ? rank : 0;
    }

    /**
     * Check if a bus-bar path is clear of obstacles.
     * Excludes source and target items from obstacle checking.
     */
    private static isPathClearForBusRouting(
        path: Point[],
        canvasItems: CanvasItem[],
        sourceItem: CanvasItem,
        targetItem: CanvasItem,
        scale: number
    ): boolean {
        // Filter out source and target from obstacles
        const obstacles = canvasItems.filter(
            item => item.uniqueID !== sourceItem.uniqueID && item.uniqueID !== targetItem.uniqueID
        );

        // Check each segment of the path (skip first and last which connect to components)
        for (let i = 1; i < path.length - 2; i++) {
            const segStart = path[i];
            const segEnd = path[i + 1];

            const isHorizontalSeg = Math.abs(segStart.y - segEnd.y) < 0.1;

            for (const item of obstacles) {
                const rect = this.getExpandedRectangle(item, scale);

                if (isHorizontalSeg) {
                    if (this.isInHorizontalPath(segStart, segEnd, rect)) {
                        return false;
                    }
                } else {
                    if (this.isInVerticalPath(segStart, segEnd, rect)) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    private static calculatePath(
        start: Point,
        end: Point,
        canvasItems: CanvasItem[],
        existingPaths: Point[][],
        scale: number
    ): PathAttempt[] {
        const attempts: PathAttempt[] = [];

        const shouldTryHorizontalFirst = this.shouldTryHorizontalFirst(start, end, canvasItems, existingPaths, scale);

        const horizontalFirstAttempt = this.tryPath(start, end, canvasItems, true, existingPaths, scale);
        const verticalFirstAttempt = this.tryPath(start, end, canvasItems, false, existingPaths, scale);

        if (horizontalFirstAttempt.isSuccessful && verticalFirstAttempt.isSuccessful) {
            const hCrossings = this.countPotentialCrossings(horizontalFirstAttempt.points, existingPaths);
            const vCrossings = this.countPotentialCrossings(verticalFirstAttempt.points, existingPaths);

            if (hCrossings < vCrossings) {
                attempts.push(horizontalFirstAttempt);
                return attempts;
            } else if (vCrossings < hCrossings) {
                attempts.push(verticalFirstAttempt);
                return attempts;
            } else {
                attempts.push(shouldTryHorizontalFirst ? horizontalFirstAttempt : verticalFirstAttempt);
                return attempts;
            }
        }

        if (horizontalFirstAttempt.isSuccessful) {
            attempts.push(horizontalFirstAttempt);
            return attempts;
        }
        if (verticalFirstAttempt.isSuccessful) {
            attempts.push(verticalFirstAttempt);
            return attempts;
        }

        // Fallback logic
        attempts.push(shouldTryHorizontalFirst ? horizontalFirstAttempt : verticalFirstAttempt);
        attempts.push(shouldTryHorizontalFirst ? verticalFirstAttempt : horizontalFirstAttempt);

        const thirdAttempt = this.continueFailedPath(attempts[0], end, canvasItems, false, existingPaths, scale);
        attempts.push(thirdAttempt);
        if (thirdAttempt.isSuccessful) return attempts;

        const fourthAttempt = this.continueFailedPath(attempts[1], end, canvasItems, true, existingPaths, scale);
        attempts.push(fourthAttempt);
        if (fourthAttempt.isSuccessful) return attempts;

        const fifthAttempt = this.continueFailedPath(thirdAttempt, end, canvasItems, true, existingPaths, scale);
        attempts.push(fifthAttempt);
        if (fifthAttempt.isSuccessful) return attempts;

        const sixthAttempt = this.continueFailedPath(fourthAttempt, end, canvasItems, false, existingPaths, scale);
        attempts.push(sixthAttempt);

        return attempts;
    }

    private static tryPath(
        start: Point,
        end: Point,
        canvasItems: CanvasItem[],
        tryHorizontalFirst: boolean,
        existingPaths: Point[][],
        scale: number
    ): PathAttempt {
        const attempt: PathAttempt = {
            points: [start],
            isSuccessful: false,
            f_parallel: false,
            s_parallel: false,
            f_obstacle: false,
            s_obstacle: false,
            tryHorizontalFirst
        };

        let nextPoint: Point;
        let f_obstacle = false, s_obstacle = false;
        let f_parallel = false, s_parallel = false;
        let obsTop: number | undefined, obsBottom: number | undefined, obsLeft: number | undefined, obsRight: number | undefined;

        if (tryHorizontalFirst) {
            const res1 = this.checkHorizontal(start, end, canvasItems, existingPaths, scale);
            nextPoint = res1.nextPoint;
            f_obstacle = res1.obstacleFound;
            f_parallel = res1.parallelLineFound;
            obsTop = res1.top; obsBottom = res1.bottom; obsLeft = res1.left; obsRight = res1.right;

            if (!f_parallel) attempt.points.push(nextPoint);

            if (f_obstacle) {
                attempt.isSuccessful = false;
                attempt.obstacleTop = obsTop; attempt.obstacleBottom = obsBottom;
                attempt.obstacleLeft = obsLeft; attempt.obstacleRight = obsRight;
                attempt.f_parallel = f_parallel; attempt.f_obstacle = f_obstacle;
                return attempt;
            }

            const res2 = this.checkVertical(attempt.points[attempt.points.length - 1], end, canvasItems, existingPaths, scale);
            nextPoint = res2.nextPoint;
            s_obstacle = res2.obstacleFound;
            s_parallel = res2.parallelLineFound;
            obsTop = res2.top; obsBottom = res2.bottom; obsLeft = res2.left; obsRight = res2.right;
        } else {
            const res1 = this.checkVertical(start, end, canvasItems, existingPaths, scale);
            nextPoint = res1.nextPoint;
            f_obstacle = res1.obstacleFound;
            f_parallel = res1.parallelLineFound;
            obsTop = res1.top; obsBottom = res1.bottom; obsLeft = res1.left; obsRight = res1.right;

            if (!f_parallel) attempt.points.push(nextPoint);

            if (f_obstacle) {
                attempt.isSuccessful = false;
                attempt.obstacleTop = obsTop; attempt.obstacleBottom = obsBottom;
                attempt.obstacleLeft = obsLeft; attempt.obstacleRight = obsRight;
                attempt.f_parallel = f_parallel; attempt.f_obstacle = f_obstacle;
                return attempt;
            }

            const res2 = this.checkHorizontal(attempt.points[attempt.points.length - 1], end, canvasItems, existingPaths, scale);
            nextPoint = res2.nextPoint;
            s_obstacle = res2.obstacleFound;
            s_parallel = res2.parallelLineFound;
            obsTop = res2.top; obsBottom = res2.bottom; obsLeft = res2.left; obsRight = res2.right;
        }

        if (!s_parallel) attempt.points.push(nextPoint);

        attempt.isSuccessful = !s_obstacle && !f_parallel && !s_parallel;
        attempt.obstacleTop = obsTop; attempt.obstacleBottom = obsBottom;
        attempt.obstacleLeft = obsLeft; attempt.obstacleRight = obsRight;
        attempt.f_parallel = f_parallel; attempt.f_obstacle = f_obstacle;
        attempt.s_parallel = s_parallel; attempt.s_obstacle = s_obstacle;

        return attempt;
    }

    private static continueFailedPath(
        failedAttempt: PathAttempt,
        end: Point,
        canvasItems: CanvasItem[],
        tryHorizontalFirst: boolean,
        existingPaths: Point[][],
        scale: number
    ): PathAttempt {
        const lastPoint = failedAttempt.points[failedAttempt.points.length - 1];
        const newAttempt: PathAttempt = {
            points: [],
            isSuccessful: false,
            f_parallel: false,
            s_parallel: false,
            f_obstacle: false,
            s_obstacle: false,
            tryHorizontalFirst
        };

        // Logic to go around obstacle
        if (!tryHorizontalFirst && (lastPoint.y === failedAttempt.obstacleTop || lastPoint.y === failedAttempt.obstacleBottom)) {
            if (failedAttempt.points.length > 2) {
                const secondLast = failedAttempt.points[failedAttempt.points.length - 2];
                newAttempt.points = failedAttempt.points.slice(0, failedAttempt.points.length - 2);
                if (newAttempt.points.length > 0) {
                    const startX = newAttempt.points[0].x;
                    const left = failedAttempt.obstacleLeft!;
                    const right = failedAttempt.obstacleRight!;
                    const offset = OBSTACLE_AVOIDANCE_OFFSET * scale;
                    const newX = Math.abs(startX - left) < Math.abs(startX - right) ? left - offset : right + offset;
                    newAttempt.points.push({ x: newX, y: secondLast.y });
                }
            } else {
                newAttempt.points = [...failedAttempt.points];
            }
        } else if (tryHorizontalFirst && (lastPoint.x === failedAttempt.obstacleLeft || lastPoint.x === failedAttempt.obstacleRight)) {
            if (failedAttempt.points.length > 2) {
                const secondLast = failedAttempt.points[failedAttempt.points.length - 2];
                newAttempt.points = failedAttempt.points.slice(0, failedAttempt.points.length - 2);
                if (newAttempt.points.length > 0) {
                    const startY = newAttempt.points[0].y;
                    const top = failedAttempt.obstacleTop!;
                    const bottom = failedAttempt.obstacleBottom!;
                    const offset = OBSTACLE_AVOIDANCE_OFFSET * scale;
                    const newY = Math.abs(startY - top) < Math.abs(startY - bottom) ? top - offset : bottom + offset;
                    newAttempt.points.push({ x: secondLast.x, y: newY });
                }
            } else {
                newAttempt.points = [...failedAttempt.points];
            }
        } else {
            newAttempt.points = [...failedAttempt.points];
        }

        // Continue pathfinding from new point
        const currentStart = newAttempt.points[newAttempt.points.length - 1];
        let nextPoint: Point;
        let f_fail = false, s_fail = false;
        let obsTop: number | undefined, obsBottom: number | undefined, obsLeft: number | undefined, obsRight: number | undefined;

        if (tryHorizontalFirst) {
            const res1 = this.checkHorizontal(currentStart, end, canvasItems, existingPaths, scale);
            nextPoint = res1.nextPoint;
            f_fail = res1.obstacleFound || res1.parallelLineFound;
            obsTop = res1.top; obsBottom = res1.bottom; obsLeft = res1.left; obsRight = res1.right;
            newAttempt.points.push(nextPoint);

            if (f_fail) {
                newAttempt.isSuccessful = false;
                return newAttempt;
            }

            const res2 = this.checkVertical(nextPoint, end, canvasItems, existingPaths, scale);
            nextPoint = res2.nextPoint;
            s_fail = res2.obstacleFound || res2.parallelLineFound;
            obsTop = res2.top; obsBottom = res2.bottom; obsLeft = res2.left; obsRight = res2.right;
        } else {
            const res1 = this.checkVertical(currentStart, end, canvasItems, existingPaths, scale);
            nextPoint = res1.nextPoint;
            f_fail = res1.obstacleFound || res1.parallelLineFound;
            obsTop = res1.top; obsBottom = res1.bottom; obsLeft = res1.left; obsRight = res1.right;
            newAttempt.points.push(nextPoint);

            if (f_fail) {
                newAttempt.isSuccessful = false;
                return newAttempt;
            }

            const res2 = this.checkHorizontal(nextPoint, end, canvasItems, existingPaths, scale);
            nextPoint = res2.nextPoint;
            s_fail = res2.obstacleFound || res2.parallelLineFound;
            obsTop = res2.top; obsBottom = res2.bottom; obsLeft = res2.left; obsRight = res2.right;
        }

        newAttempt.points.push(nextPoint);
        newAttempt.isSuccessful = !s_fail;
        newAttempt.obstacleTop = obsTop; newAttempt.obstacleBottom = obsBottom;
        newAttempt.obstacleLeft = obsLeft; newAttempt.obstacleRight = obsRight;

        return newAttempt;
    }

    private static checkHorizontal(
        start: Point,
        end: Point,
        canvasItems: CanvasItem[],
        existingPaths: Point[][],
        scale: number
    ) {
        let closestObstacleX = start.x < end.x ? Number.MAX_VALUE : Number.MIN_VALUE;
        let nextPoint = { x: end.x, y: start.y };
        let obstacleFound = false;
        let parallelLineFound = false;
        let top: number | undefined, bottom: number | undefined, left: number | undefined, right: number | undefined;

        for (const item of canvasItems) {
            const rect = this.getExpandedRectangle(item, scale);
            if (this.isInHorizontalPath(start, end, rect)) {
                if (start.x < end.x && rect.left < closestObstacleX && rect.left > start.x) {
                    closestObstacleX = rect.left;
                    nextPoint = { x: closestObstacleX, y: start.y };
                    obstacleFound = true;
                    top = rect.top; bottom = rect.bottom; left = rect.left; right = rect.right;
                } else if (start.x > end.x && rect.right > closestObstacleX && rect.right < start.x) {
                    closestObstacleX = rect.right;
                    nextPoint = { x: closestObstacleX, y: start.y };
                    obstacleFound = true;
                    top = rect.top; bottom = rect.bottom; left = rect.left; right = rect.right;
                }
            }
        }

        const threshold = PARALLEL_LINE_THRESHOLD * scale;
        for (const path of existingPaths) {
            for (let i = 0; i < path.length - 1; i++) {
                const p1 = path[i];
                const p2 = path[i + 1];
                if (Math.abs(p1.y - p2.y) < 0.1 && Math.abs(start.y - p1.y) <= threshold) { // Horizontal line
                    const lineStartX = Math.min(p1.x, p2.x);
                    const lineEndX = Math.max(p1.x, p2.x);
                    if (!(start.x < (lineStartX - threshold) && nextPoint.x < (lineStartX - threshold)) &&
                        !(start.x > (lineEndX + threshold) && nextPoint.x > (lineEndX + threshold))) {
                        parallelLineFound = true;
                        break;
                    }
                }
            }
            if (parallelLineFound) break;
        }

        return { nextPoint, top, bottom, left, right, obstacleFound, parallelLineFound };
    }

    private static checkVertical(
        start: Point,
        end: Point,
        canvasItems: CanvasItem[],
        existingPaths: Point[][],
        scale: number
    ) {
        let closestObstacleY = start.y < end.y ? Number.MAX_VALUE : Number.MIN_VALUE;
        let nextPoint = { x: start.x, y: end.y };
        let obstacleFound = false;
        let parallelLineFound = false;
        let top: number | undefined, bottom: number | undefined, left: number | undefined, right: number | undefined;

        for (const item of canvasItems) {
            const rect = this.getExpandedRectangle(item, scale);
            if (this.isInVerticalPath(start, end, rect)) {
                if (start.y < end.y && rect.top < closestObstacleY && rect.top > start.y) {
                    closestObstacleY = rect.top;
                    nextPoint = { x: start.x, y: closestObstacleY };
                    obstacleFound = true;
                    top = rect.top; bottom = rect.bottom; left = rect.left; right = rect.right;
                } else if (start.y > end.y && rect.bottom > closestObstacleY && rect.bottom < start.y) {
                    closestObstacleY = rect.bottom;
                    nextPoint = { x: start.x, y: closestObstacleY };
                    obstacleFound = true;
                    top = rect.top; bottom = rect.bottom; left = rect.left; right = rect.right;
                }
            }
        }

        const threshold = PARALLEL_LINE_THRESHOLD * scale;
        for (const path of existingPaths) {
            for (let i = 0; i < path.length - 1; i++) {
                const p1 = path[i];
                const p2 = path[i + 1];
                if (Math.abs(p1.x - p2.x) < 0.1 && Math.abs(start.x - p1.x) <= threshold) { // Vertical line
                    const lineStartY = Math.min(p1.y, p2.y);
                    const lineEndY = Math.max(p1.y, p2.y);
                    if (!(start.y < (lineStartY - threshold) && nextPoint.y < (lineStartY - threshold)) &&
                        !(start.y > (lineEndY + threshold) && nextPoint.y > (lineEndY + threshold))) {
                        parallelLineFound = true;
                        break;
                    }
                }
            }
            if (parallelLineFound) break;
        }

        return { nextPoint, top, bottom, left, right, obstacleFound, parallelLineFound };
    }

    private static getExpandedRectangle(item: CanvasItem, scale: number): Rectangle {
        const margin = MARGIN_OFFSET;
        return {
            x: item.position.x - margin,
            y: item.position.y - margin,
            width: item.size.width + 2 * margin,
            height: item.size.height + 2 * margin,
            left: item.position.x - margin,
            right: item.position.x + item.size.width + margin,
            top: item.position.y - margin,
            bottom: item.position.y + item.size.height + margin
        };
    }

    private static isInHorizontalPath(start: Point, end: Point, rect: Rectangle): boolean {
        return (start.y >= rect.top && start.y <= rect.bottom) &&
            ((start.x < end.x && rect.left > start.x && rect.left < end.x) ||
                (start.x > end.x && rect.right < start.x && rect.right > end.x));
    }

    private static isInVerticalPath(start: Point, end: Point, rect: Rectangle): boolean {
        return (start.x >= rect.left && start.x <= rect.right) &&
            ((start.y < end.y && rect.top > start.y && rect.top < end.y) ||
                (start.y > end.y && rect.bottom < start.y && rect.bottom > end.y));
    }

    private static getOffsetConnectionPoint(item: CanvasItem, scale: number, originalPoint: Point): Point {
        const side = this.determinePointSide(item, originalPoint);
        const offset = OFFSET;
        switch (side) {
            case "left": return { x: originalPoint.x - offset, y: originalPoint.y };
            case "right": return { x: originalPoint.x + offset, y: originalPoint.y };
            case "top": return { x: originalPoint.x, y: originalPoint.y - offset };
            case "bottom": return { x: originalPoint.x, y: originalPoint.y + offset };
            default: return originalPoint;
        }
    }

    private static determinePointSide(item: CanvasItem, point: Point): string {
        const rect = {
            left: item.position.x,
            right: item.position.x + item.size.width,
            top: item.position.y,
            bottom: item.position.y + item.size.height
        };
        const leftDist = Math.abs(point.x - rect.left);
        const rightDist = Math.abs(point.x - rect.right);
        const topDist = Math.abs(point.y - rect.top);
        const bottomDist = Math.abs(point.y - rect.bottom);
        const minDist = Math.min(leftDist, rightDist, topDist, bottomDist);

        if (minDist === leftDist) return "left";
        if (minDist === rightDist) return "right";
        if (minDist === topDist) return "top";
        return "bottom";
    }

    private static canConnectDirectly(start: Point, end: Point, canvasItems: CanvasItem[], scale: number): boolean {
        if (Math.abs(start.y - end.y) < 0.1) { // Horizontal
            for (const item of canvasItems) {
                const rect = this.getExpandedRectangle(item, scale);
                if (this.isInHorizontalPath(start, end, rect)) return false;
            }
            return true;
        } else if (Math.abs(start.x - end.x) < 0.1) { // Vertical
            for (const item of canvasItems) {
                const rect = this.getExpandedRectangle(item, scale);
                if (this.isInVerticalPath(start, end, rect)) return false;
            }
            return true;
        }
        return false;
    }

    private static shouldTryHorizontalFirst(start: Point, end: Point, canvasItems: CanvasItem[], existingPaths: Point[][], scale: number): boolean {
        const hDist = Math.abs(end.x - start.x);
        const vDist = Math.abs(end.y - start.y);
        const hObs = this.countObstaclesInDirection(start, end, canvasItems, true, scale);
        const vObs = this.countObstaclesInDirection(start, end, canvasItems, false, scale);
        const hCross = this.evaluateSimplePathCrossings(start, end, true, existingPaths);
        const vCross = this.evaluateSimplePathCrossings(start, end, false, existingPaths);

        const hScore = hDist + hObs * 100 + hCross * 200 + 5; // +5 bias for horizontal
        const vScore = vDist + vObs * 100 + vCross * 200;

        if (Math.abs(hScore - vScore) < 0.1) return hDist <= vDist;
        return hScore <= vScore;
    }

    private static countObstaclesInDirection(start: Point, end: Point, canvasItems: CanvasItem[], horizontal: boolean, scale: number): number {
        let count = 0;
        for (const item of canvasItems) {
            const rect = this.getExpandedRectangle(item, scale);
            if (horizontal) {
                if (this.isInHorizontalPath(start, { x: end.x, y: start.y }, rect)) count++;
            } else {
                if (this.isInVerticalPath(start, { x: start.x, y: end.y }, rect)) count++;
            }
        }
        return count;
    }

    private static evaluateSimplePathCrossings(start: Point, end: Point, horizontalFirst: boolean, existingPaths: Point[][]): number {
        const path: Point[] = [];
        if (horizontalFirst) {
            path.push(start);
            if (start.x !== end.x) path.push({ x: end.x, y: start.y });
            path.push(end);
        } else {
            path.push(start);
            if (start.y !== end.y) path.push({ x: start.x, y: end.y });
            path.push(end);
        }
        return this.countPotentialCrossings(path, existingPaths);
    }

    private static countPotentialCrossings(path: Point[], existingPaths: Point[][]): number {
        let count = 0;
        for (let i = 0; i < path.length - 1; i++) {
            const s1 = path[i];
            const e1 = path[i + 1];
            for (const exPath of existingPaths) {
                for (let j = 0; j < exPath.length - 1; j++) {
                    const s2 = exPath[j];
                    const e2 = exPath[j + 1];
                    if (this.doLinesIntersect(s1, e1, s2, e2)) {
                        const intersection = this.getIntersectionPoint(s1, e1, s2, e2);
                        if (this.isRealCrossing(intersection, s1, e1, s2, e2)) count++;
                    }
                }
            }
        }
        return count;
    }

    private static doLinesIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
        const isH1 = Math.abs(p1.y - p2.y) < 0.1;
        const isH2 = Math.abs(p3.y - p4.y) < 0.1;
        if (isH1 === isH2) return false; // Parallel

        const l1MinX = Math.min(p1.x, p2.x), l1MaxX = Math.max(p1.x, p2.x);
        const l1MinY = Math.min(p1.y, p2.y), l1MaxY = Math.max(p1.y, p2.y);
        const l2MinX = Math.min(p3.x, p4.x), l2MaxX = Math.max(p3.x, p4.x);
        const l2MinY = Math.min(p3.y, p4.y), l2MaxY = Math.max(p3.y, p4.y);

        return l1MinX <= l2MaxX && l1MaxX >= l2MinX && l1MinY <= l2MaxY && l1MaxY >= l2MinY;
    }

    private static getIntersectionPoint(p1: Point, p2: Point, p3: Point, p4: Point): Point {
        if (Math.abs(p1.y - p2.y) < 0.1) return { x: p3.x, y: p1.y }; // p1-p2 is horizontal
        return { x: p1.x, y: p3.y }; // p1-p2 is vertical
    }

    private static isRealCrossing(int: Point, s1: Point, e1: Point, s2: Point, e2: Point): boolean {
        if ((int.x === s1.x && int.y === s1.y) || (int.x === e1.x && int.y === e1.y) ||
            (int.x === s2.x && int.y === s2.y) || (int.x === e2.x && int.y === e2.y)) return false;
        return this.isPointOnSegment(int, s1, e1) && this.isPointOnSegment(int, s2, e2);
    }

    private static isPointOnSegment(p: Point, s: Point, e: Point): boolean {
        const minX = Math.min(s.x, e.x), maxX = Math.max(s.x, e.x);
        const minY = Math.min(s.y, e.y), maxY = Math.max(s.y, e.y);
        return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    }

    private static addJumperIndicationsToPath(path: Point[], existingPaths: Point[][], scale: number): Point[] {
        const result: Point[] = [path[0]];
        // Note: In JS we can't easily modify existingPaths in place and expect React to update without state change.
        // For now, we will just generate jumpers for the current path.
        // The C# code also modified existing paths, which is complex in React.
        // We will focus on drawing jumpers on the *current* path where it crosses *existing* paths.

        for (let i = 0; i < path.length - 1; i++) {
            const current = path[i];
            const next = path[i + 1];
            const isHorizontal = Math.abs(current.y - next.y) < 0.1;

            const intersections: { point: Point, isHorizontal: boolean }[] = [];

            for (const exPath of existingPaths) {
                for (let j = 0; j < exPath.length - 1; j++) {
                    const s = exPath[j];
                    const e = exPath[j + 1];
                    if (this.doLinesIntersect(current, next, s, e)) {
                        const int = this.getIntersectionPoint(current, next, s, e);
                        if (int.x !== current.x || int.y !== current.y) { // Don't jump at start
                            if (int.x !== next.x || int.y !== next.y) { // Don't jump at end
                                intersections.push({ point: int, isHorizontal });
                            }
                        }
                    }
                }
            }

            // Sort intersections by distance from current
            intersections.sort((a, b) => {
                const d1 = (a.point.x - current.x) ** 2 + (a.point.y - current.y) ** 2;
                const d2 = (b.point.x - current.x) ** 2 + (b.point.y - current.y) ** 2;
                return d1 - d2;
            });

            for (const int of intersections) {
                if (int.isHorizontal) {
                    this.addHorizontalJumper(result, int.point, current, next, scale);
                } else {
                    this.addVerticalJumper(result, int.point, current, next, scale);
                }
            }
            result.push(next);
        }
        return result;
    }

    private static addHorizontalJumper(result: Point[], intersection: Point, start: Point, end: Point, scale: number) {
        const isLeftToRight = start.x < end.x;
        if (isLeftToRight) {
            result.push({ x: intersection.x - 6, y: start.y });
            result.push({ x: intersection.x - 3, y: start.y - 3 });
            result.push({ x: intersection.x, y: start.y - 6 });
            result.push({ x: intersection.x + 3, y: start.y - 3 });
            result.push({ x: intersection.x + 6, y: start.y });
        } else {
            result.push({ x: intersection.x + 6, y: start.y });
            result.push({ x: intersection.x + 3, y: start.y - 3 });
            result.push({ x: intersection.x, y: start.y - 6 });
            result.push({ x: intersection.x - 3, y: start.y - 3 });
            result.push({ x: intersection.x - 6, y: start.y });
        }
    }

    private static addVerticalJumper(result: Point[], intersection: Point, start: Point, end: Point, scale: number) {
        const isTopToBottom = start.y < end.y;
        if (isTopToBottom) {
            result.push({ x: start.x, y: intersection.y - 6 });
            result.push({ x: start.x + 3, y: intersection.y - 3 });
            result.push({ x: start.x + 6, y: intersection.y });
            result.push({ x: start.x + 3, y: intersection.y + 3 });
            result.push({ x: start.x, y: intersection.y + 6 });
        } else {
            result.push({ x: start.x, y: intersection.y + 6 });
            result.push({ x: start.x + 3, y: intersection.y + 3 });
            result.push({ x: start.x + 6, y: intersection.y });
            result.push({ x: start.x + 3, y: intersection.y - 3 });
            result.push({ x: start.x, y: intersection.y - 6 });
        }
    }

    private static getSpecTextAndPosition(
        connector: Connector,
        path: Point[],
        scale: number,
        canvasItems: CanvasItem[],
        existingPaths: Point[][]
    ): ConnectionPath | undefined {
        if (!path || path.length < 2) return undefined;

        let specText = "";
        const replacements: Record<string, string> = {
            "Copper": "Cu", "Aluminum": "Al", "Aluminium": "Al",
            "Armoured": "Ar", "Armored": "Ar", "Un-armoured": "Un-Ar", "Un-armored": "Un-Ar"
        };

        if (connector.sourceItem.name === "Point Switch Board" || connector.targetItem.name === "Point Switch Board" ||
            connector.sourceItem.name === "Avg. 5A Switch Board" || connector.targetItem.name === "Avg. 5A Switch Board") {
            specText = "  3 x 1.5 Sq.Mm. Cu Wire ";
        } else if (connector.properties && Object.keys(connector.properties).length > 0) {
            const values = Object.values(connector.properties);
            const limit = connector.materialType === "Wiring" ? 3 : 4;
            const displayValues = values.slice(0, limit).map(v => {
                const trimmed = v.trim();
                return replacements[trimmed] || trimmed;
            });
            specText = displayValues.join(",") + (connector.materialType === "Wiring" ? ", Wire" : ", Cable");
            specText = specText.replace(/core/gi, "C");
        } else {
            return undefined;
        }

        // Estimate text size (approximate since we don't have Graphics.MeasureString)
        // Text is rendered with fontSize from settings (world units), so it scales with zoom
        const fontSize = ApplicationSettings.getConnectorSpecTextFontSize();
        const charWidth = fontSize * 0.45;
        const textWidth = specText.length * charWidth;
        const textHeight = fontSize * 1.2;

        // Find best segment
        const validSegments: any[] = [];

        for (let i = 0; i < path.length - 1; i++) {
            const p1 = path[i];
            const p2 = path[i + 1];
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            const isHorizontal = Math.abs(p1.y - p2.y) < 0.1;
            const length = isHorizontal ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y);

            // Since text is rotated on vertical lines, we always need textWidth space along the line
            const requiredLength = textWidth;

            if (length < requiredLength) continue;

            validSegments.push({ p1, mid, isHorizontal, length });
        }

        // Sort by length descending to find the most spacious segment
        validSegments.sort((a, b) => b.length - a.length);

        if (validSegments.length > 0) {
            const best = validSegments[0];
            let textX = best.mid.x;
            let textY = best.mid.y;

            if (best.isHorizontal) {
                textX -= textWidth / 2;
                textY += 5;
            } else {
                textX += 5; // Padding to the right of the line
                textY += textWidth / 2; // Center vertically (text extends upwards from insertion point)
            }
            return { specText, specTextPosition: { x: textX, y: textY }, isHorizontal: best.isHorizontal };
        }

        return undefined;
    }
}
