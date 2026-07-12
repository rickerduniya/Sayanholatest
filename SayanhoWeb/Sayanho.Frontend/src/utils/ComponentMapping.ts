// Component Mapping - Bi-directional SLD ↔ Layout synchronization mappings
// Only the 17 items that exist in both the SLD library and Layout library.

import { LayoutComponentType } from '../types/layout';

// =============================================================================
// MAPPING TYPES
// =============================================================================

export interface ComponentMapping {
    layoutType: LayoutComponentType;
    sldName: string;                    // Exact SLD item name
    syncMode: 'oneToOne' | 'aggregate' | 'decompose';
    defaultProperties?: Record<string, string>;
    aggregateBy?: 'room' | 'circuit' | 'type';
}

export interface SyncResult {
    success: boolean;
    layoutComponentId?: string;
    sldItemId?: string;
    error?: string;
}

// =============================================================================
// SLD → LAYOUT MAP
// =============================================================================

export const SLD_TO_LAYOUT_MAP: Record<string, LayoutComponentType[]> = {
    // Distribution Boards
    'SPN DB':           ['spn_db'],
    'VTPN':             ['vtpn_db'],
    'HTPN':             ['htpn_db'],
    'LT Cubical Panel': ['lt_cubical_panel'],
    'Busbar Chamber':   ['busbar_chamber'],

    // Switchgear
    'Main Switch':          ['main_switch'],
    'Change Over Switch':   ['changeover_switch'],

    // Appliances
    'AC Point':     ['ac_point'],
    'Geyser Point': ['geyser_point'],

    // Lighting
    'Bulb':       ['bulb'],
    'Tube Light': ['tube_light'],

    // Fans
    'Ceiling Fan': ['ceiling_fan_point'],
    'Exhaust Fan': ['exhaust_fan'],

    // Switch Boards
    'Point Switch Board':   ['point_switch_board'],
    'Avg. 5A Switch Board': ['avg_5a_switch_board'],

    // Infrastructure
    'Source': ['source'],

    // Others
    'Call Bell': ['call_bell'],
    'Bell':      ['call_bell'],   // alternate SLD name
};

// =============================================================================
// LAYOUT → SLD MAP
// =============================================================================

export const LAYOUT_TO_SLD_MAP: Record<LayoutComponentType, string | null> = {
    // Distribution Boards
    'spn_db':           'SPN DB',
    'vtpn_db':          'VTPN',
    'htpn_db':          'HTPN',
    'lt_cubical_panel': 'LT Cubical Panel',
    'busbar_chamber':   'Busbar Chamber',

    // Switchgear
    'main_switch':       'Main Switch',
    'changeover_switch': 'Change Over Switch',

    // Appliances
    'ac_point':    'AC Point',
    'geyser_point': 'Geyser Point',

    // Lighting
    'bulb':       'Bulb',
    'tube_light': 'Tube Light',

    // Fans
    'ceiling_fan_point': 'Ceiling Fan',
    'exhaust_fan':       'Exhaust Fan',

    // Switch Boards
    'point_switch_board':   'Point Switch Board',
    'avg_5a_switch_board':  'Avg. 5A Switch Board',

    // Infrastructure
    'source': 'Source',

    // Others
    'call_bell': 'Call Bell',
};

// =============================================================================
// SYNC RULES (with aggregate mode for lights)
// =============================================================================

export const COMPONENT_MAPPINGS: ComponentMapping[] = [
    // Distribution Boards
    { layoutType: 'spn_db',           sldName: 'SPN DB',           syncMode: 'oneToOne' },
    { layoutType: 'vtpn_db',          sldName: 'VTPN',             syncMode: 'oneToOne' },
    { layoutType: 'htpn_db',          sldName: 'HTPN',             syncMode: 'oneToOne' },
    { layoutType: 'lt_cubical_panel', sldName: 'LT Cubical Panel', syncMode: 'oneToOne' },
    { layoutType: 'busbar_chamber',   sldName: 'Busbar Chamber',   syncMode: 'oneToOne' },

    // Switchgear
    { layoutType: 'main_switch',       sldName: 'Main Switch',        syncMode: 'oneToOne' },
    { layoutType: 'changeover_switch', sldName: 'Change Over Switch', syncMode: 'oneToOne' },

    // Appliances
    { layoutType: 'ac_point',    sldName: 'AC Point',    syncMode: 'oneToOne' },
    { layoutType: 'geyser_point', sldName: 'Geyser Point', syncMode: 'oneToOne' },

    // Lighting — aggregate by room so multiple bulbs → 1 SLD Bulb item per room
    { layoutType: 'bulb',       sldName: 'Bulb',       syncMode: 'aggregate', aggregateBy: 'room' },
    { layoutType: 'tube_light', sldName: 'Tube Light', syncMode: 'oneToOne' },

    // Fans
    { layoutType: 'ceiling_fan_point', sldName: 'Ceiling Fan', syncMode: 'oneToOne' },
    { layoutType: 'exhaust_fan',       sldName: 'Exhaust Fan', syncMode: 'oneToOne' },

    // Switch Boards
    { layoutType: 'point_switch_board',  sldName: 'Point Switch Board',   syncMode: 'oneToOne' },
    { layoutType: 'avg_5a_switch_board', sldName: 'Avg. 5A Switch Board', syncMode: 'oneToOne' },

    // Infrastructure
    { layoutType: 'source', sldName: 'Source', syncMode: 'oneToOne' },

    // Others
    { layoutType: 'call_bell', sldName: 'Call Bell', syncMode: 'oneToOne' },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getMappingForLayoutType(layoutType: LayoutComponentType): ComponentMapping | undefined {
    return COMPONENT_MAPPINGS.find(m => m.layoutType === layoutType);
}

export function getLayoutTypesForSld(sldName: string): LayoutComponentType[] {
    return SLD_TO_LAYOUT_MAP[sldName] || [];
}

export function getSldNameForLayout(layoutType: LayoutComponentType): string | null {
    return LAYOUT_TO_SLD_MAP[layoutType];
}

export function hasSldEquivalent(layoutType: LayoutComponentType): boolean {
    return LAYOUT_TO_SLD_MAP[layoutType] !== null;
}

export function getPrimaryLayoutType(sldName: string): LayoutComponentType | null {
    const types = SLD_TO_LAYOUT_MAP[sldName];
    return types && types.length > 0 ? types[0] : null;
}

// =============================================================================
// POWER TOPOLOGY HIERARCHY
// =============================================================================

export const COMPONENT_HIERARCHY = {
    upstream:         ['source'] as const,
    mainSwitch:       ['main_switch', 'changeover_switch'] as const,
    mainDistribution: ['lt_cubical_panel', 'htpn_db', 'vtpn_db'] as const,
    subDistribution:  ['spn_db', 'busbar_chamber'] as const,
    switchBoards:     ['point_switch_board', 'avg_5a_switch_board'] as const,
    endLoads:         [
        'bulb', 'tube_light',
        'ceiling_fan_point', 'exhaust_fan',
        'ac_point', 'geyser_point',
        'call_bell',
    ] as const,
} as const;

export function getHierarchyLevel(layoutType: LayoutComponentType): number {
    if ((COMPONENT_HIERARCHY.upstream as readonly string[]).includes(layoutType)) return 0;
    if ((COMPONENT_HIERARCHY.mainSwitch as readonly string[]).includes(layoutType)) return 1;
    if ((COMPONENT_HIERARCHY.mainDistribution as readonly string[]).includes(layoutType)) return 2;
    if ((COMPONENT_HIERARCHY.subDistribution as readonly string[]).includes(layoutType)) return 3;
    if ((COMPONENT_HIERARCHY.switchBoards as readonly string[]).includes(layoutType)) return 4;
    if ((COMPONENT_HIERARCHY.endLoads as readonly string[]).includes(layoutType)) return 5;
    return 99;
}

export function compareHierarchy(a: LayoutComponentType, b: LayoutComponentType): number {
    return getHierarchyLevel(a) - getHierarchyLevel(b);
}
