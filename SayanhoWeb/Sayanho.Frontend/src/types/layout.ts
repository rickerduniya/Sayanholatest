// Layout Types for Electrical Layout Designer
// These are separate from SLD types and use architectural electrical symbols

import { Point, Size } from './index';
export type { Point, Size };

// ============================================================================
// Core Building Elements
// ============================================================================

export interface Wall {
    id: string;
    startPoint: Point;
    endPoint: Point;
    thickness: number;          // in pixels (will be converted to meters using scale)
}

export interface Room {
    id: string;
    name: string;
    polygon: Point[];           // Closed polygon defining room boundary
    type: RoomType;
    color?: string;             // Fill color for visualization
    detectedName?: string;      // Name detected via OCR
    detectedMeasurements?: string; // Measurements text detected via OCR
    ocrDimensions?: { lengthFt: number; widthFt: number }; // Parsed dimensions in feet
    ocrArea?: number;            // Area in sq.ft calculated from OCR dimensions
}

export type RoomType =
    | 'bedroom'
    | 'living_room'
    | 'kitchen'
    | 'bathroom'
    | 'toilet'
    | 'balcony'
    | 'corridor'
    | 'staircase'
    | 'utility'
    | 'office'
    | 'dining'
    | 'storage'
    | 'pooja'
    | 'other';

export type MeasurementUnit = 'm' | 'ft';

export interface Door {
    id: string;
    position: Point;            // Center position
    width: number;
    wallId: string;             // Reference to wall it's on
    rotation: number;           // Angle in degrees
    type: 'single' | 'double' | 'sliding';
}

export interface LayoutWindow {
    id: string;
    position: Point;
    width: number;
    height: number;
    wallId: string;
    rotation?: number;
}

export interface Stair {
    id: string;
    polygon: Point[];
    direction: 'up' | 'down';
    steps: number;
}

export interface OcrBBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface OcrOrientation {
    orientation_degrees?: number | null;
    rotate_degrees?: number | null;
    orientation_confidence?: number | null;
    script?: string;
    script_confidence?: number | null;
    raw?: string;
    error?: string;
}

export interface OcrItem {
    id: string;
    text: string;
    confidence?: number | null;
    bbox: OcrBBox;
    center: Point;
}

export interface OcrResult {
    enabled: boolean;
    text?: string;
    orientation?: OcrOrientation;
    items?: OcrItem[];
    error?: string;
}

// ============================================================================
// Electrical Components (Architectural Symbols)
// ============================================================================

export type LayoutComponentType =
    // Distribution Boards
    | 'spn_db'
    | 'vtpn_db'
    | 'htpn_db'
    | 'lt_cubical_panel'
    | 'busbar_chamber'
    // Switchgear
    | 'main_switch'
    | 'changeover_switch'
    // Appliances
    | 'ac_point'
    | 'geyser_point'
    // Lighting
    | 'bulb'
    | 'tube_light'
    // Fans
    | 'ceiling_fan_point'
    | 'exhaust_fan'
    // Switch Boards
    | 'point_switch_board'
    | 'avg_5a_switch_board'
    // Infrastructure
    | 'source'
    // Others
    | 'call_bell';

export interface LayoutComponent {
    id: string;
    type: LayoutComponentType;
    position: Point;
    rotation: number;           // degrees
    roomId?: string;            // Which room it's in
    properties: Record<string, string>;

    // Link to SLD item (for synchronization)
    sldItemId?: string;
}

export interface LayoutConnection {
    id: string;
    sourceId: string;           // Component ID
    targetId: string;           // Component ID
    path: Point[];              // Wire routing waypoints
    type: 'power' | 'control' | 'data';

    // Visualization Settings
    renderType?: 'straight' | 'curve' | 'arc' | 'orthogonal'; // Default: 'arc'
    arcBulge?: number;          // 0 to 1 (relative to distance), default 0.2

    properties?: {
        wireType?: string;
        conduitType?: string;
        phase?: string;
    };
}

export interface LayoutTextItem {
    id: string;
    text: string;
    position: Point;
    fontSize: number;
    fontFamily: string;
    color: string;
    align: 'left' | 'center' | 'right';
    width?: number;
    height?: number;
    rotation?: number;
}

// ============================================================================
// Floor Plan Container
// ============================================================================

export interface FloorPlan {
    id: string;
    name: string;

    // Background image (stored in IndexedDB, this is just a reference ID)
    backgroundImageId?: string;

    // Canvas dimensions
    width: number;
    height: number;

    // Scale: pixels per meter (for real-world measurements)
    pixelsPerMeter: number;

    measurementUnit?: MeasurementUnit;
    isScaleCalibrated?: boolean;

    // Detected/drawn elements
    walls: Wall[];
    originalWalls?: Wall[]; // Stores original API detection for reset/toggle
    rooms: Room[];
    doors: Door[];
    windows: LayoutWindow[];
    stairs: Stair[];

    ocr?: OcrResult;

    // Electrical layout
    components: LayoutComponent[];
    connections: LayoutConnection[];
    textItems?: LayoutTextItem[];

    // Viewport state
    viewportX: number;
    viewportY: number;
    scale: number;
}

// ============================================================================
// Drawing Tool Types
// ============================================================================

export type DrawingTool =
    | 'select'
    | 'pan'
    | 'wall'
    | 'room'
    | 'door'
    | 'window'
    | 'stair'
    | 'component'
    | 'connection'
    | 'erase'
    | 'pick'
    | 'calibrate';

export interface DrawingState {
    activeTool: DrawingTool;
    selectedComponentType?: LayoutComponentType;
    isDrawing: boolean;
    currentPath: Point[];
    selectedElementIds: string[];
    wallThickness: number;      // pixels
    continuousWallMode: boolean;// true for chain, false for single segment
}

// ============================================================================
// Component Definition (for sidebar)
// ============================================================================

export interface LayoutComponentDef {
    type: LayoutComponentType;
    name: string;
    category:
        | 'distribution'
        | 'switchgear'
        | 'appliances'
        | 'lighting'
        | 'fans'
        | 'switchboards'
        | 'infrastructure'
        | 'others';
    symbol: string;                    // Unicode symbol for quick display
    svgIcon: string;                   // SVG filename (relative to /public/)
    size: Size;                        // Fallback pixel size (used without calibration)
    realSizeMm: { width: number; height: number }; // Physical size in millimetres (top view)
    minDisplayPx?: number;             // Min rendered size in px (default 14)
    maxDisplayPx?: number;             // Max rendered size in px (default 180)
    sldEquivalent?: string;            // Corresponding SLD item name (for sync)
    placementType?: 'wall' | 'ceiling' | 'floor' | 'any';
    defaultWattage?: number;           // For load calculation
    description?: string;              // Tooltip description
}

// ============================================================================
// Layout View State
// ============================================================================

export type ViewMode = 'sld' | 'layout';

export interface LayoutState {
    floorPlans: FloorPlan[];
    activeFloorPlanId: string | null;
    activeView: ViewMode;
    drawingState: DrawingState;
}
