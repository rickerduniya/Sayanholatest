import { Wall, Door, LayoutWindow, Room, Point, FloorPlan, OcrResult, OcrItem, RoomType } from '../types/layout';
import { generateLayoutId, snapToWall } from '../utils/LayoutDrawingTools';
import { stitchWalls } from '../utils/WallStitching';

const API_URL = "https://nilche111-floorplan3d-api.hf.space/predict";

// ============================================================================
// Module-Level Utility Functions for OCR Room Enrichment
// ============================================================================

/**
 * Check if a point is inside a polygon using Ray Casting algorithm
 */
function isPointInPolygon(pt: { x: number; y: number }, polygon: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect = ((yi > pt.y) !== (yj > pt.y))
            && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Check if two bounding boxes overlap
 */
function doBoundingBoxesOverlap(
    box1: { x1: number; y1: number; x2: number; y2: number },
    box2: { x1: number; y1: number; x2: number; y2: number }
): boolean {
    // Normalize coordinates (ensure x1 < x2, y1 < y2)
    const a = {
        x1: Math.min(box1.x1, box1.x2),
        y1: Math.min(box1.y1, box1.y2),
        x2: Math.max(box1.x1, box1.x2),
        y2: Math.max(box1.y1, box1.y2)
    };
    const b = {
        x1: Math.min(box2.x1, box2.x2),
        y1: Math.min(box2.y1, box2.y2),
        x2: Math.max(box2.x1, box2.x2),
        y2: Math.max(box2.y1, box2.y2)
    };

    // Check for no overlap
    if (a.x2 < b.x1 || b.x2 < a.x1) return false; // No horizontal overlap
    if (a.y2 < b.y1 || b.y2 < a.y1) return false; // No vertical overlap

    return true;
}

/**
 * Get the bounding box of a polygon
 */
function getPolygonBoundingBox(polygon: { x: number; y: number }[]): { x1: number; y1: number; x2: number; y2: number } {
    if (polygon.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };

    let minX = polygon[0].x, maxX = polygon[0].x;
    let minY = polygon[0].y, maxY = polygon[0].y;

    for (const pt of polygon) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
    }

    return { x1: minX, y1: minY, x2: maxX, y2: maxY };
}

/**
 * Map detected text to RoomType
 */
function mapNameToRoomType(name: string): RoomType {
    const lowerName = name.toLowerCase();

    if (lowerName.includes('bed') || lowerName.includes('m.bed') || lowerName.includes('master')) return 'bedroom';
    if (lowerName.includes('bath') || lowerName.includes('toilet') || lowerName.includes('wc') || lowerName.includes('pwdr') || lowerName.includes('wash')) return 'bathroom';
    if (lowerName.includes('kitchen') || lowerName.includes('cook') || lowerName.includes('pantry')) return 'kitchen';
    if (lowerName.includes('living') || lowerName.includes('hall') || lowerName.includes('lounge') || lowerName.includes('drawing') || lowerName.includes('sitting')) return 'living_room';
    if (lowerName.includes('dining')) return 'dining';
    if (lowerName.includes('balcony') || lowerName.includes('terrace') || lowerName.includes('sitout') || lowerName.includes('deck') || lowerName.includes('verandah')) return 'balcony';
    if (lowerName.includes('store') || lowerName.includes('storage') || lowerName.includes('clt') || lowerName.includes('closet') || lowerName.includes('wardrobe')) return 'storage';
    if (lowerName.includes('pooja') || lowerName.includes('puja') || lowerName.includes('prayer')) return 'pooja';
    if (lowerName.includes('office') || lowerName.includes('study') || lowerName.includes('library')) return 'office';
    if (lowerName.includes('utility') || lowerName.includes('wash area')) return 'utility';
    if (lowerName.includes('stair') || lowerName.includes('lift')) return 'staircase';
    if (lowerName.includes('passage') || lowerName.includes('corridor') || lowerName.includes('lobby')) return 'corridor';

    return 'other';
}

/**
 * Parse a single dimension value (feet and inches) to decimal feet
 * Handles formats: 11'-7/2", 10'-6", 5'-0", 10, 10.5, 3.5m
 */
function parseSingleDimension(dim: string): number | null {
    if (!dim) return null;

    dim = dim.trim();

    // Handle meters: 3.5m -> convert to feet
    const meterMatch = dim.match(/^(\d+\.?\d*)m$/i);
    if (meterMatch) {
        return parseFloat(meterMatch[1]) * 3.28084; // meters to feet
    }

    // Handle feet-inches: 11'-7/2", 10'-6", 5'-0"
    // Pattern: FEET'-INCHES" where INCHES can be fraction like 7/2 or 01/2
    const feetInchMatch = dim.match(/^(\d+)['\-][\s\-]*(\d*\/?\d*)["']?$/);
    if (feetInchMatch) {
        const feet = parseInt(feetInchMatch[1], 10);
        const inchPart = feetInchMatch[2];

        let inches = 0;
        if (inchPart) {
            // Handle fractions like 7/2 or 01/2
            if (inchPart.includes('/')) {
                const [num, den] = inchPart.split('/');
                if (den && parseInt(den, 10) !== 0) {
                    inches = parseInt(num, 10) / parseInt(den, 10);
                }
            } else {
                inches = parseInt(inchPart, 10) || 0;
            }
        }

        return feet + (inches / 12);
    }

    // Handle simple feet with dash: 11-7 (11 feet 7 inches)
    const simpleFeetInch = dim.match(/^(\d+)-(\d+)$/);
    if (simpleFeetInch) {
        const feet = parseInt(simpleFeetInch[1], 10);
        const inches = parseInt(simpleFeetInch[2], 10);
        return feet + (inches / 12);
    }

    // Handle pure number (assumed feet)
    const numMatch = dim.match(/^(\d+\.?\d*)$/);
    if (numMatch) {
        return parseFloat(numMatch[1]);
    }

    return null;
}

/**
 * Parse dimension string like "11'-7/2"X10'-6"" to { lengthFt, widthFt }
 * Handles Indian floorplan formats
 */
export function parseDimensionString(text: string): { lengthFt: number; widthFt: number } | null {
    if (!text) return null;

    // Normalize separators
    const normalized = text.replace(/[×*]/g, 'X').replace(/\s+/g, '');

    // Split by X (case insensitive)
    const parts = normalized.split(/[xX]/i);
    if (parts.length !== 2) return null;

    const length = parseSingleDimension(parts[0]);
    const width = parseSingleDimension(parts[1]);

    if (length === null || width === null) return null;
    if (length <= 0 || width <= 0) return null;

    return { lengthFt: length, widthFt: width };
}

/**
 * Enrich rooms with OCR data - assigns names and measurements based on text found inside rooms
 * Uses bounding box overlap AND point-in-polygon checks for robust matching
 */
export function enrichRoomsWithOcr(rooms: Room[], ocrItems: OcrItem[]): void {
    if (!ocrItems || ocrItems.length === 0 || !rooms || rooms.length === 0) return;

    // Measurement Regex: matches formats like 10x12, 10'x12', 10'-6" x 12'-0", 3.5m x 4.0m
    const measurementRegex = /((?:\d+['"]?[-.\s]?\d*[/'"]?)|(?:\d+\.?\d*m))\s*[xX*×]\s*((?:\d+['"]?[-.\s]?\d*[/'"]?)|(?:\d+\.?\d*m))/i;

    // Excluded words that should not be treated as room names
    const excludeWords = [
        'ground', 'floor', 'plan', 'scale', '1:100', '1:50', 'elevation', 'section', 'detail',
        'layout', 'schedule', 'area', 'sq.ft', 'sq.mt', 'sqft', 'sqm', 'wide', 'lvl', 'level',
        'up', 'dn', 'down', 'entry', 'exit', 'void', 'open', 'below', 'above', 'north', 'south',
        'east', 'west', 'site', 'plot', 'boundary', 'road', 'street'
    ];

    for (const room of rooms) {
        const roomBBox = getPolygonBoundingBox(room.polygon);

        // Find OCR items that intersect with this room
        const inRoomItems = ocrItems.filter(item => {
            const textBBox = item.bbox;

            // Method 1: Bounding box overlap (fast check)
            if (doBoundingBoxesOverlap(roomBBox, textBBox)) {
                // Method 2: Verify with point-in-polygon (center or any corner)
                if (isPointInPolygon(item.center, room.polygon)) return true;
                if (isPointInPolygon({ x: textBBox.x1, y: textBBox.y1 }, room.polygon)) return true;
                if (isPointInPolygon({ x: textBBox.x2, y: textBBox.y1 }, room.polygon)) return true;
                if (isPointInPolygon({ x: textBBox.x2, y: textBBox.y2 }, room.polygon)) return true;
                if (isPointInPolygon({ x: textBBox.x1, y: textBBox.y2 }, room.polygon)) return true;
            }

            return false;
        });

        if (inRoomItems.length === 0) continue;

        // Find best name and measurement from matching OCR items
        let bestName: string | null = null;
        let bestMeas: string | null = null;
        let maxNameScore = -1;

        for (const item of inRoomItems) {
            const text = item.text.trim();
            if (!text) continue;

            const isMeasurement = measurementRegex.test(text);

            if (isMeasurement) {
                if (!bestMeas) bestMeas = text;
            } else {
                const lowerText = text.toLowerCase();

                // Filter out excluded words
                if (excludeWords.some(w => lowerText.includes(w))) continue;

                // Filter out short text
                if (text.length < 3) continue;

                // Must contain at least one letter (excluding 'x' which is often in dimensions)
                const lettersOnly = text.replace(/[^a-zA-Z]/g, '').replace(/[xX]/g, '');
                if (lettersOnly.length === 0) continue;

                // Scoring heuristic
                let score = item.confidence ?? 50;

                // Bonus for uppercase (common in architectural drawings)
                if (text === text.toUpperCase() && /[A-Z]/.test(text)) score += 20;

                // Bonus for known room keywords
                if (/bed|bath|kitchen|living|dining|toilet|wc|hall|store|pooja|balcony/i.test(text)) {
                    score += 30;
                }

                if (score > maxNameScore) {
                    maxNameScore = score;
                    bestName = text;
                }
            }
        }

        // Apply the best name found
        if (bestName) {
            room.detectedName = bestName;
            room.name = bestName;
            room.type = mapNameToRoomType(bestName);
        }

        // Apply the best measurement found and calculate area
        if (bestMeas) {
            room.detectedMeasurements = bestMeas;

            // Parse dimensions and calculate area
            const dims = parseDimensionString(bestMeas);
            if (dims) {
                room.ocrDimensions = dims;
                room.ocrArea = dims.lengthFt * dims.widthFt; // Area in sq.ft
            }
        }
    }
}

export interface FloorplanApiDebugInfo {
    request: {
        url: string;
        method: string;
        filename: string;
        fileSize: number;
        fileType: string;
        confidence_threshold: string;
        detection_threshold: string;
        enable_ocr?: string;
        ocr_lang?: string;
        ocr_psm?: string;
        ocr_scale?: string;
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
    const step = 1;
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
    ocr?: ApiOcrResult;
}

interface ApiResponse {
    images: ApiResponseImage[];
}

interface ApiOcrBBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

interface ApiOcrItem {
    text: string;
    confidence?: number | null;
    bbox: ApiOcrBBox;
}

interface ApiOcrOrientation {
    orientation_degrees?: number | null;
    rotate_degrees?: number | null;
    orientation_confidence?: number | null;
    script?: string;
    script_confidence?: number | null;
    raw?: string;
    error?: string;
}

interface ApiOcrResult {
    enabled: boolean;
    text?: string;
    orientation?: ApiOcrOrientation;
    items?: ApiOcrItem[];
    error?: string;
}



export interface DetectedLayout {
    walls: Wall[];
    doors: Door[];
    windows: LayoutWindow[];
    rooms: Room[];
    originalWalls: Wall[];
    ocr?: OcrResult;
}

export const FloorplanApiService = {
    /**
     * Detect layout from an image file using the external API
     */
    detectLayout: async (
        file: File,
        actualWidth?: number,
        actualHeight?: number,
        options?: {
            enableOcr?: boolean;
            ocrLang?: string;
            ocrPsm?: number;
            ocrScale?: number;
        }
    ): Promise<DetectedLayout> => {
        const formData = new FormData();
        formData.append('image', file);
        const confidence_threshold = '0.2';
        const detection_threshold = '0.2';
        formData.append('confidence_threshold', confidence_threshold); // Default threshold
        formData.append('detection_threshold', detection_threshold);

        const enableOcr = options?.enableOcr ?? true;
        const ocr_lang = options?.ocrLang ?? 'eng';
        // PSM 11 is "Sparse text. Find as much text as possible in no particular order." - Best for floor plans
        const ocr_psm = String(options?.ocrPsm ?? 11);
        const ocr_scale = String(options?.ocrScale ?? 2.0);

        formData.append('enable_ocr', enableOcr ? 'true' : 'false');
        formData.append('ocr_lang', ocr_lang);
        formData.append('ocr_psm', ocr_psm);
        formData.append('ocr_scale', ocr_scale);

        lastDebugInfo = {
            request: {
                url: API_URL,
                method: 'POST',
                filename: file.name,
                fileSize: file.size,
                fileType: file.type,
                confidence_threshold,
                detection_threshold,
                enable_ocr: enableOcr ? 'true' : 'false',
                ocr_lang,
                ocr_psm,
                ocr_scale
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

            // Reconcile rotation if dimensions are swapped (EXIF issue)
            return processDetectionResult(imgResult, actualWidth, actualHeight);

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

    detectRoomsFromPlan: (plan: Pick<FloorPlan, 'width' | 'height' | 'walls' | 'doors' | 'windows'>, ocrItems?: OcrItem[]): Room[] => {
        const rooms = detectRoomsFromLayoutGeometry(plan.width, plan.height, plan.walls, plan.doors, plan.windows);

        // Enrich rooms with OCR data if available
        if (ocrItems && ocrItems.length > 0) {
            enrichRoomsWithOcr(rooms, ocrItems);
        }

        return rooms;
    },

    // Expose enrichRoomsWithOcr for external use
    enrichRooms: enrichRoomsWithOcr
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

            // Transient errors (Space waking up / gateway issues)
            if (response.status === 502 || response.status === 503 || response.status === 504) {
                console.warn(`Service unavailable (status ${response.status}, attempt ${i + 1}/${retries}). Waiting...`);
                const waitTime = i === 0 ? 15000 : (i === 1 ? 7000 : 5000);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }

            if (!response.ok) {
                let bodyText = '';
                try {
                    bodyText = await response.text();
                } catch {
                }
                const snippet = bodyText ? ` - ${bodyText.slice(0, 800)}` : '';
                throw new Error(`API Error: ${response.status} ${response.statusText}${snippet}`);
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
function processDetectionResult(result: ApiResponseImage, targetWidth?: number, targetHeight?: number): DetectedLayout {
    let { points, classes, Width: apiWidth, Height: apiHeight } = result;

    // Reconciliation Logic for EXIF Rotation
    // If API sees 359x515 (Portrait) but FrontEnd shows 515x359 (Landscape),
    // we need to rotate coordinates 90 degrees.
    let rotation: '90cw' | '90ccw' | 'none' = 'none';
    let finalWidth = apiWidth;
    let finalHeight = apiHeight;

    if (targetWidth && targetHeight) {
        // Check for 90-degree swap (with 5px tolerance)
        const isSwapped = Math.abs(apiWidth - targetHeight) < 5 && Math.abs(apiHeight - targetWidth) < 5;
        if (isSwapped) {
            // Usually, rotated images from cameras are 90 CW (the browser handles EXIF)
            // but the API sees raw bits.
            rotation = '90cw';
            finalWidth = targetWidth;
            finalHeight = targetHeight;
            console.log(`Rotation mismatch detected! API: ${apiWidth}x${apiHeight}, Target: ${targetWidth}x${targetHeight}. Applying transformation.`);
        }
    }

    const transformPt = (x: number, y: number): { x: number, y: number } => {
        const rot: string = rotation; // Use string to bypass narrowing issue
        if (rot === '90cw') return { x: apiHeight - y, y: x };
        if (rot === '90ccw') return { x: y, y: apiWidth - x };
        return { x, y };
    };

    const transformBBox = (b: ApiOcrBBox): ApiOcrBBox => {
        if (rotation === 'none') return b;
        const p1 = transformPt(b.x1, b.y1);
        const p2 = transformPt(b.x2, b.y2);
        return {
            x1: Math.min(p1.x, p2.x),
            y1: Math.min(p1.y, p2.y),
            x2: Math.max(p1.x, p2.x),
            y2: Math.max(p1.y, p2.y)
        };
    };

    // Note: isPointInPolygon and enrichRoomsWithOcr are now module-level functions

    // -------------------------------------------------------------------------
    // 1. First Pass: Collect "Raw" Walls (including segments for Openings)
    // -------------------------------------------------------------------------
    const rawWalls: Wall[] = [];
    // We also validly collect raw API points for second pass
    const rawOpeningsRefs: Array<{ type: 'door' | 'window', box: { x1: number, y1: number, x2: number, y2: number }, center: Point }> = [];

    points.forEach((pt, idx) => {
        const cls = classes[idx];
        if (!cls) return;

        // Transform bounding box if needed (EXIF rotation)
        let x1 = pt.x1, x2 = pt.x2, y1 = pt.y1, y2 = pt.y2;
        if (rotation !== 'none') {
            const p1 = transformPt(pt.x1, pt.y1);
            const p2 = transformPt(pt.x2, pt.y2);
            x1 = Math.min(p1.x, p2.x);
            x2 = Math.max(p1.x, p2.x);
            y1 = Math.min(p1.y, p2.y);
            y2 = Math.max(p1.y, p2.y);
        }

        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;
        const center = { x: centerX, y: centerY };

        // Determine Wall Segment Logic (for Wall AND Openings)
        // Check if item is valid for distinct wall generation
        if (cls.name === 'wall' || cls.name === 'door' || cls.name === 'window') {
            let start: Point, end: Point, thickness = 10;

            if (width > height) { // Horizontal
                thickness = height;
                let sx = x1;
                let ex = x2;
                // Extend structural wall for openings by thickness on both ends
                if (cls.name === 'door' || cls.name === 'window') {
                    sx -= thickness;
                    ex += thickness;
                }
                start = { x: sx, y: centerY };
                end = { x: ex, y: centerY };
            } else { // Vertical
                thickness = width;
                let sy = y1;
                let ey = y2;
                // Extend structural wall for openings by thickness on both ends
                if (cls.name === 'door' || cls.name === 'window') {
                    sy -= thickness;
                    ey += thickness;
                }
                start = { x: centerX, y: sy };
                end = { x: centerX, y: ey };
            }

            // Create valid "original" wall segment
            // We tag it specially if it's an opening segment, or just treat as wall?
            // "Generic Collinear Merge" treats them all as walls.
            // But for 'reset', we want to distinguish? 
            // User said: "original walls as per api responce + doors cordinates... + windows cordinates... this will become original walls data"
            // So 'rawWalls' essentially contains ALL of them.
            rawWalls.push({
                id: generateLayoutId('wall_raw'),
                startPoint: start,
                endPoint: end,
                thickness: thickness
            });

            // Isolate opening data for Step 3
            if (cls.name === 'door') {
                rawOpeningsRefs.push({ type: 'door', box: { x1, y1, x2, y2 }, center });
            } else if (cls.name === 'window') {
                rawOpeningsRefs.push({ type: 'window', box: { x1, y1, x2, y2 }, center });
            }
        }
    });

    // Normalize thickness for consistency in raw set
    const avgThickness = calculateAvgWallThicknessFromWalls(rawWalls);
    rawWalls.forEach(w => {
        if (w.thickness < 5 || Math.abs(w.thickness - avgThickness) > 20) {
            w.thickness = avgThickness;
        }
    });

    // -------------------------------------------------------------------------
    // 2. Second Pass: SMART STITCH (Merge Raw Walls)
    // -------------------------------------------------------------------------
    // This creates the clean, continuous walls that openings will snap to.
    let stitchedWalls: Wall[] = [];
    try {
        // We pass empty doors/windows because we are stitching basic geometry
        stitchedWalls = stitchWalls(rawWalls, [], [], finalWidth, finalHeight);
    } catch (e) {
        console.error("Stitch failed inside service", e);
        stitchedWalls = [...rawWalls];
    }

    // -------------------------------------------------------------------------
    // 3. Third Pass: Place Openings (Snap to Stitched Walls)
    // -------------------------------------------------------------------------
    const doors: Door[] = [];
    const windows: LayoutWindow[] = [];

    rawOpeningsRefs.forEach(ref => {
        const { x1, y1, x2, y2 } = ref.box;
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);

        const isHorizontal = width > height;
        const intrinsicAngle = isHorizontal ? 0 : 90;

        // Try to snap to a stitched wall
        const snap = snapToWall(ref.center, stitchedWalls, 50); // 50px snap radius
        const snappedWall = snap ? snap.wall : null;

        // Determine rotation: Align with wall if snapped, else intrinsic
        let rotation = intrinsicAngle;
        let wallId = 'orphan';

        if (snappedWall) {
            wallId = snappedWall.id;
            const dx = snappedWall.endPoint.x - snappedWall.startPoint.x;
            const dy = snappedWall.endPoint.y - snappedWall.startPoint.y;
            const angleRad = Math.atan2(dy, dx);
            const angleDeg = (angleRad * 180) / Math.PI;
            rotation = angleDeg;

            // Normalize rotation to 0, 90, 180, 270 mostly?
            // Actually, keep it precise if walls are slightly skewed (though we lock them now).
        }

        if (ref.type === 'door') {
            const size = Math.max(width, height);
            doors.push({
                id: generateLayoutId('door'),
                position: ref.center,
                width: size,
                wallId,
                rotation,
                type: 'single'
            });
        } else {
            const length = Math.max(width, height);
            const depth = Math.max(6, Math.min(width, height));
            windows.push({
                id: generateLayoutId('window'),
                position: ref.center,
                width: length,
                height: depth,
                wallId,
                rotation
            });
        }
    });

    const rooms = detectRoomsFromLayoutGeometry(finalWidth, finalHeight, stitchedWalls, doors, windows);

    let ocr: OcrResult | undefined = undefined;
    if (result.ocr) {
        try {
            const apiOcr = result.ocr;
            const items: OcrItem[] = (apiOcr.items || []).map((it) => {
                const bb = transformBBox(it.bbox);
                return {
                    id: generateLayoutId('ocr'),
                    text: String(it.text || ''),
                    confidence: (it.confidence ?? null),
                    bbox: { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 },
                    center: { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 }
                };
            }).filter(it => it.text.trim().length > 0);

            ocr = {
                enabled: Boolean(apiOcr.enabled),
                text: apiOcr.text,
                orientation: apiOcr.orientation,
                items,
                error: apiOcr.error
            };
        } catch (e: any) {
            ocr = {
                enabled: false,
                error: e?.message || 'Failed to parse OCR results'
            };
        }
    }

    if (ocr && ocr.items) {
        enrichRoomsWithOcr(rooms, ocr.items);
    }

    return {
        walls: stitchedWalls,
        doors,
        windows,
        rooms,
        originalWalls: rawWalls,
        ocr
    };
}

function calculateAvgWallThicknessFromWalls(walls: Wall[]): number {
    if (!walls || walls.length === 0) return 10;
    let totalThick = 0;
    let count = 0;
    walls.forEach(w => {
        const thick = w.thickness;
        if (thick > 1) {
            totalThick += thick;
            count++;
        }
    });
    return count > 0 ? (totalThick / count) : 10;
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
