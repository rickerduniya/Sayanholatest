// Component Mapping - Bi-directional SLD ↔ Layout synchronization mappings
// Defines how SLD items correspond to Layout components and vice versa

import { LayoutComponentType } from '../types/layout';

// =============================================================================
// MAPPING TYPES
// =============================================================================

export interface ComponentMapping {
    layoutType: LayoutComponentType;
    sldName: string;                    // Exact SLD item name
    syncMode: 'oneToOne' | 'aggregate' | 'decompose';
    // oneToOne: 1 SLD item = 1 Layout component
    // aggregate: Multiple Layout components → 1 SLD item (e.g., lights in room)
    // decompose: 1 SLD item → Multiple Layout components (NOT USED per user decision)

    defaultProperties?: Record<string, string>;

    // For aggregation: how to group in SLD
    aggregateBy?: 'room' | 'circuit' | 'type';
}

export interface SyncResult {
    success: boolean;
    layoutComponentId?: string;
    sldItemId?: string;
    error?: string;
}

// =============================================================================
// SLD → LAYOUT MAPPINGS
// Map from SLD item name to Layout component type(s)
// =============================================================================

export const SLD_TO_LAYOUT_MAP: Record<string, LayoutComponentType[]> = {
    // Lighting
    'Bulb': ['ceiling_light', 'wall_light'],
    'Tube Light': ['tube_light'],
    'Light Point': ['light_point'],

    // Fans
    'Ceiling Fan': ['ceiling_fan_point'],
    'Exhaust Fan': ['exhaust_fan'],
    'Ceiling Rose': ['ceiling_rose'],

    // HVAC
    'AC Point': ['ac_point'],

    // Sockets
    '5A Socket': ['socket_5a'],
    '15A Socket': ['socket_15a'],
    '5A Socket Board': ['socket_board_5a'],
    '15A Socket Board': ['socket_board_15a'],

    // Switches / Bell
    'Bell Push': ['switch_bell'],
    'Bell': ['call_bell'],
    'Call Bell': ['call_bell'],

    // Switch Boards
    'Point Switch Board': ['point_switch_board'],
    'Avg. 5A Switch Board': ['avg_5a_switch_board'],

    // Distribution
    'SPN DB': ['spn_db', 'db_box'],
    'VTPN': ['vtpn_db'],
    'HTPN': ['htpn_db'],
    'LT Cubical Panel': ['lt_cubical_panel'],
    'Busbar Chamber': ['busbar_chamber'],

    // Switchgear
    'Main Switch': ['main_switch'],
    'Change Over Switch': ['changeover_switch'],

    // Meters
    '1 Phase Meter': ['meter_1phase'],
    '3 Phase Meter': ['meter_3phase'],

    // Appliances
    'Geyser Point': ['geyser_point'],
    'Computer Point': ['computer_point'],

    // Infrastructure
    'Source': ['source'],
    'Portal': ['portal'],
    'Generator': ['generator']
};

// =============================================================================
// LAYOUT → SLD MAPPINGS  
// Map from Layout component type to SLD item name
// =============================================================================

export const LAYOUT_TO_SLD_MAP: Record<LayoutComponentType, string | null> = {
    // Lighting
    'ceiling_light': 'Bulb',
    'wall_light': 'Bulb',
    'tube_light': 'Tube Light',
    'led_panel': 'Bulb',
    'emergency_light': null,  // No direct SLD equivalent
    'light_point': 'Light Point',

    // Power
    'socket_5a': '5A Socket',
    'socket_15a': '15A Socket',
    'socket_20a': '15A Socket',  // Map to closest
    'socket_usb': null,
    'socket_board_5a': '5A Socket Board',
    'socket_board_15a': '15A Socket Board',

    // Switches
    'switch_1way': null,
    'switch_2way': null,
    'switch_dimmer': null,
    'switch_bell': 'Bell Push',

    // Switch Boards
    'point_switch_board': 'Point Switch Board',
    'switch_board_2way': '2 Switch Board',
    'switch_board_3way': '3 Switch Board',
    'switch_board_4way': '4 Switch Board',
    'switch_board_6way': '6 Switch Board',
    'switch_board_8way': '8 Switch Board',
    'switch_board_12way': '12 Switch Board',
    'switch_board_18way': '18 Switch Board',
    'avg_5a_switch_board': 'Avg. 5A Switch Board',

    // HVAC
    'ac_point': 'AC Point',
    'exhaust_fan': 'Exhaust Fan',
    'ceiling_fan_point': 'Ceiling Fan',
    'ceiling_rose': 'Ceiling Rose',

    // Distribution
    'db_box': 'SPN DB',
    'spn_db': 'SPN DB',
    'vtpn_db': 'VTPN',
    'htpn_db': 'HTPN',
    'lt_cubical_panel': 'LT Cubical Panel',
    'busbar_chamber': 'Busbar Chamber',
    'mcb_point': null,

    // Switchgear
    'main_switch': 'Main Switch',
    'changeover_switch': 'Change Over Switch',

    // Meters
    'meter_1phase': '1 Phase Meter',
    'meter_3phase': '3 Phase Meter',

    // Appliances
    'geyser_point': 'Geyser Point',
    'computer_point': 'Computer Point',
    'call_bell': 'Call Bell',

    // Infrastructure
    'source': 'Source',
    'portal': 'Portal',
    'generator': 'Generator',

    // Safety - no SLD equivalents
    'smoke_detector': null,
    'fire_alarm': null
};

// =============================================================================
// COMPONENT MAPPINGS WITH SYNC RULES
// =============================================================================

export const COMPONENT_MAPPINGS: ComponentMapping[] = [
    // Lighting - aggregate by room for quantity
    { layoutType: 'ceiling_light', sldName: 'Bulb', syncMode: 'aggregate', aggregateBy: 'room' },
    { layoutType: 'wall_light', sldName: 'Bulb', syncMode: 'aggregate', aggregateBy: 'room' },
    { layoutType: 'tube_light', sldName: 'Tube Light', syncMode: 'oneToOne' },
    { layoutType: 'led_panel', sldName: 'Bulb', syncMode: 'aggregate', aggregateBy: 'room' },
    { layoutType: 'light_point', sldName: 'Light Point', syncMode: 'oneToOne' },

    // Fans
    { layoutType: 'ceiling_fan_point', sldName: 'Ceiling Fan', syncMode: 'oneToOne' },
    { layoutType: 'exhaust_fan', sldName: 'Exhaust Fan', syncMode: 'oneToOne' },
    { layoutType: 'ceiling_rose', sldName: 'Ceiling Rose', syncMode: 'oneToOne' },

    // HVAC
    { layoutType: 'ac_point', sldName: 'AC Point', syncMode: 'oneToOne' },

    // Sockets
    { layoutType: 'socket_5a', sldName: '5A Socket', syncMode: 'oneToOne' },
    { layoutType: 'socket_15a', sldName: '15A Socket', syncMode: 'oneToOne' },
    { layoutType: 'socket_20a', sldName: '15A Socket', syncMode: 'oneToOne' },
    { layoutType: 'socket_board_5a', sldName: '5A Socket Board', syncMode: 'oneToOne' },
    { layoutType: 'socket_board_15a', sldName: '15A Socket Board', syncMode: 'oneToOne' },

    // Switch Boards - one unit
    { layoutType: 'point_switch_board', sldName: 'Point Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_2way', sldName: '2 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_3way', sldName: '3 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_4way', sldName: '4 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_6way', sldName: '6 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_8way', sldName: '8 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_12way', sldName: '12 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'switch_board_18way', sldName: '18 Switch Board', syncMode: 'oneToOne' },
    { layoutType: 'avg_5a_switch_board', sldName: 'Avg. 5A Switch Board', syncMode: 'oneToOne' },

    // Distribution Boards
    { layoutType: 'spn_db', sldName: 'SPN DB', syncMode: 'oneToOne' },
    { layoutType: 'vtpn_db', sldName: 'VTPN', syncMode: 'oneToOne' },
    { layoutType: 'htpn_db', sldName: 'HTPN', syncMode: 'oneToOne' },
    { layoutType: 'lt_cubical_panel', sldName: 'LT Cubical Panel', syncMode: 'oneToOne' },
    { layoutType: 'busbar_chamber', sldName: 'Busbar Chamber', syncMode: 'oneToOne' },
    { layoutType: 'db_box', sldName: 'SPN DB', syncMode: 'oneToOne' },

    // Switchgear
    { layoutType: 'main_switch', sldName: 'Main Switch', syncMode: 'oneToOne' },
    { layoutType: 'changeover_switch', sldName: 'Change Over Switch', syncMode: 'oneToOne' },

    // Meters
    { layoutType: 'meter_1phase', sldName: '1 Phase Meter', syncMode: 'oneToOne' },
    { layoutType: 'meter_3phase', sldName: '3 Phase Meter', syncMode: 'oneToOne' },

    // Appliances
    { layoutType: 'geyser_point', sldName: 'Geyser Point', syncMode: 'oneToOne' },
    { layoutType: 'computer_point', sldName: 'Computer Point', syncMode: 'oneToOne' },
    { layoutType: 'call_bell', sldName: 'Call Bell', syncMode: 'oneToOne' },
    { layoutType: 'switch_bell', sldName: 'Bell Push', syncMode: 'oneToOne' },

    // Infrastructure
    { layoutType: 'source', sldName: 'Source', syncMode: 'oneToOne' },
    { layoutType: 'portal', sldName: 'Portal', syncMode: 'oneToOne' },
    { layoutType: 'generator', sldName: 'Generator', syncMode: 'oneToOne' }
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the mapping configuration for a layout component type
 */
export function getMappingForLayoutType(layoutType: LayoutComponentType): ComponentMapping | undefined {
    return COMPONENT_MAPPINGS.find(m => m.layoutType === layoutType);
}

/**
 * Get all layout types that map to a given SLD item name
 */
export function getLayoutTypesForSld(sldName: string): LayoutComponentType[] {
    return SLD_TO_LAYOUT_MAP[sldName] || [];
}

/**
 * Get the SLD item name for a layout component type
 */
export function getSldNameForLayout(layoutType: LayoutComponentType): string | null {
    return LAYOUT_TO_SLD_MAP[layoutType];
}

/**
 * Check if a layout component has an SLD equivalent
 */
export function hasSldEquivalent(layoutType: LayoutComponentType): boolean {
    return LAYOUT_TO_SLD_MAP[layoutType] !== null;
}

/**
 * Get default SLD item name based on most common usage
 * For SLD items that map to multiple layout types
 */
export function getPrimaryLayoutType(sldName: string): LayoutComponentType | null {
    const types = SLD_TO_LAYOUT_MAP[sldName];
    return types && types.length > 0 ? types[0] : null;
}

// =============================================================================
// UPSTREAM-DOWNSTREAM TOPOLOGY
// Defines the power flow hierarchy for SLD generation
// =============================================================================

export const COMPONENT_HIERARCHY = {
    // Level 0: Power Source
    upstream: ['source', 'generator'],

    // Level 1: Meters (after source)
    metering: ['meter_1phase', 'meter_3phase'],

    // Level 2: Main Switchgear
    mainSwitch: ['main_switch', 'changeover_switch'],

    // Level 3: Main Distribution
    mainDistribution: ['lt_cubical_panel', 'htpn_db', 'vtpn_db'],

    // Level 4: Sub-Distribution
    subDistribution: ['spn_db', 'db_box', 'busbar_chamber'],

    // Level 5: Switch Boards
    switchBoards: [
        'point_switch_board', 'switch_board_2way', 'switch_board_3way',
        'switch_board_4way', 'switch_board_6way', 'switch_board_8way',
        'switch_board_12way', 'switch_board_18way', 'avg_5a_switch_board'
    ],

    // Level 6: End Loads (terminals)
    endLoads: [
        'ceiling_light', 'wall_light', 'tube_light', 'led_panel', 'light_point',
        'ceiling_fan_point', 'exhaust_fan', 'ceiling_rose',
        'ac_point', 'geyser_point', 'computer_point',
        'socket_5a', 'socket_15a', 'socket_20a', 'socket_board_5a', 'socket_board_15a',
        'call_bell', 'smoke_detector', 'fire_alarm'
    ]
} as const;

/**
 * Get the hierarchy level of a component type
 * Lower number = upstream, Higher number = downstream
 */
export function getHierarchyLevel(layoutType: LayoutComponentType): number {
    if (COMPONENT_HIERARCHY.upstream.includes(layoutType as any)) return 0;
    if (COMPONENT_HIERARCHY.metering.includes(layoutType as any)) return 1;
    if (COMPONENT_HIERARCHY.mainSwitch.includes(layoutType as any)) return 2;
    if (COMPONENT_HIERARCHY.mainDistribution.includes(layoutType as any)) return 3;
    if (COMPONENT_HIERARCHY.subDistribution.includes(layoutType as any)) return 4;
    if (COMPONENT_HIERARCHY.switchBoards.includes(layoutType as any)) return 5;
    if (COMPONENT_HIERARCHY.endLoads.includes(layoutType as any)) return 6;
    return 99; // Unknown
}

/**
 * Compare two components for upstream-downstream ordering
 * Returns negative if a is upstream of b, positive if downstream, 0 if same level
 */
export function compareHierarchy(a: LayoutComponentType, b: LayoutComponentType): number {
    return getHierarchyLevel(a) - getHierarchyLevel(b);
}
