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
    | 'other';

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

// ============================================================================
// Electrical Components (Architectural Symbols)
// ============================================================================

export type LayoutComponentType =
    // =========================================================================
    // LIGHTING
    // =========================================================================
    | 'ceiling_light'
    | 'wall_light'
    | 'tube_light'
    | 'led_panel'
    | 'emergency_light'
    | 'light_point'           // Generic light point (SLD: Light Point)

    // =========================================================================
    // POWER OUTLETS / SOCKETS
    // =========================================================================
    | 'socket_5a'
    | 'socket_15a'
    | 'socket_20a'
    | 'socket_usb'
    | 'socket_board_5a'       // SLD: 5A Socket Board
    | 'socket_board_15a'      // SLD: 15A Socket Board

    // =========================================================================
    // SWITCHES
    // =========================================================================
    | 'switch_1way'
    | 'switch_2way'
    | 'switch_dimmer'
    | 'switch_bell'           // Bell Push

    // =========================================================================
    // SWITCH BOARDS (Combined Units)
    // =========================================================================
    | 'point_switch_board'    // SLD: Point Switch Board
    | 'switch_board_2way'     // SLD: 2 Switch Board
    | 'switch_board_3way'     // SLD: 3 Switch Board
    | 'switch_board_4way'     // SLD: 4 Switch Board
    | 'switch_board_6way'     // SLD: 6 Switch Board
    | 'switch_board_8way'     // SLD: 8 Switch Board
    | 'switch_board_12way'    // SLD: 12 Switch Board
    | 'switch_board_18way'    // SLD: 18 Switch Board
    | 'avg_5a_switch_board'   // SLD: Avg. 5A Switch Board

    // =========================================================================
    // HVAC / FANS
    // =========================================================================
    | 'ac_point'
    | 'exhaust_fan'
    | 'ceiling_fan_point'
    | 'ceiling_rose'          // SLD: Ceiling Rose

    // =========================================================================
    // DISTRIBUTION BOARDS
    // =========================================================================
    | 'db_box'                // Generic DB
    | 'spn_db'                // SLD: SPN DB
    | 'vtpn_db'               // SLD: VTPN
    | 'htpn_db'               // SLD: HTPN
    | 'lt_cubical_panel'      // SLD: LT Cubical Panel
    | 'busbar_chamber'        // SLD: Busbar Chamber
    | 'mcb_point'

    // =========================================================================
    // SWITCHGEAR
    // =========================================================================
    | 'main_switch'           // SLD: Main Switch
    | 'changeover_switch'     // SLD: Change Over Switch

    // =========================================================================
    // METERS
    // =========================================================================
    | 'meter_1phase'          // SLD: 1 Phase Meter
    | 'meter_3phase'          // SLD: 3 Phase Meter

    // =========================================================================
    // APPLIANCES
    // =========================================================================
    | 'geyser_point'          // SLD: Geyser Point
    | 'computer_point'        // SLD: Computer Point
    | 'call_bell'             // SLD: Call Bell Point

    // =========================================================================
    // INFRASTRUCTURE
    // =========================================================================
    | 'source'                // SLD: Source (power source)
    | 'portal'                // SLD: Portal (cross-sheet reference)
    | 'generator'             // SLD: Generator

    // =========================================================================
    // SAFETY
    // =========================================================================
    | 'smoke_detector'
    | 'fire_alarm';

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

    // Detected/drawn elements
    walls: Wall[];
    originalWalls?: Wall[]; // Stores original API detection for reset/toggle
    rooms: Room[];
    doors: Door[];
    windows: LayoutWindow[];
    stairs: Stair[];

    // Electrical layout
    components: LayoutComponent[];
    connections: LayoutConnection[];

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
    | 'pick';

export interface DrawingState {
    activeTool: DrawingTool;
    selectedComponentType?: LayoutComponentType;
    isDrawing: boolean;
    currentPath: Point[];
    selectedElementIds: string[];
    gridSnap: boolean;
    gridSize: number;           // pixels (Legacy)
    gridSpacingMeters: number;  // Meters (New standard)
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
    | 'lighting'
    | 'power'
    | 'switches'
    | 'switchboards'      // NEW: Combined switch units
    | 'hvac'
    | 'distribution'
    | 'switchgear'        // NEW: Main switches
    | 'meters'            // NEW: Metering
    | 'appliances'        // NEW: Geyser, computer, etc.
    | 'infrastructure'    // NEW: Source, portal, generator
    | 'safety';
    symbol: string;                    // Unicode symbol for quick display
    svgIcon: string;                   // SVG filename
    size: Size;
    sldEquivalent?: string;            // Corresponding SLD item name (for sync)

    // NEW: Placement hints
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
