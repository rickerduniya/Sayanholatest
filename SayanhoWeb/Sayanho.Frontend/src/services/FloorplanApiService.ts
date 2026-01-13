import { Wall, Door, LayoutWindow, Room, Point, FloorPlan } from '../types/layout';
import { generateLayoutId, snapToWall } from '../utils/LayoutDrawingTools';

const API_URL = "https://nilche111-floorplan3d-api.hf.space/predict";

export interface FloorplanApiDebugInfo {
    request: {
        url: string;
        method: string;
        filename: string;
        fileSize: number;
        fileType: string;
        confidence_threshold: string;
        detection_threshold: string;
    };
    response?: {
        status: number;
        statusText: string;
        receivedAt: string;
        json: unknown;
    };
    error?: {
        message: string;
    };
}

function detectRoomsFromPixels(
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
    offsetX: number = 0,
    offsetY: number = 0
): Room[] {
    const step = 3;
    const gw = Math.floor(width / step);
    const gh = Math.floor(height / step);
    if (gw <= 2 || gh <= 2) return [];

    const gridOpen = new Uint8Array(gw * gh);
    const gridVisited = new Uint8Array(gw * gh);
    const gIdx = (x: number, y: number) => (y * gw + x);
    const pIdx = (x: number, y: number) => (y * width + x);

    const half = Math.floor(step / 2);
    for (let gy = 0; gy < gh; gy++) {
        const py = Math.min(height - 1, gy * step + half);
        for (let gx = 0; gx < gw; gx++) {
            const px = Math.min(width - 1, gx * step + half);
            const pi = pIdx(px, py) * 4;
            gridOpen[gIdx(gx, gy)] = pixels[pi] > 128 ? 1 : 0;
        }
    }

    const detectedRooms: Room[] = [];
    const candidateRooms: Array<{ room: Room; touchesBorder: boolean; cellCount: number }> = [];
    const minAreaPx = 200;
    const minCells = Math.max(1, Math.ceil(minAreaPx / (step * step)));

    const encode = (x: number, y: number) => `${x},${y}`;
    const decode = (k: string) => {
        const [xs, ys] = k.split(',');
        return { x: parseInt(xs, 10), y: parseInt(ys, 10) };
    };

    const simplifyCollinear = (pts: Point[]): Point[] => {
        if (pts.length < 4) return pts;
        const out: Point[] = [];
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n];
            const cur = pts[i];
            const next = pts[(i + 1) % n];
            const dx1 = cur.x - prev.x;
            const dy1 = cur.y - prev.y;
            const dx2 = next.x - cur.x;
            const dy2 = next.y - cur.y;
            const collinear = (dx1 === 0 && dx2 === 0) || (dy1 === 0 && dy2 === 0);
            if (!collinear) out.push(cur);
        }
        return out;
    };

    const buildBoundaryPolygon = (cells: Array<[number, number]>): Point[] | null => {
        const cellSet = new Set<number>();
        for (const [x, y] of cells) cellSet.add(gIdx(x, y));

        const outEdges = new Map<string, string[]>();
        const addEdge = (sx: number, sy: number, ex: number, ey: number) => {
            const s = encode(sx, sy);
            const e = encode(ex, ey);
            const arr = outEdges.get(s);
            if (arr) arr.push(e);
            else outEdges.set(s, [e]);
        };

        for (const [gx, gy] of cells) {
            const x0 = gx * step;
            const y0 = gy * step;
            const x1 = x0 + step;
            const y1 = y0 + step;

            const up = gy > 0 && cellSet.has(gIdx(gx, gy - 1));
            const right = gx < gw - 1 && cellSet.has(gIdx(gx + 1, gy));
            const down = gy < gh - 1 && cellSet.has(gIdx(gx, gy + 1));
            const left = gx > 0 && cellSet.has(gIdx(gx - 1, gy));

            if (!up) addEdge(x0, y0, x1, y0);
            if (!right) addEdge(x1, y0, x1, y1);
            if (!down) addEdge(x1, y1, x0, y1);
            if (!left) addEdge(x0, y1, x0, y0);
        }

        if (outEdges.size === 0) return null;

        const used = new Set<string>();
        const anyStart = outEdges.keys().next().value as string;
        const startList = outEdges.get(anyStart);
        if (!startList || startList.length === 0) return null;

        const loop: Point[] = [];
        let cur = anyStart;
        let next = startList[0];
        used.add(`${cur}->${next}`);
        loop.push(decode(cur));

        let guard = 0;
        while (guard++ < 200000) {
            loop.push(decode(next));
            if (next === anyStart) break;
            const candidates = outEdges.get(next);
            if (!candidates || candidates.length === 0) break;
            let chosen: string | null = null;
            for (const cand of candidates) {
                const k = `${next}->${cand}`;
                if (!used.has(k)) {
                    chosen = cand;
                    used.add(k);
                    break;
                }
            }
            if (!chosen) break;
            cur = next;
            next = chosen;
        }

        if (loop.length > 1) {
            const last = loop[loop.length - 1];
            const first = loop[0];
            if (last.x === first.x && last.y === first.y) loop.pop();
        }

        const cleaned = simplifyCollinear(loop);
        return cleaned.length >= 3 ? cleaned : null;
    };

    for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
            const gi = gIdx(gx, gy);
            if (gridOpen[gi] === 0 || gridVisited[gi] === 1) continue;

            const qx: number[] = [gx];
            const qy: number[] = [gy];
            gridVisited[gi] = 1;

            const cells: Array<[number, number]> = [];
            let minCellX = gx;
            let maxCellX = gx;
            let minCellY = gy;
            let maxCellY = gy;
            let touchesBorder = false;
            while (qx.length) {
                const cx = qx.pop()!;
                const cy = qy.pop()!;
                cells.push([cx, cy]);

                if (cx < minCellX) minCellX = cx;
                if (cx > maxCellX) maxCellX = cx;
                if (cy < minCellY) minCellY = cy;
                if (cy > maxCellY) maxCellY = cy;

                if (cx === 0 || cy === 0 || cx === gw - 1 || cy === gh - 1) {
                    touchesBorder = true;
                }

                const neigh = [
                    [cx + 1, cy],
                    [cx - 1, cy],
                    [cx, cy + 1],
                    [cx, cy - 1]
                ];
                for (const [nx, ny] of neigh) {
                    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                    const ni = gIdx(nx, ny);
                    if (gridVisited[ni] === 1) continue;
                    if (gridOpen[ni] === 0) continue;
                    gridVisited[ni] = 1;
                    qx.push(nx);
                    qy.push(ny);
                }
            }

            if (cells.length < minCells) continue;

            const polygon = buildBoundaryPolygon(cells);
            const fallbackPolygon: Point[] = [
                { x: minCellX * step, y: minCellY * step },
                { x: (maxCellX + 1) * step, y: minCellY * step },
                { x: (maxCellX + 1) * step, y: (maxCellY + 1) * step },
                { x: minCellX * step, y: (maxCellY + 1) * step }
            ];

            const finalPoly = polygon ?? fallbackPolygon;

            const room: Room = {
                id: generateLayoutId('room'),
                name: `Room ${candidateRooms.length + 1}`,
                polygon: finalPoly.map(p => ({ x: p.x + offsetX, y: p.y + offsetY })),
                type: 'other'
            };
            candidateRooms.push({ room, touchesBorder, cellCount: cells.length });
        }
    }

    // Prefer dropping any region connected to the crop border (outside area).
    let kept = candidateRooms.filter(r => !r.touchesBorder);

    // Fallback: if nothing touches border (e.g. border fully blocked) but we still got a huge region,
    // drop the largest region as it is almost certainly the outside/background.
    if (kept.length === candidateRooms.length && candidateRooms.length > 1) {
        let maxIdx = 0;
        for (let i = 1; i < candidateRooms.length; i++) {
            if (candidateRooms[i].cellCount > candidateRooms[maxIdx].cellCount) maxIdx = i;
        }
        const maxCells = candidateRooms[maxIdx].cellCount;
        const totalCells = gw * gh;
        if (maxCells > totalCells * 0.35) {
            kept = candidateRooms.filter((_, i) => i !== maxIdx);
        }
    }

    for (const k of kept) detectedRooms.push(k.room);
    return detectedRooms;
}

function detectRoomsFromLayoutGeometry(
    width: number,
    height: number,
    walls: Wall[],
    doors: Door[],
    windows: LayoutWindow[]
): Room[] {
    if (typeof document === 'undefined') return [];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const expand = (x: number, y: number) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };

    for (const w of walls) {
        expand(w.startPoint.x, w.startPoint.y);
        expand(w.endPoint.x, w.endPoint.y);
    }
    for (const d of doors) expand(d.position.x, d.position.y);
    for (const win of windows) expand(win.position.x, win.position.y);

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return [];

    const margin = 140;
    const ox = Math.max(0, Math.floor(minX - margin));
    const oy = Math.max(0, Math.floor(minY - margin));
    const ex = Math.min(width, Math.ceil(maxX + margin));
    const ey = Math.min(height, Math.ceil(maxY + margin));
    const cw = Math.max(1, ex - ox);
    const ch = Math.max(1, ey - oy);

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];

    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cw, ch);

    ctx.fillStyle = '#000000';

    const wallById = new Map(walls.map(w => [w.id, w] as const));

    for (const w of walls) {
        const ax = w.startPoint.x;
        const ay = w.startPoint.y;
        const bx = w.endPoint.x;
        const by = w.endPoint.y;
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len <= 1e-6) continue;

        const px = -dy / len;
        const py = dx / len;

        const t = Math.max(1, w.thickness || 10) + 2;
        const halfT = t / 2;

        const p1x = ax + px * halfT;
        const p1y = ay + py * halfT;
        const p2x = bx + px * halfT;
        const p2y = by + py * halfT;
        const p3x = bx - px * halfT;
        const p3y = by - py * halfT;
        const p4x = ax - px * halfT;
        const p4y = ay - py * halfT;

        ctx.beginPath();
        ctx.moveTo(p1x - ox, p1y - oy);
        ctx.lineTo(p2x - ox, p2y - oy);
        ctx.lineTo(p3x - ox, p3y - oy);
        ctx.lineTo(p4x - ox, p4y - oy);
        ctx.closePath();
        ctx.fill();

        // End-caps to close tiny corner gaps where two walls meet.
        ctx.beginPath();
        ctx.arc(ax - ox, ay - oy, halfT, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.arc(bx - ox, by - oy, halfT, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
    }

    const drawClosure = (center: Point, length: number, thickness: number, angleRad: number) => {
        ctx.save();
        ctx.translate(center.x - ox, center.y - oy);
        ctx.rotate(angleRad);
        ctx.fillRect(-length / 2, -thickness / 2, length, thickness);
        ctx.restore();
    };

    for (const d of doors) {
        const w = wallById.get(d.wallId);
        const angleRad = w
            ? Math.atan2(w.endPoint.y - w.startPoint.y, w.endPoint.x - w.startPoint.x)
            : (d.rotation * Math.PI) / 180;
        const thickness = Math.max(6, ((w?.thickness ?? 10) as number) * 1.1);
        drawClosure(d.position, Math.max(10, d.width), thickness, angleRad);
    }

    for (const win of windows) {
        const w = wallById.get(win.wallId);
        const angleRad = w
            ? Math.atan2(w.endPoint.y - w.startPoint.y, w.endPoint.x - w.startPoint.x)
            : (((win.rotation ?? 0) * Math.PI) / 180);
        const thickness = Math.max(4, ((w?.thickness ?? 10) as number) * 1.05);
        drawClosure(win.position, Math.max(10, win.width), thickness, angleRad);
    }

    const imgData = ctx.getImageData(0, 0, cw, ch);
    const rooms = detectRoomsFromPixels(cw, ch, imgData.data, ox, oy);
    if (rooms.length === 0) {
        console.debug('[detectRooms] no rooms found', {
            crop: { ox, oy, cw, ch },
            counts: { walls: walls.length, doors: doors.length, windows: windows.length }
        });
    }
    return rooms;
}

let lastDebugInfo: FloorplanApiDebugInfo | null = null;

interface ApiPoint {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

interface ApiClass {
    name: string;
    confidence: number;
}

interface ApiResponseImage {
    floor_index: number;
    points: ApiPoint[];
    classes: ApiClass[];
    Width: number;
    Height: number;
    averageDoor: number;
}

interface ApiResponse {
    images: ApiResponseImage[];
}

export interface DetectedLayout {
    walls: Wall[];
    doors: Door[];
    windows: LayoutWindow[];
    rooms: Room[];
}

export const FloorplanApiService = {
    /**
     * Detect layout from an image file using the external API
     */
    detectLayout: async (file: File): Promise<DetectedLayout> => {
        const formData = new FormData();
        formData.append('image', file);
        const confidence_threshold = '0.2';
        const detection_threshold = '0.2';
        formData.append('confidence_threshold', confidence_threshold); // Default threshold
        formData.append('detection_threshold', detection_threshold);

        lastDebugInfo = {
            request: {
                url: API_URL,
                method: 'POST',
                filename: file.name,
                fileSize: file.size,
                fileType: file.type,
                confidence_threshold,
                detection_threshold
            }
        };

        try {
            const response = await fetchWithRetry(API_URL, {
                method: 'POST',
                body: formData
            });

            const data: ApiResponse = await response.json();

            lastDebugInfo = {
                ...lastDebugInfo,
                response: {
                    status: response.status,
                    statusText: response.statusText,
                    receivedAt: new Date().toISOString(),
                    json: data
                }
            };

            if (!data.images || data.images.length === 0) {
                throw new Error("No layout detected in the response.");
            }

            const imgResult = data.images[0];
            return processDetectionResult(imgResult);

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            lastDebugInfo = {
                ...(lastDebugInfo || {
                    request: {
                        url: API_URL,
                        method: 'POST',
                        filename: file.name,
                        fileSize: file.size,
                        fileType: file.type,
                        confidence_threshold: '0.2',
                        detection_threshold: '0.2'
                    }
                }),
                error: { message: msg }
            };
            console.error("Floorplan detection failed:", error);
            throw error;
        }
    },

    getLastDebugInfo: (): FloorplanApiDebugInfo | null => lastDebugInfo,

    detectRoomsFromPlan: (plan: Pick<FloorPlan, 'width' | 'height' | 'walls' | 'doors' | 'windows'>): Room[] => {
        return detectRoomsFromLayoutGeometry(plan.width, plan.height, plan.walls, plan.doors, plan.windows);
    }
};

/**
 * Fetch wrapper with retry logic for 503 (Service Unavailable / Sleeping)
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, timeoutMs = 60000): Promise<Response> {
    const startTime = Date.now();

    for (let i = 0; i < retries; i++) {
        try {
            // Check for overall timeout
            if (Date.now() - startTime > timeoutMs) {
                throw new Error("Request timed out waiting for service to wake up.");
            }

            const response = await fetch(url, options);

            // If 503, the Hugging Face Space might be waking up
            if (response.status === 503) {
                console.warn(`Service unavailable (attempt ${i + 1}/${retries}). Waiting...`);
                // Wait longer for the first retry as it might be cold start
                const waitTime = i === 0 ? 15000 : 5000;
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            return response;

        } catch (err: any) {
            if (i === retries - 1) throw err;
            console.warn(`Fetch error (attempt ${i + 1}/${retries}):`, err);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    throw new Error("Failed to connect to detection service.");
}

/**
 * Process the API result into application entities
 */
function processDetectionResult(result: ApiResponseImage): DetectedLayout {
    const walls: Wall[] = [];
    const doors: Door[] = [];
    const windows: LayoutWindow[] = [];

    // Categorize raw detections for room detection
    const rawWalls: ApiPoint[] = [];
    const rawDoors: ApiPoint[] = [];
    const rawWindows: ApiPoint[] = [];
    const rawUnclassified: ApiPoint[] = [];

    const { points, classes, Width, Height } = result;

    // 1. First Pass: Categorize and Process Walls
    points.forEach((pt, idx) => {
        const cls = classes[idx];
        if (!cls) return;

        if (cls.name === 'wall') {
            rawWalls.push(pt);

            const width = Math.abs(pt.x2 - pt.x1);
            const height = Math.abs(pt.y2 - pt.y1);
            const centerX = (pt.x1 + pt.x2) / 2;
            const centerY = (pt.y1 + pt.y2) / 2;

            let thickness = 10;
            let start: Point;
            let end: Point;

            if (width > height) {
                // Horizontal Wall
                thickness = Math.max(height, 5);
                start = { x: pt.x1, y: centerY };
                end = { x: pt.x2, y: centerY };
            } else {
                // Vertical Wall
                thickness = Math.max(width, 5);
                start = { x: centerX, y: pt.y1 };
                end = { x: centerX, y: pt.y2 };
            }

            walls.push({
                id: generateLayoutId('wall'),
                startPoint: start,
                endPoint: end,
                thickness: thickness
            });
        } else if (cls.name === 'door') {
            rawDoors.push(pt);
        } else if (cls.name === 'window') {
            rawWindows.push(pt);
        } else if (cls.name === 'unclassified') {
            rawUnclassified.push(pt);
        }
    });

    // 2. Process Doors/Windows
    points.forEach((pt, idx) => {
        const cls = classes[idx];
        if (!cls || cls.name === 'wall' || cls.name === 'unclassified') return;

        const width = Math.abs(pt.x2 - pt.x1);
        const height = Math.abs(pt.y2 - pt.y1);
        const centerX = (pt.x1 + pt.x2) / 2;
        const centerY = (pt.y1 + pt.y2) / 2;
        const center = { x: centerX, y: centerY };

        // Finds nearest wall for rotation/association only.
        // NOTE: We do NOT snap the position to the wall, because the API detects doors
        // as gaps between walls. Snapping to the nearest wall segment would move
        // the door onto the solid wall, hiding it or looking wrong.
        const snap = snapToWall(center, walls, 200);
        const snappedWall = snap ? snap.wall : null;
        const snappedAngleDeg = snappedWall
            ? (Math.atan2(snappedWall.endPoint.y - snappedWall.startPoint.y, snappedWall.endPoint.x - snappedWall.startPoint.x) * 180) / Math.PI
            : null;

        if (cls.name === 'door') {
            const size = Math.max(width, height);

            const rotation = snappedAngleDeg ?? (width > height ? 0 : 90);

            doors.push({
                id: generateLayoutId('door'),
                position: center,
                width: size,
                wallId: snappedWall ? snappedWall.id : 'orphan',
                rotation,
                type: 'single'
            });

        } else if (cls.name === 'window') {
            const length = Math.max(width, height);
            const depth = Math.max(6, Math.min(width, height));
            const rotation = snappedAngleDeg ?? (width > height ? 0 : 90);
            windows.push({
                id: generateLayoutId('window'),
                position: center,
                width: length,
                height: depth,
                wallId: snappedWall ? snappedWall.id : 'orphan',
                rotation
            });
        }
    });

    const rooms = detectRoomsFromLayoutGeometry(Width, Height, walls, doors, windows);

    return { walls, doors, windows, rooms };
}

function calculateAvgWallThickness(walls: ApiPoint[]): number {
    if (!walls || walls.length === 0) return 10;
    let totalThick = 0;
    let count = 0;
    walls.forEach(w => {
        const width = Math.abs(w.x2 - w.x1);
        const height = Math.abs(w.y2 - w.y1);
        const thick = Math.min(width, height);
        if (thick > 1) {
            totalThick += thick;
            count++;
        }
    });
    return count > 0 ? (totalThick / count) : 10;
}

/**
 * Room Segmentation Logic (ported from improved sample)
 */
function detectRooms(
    width: number,
    height: number,
    walls: ApiPoint[],
    doors: ApiPoint[],
    windows: ApiPoint[],
    unclassified: ApiPoint[]
): Room[] {
    if (typeof document === 'undefined') {
        return [];
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!ctx) return [];

    // 1. Draw Background (White)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);

    // 2. Draw Obstacles (Black)
    ctx.fillStyle = '#000000';

    // Calculate inflation to close small gaps
    const avgThickness = calculateAvgWallThickness(walls);
    const inflation = Math.max(2, avgThickness * 0.15);

    const drawObstacle = (items: ApiPoint[]) => {
        items.forEach(item => {
            const w = Math.abs(item.x2 - item.x1);
            const h = Math.abs(item.y2 - item.y1);
            const x = Math.min(item.x1, item.x2);
            const y = Math.min(item.y1, item.y2);

            ctx.fillRect(
                x - inflation,
                y - inflation,
                w + (inflation * 2),
                h + (inflation * 2)
            );
        });
    };

    drawObstacle(walls);
    drawObstacle(doors);
    drawObstacle(windows);
    drawObstacle(unclassified);

    const imgData = ctx.getImageData(0, 0, width, height);
    const pixels = imgData.data;

    // Work on a downsampled grid for speed; each cell represents a step×step block.
    // This also naturally produces pixel-perfect-ish polygons (at step resolution).
    const step = 5;
    const gw = Math.floor(width / step);
    const gh = Math.floor(height / step);
    if (gw <= 2 || gh <= 2) return [];

    const gridOpen = new Uint8Array(gw * gh);
    const gridVisited = new Uint8Array(gw * gh);
    const gIdx = (x: number, y: number) => (y * gw + x);
    const pIdx = (x: number, y: number) => (y * width + x);

    // Sample the center pixel of each block. (Obstacles are black, empty space is white.)
    const half = Math.floor(step / 2);
    for (let gy = 0; gy < gh; gy++) {
        const py = Math.min(height - 1, gy * step + half);
        for (let gx = 0; gx < gw; gx++) {
            const px = Math.min(width - 1, gx * step + half);
            const pi = pIdx(px, py) * 4;
            gridOpen[gIdx(gx, gy)] = pixels[pi] > 128 ? 1 : 0;
        }
    }

    const detectedRooms: Room[] = [];
    const minAreaPx = 200;
    const minCells = Math.max(1, Math.ceil(minAreaPx / (step * step)));

    const encode = (x: number, y: number) => `${x},${y}`;
    const decode = (k: string) => {
        const [xs, ys] = k.split(',');
        return { x: parseInt(xs, 10), y: parseInt(ys, 10) };
    };

    const simplifyCollinear = (pts: Point[]): Point[] => {
        if (pts.length < 4) return pts;
        const out: Point[] = [];
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n];
            const cur = pts[i];
            const next = pts[(i + 1) % n];
            const dx1 = cur.x - prev.x;
            const dy1 = cur.y - prev.y;
            const dx2 = next.x - cur.x;
            const dy2 = next.y - cur.y;
            const collinear = (dx1 === 0 && dx2 === 0) || (dy1 === 0 && dy2 === 0);
            if (!collinear) out.push(cur);
        }
        return out;
    };

    const buildBoundaryPolygon = (cells: Array<[number, number]>): Point[] | null => {
        const cellSet = new Set<number>();
        for (const [x, y] of cells) cellSet.add(gIdx(x, y));

        // Collect directed boundary edges (clockwise) for the union of grid squares.
        const outEdges = new Map<string, string[]>();
        const addEdge = (sx: number, sy: number, ex: number, ey: number) => {
            const s = encode(sx, sy);
            const e = encode(ex, ey);
            const arr = outEdges.get(s);
            if (arr) arr.push(e);
            else outEdges.set(s, [e]);
        };

        for (const [gx, gy] of cells) {
            const x0 = gx * step;
            const y0 = gy * step;
            const x1 = x0 + step;
            const y1 = y0 + step;

            // neighbor checks
            const up = gy > 0 && cellSet.has(gIdx(gx, gy - 1));
            const right = gx < gw - 1 && cellSet.has(gIdx(gx + 1, gy));
            const down = gy < gh - 1 && cellSet.has(gIdx(gx, gy + 1));
            const left = gx > 0 && cellSet.has(gIdx(gx - 1, gy));

            if (!up) addEdge(x0, y0, x1, y0);
            if (!right) addEdge(x1, y0, x1, y1);
            if (!down) addEdge(x1, y1, x0, y1);
            if (!left) addEdge(x0, y1, x0, y0);
        }

        if (outEdges.size === 0) return null;

        // Stitch edges into a loop.
        const used = new Set<string>();
        const anyStart = outEdges.keys().next().value as string;
        const startList = outEdges.get(anyStart);
        if (!startList || startList.length === 0) return null;

        const loop: Point[] = [];
        let cur = anyStart;
        let next = startList[0];
        used.add(`${cur}->${next}`);
        loop.push(decode(cur));

        let guard = 0;
        while (guard++ < 200000) {
            loop.push(decode(next));
            if (next === anyStart) break;
            const candidates = outEdges.get(next);
            if (!candidates || candidates.length === 0) break;
            // pick first unused edge
            let chosen: string | null = null;
            for (const cand of candidates) {
                const k = `${next}->${cand}`;
                if (!used.has(k)) {
                    chosen = cand;
                    used.add(k);
                    break;
                }
            }
            if (!chosen) break;
            cur = next;
            next = chosen;
        }

        // remove last repeated start
        if (loop.length > 1) {
            const last = loop[loop.length - 1];
            const first = loop[0];
            if (last.x === first.x && last.y === first.y) loop.pop();
        }

        const cleaned = simplifyCollinear(loop);
        return cleaned.length >= 3 ? cleaned : null;
    };

    for (let gy = 1; gy < gh - 1; gy++) {
        for (let gx = 1; gx < gw - 1; gx++) {
            const gi = gIdx(gx, gy);
            if (gridOpen[gi] === 0 || gridVisited[gi] === 1) continue;

            // BFS component in grid
            const qx: number[] = [gx];
            const qy: number[] = [gy];
            gridVisited[gi] = 1;

            const cells: Array<[number, number]> = [];
            let touchesBorder = false;
            while (qx.length) {
                const cx = qx.pop()!;
                const cy = qy.pop()!;
                cells.push([cx, cy]);

                if (cx === 0 || cy === 0 || cx === gw - 1 || cy === gh - 1) {
                    touchesBorder = true;
                }

                const neigh = [
                    [cx + 1, cy],
                    [cx - 1, cy],
                    [cx, cy + 1],
                    [cx, cy - 1]
                ];
                for (const [nx, ny] of neigh) {
                    if (nx <= 0 || ny <= 0 || nx >= gw - 1 || ny >= gh - 1) continue;
                    const ni = gIdx(nx, ny);
                    if (gridVisited[ni] === 1) continue;
                    if (gridOpen[ni] === 0) continue;
                    gridVisited[ni] = 1;
                    qx.push(nx);
                    qy.push(ny);
                }
            }

            // If it touches the boundary it's likely "outside" / background.
            if (touchesBorder || cells.length < minCells) continue;

            const polygon = buildBoundaryPolygon(cells);
            if (!polygon) continue;

            detectedRooms.push({
                id: generateLayoutId('room'),
                name: `Room ${detectedRooms.length + 1}`,
                polygon,
                type: 'other'
            });
        }
    }

    return detectedRooms;
}
