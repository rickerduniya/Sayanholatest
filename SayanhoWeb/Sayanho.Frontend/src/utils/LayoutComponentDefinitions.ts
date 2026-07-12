// Layout Component Definitions — CPWD/IS 12032 Professional Electrical Symbols
// Exactly mirrors the SLD library (17 items).
// Real-world dimensions in mm; pixel size computed from pixelsPerMeter calibration.

import { LayoutComponentDef, LayoutComponentType } from '../types/layout';

// =============================================================================
// CALIBRATION-AWARE SIZE UTILITY
// =============================================================================

/**
 * Convert a real-world mm dimension to canvas pixels using floor-plan calibration.
 * Enforces a minimum display size so symbols stay clickable even at small scale.
 *
 * @param mm           Real-world size in millimetres
 * @param pixelsPerMeter  Calibration value from FloorPlan (default 50 px/m)
 * @param minPx        Minimum pixel size for visibility (default 14)
 * @param maxPx        Maximum pixel size to keep large items manageable (default 180)
 */
export function mmToPx(
    mm: number,
    pixelsPerMeter = 50,
    minPx = 14,
    maxPx = 180
): number {
    const raw = (mm / 1000) * pixelsPerMeter;
    return Math.round(Math.max(minPx, Math.min(maxPx, raw)));
}

/**
 * Return pixel {width, height} for a component at the current calibration.
 */
export function getScaledComponentSize(
    type: LayoutComponentType,
    pixelsPerMeter = 50
): { width: number; height: number } {
    const def = LAYOUT_COMPONENT_DEFINITIONS[type];
    if (!def) return { width: 24, height: 24 };
    return {
        width:  mmToPx(def.realSizeMm.width,  pixelsPerMeter, def.minDisplayPx ?? 14, def.maxDisplayPx ?? 180),
        height: mmToPx(def.realSizeMm.height, pixelsPerMeter, def.minDisplayPx ?? 14, def.maxDisplayPx ?? 180),
    };
}

// =============================================================================
// COMPONENT DEFINITIONS  (17 items — matches SLD library exactly)
// =============================================================================
// realSizeMm: physical top-view footprint in millimetres
//   Sources: CPWD General Specs 2023, Havells/Schneider datasheets, IS 12032-11
// svgIcon: served from /public/layout/ (Vite serves /public as root)
// =============================================================================

export const LAYOUT_COMPONENT_DEFINITIONS: Record<LayoutComponentType, LayoutComponentDef> = {

    // =========================================================================
    // DISTRIBUTION BOARDS
    // =========================================================================

    'spn_db': {
        type: 'spn_db',
        name: 'SPN DB',
        category: 'distribution',
        symbol: '▦',
        svgIcon: 'layout/spn_db.svg',
        // SPN 8-way enclosure top view (Havells ESDB): 247 × 166 mm
        realSizeMm: { width: 247, height: 166 },
        size: { width: 40, height: 28 },            // fallback px (used without calibration)
        sldEquivalent: 'SPN DB',
        placementType: 'wall',
        description: 'Single Pole Neutral Distribution Board',
    },

    'vtpn_db': {
        type: 'vtpn_db',
        name: 'VTPN',
        category: 'distribution',
        symbol: '▧',
        svgIcon: 'layout/vtpn_db.svg',
        // VTPN 12-way (Schneider Pragma): 416 × 155 mm
        realSizeMm: { width: 416, height: 155 },
        size: { width: 52, height: 22 },
        sldEquivalent: 'VTPN',
        placementType: 'wall',
        description: 'Vertical Triple Pole Neutral Distribution Board',
    },

    'htpn_db': {
        type: 'htpn_db',
        name: 'HTPN',
        category: 'distribution',
        symbol: '▨',
        svgIcon: 'layout/htpn_db.svg',
        // HTPN/TPN 8-way (Havells): 500 × 306 mm
        realSizeMm: { width: 500, height: 306 },
        size: { width: 56, height: 38 },
        sldEquivalent: 'HTPN',
        placementType: 'wall',
        description: 'Horizontal Triple Pole Neutral Distribution Board',
    },

    'lt_cubical_panel': {
        type: 'lt_cubical_panel',
        name: 'LT Cubical Panel',
        category: 'distribution',
        symbol: '⬛',
        svgIcon: 'layout/lt_cubical_panel.svg',
        // Standard single cubicle section: 800 × 500 mm
        realSizeMm: { width: 800, height: 500 },
        size: { width: 70, height: 50 },
        maxDisplayPx: 200,
        sldEquivalent: 'LT Cubical Panel',
        placementType: 'floor',
        description: 'Low Tension Cubicle Panel (MCC/PCC)',
    },

    'busbar_chamber': {
        type: 'busbar_chamber',
        name: 'Busbar Chamber',
        category: 'distribution',
        symbol: '▬',
        svgIcon: 'layout/busbar_chamber.svg',
        // Modular busbar chamber 400A: 600 × 400 mm
        realSizeMm: { width: 600, height: 400 },
        size: { width: 60, height: 40 },
        maxDisplayPx: 180,
        sldEquivalent: 'Busbar Chamber',
        placementType: 'floor',
        description: 'Busbar Trunking Chamber',
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
        // ISOS 63A TPN enclosure: 150 × 100 mm
        realSizeMm: { width: 150, height: 100 },
        size: { width: 30, height: 22 },
        sldEquivalent: 'Main Switch',
        placementType: 'wall',
        description: 'Main Incomer Switch / ISOS',
    },

    'changeover_switch': {
        type: 'changeover_switch',
        name: 'Change Over Switch',
        category: 'switchgear',
        symbol: '⇄',
        svgIcon: 'layout/changeover_switch.svg',
        // COS 63A TPN enclosure: 150 × 100 mm
        realSizeMm: { width: 150, height: 100 },
        size: { width: 30, height: 22 },
        sldEquivalent: 'Change Over Switch',
        placementType: 'wall',
        description: 'Manual Changeover Switch (Mains/DG)',
    },

    // =========================================================================
    // APPLIANCES
    // =========================================================================

    'ac_point': {
        type: 'ac_point',
        name: 'AC Point',
        category: 'appliances',
        symbol: '❄',
        svgIcon: 'layout/ac_point.svg',
        // 1.5T Split AC indoor unit top view: 900 × 220 mm
        realSizeMm: { width: 900, height: 220 },
        size: { width: 60, height: 18 },
        maxDisplayPx: 200,
        sldEquivalent: 'AC Point',
        placementType: 'wall',
        defaultWattage: 1500,
        description: 'Split AC Indoor Unit / AC Power Point',
    },

    'geyser_point': {
        type: 'geyser_point',
        name: 'Geyser Point',
        category: 'appliances',
        symbol: '♨',
        svgIcon: 'layout/geyser_point.svg',
        // 15L storage geyser diameter: ~315 mm
        realSizeMm: { width: 315, height: 315 },
        size: { width: 32, height: 32 },
        sldEquivalent: 'Geyser Point',
        placementType: 'wall',
        defaultWattage: 2000,
        description: 'Electric Water Heater / Geyser Point',
    },

    // =========================================================================
    // LIGHTING
    // =========================================================================

    'bulb': {
        type: 'bulb',
        name: 'Bulb',
        category: 'lighting',
        symbol: '⊕',
        svgIcon: 'layout/bulb.svg',
        // Recessed downlight cutout diameter: ~110 mm (IS 12032 symbol: circle ⌀110)
        realSizeMm: { width: 110, height: 110 },
        size: { width: 24, height: 24 },
        sldEquivalent: 'Bulb',
        placementType: 'ceiling',
        defaultWattage: 9,
        description: 'Light Point / Bulb (CPWD: circle with cross)',
    },

    'tube_light': {
        type: 'tube_light',
        name: 'Tube Light',
        category: 'lighting',
        symbol: '═',
        svgIcon: 'layout/tube_light.svg',
        // Standard 4ft T8 batten: 1200 × 38 mm
        realSizeMm: { width: 1200, height: 38 },
        size: { width: 60, height: 10 },
        minDisplayPx: 30,
        maxDisplayPx: 200,
        sldEquivalent: 'Tube Light',
        placementType: 'ceiling',
        defaultWattage: 36,
        description: 'Fluorescent / LED Batten Tube Light',
    },

    // =========================================================================
    // FANS
    // =========================================================================

    'ceiling_fan_point': {
        type: 'ceiling_fan_point',
        name: 'Ceiling Fan',
        category: 'fans',
        symbol: '⊛',
        svgIcon: 'layout/ceiling_fan.svg',
        // Standard 1200mm sweep fan (top view = full sweep circle)
        realSizeMm: { width: 1200, height: 1200 },
        size: { width: 48, height: 48 },
        maxDisplayPx: 200,
        sldEquivalent: 'Ceiling Fan',
        placementType: 'ceiling',
        defaultWattage: 75,
        description: 'Ceiling Fan (1200mm sweep — CPWD symbol)',
    },

    'exhaust_fan': {
        type: 'exhaust_fan',
        name: 'Exhaust Fan',
        category: 'fans',
        symbol: '⌀',
        svgIcon: 'layout/exhaust_fan.svg',
        // Standard 250mm (10") exhaust fan frame
        realSizeMm: { width: 250, height: 250 },
        size: { width: 28, height: 28 },
        sldEquivalent: 'Exhaust Fan',
        placementType: 'wall',
        defaultWattage: 40,
        description: 'Exhaust Fan (250mm frame)',
    },

    // =========================================================================
    // SWITCH BOARDS
    // =========================================================================

    'point_switch_board': {
        type: 'point_switch_board',
        name: 'Point Switch Board',
        category: 'switchboards',
        symbol: '⬚',
        svgIcon: 'layout/point_switch_board.svg',
        // 6M modular switch plate: 224 × 87 mm
        realSizeMm: { width: 224, height: 87 },
        size: { width: 44, height: 20 },
        sldEquivalent: 'Point Switch Board',
        placementType: 'wall',
        description: 'Point Switch Board (6M modular plate)',
    },

    'avg_5a_switch_board': {
        type: 'avg_5a_switch_board',
        name: 'Avg. 5A Switch Board',
        category: 'switchboards',
        symbol: '⬚ₐ',
        svgIcon: 'layout/avg_5a_switch_board.svg',
        // 4M modular plate: 150 × 87 mm
        realSizeMm: { width: 150, height: 87 },
        size: { width: 32, height: 20 },
        sldEquivalent: 'Avg. 5A Switch Board',
        placementType: 'wall',
        description: 'Average 5A Switch Board (4M modular plate)',
    },

    // =========================================================================
    // INFRASTRUCTURE
    // =========================================================================

    'source': {
        type: 'source',
        name: 'Source',
        category: 'infrastructure',
        symbol: '⚡',
        svgIcon: 'layout/source.svg',
        // Schematic symbol — no physical footprint; use indicative 200×200mm
        realSizeMm: { width: 200, height: 200 },
        size: { width: 36, height: 36 },
        sldEquivalent: 'Source',
        placementType: 'any',
        description: 'Power Source / Incomer Supply Point',
    },

    // =========================================================================
    // OTHERS
    // =========================================================================

    'call_bell': {
        type: 'call_bell',
        name: 'Call Bell',
        category: 'others',
        symbol: '🔔',
        svgIcon: 'layout/call_bell.svg',
        // Ding-dong call bell unit: 80 × 40 mm
        realSizeMm: { width: 80, height: 40 },
        size: { width: 20, height: 14 },
        sldEquivalent: 'Call Bell',
        placementType: 'wall',
        defaultWattage: 5,
        description: 'Call Bell / Door Bell Unit',
    },
};

// =============================================================================
// HELPER UTILITIES
// =============================================================================

/**
 * Get component definition by type. Returns undefined if type is not found.
 */
export function getComponentDef(type: LayoutComponentType): LayoutComponentDef | undefined {
    return LAYOUT_COMPONENT_DEFINITIONS[type];
}

/**
 * Get all components in a given category.
 */
export function getComponentsByCategory(
    category: LayoutComponentDef['category']
): LayoutComponentDef[] {
    return Object.values(LAYOUT_COMPONENT_DEFINITIONS).filter(d => d.category === category);
}

/**
 * Find the layout component type by SLD item name.
 */
export function getLayoutTypeForSldItem(sldItemName: string): LayoutComponentType | null {
    for (const [type, def] of Object.entries(LAYOUT_COMPONENT_DEFINITIONS)) {
        if (def.sldEquivalent === sldItemName) return type as LayoutComponentType;
    }
    return null;
}

/**
 * Get all layout types that map to a given SLD item.
 */
export function getLayoutTypesForSldItem(sldItemName: string): LayoutComponentType[] {
    return (Object.entries(LAYOUT_COMPONENT_DEFINITIONS) as [LayoutComponentType, LayoutComponentDef][])
        .filter(([, def]) => def.sldEquivalent === sldItemName)
        .map(([type]) => type);
}

/**
 * Get default wattage for load calculation.
 */
export function getComponentWattage(type: LayoutComponentType): number {
    return LAYOUT_COMPONENT_DEFINITIONS[type]?.defaultWattage ?? 0;
}

/**
 * Search components by name or description.
 */
export function searchComponents(query: string): LayoutComponentDef[] {
    const q = query.toLowerCase();
    return Object.values(LAYOUT_COMPONENT_DEFINITIONS).filter(
        def =>
            def.name.toLowerCase().includes(q) ||
            def.description?.toLowerCase().includes(q) ||
            def.category.toLowerCase().includes(q)
    );
}

// =============================================================================
// CATEGORY METADATA  (used by LayoutSidebar)
// Order matches the SLD sidebar exactly.
// =============================================================================

export interface LayoutCategoryMeta {
    key: LayoutComponentDef['category'];
    name: string;
    icon: string;
    order: number;
    defaultExpanded?: boolean;
}

export const LAYOUT_COMPONENT_CATEGORIES: LayoutCategoryMeta[] = [
    { key: 'distribution',   name: 'Distribution Boards', icon: '⚡', order: 1, defaultExpanded: true },
    { key: 'switchgear',     name: 'Switchgear',          icon: '🔌', order: 2 },
    { key: 'appliances',     name: 'Appliances',          icon: '❄️',  order: 3 },
    { key: 'lighting',       name: 'Lighting',            icon: '💡', order: 4, defaultExpanded: true },
    { key: 'fans',           name: 'Fans',                icon: '🌀', order: 5 },
    { key: 'switchboards',   name: 'Switch Boards',       icon: '🗂️',  order: 6 },
    { key: 'infrastructure', name: 'Infrastructure',      icon: '🏗️',  order: 7 },
    { key: 'others',         name: 'Others',              icon: '🔔', order: 8 },
];

/**
 * Returns categories in SLD-matching order, each with its component list.
 * Empty categories are omitted automatically.
 */
export function getSortedCategories(): Array<{
    key: string;
    name: string;
    icon: string;
    components: LayoutComponentDef[];
}> {
    return LAYOUT_COMPONENT_CATEGORIES
        .sort((a, b) => a.order - b.order)
        .map(cat => ({
            key:  cat.key,
            name: cat.name,
            icon: cat.icon,
            components: Object.values(LAYOUT_COMPONENT_DEFINITIONS).filter(
                d => d.category === cat.key
            ),
        }))
        .filter(cat => cat.components.length > 0);
}

/**
 * Alias for getComponentDef — kept for backward compatibility with
 * any code that imports getLayoutComponentDef.
 */
export function getLayoutComponentDef(type: LayoutComponentType): LayoutComponentDef | undefined {
    return LAYOUT_COMPONENT_DEFINITIONS[type];
}
