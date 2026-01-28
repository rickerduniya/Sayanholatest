/**
 * DefaultRulesEngine.ts
 * 
 * Centralized, modular default component generation system for the SLD project.
 * This file consolidates all default rules for items and connectors in one place
 * for easy monitoring and modification.
 * 
 * To add new items or components:
 * 1. Define the rule in the appropriate section (ITEM_RULES or CONNECTOR_RULES)
 * 2. The rule will be automatically picked up by the registry
 */

import { Point, Size } from '../types';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Geometry definition for an item (size and connection points)
 */
export interface ItemGeometry {
    size: Size;
    connectionPoints: Record<string, Point>;
}

/**
 * Property defaults for an item
 */
export interface ItemPropertyDefaults {
    properties: Record<string, string>;
    incomer?: Record<string, string>;
    outgoing?: Record<string, string>[];
    accessories?: Record<string, string>[];
    alternativeCompany1?: string;
    alternativeCompany2?: string;
}

/**
 * Complete rule definition for an item
 */
export interface ItemRule {
    name: string;
    category: 'load' | 'source' | 'switch' | 'distribution' | 'connector_point' | 'other';
    geometry: ItemGeometry;
    defaults: ItemPropertyDefaults;
    /** If true, item requires backend API call for full initialization (VTPN, HTPN, SPN DB) */
    requiresBackendInit?: boolean;
    /** Default Way value for distribution boards */
    defaultWay?: string;
}

/**
 * Rule definition for a connector
 */
export interface ConnectorRule {
    materialType: 'Cable' | 'Wiring';
    defaults: {
        properties: Record<string, string>;
        laying?: Record<string, string>;
        accessories?: Record<string, string>[];
    };
}

// ============================================================================
// ITEM RULES - Load Items (Bulb, Fan, Geyser, etc.)
// ============================================================================

const LOAD_ITEMS: ItemRule[] = [
    {
        name: "Bulb",
        category: "load",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "in": { x: 30, y: 0 } }
        },
        defaults: {
            properties: { "Power": "12 W", "Description": "Bulb", "Type": "Lighting" }
        }
    },
    {
        name: "Tube Light",
        category: "load",
        geometry: {
            size: { width: 80, height: 48 },
            connectionPoints: { "in": { x: 40, y: 0 } }
        },
        defaults: {
            properties: { "Power": "18 W", "Description": "Tube Light", "Type": "Lighting" }
        }
    },
    {
        name: "Ceiling Fan",
        category: "load",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "in": { x: 30, y: 0 } }
        },
        defaults: {
            properties: { "Power": "80 W", "Description": "Ceiling Fan", "Type": "Appliance" }
        }
    },
    {
        name: "Exhaust Fan",
        category: "load",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "in": { x: 30, y: 0 } }
        },
        defaults: {
            properties: { "Power": "60 W", "Description": "Exhaust Fan", "Type": "Appliance" }
        }
    },
    {
        name: "Split AC",
        category: "load",
        geometry: {
            size: { width: 80, height: 60 },
            connectionPoints: { "in": { x: 40, y: 0 } }
        },
        defaults: {
            properties: { "Power": "2200 W", "Description": "Split AC", "Type": "Appliance" }
        }
    },
    {
        name: "AC Point",
        category: "load",
        geometry: {
            size: { width: 80, height: 60 },
            connectionPoints: { "in": { x: 40, y: 0 } }
        },
        defaults: {
            properties: { "Power": "2200 W", "Description": "AC Point", "Type": "Appliance" }
        }
    },
    {
        name: "Geyser",
        category: "load",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "in": { x: 30, y: 0 } }
        },
        defaults: {
            properties: { "Power": "1200 W", "Description": "Geyser", "Type": "Appliance" }
        }
    },
    {
        name: "Geyser Point",
        category: "load",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "in": { x: 30, y: 0 } }
        },
        defaults: {
            properties: { "Power": "1200 W", "Description": "Geyser Point", "Type": "Appliance" }
        }
    },
    {
        name: "Call Bell",
        category: "load",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "in": { x: 30, y: 0 } }
        },
        defaults: {
            properties: { "Power": "10 W", "Description": "Call Bell", "Type": "Other" }
        }
    }
];

// ============================================================================
// ITEM RULES - Source Items
// ============================================================================

const SOURCE_ITEMS: ItemRule[] = [
    {
        name: "Source",
        category: "source",
        geometry: {
            size: { width: 60, height: 60 },
            connectionPoints: { "out": { x: 30, y: 60 } }
        },
        defaults: {
            properties: {
                "Type": "3-phase",
                "Voltage": "415 V",
                "Frequency": "50 Hz"
            }
        }
    }
];

// ============================================================================
// ITEM RULES - Switch Items
// ============================================================================

const SWITCH_ITEMS: ItemRule[] = [
    {
        name: "Main Switch",
        category: "switch",
        geometry: {
            size: { width: 100, height: 100 },
            connectionPoints: {
                "in": { x: 50, y: 0 },
                "out": { x: 50, y: 100 }
            }
        },
        defaults: {
            properties: {
                "Current Rating": "63 A",
                "Voltage": "415V TPN",
                "Company": "Havells"
            },
            accessories: [
                { "endbox_required": "false", "number_of_endbox": "2" }
            ]
        },
        requiresBackendInit: true
    },
    {
        name: "Change Over Switch",
        category: "switch",
        geometry: {
            size: { width: 100, height: 100 },
            connectionPoints: {
                "in1": { x: 31, y: 0 },
                "in2": { x: 85, y: 0 },
                "out": { x: 58, y: 100 }
            }
        },
        defaults: {
            properties: {
                "Current Rating": "63 A",
                "Voltage": "415V TPN",
                "Company": "Havells"
            }
        },
        requiresBackendInit: true
    }
];

// ============================================================================
// ITEM RULES - Distribution Boards
// ============================================================================

const DISTRIBUTION_ITEMS: ItemRule[] = [
    {
        name: "VTPN",
        category: "distribution",
        geometry: {
            // Dynamic - calculated by GeometryCalculator based on Way
            size: { width: 120, height: 150 },
            connectionPoints: {
                "in": { x: 60, y: 0 },
                "out": { x: 60, y: 150 }
            }
        },
        defaults: {
            properties: {
                "Way": "4",
                "Company": "Havells"
            }
        },
        requiresBackendInit: true,
        defaultWay: "4"
    },
    {
        name: "HTPN",
        category: "distribution",
        geometry: {
            // Dynamic - calculated by GeometryCalculator based on Way
            size: { width: 150, height: 120 },
            connectionPoints: {
                "in": { x: 75, y: 0 },
                "out": { x: 75, y: 120 }
            }
        },
        defaults: {
            properties: {
                "Way": "4",
                "Company": "Havells"
            }
        },
        requiresBackendInit: true,
        defaultWay: "4"
    },
    {
        name: "SPN DB",
        category: "distribution",
        geometry: {
            // Dynamic - calculated by GeometryCalculator based on Way
            size: { width: 100, height: 100 },
            connectionPoints: {
                "in": { x: 50, y: 0 }
            }
        },
        defaults: {
            properties: {
                "Way": "2+4",
                "Company": "Havells"
            }
        },
        requiresBackendInit: true,
        defaultWay: "2+4"
    },
    {
        name: "Busbar Chamber",
        category: "distribution",
        geometry: {
            // Dynamic - calculated by GeometryCalculator based on Length
            size: { width: 360, height: 150 },
            connectionPoints: {
                "in": { x: 180, y: 0 },
                "out1": { x: 30, y: 150 },
                "out2": { x: 90, y: 150 },
                "out3": { x: 150, y: 150 },
                "out4": { x: 210, y: 150 },
                "out5": { x: 270, y: 150 },
                "out6": { x: 330, y: 150 }
            }
        },
        defaults: {
            properties: {
                "Length": "1",
                "Company": "Havells"
            }
        },
        requiresBackendInit: true
    }
];

// ============================================================================
// ITEM RULES - Connector/Junction Points
// ============================================================================

const CONNECTOR_POINT_ITEMS: ItemRule[] = [
    {
        name: "Point Switch Board",
        category: "connector_point",
        geometry: {
            size: { width: 200, height: 120 },
            connectionPoints: {
                "in": { x: 100, y: 0 },
                "out1": { x: 4, y: 120 },
                "out2": { x: 28, y: 120 },
                "out3": { x: 52, y: 120 },
                "out4": { x: 76, y: 120 },
                "out5": { x: 100, y: 120 },
                "out6": { x: 124, y: 120 },
                "out7": { x: 148, y: 120 },
                "out8": { x: 172, y: 120 },
                "out9": { x: 196, y: 120 }
            }
        },
        defaults: {
            properties: {
                "Avg. Run": "10 M",
                "Type": "Lighting"
            },
            accessories: [
                { "orboard_required": "false", "number_of_onboard": "1" }
            ]
        },
        requiresBackendInit: true
    },
    {
        name: "Avg. 5A Switch Board",
        category: "connector_point",
        geometry: {
            size: { width: 100, height: 100 },
            connectionPoints: {
                "in": { x: 50, y: 0 }
            }
        },
        defaults: {
            properties: {
                "Avg. Run": "10 M",
                "Type": "Power"
            }
        }
    }
];

// ============================================================================
// ITEM RULES - Other Items
// ============================================================================

const OTHER_ITEMS: ItemRule[] = [
    {
        name: "Portal",
        category: "other",
        geometry: {
            size: { width: 60, height: 40 },
            connectionPoints: {
                "port": { x: 60, y: 20 }
            }
        },
        defaults: {
            properties: {
                "NetId": "",
                "Label": "",
                "Direction": "out"
            }
        }
    },
    {
        name: "LT Cubical Panel",
        category: "distribution",
        geometry: {
            size: { width: 300, height: 200 }, // Default size, will be dynamic
            connectionPoints: {}
        },
        defaults: {
            properties: {
                "Orientation": "Vertical",
                "Cable Alley": "Both",
                "Incomer Count": "1",
                "Busbar Material": "Aluminium",
                "Bus Coupling": "None"
            }
        },
        requiresBackendInit: true
    },
    {
        name: "Text",
        category: "other",
        geometry: {
            size: { width: 200, height: 50 },
            connectionPoints: {}
        },
        defaults: {
            properties: {
                "Text": "Text",
                "FontSize": "14",
                "FontFamily": "Arial",
                "Color": "#000000",
                "Align": "left"
            }
        }
    }
];

// ============================================================================
// CONNECTOR RULES
// ============================================================================

const CONNECTOR_RULES: ConnectorRule[] = [
    {
        materialType: "Cable",
        defaults: {
            properties: {
                "Conductor": "Aluminium",
                "Armoured": "Armoured",
                "Core": "2 Core",
                "Size": "4 sq.mm.",
                "Company": "KEI"
            },
            laying: {},
            accessories: []
        }
    },
    {
        materialType: "Wiring",
        defaults: {
            properties: {
                "Conductor": "Copper",
                "Type": "FR",
                "Size": "1.5 sq.mm.",
                "Company": "Finolex"
            },
            laying: {},
            accessories: []
        }
    }
];

// ============================================================================
// DEFAULT RULES REGISTRY
// ============================================================================

/**
 * Registry of all item rules, indexed by name
 */
const ITEM_RULES_MAP: Map<string, ItemRule> = new Map();

// Register all item rules
const ALL_ITEM_RULES = [
    ...LOAD_ITEMS,
    ...SOURCE_ITEMS,
    ...SWITCH_ITEMS,
    ...DISTRIBUTION_ITEMS,
    ...CONNECTOR_POINT_ITEMS,
    ...OTHER_ITEMS
];

ALL_ITEM_RULES.forEach(rule => {
    ITEM_RULES_MAP.set(rule.name, rule);
});

/**
 * Registry of connector rules, indexed by material type
 */
const CONNECTOR_RULES_MAP: Map<string, ConnectorRule> = new Map();

CONNECTOR_RULES.forEach(rule => {
    CONNECTOR_RULES_MAP.set(rule.materialType, rule);
});

// ============================================================================
// PUBLIC API - DefaultRulesEngine
// ============================================================================

/**
 * Centralized Default Rules Engine
 * 
 * Provides access to all default rules for items and connectors.
 * Use this class to get geometry, properties, and other defaults.
 */
export class DefaultRulesEngine {
    /**
     * Get the complete rule for an item by name
     */
    static getItemRule(name: string): ItemRule | undefined {
        return ITEM_RULES_MAP.get(name);
    }

    /**
     * Get geometry (size and connection points) for an item
     */
    static getItemGeometry(name: string): ItemGeometry | undefined {
        const rule = ITEM_RULES_MAP.get(name);
        return rule?.geometry;
    }

    /**
     * Get default properties for an item
     */
    static getItemDefaults(name: string): ItemPropertyDefaults | undefined {
        const rule = ITEM_RULES_MAP.get(name);
        return rule?.defaults;
    }

    /**
     * Check if an item requires backend initialization (API call)
     */
    static requiresBackendInit(name: string): boolean {
        const rule = ITEM_RULES_MAP.get(name);
        return rule?.requiresBackendInit ?? false;
    }

    /**
     * Get default Way value for distribution boards
     */
    static getDefaultWay(name: string): string | undefined {
        const rule = ITEM_RULES_MAP.get(name);
        return rule?.defaultWay;
    }

    /**
     * Get the complete rule for a connector by material type
     */
    static getConnectorRule(materialType: string): ConnectorRule | undefined {
        return CONNECTOR_RULES_MAP.get(materialType);
    }

    /**
     * Get default properties for a connector
     */
    static getConnectorDefaults(materialType: string): ConnectorRule['defaults'] | undefined {
        const rule = CONNECTOR_RULES_MAP.get(materialType);
        return rule?.defaults;
    }

    /**
     * Get all item names that have rules defined
     */
    static getAllItemNames(): string[] {
        return Array.from(ITEM_RULES_MAP.keys());
    }

    /**
     * Get all items of a specific category
     */
    static getItemsByCategory(category: ItemRule['category']): ItemRule[] {
        return ALL_ITEM_RULES.filter(rule => rule.category === category);
    }

    /**
     * Check if an item is a load item (for power calculations)
     */
    static isLoadItem(name: string): boolean {
        const rule = ITEM_RULES_MAP.get(name);
        return rule?.category === 'load';
    }

    /**
     * Register a new item rule (for runtime extensions)
     */
    static registerItemRule(rule: ItemRule): void {
        ITEM_RULES_MAP.set(rule.name, rule);
    }

    /**
     * Register a new connector rule (for runtime extensions)
     */
    static registerConnectorRule(rule: ConnectorRule): void {
        CONNECTOR_RULES_MAP.set(rule.materialType, rule);
    }

    // ========================================================================
    // PHASE TYPE AND DYNAMIC CONNECTOR CONFIGURATION
    // ========================================================================

    /**
     * Items that are excluded from automatic core/wire calculation
     * (Point Switch Board and Avg. 5A Switch Board use fixed wiring)
     */
    private static readonly EXCLUDED_FROM_PHASE_LOGIC = [
        "Point Switch Board",
        "Avg. 5A Switch Board"
    ];

    /**
     * Three-phase items - require 3.5/4 Core cables or 3-wire phase configuration
     */
    private static readonly THREE_PHASE_ITEMS = [
        "VTPN",
        "HTPN",
        "Source",  // Source is typically 3-phase
        "LT Cubical Panel"
    ];

    /**
     * Three-phase switch types (based on voltage property "415V TPN" or "415V FP")
     */
    private static readonly THREE_PHASE_SWITCH_VOLTAGES = [
        "415V TPN",
        "415V FP"
    ];

    /**
     * Single-phase items - require 2 Core cables or 2-wire phase configuration
     */
    private static readonly SINGLE_PHASE_ITEMS = [
        "SPN DB"
    ];

    /**
     * Single-phase switch types (based on voltage property "230V DP")
     */
    private static readonly SINGLE_PHASE_SWITCH_VOLTAGES = [
        "230V DP"
    ];

    /**
     * Determines if an item should be excluded from phase-based connector logic
     */
    static isExcludedFromPhaseLogic(itemName: string): boolean {
        return this.EXCLUDED_FROM_PHASE_LOGIC.includes(itemName);
    }

    /**
     * Determines the phase type of an item based on its name and properties
     * @param itemName - The name of the item
     * @param itemProperties - The item's properties (optional, used to check voltage)
     * @returns 'three-phase' | 'single-phase' | 'unknown'
     */
    static getItemPhaseType(
        itemName: string,
        itemProperties?: Record<string, string>
    ): 'three-phase' | 'single-phase' | 'unknown' {
        // Check if item is excluded
        if (this.isExcludedFromPhaseLogic(itemName)) {
            return 'unknown';
        }

        // Check explicit three-phase items
        if (this.THREE_PHASE_ITEMS.includes(itemName)) {
            return 'three-phase';
        }

        // Check explicit single-phase items
        if (this.SINGLE_PHASE_ITEMS.includes(itemName)) {
            return 'single-phase';
        }

        // Check switch items by their voltage property
        if (itemProperties) {
            const voltage = itemProperties["Voltage"] || "";

            // Check for TPN/FP (three-phase)
            if (this.THREE_PHASE_SWITCH_VOLTAGES.some(v => voltage.includes(v.replace("415V ", "")))) {
                return 'three-phase';
            }

            // Check for DP (single-phase)
            if (this.SINGLE_PHASE_SWITCH_VOLTAGES.some(v => voltage.includes(v.replace("230V ", "")))) {
                return 'single-phase';
            }
        }

        // Load items are typically single-phase
        const rule = ITEM_RULES_MAP.get(itemName);
        if (rule?.category === 'load') {
            return 'single-phase';
        }

        // Check switch voltage in defaults
        if (rule?.category === 'switch' && rule.defaults.properties["Voltage"]) {
            const defaultVoltage = rule.defaults.properties["Voltage"];
            if (defaultVoltage.includes("TPN") || defaultVoltage.includes("FP")) {
                return 'three-phase';
            }
            if (defaultVoltage.includes("DP")) {
                return 'single-phase';
            }
        }

        return 'unknown';
    }

    /**
     * Gets the appropriate cable core configuration based on downstream item
     * @param targetItemName - Name of the downstream (target) item
     * @param targetProperties - Properties of the target item (optional)
     * @returns Core specification string (e.g., "4 Core", "2 Core")
     * 
     * Valid Core values from database: "1 Core", "2 Core", "3 Core", "3.5 Core", "4 Core", "5 Core"
     */
    static getCableCoreForTarget(
        targetItemName: string,
        targetProperties?: Record<string, string>
    ): string {
        // Excluded items use default 2 Core
        if (this.isExcludedFromPhaseLogic(targetItemName)) {
            return "2 Core";
        }

        const phaseType = this.getItemPhaseType(targetItemName, targetProperties);

        if (phaseType === 'three-phase') {
            return "4 Core";  // 4 Core for 3-phase (R, Y, B, N)
        }

        // Default to 2 Core for single-phase or unknown
        return "2 Core";
    }

    /**
     * Gets the appropriate wiring Conductor Size based on downstream item
     * Uses database-compatible format from Schedule.xlsx
     * 
     * Database format examples:
     * - Single-phase: "2 x 1.5 sq.mm" (2 wires: phase + neutral)
     *                 "2 x 1.5 + 1 x 1.5 sq.mm" (2 phase/neutral + 1 earth)
     * - Three-phase:  "3 x 1.5 + 2 x 1.5 sq.mm" (3 phase + 2 neutral/earth)
     * 
     * @param targetItemName - Name of the downstream (target) item
     * @param targetProperties - Properties of the target item (optional)
     * @returns Object with wire configuration info
     */
    static getWiringConfigForTarget(
        targetItemName: string,
        targetProperties?: Record<string, string>
    ): { phase: number; neutral: number; earth: number; description: string; conductorSize: string } {
        // Excluded items use default single-phase wiring
        if (this.isExcludedFromPhaseLogic(targetItemName)) {
            return {
                phase: 2,
                neutral: 0,
                earth: 1,
                description: "2 x wire (P+N) + 1 x wire (E)",
                conductorSize: "2 x 1.5 sq.mm"
            };
        }

        const phaseType = this.getItemPhaseType(targetItemName, targetProperties);

        if (phaseType === 'three-phase') {
            // Three-phase: 3 wires for phase + 2 for neutral/earth
            return {
                phase: 3,
                neutral: 2,
                earth: 0,  // Earth included in neutral count for 3-phase
                description: "3 x wire (R,Y,B) + 2 x wire (N+E)",
                conductorSize: "3 x 1.5 + 2 x 1.5 sq.mm"
            };
        }

        // Single-phase: 2 wires for phase + neutral, 1 for earth
        return {
            phase: 2,
            neutral: 0,  // Neutral included in phase count for single-phase
            earth: 1,
            description: "2 x wire (P+N) + 1 x wire (E)",
            conductorSize: "2 x 1.5 + 1 x 1.5 sq.mm"
        };
    }

    /**
     * Gets the default outgoing current rating threshold for distribution boards
     * The system should select the lowest available rating >= this threshold.
     */
    static getDefaultOutgoingThreshold(itemName: string): number {
        switch (itemName) {
            case "SPN DB":
                return 6;
            case "HTPN":
                return 10;
            case "VTPN":
                return 25;
            default:
                return 0;
        }
    }

    /**
     * Gets complete connector defaults with dynamic core/wire configuration
     * based on the target (downstream) item
     * @param materialType - 'Cable' or 'Wiring'
     * @param targetItemName - Name of the target item
     * @param targetProperties - Properties of the target item (optional)
     * @returns Connector defaults with appropriate core/wire configuration
     */
    static getConnectorDefaultsForTarget(
        materialType: 'Cable' | 'Wiring',
        targetItemName: string,
        targetProperties?: Record<string, string>
    ): ConnectorRule['defaults'] {
        // Get base defaults
        const baseDefaults = this.getConnectorDefaults(materialType);
        if (!baseDefaults) {
            return { properties: {}, laying: {}, accessories: [] };
        }

        // Clone the defaults to avoid mutating the original
        const result = {
            properties: { ...baseDefaults.properties },
            laying: { ...baseDefaults.laying },
            accessories: [...(baseDefaults.accessories || [])]
        };

        // Apply dynamic configuration based on target item
        if (materialType === 'Cable') {
            result.properties["Core"] = this.getCableCoreForTarget(targetItemName, targetProperties);
        } else if (materialType === 'Wiring') {
            const wiringConfig = this.getWiringConfigForTarget(targetItemName, targetProperties);
            // Use database-compatible Conductor Size format
            result.properties["Conductor Size"] = wiringConfig.conductorSize;
            result.properties["Wire Configuration"] = wiringConfig.description;
        }

        return result;
    }
}

// ============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// ============================================================================

/**
 * @deprecated Use DefaultRulesEngine.getItemDefaults() instead
 * This export is maintained for backward compatibility during migration
 */
export const LOAD_ITEM_DEFAULTS: Record<string, Record<string, string>> = {};
LOAD_ITEMS.forEach(item => {
    LOAD_ITEM_DEFAULTS[item.name] = item.defaults.properties;
});
// Also add switch items that had defaults in the old system
SWITCH_ITEMS.forEach(item => {
    LOAD_ITEM_DEFAULTS[item.name] = item.defaults.properties;
});
// Add Point Switch Board
const psb = CONNECTOR_POINT_ITEMS.find(i => i.name === "Point Switch Board");
if (psb) {
    LOAD_ITEM_DEFAULTS[psb.name] = psb.defaults.properties;
}

/**
 * @deprecated Use DefaultRulesEngine.getItemGeometry() instead
 * This export is maintained for backward compatibility during migration
 */
export const STATIC_ITEM_DEFINITIONS: Record<string, { size: Size, connectionPoints: Record<string, Point> }> = {};
ALL_ITEM_RULES.forEach(rule => {
    STATIC_ITEM_DEFINITIONS[rule.name] = {
        size: rule.geometry.size,
        connectionPoints: rule.geometry.connectionPoints
    };
});
// Add default fallback
STATIC_ITEM_DEFINITIONS["default"] = {
    size: { width: 60, height: 60 },
    connectionPoints: { "in": { x: 30, y: 0 } }
};

/**
 * @deprecated Use DefaultRulesEngine.getItemGeometry() instead
 */
export const getItemDefinition = (name: string) => {
    return STATIC_ITEM_DEFINITIONS[name] || STATIC_ITEM_DEFINITIONS["default"];
};
