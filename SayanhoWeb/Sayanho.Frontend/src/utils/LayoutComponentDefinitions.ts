// Layout Component Definitions - Comprehensive Architectural Electrical Symbols
// Standard IS/IEC-style symbols for floor plan layouts
// Maps to corresponding SLD items for bi-directional sync

import { LayoutComponentDef, LayoutComponentType } from '../types/layout';

// =============================================================================
// COMPLETE COMPONENT DEFINITIONS
// Covers all SLD item equivalents plus layout-specific components
// =============================================================================

export const LAYOUT_COMPONENT_DEFINITIONS: Record<LayoutComponentType, LayoutComponentDef> = {
    // =========================================================================
    // LIGHTING
    // =========================================================================
    'ceiling_light': {
        type: 'ceiling_light',
        name: 'Ceiling Light',
        category: 'lighting',
        symbol: '⊕',
        svgIcon: 'layout/ceiling_light.svg',
        size: { width: 24, height: 24 },
        sldEquivalent: 'Bulb',
        placementType: 'ceiling',
        defaultWattage: 60,
        description: 'Standard ceiling-mounted light fixture'
    },
    'wall_light': {
        type: 'wall_light',
        name: 'Wall Light',
        category: 'lighting',
        symbol: '◐',
        svgIcon: 'layout/wall_light.svg',
        size: { width: 20, height: 20 },
        sldEquivalent: 'Bulb',
        placementType: 'wall',
        defaultWattage: 40,
        description: 'Wall-mounted light fixture'
    },
    'tube_light': {
        type: 'tube_light',
        name: 'Tube Light',
        category: 'lighting',
        symbol: '═',
        svgIcon: 'layout/tube_light.svg',
        size: { width: 40, height: 12 },
        sldEquivalent: 'Tube Light',
        placementType: 'ceiling',
        defaultWattage: 36,
        description: 'Fluorescent tube light'
    },
    'led_panel': {
        type: 'led_panel',
        name: 'LED Panel',
        category: 'lighting',
        symbol: '▢',
        svgIcon: 'layout/led_panel.svg',
        size: { width: 30, height: 30 },
        sldEquivalent: 'Bulb',
        placementType: 'ceiling',
        defaultWattage: 18,
        description: 'LED panel light (2x2 or slim)'
    },
    'emergency_light': {
        type: 'emergency_light',
        name: 'Emergency Light',
        category: 'lighting',
        symbol: '⊗',
        svgIcon: 'layout/emergency_light.svg',
        size: { width: 24, height: 24 },
        placementType: 'wall',
        defaultWattage: 10,
        description: 'Battery backup emergency light'
    },
    'light_point': {
        type: 'light_point',
        name: 'Light Point',
        category: 'lighting',
        symbol: '○',
        svgIcon: 'layout/light_point.svg',
        size: { width: 20, height: 20 },
        sldEquivalent: 'Light Point',
        placementType: 'ceiling',
        defaultWattage: 60,
        description: 'Generic light point'
    },

    // =========================================================================
    // POWER OUTLETS / SOCKETS
    // =========================================================================
    'socket_5a': {
        type: 'socket_5a',
        name: '5A Socket',
        category: 'power',
        symbol: '⊡',
        svgIcon: 'layout/socket_5a.svg',
        size: { width: 20, height: 20 },
        sldEquivalent: '5A Socket',
        placementType: 'wall',
        description: '5 Amp power socket'
    },
    'socket_15a': {
        type: 'socket_15a',
        name: '15A Socket',
        category: 'power',
        symbol: '⊞',
        svgIcon: 'layout/socket_15a.svg',
        size: { width: 20, height: 20 },
        sldEquivalent: '15A Socket',
        placementType: 'wall',
        description: '15 Amp power socket (heavy duty)'
    },
    'socket_20a': {
        type: 'socket_20a',
        name: '20A Socket',
        category: 'power',
        symbol: '⊠',
        svgIcon: 'layout/socket_20a.svg',
        size: { width: 24, height: 24 },
        sldEquivalent: '15A Socket',
        placementType: 'wall',
        description: '20 Amp power socket (industrial)'
    },
    'socket_usb': {
        type: 'socket_usb',
        name: 'USB Socket',
        category: 'power',
        symbol: '⊟',
        svgIcon: 'layout/socket_usb.svg',
        size: { width: 20, height: 20 },
        placementType: 'wall',
        description: 'Socket with USB charging ports'
    },
    'socket_board_5a': {
        type: 'socket_board_5a',
        name: '5A Socket Board',
        category: 'power',
        symbol: '▣',
        svgIcon: 'layout/socket_board_5a.svg',
        size: { width: 28, height: 28 },
        sldEquivalent: '5A Socket Board',
        placementType: 'wall',
        description: 'Socket board with 5A sockets'
    },
    'socket_board_15a': {
        type: 'socket_board_15a',
        name: '15A Socket Board',
        category: 'power',
        symbol: '▤',
        svgIcon: 'layout/socket_board_15a.svg',
        size: { width: 28, height: 28 },
        sldEquivalent: '15A Socket Board',
        placementType: 'wall',
        description: 'Socket board with 15A sockets'
    },

    // =========================================================================
    // SWITCHES
    // =========================================================================
    'switch_1way': {
        type: 'switch_1way',
        name: '1-Way Switch',
        category: 'switches',
        symbol: '○─',
        svgIcon: 'layout/switch_1way.svg',
        size: { width: 20, height: 16 },
        placementType: 'wall',
        description: 'Single pole single throw switch'
    },
    'switch_2way': {
        type: 'switch_2way',
        name: '2-Way Switch',
        category: 'switches',
        symbol: '○═',
        svgIcon: 'layout/switch_2way.svg',
        size: { width: 20, height: 16 },
        placementType: 'wall',
        description: 'Two-way switch for staircase/corridor'
    },
    'switch_dimmer': {
        type: 'switch_dimmer',
        name: 'Dimmer Switch',
        category: 'switches',
        symbol: '◎',
        svgIcon: 'layout/switch_dimmer.svg',
        size: { width: 20, height: 20 },
        placementType: 'wall',
        description: 'Variable intensity dimmer'
    },
    'switch_bell': {
        type: 'switch_bell',
        name: 'Bell Push',
        category: 'switches',
        symbol: '⊙',
        svgIcon: 'layout/switch_bell.svg',
        size: { width: 16, height: 16 },
        sldEquivalent: 'Bell Push',
        placementType: 'wall',
        description: 'Door bell push button'
    },

    // =========================================================================
    // SWITCH BOARDS (Combined Units)
    // =========================================================================
    'point_switch_board': {
        type: 'point_switch_board',
        name: 'Point Switch Board',
        category: 'switchboards',
        symbol: '⬚',
        svgIcon: 'layout/point_switch_board.svg',
        size: { width: 40, height: 40 },
        sldEquivalent: 'Point Switch Board',
        placementType: 'wall',
        description: 'Multi-output switch board for point wiring'
    },
    'switch_board_2way': {
        type: 'switch_board_2way',
        name: '2 Switch Board',
        category: 'switchboards',
        symbol: '⬚₂',
        svgIcon: 'layout/switch_board_2way.svg',
        size: { width: 24, height: 24 },
        sldEquivalent: '2 Switch Board',
        placementType: 'wall',
        description: '2-gang switch board'
    },
    'switch_board_3way': {
        type: 'switch_board_3way',
        name: '3 Switch Board',
        category: 'switchboards',
        symbol: '⬚₃',
        svgIcon: 'layout/switch_board_3way.svg',
        size: { width: 28, height: 24 },
        sldEquivalent: '3 Switch Board',
        placementType: 'wall',
        description: '3-gang switch board'
    },
    'switch_board_4way': {
        type: 'switch_board_4way',
        name: '4 Switch Board',
        category: 'switchboards',
        symbol: '⬚₄',
        svgIcon: 'layout/switch_board_4way.svg',
        size: { width: 32, height: 24 },
        sldEquivalent: '4 Switch Board',
        placementType: 'wall',
        description: '4-gang switch board'
    },
    'switch_board_6way': {
        type: 'switch_board_6way',
        name: '6 Switch Board',
        category: 'switchboards',
        symbol: '⬚₆',
        svgIcon: 'layout/switch_board_6way.svg',
        size: { width: 40, height: 28 },
        sldEquivalent: '6 Switch Board',
        placementType: 'wall',
        description: '6-gang switch board'
    },
    'switch_board_8way': {
        type: 'switch_board_8way',
        name: '8 Switch Board',
        category: 'switchboards',
        symbol: '⬚₈',
        svgIcon: 'layout/switch_board_8way.svg',
        size: { width: 48, height: 28 },
        sldEquivalent: '8 Switch Board',
        placementType: 'wall',
        description: '8-gang switch board'
    },
    'switch_board_12way': {
        type: 'switch_board_12way',
        name: '12 Switch Board',
        category: 'switchboards',
        symbol: '⬚₁₂',
        svgIcon: 'layout/switch_board_12way.svg',
        size: { width: 56, height: 32 },
        sldEquivalent: '12 Switch Board',
        placementType: 'wall',
        description: '12-gang switch board'
    },
    'switch_board_18way': {
        type: 'switch_board_18way',
        name: '18 Switch Board',
        category: 'switchboards',
        symbol: '⬚₁₈',
        svgIcon: 'layout/switch_board_18way.svg',
        size: { width: 64, height: 36 },
        sldEquivalent: '18 Switch Board',
        placementType: 'wall',
        description: '18-gang switch board'
    },
    'avg_5a_switch_board': {
        type: 'avg_5a_switch_board',
        name: 'Avg 5A Switch Board',
        category: 'switchboards',
        symbol: '⬚ₐ',
        svgIcon: 'layout/avg_5a_switch_board.svg',
        size: { width: 32, height: 28 },
        sldEquivalent: 'Avg. 5A Switch Board',
        placementType: 'wall',
        description: 'Average 5A rated switch board'
    },

    // =========================================================================
    // HVAC / FANS
    // =========================================================================
    'ac_point': {
        type: 'ac_point',
        name: 'AC Point',
        category: 'hvac',
        symbol: '❄',
        svgIcon: 'layout/ac_point.svg',
        size: { width: 28, height: 28 },
        sldEquivalent: 'AC Point',
        placementType: 'wall',
        defaultWattage: 1500,
        description: 'Air conditioner connection point'
    },
    'exhaust_fan': {
        type: 'exhaust_fan',
        name: 'Exhaust Fan',
        category: 'hvac',
        symbol: '⌀',
        svgIcon: 'layout/exhaust_fan.svg',
        size: { width: 24, height: 24 },
        sldEquivalent: 'Exhaust Fan',
        placementType: 'wall',
        defaultWattage: 40,
        description: 'Exhaust/ventilation fan'
    },
    'ceiling_fan_point': {
        type: 'ceiling_fan_point',
        name: 'Ceiling Fan',
        category: 'hvac',
        symbol: '⊛',
        svgIcon: 'layout/ceiling_fan.svg',
        size: { width: 24, height: 24 },
        sldEquivalent: 'Ceiling Fan',
        placementType: 'ceiling',
        defaultWattage: 75,
        description: 'Ceiling fan point'
    },
    'ceiling_rose': {
        type: 'ceiling_rose',
        name: 'Ceiling Rose',
        category: 'hvac',
        symbol: '✿',
        svgIcon: 'layout/ceiling_rose.svg',
        size: { width: 20, height: 20 },
        sldEquivalent: 'Ceiling Rose',
        placementType: 'ceiling',
        description: 'Ceiling connection rose'
    },

    // =========================================================================
    // DISTRIBUTION BOARDS
    // =========================================================================
    'db_box': {
        type: 'db_box',
        name: 'DB Box',
        category: 'distribution',
        symbol: '▣',
        svgIcon: 'layout/db_box.svg',
        size: { width: 40, height: 30 },
        sldEquivalent: 'SPN DB',
        placementType: 'wall',
        description: 'Generic distribution box'
    },
    'spn_db': {
        type: 'spn_db',
        name: 'SPN DB',
        category: 'distribution',
        symbol: '▦',
        svgIcon: 'layout/spn_db.svg',
        size: { width: 50, height: 40 },
        sldEquivalent: 'SPN DB',
        placementType: 'wall',
        description: 'Single Phase Neutral Distribution Board'
    },
    'vtpn_db': {
        type: 'vtpn_db',
        name: 'VTPN DB',
        category: 'distribution',
        symbol: '▧',
        svgIcon: 'layout/vtpn_db.svg',
        size: { width: 60, height: 50 },
        sldEquivalent: 'VTPN',
        placementType: 'wall',
        description: 'Vertical Three Phase Neutral DB'
    },
    'htpn_db': {
        type: 'htpn_db',
        name: 'HTPN DB',
        category: 'distribution',
        symbol: '▨',
        svgIcon: 'layout/htpn_db.svg',
        size: { width: 70, height: 50 },
        sldEquivalent: 'HTPN',
        placementType: 'wall',
        description: 'Horizontal Three Phase Neutral DB'
    },
    'lt_cubical_panel': {
        type: 'lt_cubical_panel',
        name: 'LT Cubical Panel',
        category: 'distribution',
        symbol: '⬛',
        svgIcon: 'layout/lt_cubical_panel.svg',
        size: { width: 80, height: 60 },
        sldEquivalent: 'LT Cubical Panel',
        placementType: 'floor',
        description: 'Low Tension Cubical Panel'
    },
    'busbar_chamber': {
        type: 'busbar_chamber',
        name: 'Busbar Chamber',
        category: 'distribution',
        symbol: '▬',
        svgIcon: 'layout/busbar_chamber.svg',
        size: { width: 60, height: 30 },
        sldEquivalent: 'Busbar Chamber',
        placementType: 'wall',
        description: 'Busbar trunking chamber'
    },
    'mcb_point': {
        type: 'mcb_point',
        name: 'MCB Point',
        category: 'distribution',
        symbol: '⊔',
        svgIcon: 'layout/mcb_point.svg',
        size: { width: 20, height: 20 },
        placementType: 'wall',
        description: 'MCB/circuit breaker point'
    },

    // =========================================================================
    // SWITCHGEAR
    // =========================================================================
    'main_switch': {
        type: 'main_switch',
        name: 'Main Switch',
        category: 'switchgear',
        symbol: '⏻',
        svgIcon: 'layout/main_switch.svg',
        size: { width: 36, height: 36 },
        sldEquivalent: 'Main Switch',
        placementType: 'wall',
        description: 'Main isolator switch'
    },
    'changeover_switch': {
        type: 'changeover_switch',
        name: 'Changeover Switch',
        category: 'switchgear',
        symbol: '⇄',
        svgIcon: 'layout/changeover_switch.svg',
        size: { width: 40, height: 36 },
        sldEquivalent: 'Change Over Switch',
        placementType: 'wall',
        description: 'Manual/Auto changeover switch'
    },

    // =========================================================================
    // METERS
    // =========================================================================
    'meter_1phase': {
        type: 'meter_1phase',
        name: '1 Phase Meter',
        category: 'meters',
        symbol: 'Ⓜ₁',
        svgIcon: 'layout/meter_1phase.svg',
        size: { width: 32, height: 40 },
        sldEquivalent: '1 Phase Meter',
        placementType: 'wall',
        description: 'Single phase energy meter'
    },
    'meter_3phase': {
        type: 'meter_3phase',
        name: '3 Phase Meter',
        category: 'meters',
        symbol: 'Ⓜ₃',
        svgIcon: 'layout/meter_3phase.svg',
        size: { width: 40, height: 48 },
        sldEquivalent: '3 Phase Meter',
        placementType: 'wall',
        description: 'Three phase energy meter'
    },

    // =========================================================================
    // APPLIANCES
    // =========================================================================
    'geyser_point': {
        type: 'geyser_point',
        name: 'Geyser Point',
        category: 'appliances',
        symbol: '♨',
        svgIcon: 'layout/geyser_point.svg',
        size: { width: 28, height: 28 },
        sldEquivalent: 'Geyser Point',
        placementType: 'wall',
        defaultWattage: 2000,
        description: 'Water heater connection point'
    },
    'computer_point': {
        type: 'computer_point',
        name: 'Computer Point',
        category: 'appliances',
        symbol: '💻',
        svgIcon: 'layout/computer_point.svg',
        size: { width: 24, height: 24 },
        sldEquivalent: 'Computer Point',
        placementType: 'wall',
        defaultWattage: 500,
        description: 'Computer/workstation point'
    },
    'call_bell': {
        type: 'call_bell',
        name: 'Call Bell',
        category: 'appliances',
        symbol: '🔔',
        svgIcon: 'layout/call_bell.svg',
        size: { width: 20, height: 20 },
        sldEquivalent: 'Call Bell',
        placementType: 'wall',
        defaultWattage: 5,
        description: 'Door/call bell unit'
    },

    // =========================================================================
    // INFRASTRUCTURE
    // =========================================================================
    'source': {
        type: 'source',
        name: 'Power Source',
        category: 'infrastructure',
        symbol: '⚡',
        svgIcon: 'layout/source.svg',
        size: { width: 40, height: 40 },
        sldEquivalent: 'Source',
        placementType: 'any',
        description: 'Main power source (utility/grid)'
    },
    'portal': {
        type: 'portal',
        name: 'Portal',
        category: 'infrastructure',
        symbol: '⟷',
        svgIcon: 'layout/portal.svg',
        size: { width: 32, height: 24 },
        sldEquivalent: 'Portal',
        placementType: 'any',
        description: 'Cross-sheet reference portal'
    },
    'generator': {
        type: 'generator',
        name: 'Generator',
        category: 'infrastructure',
        symbol: 'Ⓖ',
        svgIcon: 'layout/generator.svg',
        size: { width: 50, height: 40 },
        sldEquivalent: 'Generator',
        placementType: 'floor',
        description: 'Backup generator/DG set'
    },

    // =========================================================================
    // SAFETY
    // =========================================================================
    'smoke_detector': {
        type: 'smoke_detector',
        name: 'Smoke Detector',
        category: 'safety',
        symbol: '◉',
        svgIcon: 'layout/smoke_detector.svg',
        size: { width: 20, height: 20 },
        placementType: 'ceiling',
        description: 'Smoke/fire detector'
    },
    'fire_alarm': {
        type: 'fire_alarm',
        name: 'Fire Alarm',
        category: 'safety',
        symbol: '⚠',
        svgIcon: 'layout/fire_alarm.svg',
        size: { width: 20, height: 20 },
        placementType: 'wall',
        description: 'Fire alarm call point'
    }
};

// =============================================================================
// CATEGORY DEFINITIONS - For Sidebar Display
// =============================================================================

// =============================================================================
// CATEGORY DEFINITIONS - Dynamic Generation from Unified Definition
// =============================================================================
import { UNIFIED_ITEM_CATEGORIES } from './UnifiedDefinition';
// Removed conflicting import
// We can't call exported functions before they are defined if using variable init, 
// but we can inside the map.
// Actually, circular dependency risk if we import from self.
// The functions `getElement...` are below. We can iterate `LAYOUT_COMPONENT_DEFINITIONS` directly.

export const LAYOUT_COMPONENT_CATEGORIES: Record<string, { name: string; icon: string; order: number; components: LayoutComponentType[] }> = {};

// Helper to find layout type for SLD Item directly from definitions (avoiding circular dep issue)
const findLayoutTypes = (sldName: string): LayoutComponentType[] => {
    const matches: LayoutComponentType[] = [];
    for (const [type, def] of Object.entries(LAYOUT_COMPONENT_DEFINITIONS)) {
        if (def.sldEquivalent === sldName) {
            matches.push(type as LayoutComponentType);
        }
    }
    // Also handle manual mappings if sldEquivalent isn't enough (e.g. switch_bell maps to Bell Push)
    // Actually definitions are correct now.
    return matches;
};

// Populate Categories
UNIFIED_ITEM_CATEGORIES.forEach(cat => {
    const components: LayoutComponentType[] = [];

    // Add components that map to SLD items in this category
    cat.sldItems.forEach(sldItem => {
        const types = findLayoutTypes(sldItem);
        components.push(...types);
    });

    // Handle Layout-Specific items that might not be in SLD list explicitly yet
    // Example: Smoke Detector in Safety.
    // If the unified category has empty sldItems, we might need manual mapping or 
    // we assume the UnifiedDefinition will be updated to include 'Smoke Detector' as SLD item even if unused in SLD view yet.

    // For now, let's hardcode the safety/extra items if they are missing
    if (cat.id === 'safety') {
        const safetyTypes: LayoutComponentType[] = ['smoke_detector', 'fire_alarm']; // Add explicitly
        components.push(...safetyTypes);
    }
    // Switches: SLD has "Bell Push" (Others). Layout has sw_1way etc.
    // If we want "Switches" category in Layout to still have 1-way, 2-way etc.
    // We need to add them. The User wanted "common shared named".
    // If SLD doesn't have "Switches" category (it has "Switch Boards"), 
    // we might lose 1-way/2-way if we strictly follow SLD.
    // But we defined "Switches" in UnifiedDefinition?
    // Wait, UnifiedDefinition had "Others" for Bell Push.
    // The user's SLD image had "Switch Boards".
    // It did NOT show "1 Way Switch".

    // However, Layout NEEDS 1-way switches.
    // I should create a "Switches" category in UnifiedDefinition if it's missing or append to it.
    // In my generated UnifiedDefinition, I didn't add "Switches" category because SLD didn't have it.
    // I added "Others".

    // Check if I added "Switches" to UnifiedDefinition? No.
    // Layout needs "Switches".
    // I should add "Switches" to UnifiedDefinition (maybe empty sldItems) so it exists.
    // Actually, I should just ADD it to the generated object if it's layout specific.
});

// RE-WRITING THE GENERATION TO BE SAFE AND COMPLETE
// We will start with empty and fill from Unified.
// THEN we append Layout-Specific categories that don't exist in SLD if needed.

UNIFIED_ITEM_CATEGORIES.forEach(cat => {
    const components: LayoutComponentType[] = [];
    cat.sldItems.forEach(name => components.push(...findLayoutTypes(name)));

    LAYOUT_COMPONENT_CATEGORIES[cat.id] = {
        name: cat.label,
        icon: cat.icon,
        order: cat.order,
        components: Array.from(new Set(components)) // Dedup
    };
});

// Manual additions for Layout-only components (Essential for Layout to function)
// Switches (1way, 2way, dimmer) - SLD doesn't use these usually
if (!LAYOUT_COMPONENT_CATEGORIES['switches']) {
    LAYOUT_COMPONENT_CATEGORIES['switches'] = {
        name: 'Switches',
        icon: '🔘',
        order: 2.5, // Between Switchgear and Appliances
        components: ['switch_1way', 'switch_2way', 'switch_dimmer', 'switch_bell']
    };
} else {
    // If it exists (maybe I added it to Unified?), merge.
    LAYOUT_COMPONENT_CATEGORIES['switches'].components.push('switch_1way', 'switch_2way', 'switch_dimmer', 'switch_bell');
    LAYOUT_COMPONENT_CATEGORIES['switches'].components = Array.from(new Set(LAYOUT_COMPONENT_CATEGORIES['switches'].components));
}

// Ensure Safety components are present
if (LAYOUT_COMPONENT_CATEGORIES['safety']) {
    LAYOUT_COMPONENT_CATEGORIES['safety'].components.push('smoke_detector', 'fire_alarm');
    LAYOUT_COMPONENT_CATEGORIES['safety'].components = Array.from(new Set(LAYOUT_COMPONENT_CATEGORIES['safety'].components));
}


// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get component definition by type
 */
export function getLayoutComponentDef(type: LayoutComponentType): LayoutComponentDef {
    return LAYOUT_COMPONENT_DEFINITIONS[type];
}

/**
 * Get all components in a category
 */
export function getComponentsByCategory(category: keyof typeof LAYOUT_COMPONENT_CATEGORIES): LayoutComponentDef[] {
    const categoryDef = LAYOUT_COMPONENT_CATEGORIES[category];
    return categoryDef.components.map(type => LAYOUT_COMPONENT_DEFINITIONS[type as LayoutComponentType]);
}

/**
 * Get categories sorted by order
 */
export function getSortedCategories(): Array<{ key: string; name: string; icon: string; components: LayoutComponentDef[] }> {
    return Object.entries(LAYOUT_COMPONENT_CATEGORIES)
        .sort(([, a], [, b]) => a.order - b.order)
        .map(([key, value]) => ({
            key,
            name: value.name,
            icon: value.icon,
            components: value.components.map(type => LAYOUT_COMPONENT_DEFINITIONS[type as LayoutComponentType])
        }));
}

/**
 * Find layout component type by SLD equivalent name
 */
export function findLayoutTypeForSldItem(sldItemName: string): LayoutComponentType | null {
    for (const [type, def] of Object.entries(LAYOUT_COMPONENT_DEFINITIONS)) {
        if (def.sldEquivalent === sldItemName) {
            return type as LayoutComponentType;
        }
    }
    return null;
}

/**
 * Get all layout types that map to a given SLD item
 */
export function getLayoutTypesForSldItem(sldItemName: string): LayoutComponentType[] {
    const matches: LayoutComponentType[] = [];
    for (const [type, def] of Object.entries(LAYOUT_COMPONENT_DEFINITIONS)) {
        if (def.sldEquivalent === sldItemName) {
            matches.push(type as LayoutComponentType);
        }
    }
    return matches;
}

/**
 * Get default wattage for load calculation
 */
export function getComponentWattage(type: LayoutComponentType): number {
    return LAYOUT_COMPONENT_DEFINITIONS[type].defaultWattage || 0;
}

/**
 * Search components by name
 */
export function searchComponents(query: string): LayoutComponentDef[] {
    const lowerQuery = query.toLowerCase();
    return Object.values(LAYOUT_COMPONENT_DEFINITIONS).filter(
        def => def.name.toLowerCase().includes(lowerQuery) ||
            def.description?.toLowerCase().includes(lowerQuery) ||
            def.category.toLowerCase().includes(lowerQuery)
    );
}
