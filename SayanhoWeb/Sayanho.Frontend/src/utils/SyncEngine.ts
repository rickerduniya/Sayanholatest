// SyncEngine - Bi-directional synchronization between SLD and Layout views
// Automatically generates SLD diagram from Layout floor plan using upstream-to-downstream algorithm

import { CanvasItem, CanvasSheet, Connector } from '../types';
import {
    FloorPlan,
    LayoutComponent,
    Room,
    LayoutComponentType,
    LayoutConnection
} from '../types/layout';
import {
    LAYOUT_TO_SLD_MAP,
    SLD_TO_LAYOUT_MAP,
    getHierarchyLevel,
    compareHierarchy,
    COMPONENT_HIERARCHY
} from './ComponentMapping';
import { LAYOUT_COMPONENT_DEFINITIONS } from './LayoutComponentDefinitions';
import { api } from '../services/api';
import { getItemDefinition } from './ItemDefinitions';
import { updateItemVisuals } from './SvgUpdater';
import { calculateGeometry } from './GeometryCalculator';
import type { ItemData } from '../types';

type ItemPropertiesResult = Awaited<ReturnType<typeof api.getItemProperties>>;

const MAX_CONCURRENT_ITEM_GENERATIONS = 8;

let cachedItemCatalog: ItemData[] | null = null;
let itemCatalogRequest: Promise<ItemData[]> | null = null;
const itemPropertiesRequests = new Map<string, Promise<ItemPropertiesResult>>();
const iconContentRequests = new Map<string, Promise<string | undefined>>();

async function getItemCatalog(): Promise<ItemData[]> {
    if (cachedItemCatalog) return cachedItemCatalog;

    if (!itemCatalogRequest) {
        itemCatalogRequest = api.getItems()
            .then(items => {
                cachedItemCatalog = items;
                return items;
            })
            .catch(error => {
                itemCatalogRequest = null;
                throw error;
            });
    }

    return itemCatalogRequest;
}

function getCachedItemProperties(sldName: string): Promise<ItemPropertiesResult> {
    const existingRequest = itemPropertiesRequests.get(sldName);
    if (existingRequest) return existingRequest;

    const request = api.getItemProperties(sldName, 1).catch(error => {
        itemPropertiesRequests.delete(sldName);
        throw error;
    });

    itemPropertiesRequests.set(sldName, request);
    return request;
}

function getCachedIconContent(iconName: string): Promise<string | undefined> {
    const iconLeaf = iconName.split('/').pop() || iconName;
    const existingRequest = iconContentRequests.get(iconLeaf);
    if (existingRequest) return existingRequest;

    const request = fetch(encodeURI(api.getIconUrl(iconLeaf)))
        .then(response => response.ok ? response.text() : undefined)
        .catch(error => {
            iconContentRequests.delete(iconLeaf);
            throw error;
        });

    iconContentRequests.set(iconLeaf, request);
    return request;
}

async function resolveIconPathForSldName(sldName: string): Promise<string | undefined> {
    try {
        const items = await getItemCatalog();
        const match = items.find(i => i.name === sldName);
        return match?.iconPath;
    } catch {
        return undefined;
    }
}

// =============================================================================
// TYPES
// =============================================================================

export interface SyncState {
    // Mapping: layoutComponentId → sldItemId
    layoutToSld: Map<string, string>;
    // Mapping: sldItemId → layoutComponentId
    sldToLayout: Map<string, string>;
    // Last sync timestamp
    lastSyncTime: number;
}

export interface LoadSummary {
    lightingLoad: number;      // Watts
    powerLoad: number;         // Watts
    hvacLoad: number;          // Watts
    totalLoad: number;         // Watts
    componentCount: number;
    breakdown: Record<string, { count: number; watts: number }>;
}

export interface SldGenerationResult {
    items: CanvasItem[];
    connectors: Connector[];
    syncLinks: Map<string, string>;  // layoutId → sldId
    warnings: string[];
}

export interface SldGenerationOptions {
    // Items already staged or placed in SLD do not need to be recreated.
    existingSldItemIds?: ReadonlySet<string>;
}

export interface UpstreamGroup {
    dbComponent: LayoutComponent;
    connectedLoads: LayoutComponent[];
    room?: Room;
}

interface SldGenerationCandidate {
    layoutComponent: LayoutComponent;
    sldName: string;
    position: { x: number; y: number };
    hierarchyLevel: number;
}

async function mapWithConcurrency<T, R>(
    values: T[],
    mapper: (value: T) => Promise<R>,
    concurrency = MAX_CONCURRENT_ITEM_GENERATIONS
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            results[index] = await mapper(values[index]);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
    );

    return results;
}

// =============================================================================
// LOAD CALCULATION
// =============================================================================

/**
 * Calculate total electrical load for a room
 */
export function calculateRoomLoad(room: Room, components: LayoutComponent[]): LoadSummary {
    const roomComponents = components.filter(c => c.roomId === room.id);

    const breakdown: Record<string, { count: number; watts: number }> = {};
    let lightingLoad = 0;
    let powerLoad = 0;
    let hvacLoad = 0;

    for (const comp of roomComponents) {
        const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
        const watts = def.defaultWattage || 0;

        // Track breakdown
        if (!breakdown[comp.type]) {
            breakdown[comp.type] = { count: 0, watts: 0 };
        }
        breakdown[comp.type].count++;
        breakdown[comp.type].watts += watts;

        // Categorize load
        if (def.category === 'lighting') {
            lightingLoad += watts;
        } else if (def.category === 'appliances' || def.category === 'fans') {
            hvacLoad += watts;
        } else {
            powerLoad += watts;
        }
    }

    return {
        lightingLoad,
        powerLoad,
        hvacLoad,
        totalLoad: lightingLoad + powerLoad + hvacLoad,
        componentCount: roomComponents.length,
        breakdown
    };
}

/**
 * Calculate total load for entire floor plan
 */
export function calculateFloorPlanLoad(floorPlan: FloorPlan): LoadSummary {
    const paramProps = floorPlan.components.reduce((acc, comp) => {
        const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
        const watts = def?.defaultWattage || 0;

        if (def?.category === 'lighting') acc.lightingLoad += watts;
        else if (def?.category === 'appliances' || def?.category === 'fans') acc.hvacLoad += watts;
        else acc.powerLoad += watts;
        acc.totalLoad += watts;

        return acc;
    }, { lightingLoad: 0, powerLoad: 0, hvacLoad: 0, totalLoad: 0 });

    return {
        componentCount: floorPlan.components.length,
        breakdown: {},
        ...paramProps
    };
}

// =============================================================================
// UPSTREAM-TO-DOWNSTREAM SORTING
// =============================================================================

/**
 * Sort components from upstream (source) to downstream (loads)
 */
export function sortByHierarchy(components: LayoutComponent[]): LayoutComponent[] {
    return [...components].sort((a, b) => compareHierarchy(a.type, b.type));
}

/**
 * Group components by hierarchy level
 */
export function groupByHierarchy(components: LayoutComponent[]): Record<number, LayoutComponent[]> {
    const groups: Record<number, LayoutComponent[]> = {};

    for (const comp of components) {
        const level = getHierarchyLevel(comp.type);
        if (!groups[level]) groups[level] = [];
        groups[level].push(comp);
    }

    return groups;
}

/**
 * Find the upstream distribution board for a load component
 * Uses room assignment and proximity
 */
export function findUpstreamDB(load: LayoutComponent, floorPlan: FloorPlan): LayoutComponent | null {
    // First check if there's a DB in the same room
    if (load.roomId) {
        const roomDBs = floorPlan.components.filter(c =>
            c.roomId === load.roomId &&
            getHierarchyLevel(c.type) <= 4  // Distribution level or higher
        );
        if (roomDBs.length > 0) {
            // Return the lowest hierarchy level (most downstream) DB that's still upstream of load
            return roomDBs.sort((a, b) => getHierarchyLevel(b.type) - getHierarchyLevel(a.type))[0];
        }
    }

    // Find any sub-distribution (SPN DB, DB box) first
    const subDBs = floorPlan.components.filter(c =>
        COMPONENT_HIERARCHY.subDistribution.includes(c.type as any)
    );
    if (subDBs.length > 0) {
        // Find closest by position
        return findClosestComponent(load, subDBs);
    }

    // Fall back to main distribution
    const mainDBs = floorPlan.components.filter(c =>
        COMPONENT_HIERARCHY.mainDistribution.includes(c.type as any)
    );
    if (mainDBs.length > 0) {
        return mainDBs[0];
    }

    return null;
}

/**
 * Find closest component by position
 */
function findClosestComponent(target: LayoutComponent, candidates: LayoutComponent[]): LayoutComponent | null {
    if (candidates.length === 0) return null;

    let closest = candidates[0];
    let minDist = Number.MAX_VALUE;

    for (const cand of candidates) {
        const dist = Math.hypot(
            cand.position.x - target.position.x,
            cand.position.y - target.position.y
        );
        if (dist < minDist) {
            minDist = dist;
            closest = cand;
        }
    }

    return closest;
}

// =============================================================================
// SLD GENERATION FROM LAYOUT
// =============================================================================

/**
 * Generate SLD diagram from Layout floor plan
 * Uses upstream-to-downstream algorithm to create proper connections
 */
export async function generateSldFromLayout(
    floorPlan: FloorPlan,
    onProgress?: (msg: string) => void,
    options: SldGenerationOptions = {}
): Promise<SldGenerationResult> {
    const items: CanvasItem[] = [];
    const connectors: Connector[] = [];
    const syncLinks = new Map<string, string>();
    const warnings: string[] = [];

    // Group components by hierarchy level
    const hierarchyGroups = groupByHierarchy(floorPlan.components);
    const levels = Object.keys(hierarchyGroups).map(Number).sort((a, b) => a - b);

    // Layout positioning
    let currentY = 100;
    const xCenter = 400;
    const levelSpacing = 150;
    const itemSpacing = 120;

    const candidates: SldGenerationCandidate[] = [];

    // Build the work list synchronously so item setup can run concurrently.
    for (const level of levels) {
        const levelComponents = hierarchyGroups[level];
        let currentX = xCenter - ((levelComponents.length - 1) * itemSpacing) / 2;

        for (const layoutComp of levelComponents) {
            const sldName = LAYOUT_TO_SLD_MAP[layoutComp.type];
            if (!sldName) {
                // No SLD equivalent - skip but warn
                warnings.push(`No SLD equivalent for ${layoutComp.type}`);
                currentX += itemSpacing;
                continue;
            }

            const sldItemId = layoutComp.sldItemId ?? `sld_${layoutComp.id}`;
            if (options.existingSldItemIds?.has(sldItemId)) {
                // Preserve the link without rebuilding an item that is already
                // staged or placed in SLD.
                syncLinks.set(layoutComp.id, sldItemId);
                currentX += itemSpacing;
                continue;
            }

            candidates.push({
                layoutComponent: layoutComp,
                sldName,
                position: { x: currentX, y: currentY },
                hierarchyLevel: level
            });

            currentX += itemSpacing;
        }

        currentY += levelSpacing;
    }

    if (candidates.length === 0) {
        onProgress?.('SLD is already up to date');
        return { items, connectors, syncLinks, warnings };
    }

    // Fetch item defaults and SVGs in a bounded parallel pool. This avoids
    // one network round-trip per component while keeping the browser and API
    // responsive for very large layouts.
    let completed = 0;
    const generated = await mapWithConcurrency(candidates, async candidate => {
        try {
            const item = await createProperSldItem(
                candidate.sldName,
                candidate.layoutComponent,
                candidate.position
            );

            completed++;
            if (onProgress && (completed === candidates.length || completed % MAX_CONCURRENT_ITEM_GENERATIONS === 0)) {
                onProgress(`Syncing ${completed}/${candidates.length} items`);
            }

            return { candidate, item };
        } catch (error) {
            console.error(`Failed to create SLD item for ${candidate.layoutComponent.type}`, error);
            warnings.push(`Failed to create ${candidate.sldName}`);
            return { candidate, item: undefined };
        }
    });

    // Keep result ordering deterministic and build a complete lookup before
    // calculating connectors. The lookup is also used for stable sync links.
    const sldItemMap = new Map<string, CanvasItem>();
    for (const { candidate, item } of generated) {
        if (!item) continue;

        items.push(item);
        sldItemMap.set(candidate.layoutComponent.id, item);
        syncLinks.set(candidate.layoutComponent.id, item.uniqueID);
    }

    for (const { candidate, item } of generated) {
        if (!item || candidate.hierarchyLevel <= 0) continue;

        const upstreamDB = findUpstreamDB(candidate.layoutComponent, floorPlan);
        if (upstreamDB && sldItemMap.has(upstreamDB.id)) {
            const sourceItem = sldItemMap.get(upstreamDB.id)!;
            connectors.push(createConnector(sourceItem, item));
        }
    }

    // NOTE: Aggregation disabled to maintain 1:1 mapping between Layout and SLD items
    // Each Layout component should have its own SLD item for proper bi-directional sync
    // const aggregatedItems = aggregateSldItems(items, syncLinks);

    return {
        items: items,  // Return items directly without aggregation
        connectors,
        syncLinks: syncLinks,  // Keep original links
        warnings
    };
}

/**
 * Create a fully initialized SLD CanvasItem
 */
async function createProperSldItem(
    sldName: string,
    layoutComp: LayoutComponent,
    position: { x: number; y: number }
): Promise<CanvasItem> {
    // PHASE 1.4: Respect existing sldItemId to prevent ID churn during roundtrips
    // If layout component already has a linked SLD item ID, use it; otherwise generate a new stable ID
    const uniqueID = layoutComp.sldItemId ?? `sld_${layoutComp.id}`;

    // 1. Basic Item Structure
    const newItem: CanvasItem = {
        uniqueID,
        name: sldName,
        position,
        size: { width: 60, height: 60 },
        connectionPoints: { 'in': { x: 30, y: 0 }, 'out': { x: 30, y: 60 } }, // Defaults
        properties: [],
        alternativeCompany1: '',
        alternativeCompany2: '',
        svgContent: undefined,
        iconPath: undefined,
        locked: false,
        idPoints: {},
        incomer: {},
        outgoing: [],
        accessories: []
    };

    // 2. Fetch Properties & Defaults from API
    try {
        const props = await getCachedItemProperties(sldName);
        if (props?.properties && props.properties.length > 0) {
            newItem.properties = [props.properties[0]];
        }
        newItem.alternativeCompany1 = props?.alternativeCompany1 || '';
        newItem.alternativeCompany2 = props?.alternativeCompany2 || '';
    } catch (err) {
        console.warn(`[Sync] Property fetch failed for ${sldName}`);
        // Add basic property if API fails
        if (newItem.properties.length === 0) {
            newItem.properties = [{ 'Name': sldName }];
        }
    }

    // 3. Inject Layout Metadata
    newItem.properties[0] = {
        ...newItem.properties[0],
        'Quantity': '1',
        'Room': layoutComp.roomId || '',
        '_layoutComponentId': layoutComp.id,
        // Also store the reverse link if we have it, though usually syncLayoutToSld creates fresh items
        // unless we implementing update logic.
    };


    const resolvedIconPath = await resolveIconPathForSldName(sldName);
    const iconName = resolvedIconPath || `${sldName}.svg`;
    try {
        const svgContent = await getCachedIconContent(iconName);
        if (svgContent) {
            newItem.svgContent = svgContent;
            newItem.iconPath = iconName;
        }
    } catch {
    }

    // 5. Apply Static Definitions (Size, Connection Points)
    const staticDef = getItemDefinition(sldName);
    if (staticDef) {
        newItem.size = staticDef.size;
        newItem.connectionPoints = staticDef.connectionPoints;
    }

    // 6. DB Initialization (Important for sizing and rendering)
    if (["HTPN", "VTPN", "SPN DB", "Main Switch", "Change Over Switch", "Point Switch Board", "Avg. 5A Switch Board", "Busbar Chamber"].includes(sldName)) {
        // Initialize logic...
        try {
            // Basic DB init
            const initData = await api.initializeItem(sldName, newItem.properties);
            if (initData) {
                if (initData.incomer) newItem.incomer = initData.incomer;
                if (initData.outgoing) newItem.outgoing = initData.outgoing;
                if (initData.accessories) newItem.accessories = initData.accessories;
            }

            // Recalculate geometry
            const geometry = calculateGeometry(newItem);
            if (geometry) {
                newItem.size = geometry.size;
                newItem.connectionPoints = geometry.connectionPoints;
            }

            // Update visuals if SVG content exists
            if (newItem.svgContent) {
                const updatedSvg = updateItemVisuals(newItem);
                if (updatedSvg) newItem.svgContent = updatedSvg;
            }
        } catch (err) {
            console.error(`[Sync] DB Init failed for ${sldName}`, err);
        }
    }

    return newItem;
}

/**
 * Create a connector between two SLD items
 */
function createConnector(source: CanvasItem, target: CanvasItem): Connector {
    return {
        sourceItem: source,
        sourcePointKey: 'out',
        targetItem: target,
        targetPointKey: 'in',
        materialType: 'Wiring',
        properties: {},
        length: 1
    };
}

/**
 * Aggregate SLD items of the same type (e.g., multiple Bulbs → quantity)
 */
function aggregateSldItems(
    items: CanvasItem[],
    syncLinks: Map<string, string>
): { items: CanvasItem[]; syncLinks: Map<string, string> } {
    // Group by name and room
    const groups = new Map<string, CanvasItem[]>();

    for (const item of items) {
        const prop = item.properties[0] || {};
        const room = prop['Room'] || 'unassigned';
        const key = `${item.name}__${room}`;

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(item);
    }

    const aggregated: CanvasItem[] = [];
    const newSyncLinks = new Map<string, string>();

    for (const [_, groupItems] of groups) {
        if (groupItems.length === 1) {
            // No aggregation needed
            aggregated.push(groupItems[0]);
            // Keep sync links
            for (const [layoutId, sldId] of syncLinks) {
                if (sldId === groupItems[0].uniqueID) {
                    newSyncLinks.set(layoutId, sldId);
                }
            }
        } else {
            // Aggregate: keep first item, update quantity
            const primary = { ...groupItems[0] };
            // Deep copy properties to avoid reference issues
            primary.properties = [{ ...primary.properties[0] }];

            primary.properties[0]['Quantity'] = String(groupItems.length);

            aggregated.push(primary);

            // Link all layout components to the aggregated SLD item
            for (const item of groupItems) {
                const p = item.properties[0] || {};
                const layoutId = p['_layoutComponentId'];
                if (layoutId) {
                    newSyncLinks.set(layoutId, primary.uniqueID);
                }
            }
        }
    }

    return { items: aggregated, syncLinks: newSyncLinks };
}

// ... existing sync helpers (countComponentsByType, etc) ...

// =============================================================================
// SYNC ENGINE CLASS
// =============================================================================

export class SyncEngine {
    private state: SyncState = {
        layoutToSld: new Map(),
        sldToLayout: new Map(),
        lastSyncTime: 0
    };

    /**
     * Synchronize layout to SLD (Async)
     * Generates SLD diagram from layout floor plan
     */
    async syncLayoutToSld(
        floorPlan: FloorPlan,
        onProgress?: (msg: string) => void,
        options?: SldGenerationOptions
    ): Promise<SldGenerationResult> {
        const result = await generateSldFromLayout(floorPlan, onProgress, options);

        // Update state
        this.state.layoutToSld = result.syncLinks;
        this.state.sldToLayout = new Map(
            Array.from(result.syncLinks.entries()).map(([k, v]) => [v, k])
        );
        this.state.lastSyncTime = Date.now();

        return result;
    }

    /**
     * Synchronize SLD to Layout
     * Identifies items in SLD that are NOT in Layout and returns them as staging components
     */
    syncSldToLayout(
        floorPlan: FloorPlan,
        sldItems: CanvasItem[]
    ): LayoutComponent[] {
        const stagingItems: LayoutComponent[] = [];

        // 1. Build map of existing layout components that are linked
        // We look for the custom property '_layoutComponentId' in SLD items
        // OR we check if any layout component refers to this SLD ID (which is harder if link is one-way)
        // Ideally, we rely on the SLD item properties having the link.

        const linkedLayoutIds = new Set<string>();
        // Also check actual layout components in case they have the sldItemId set (if we add that prop)
        floorPlan.components.forEach(c => {
            if (c.sldItemId) linkedLayoutIds.add(c.id); // If we added sldItemId to LayoutComponent
        });

        // 2. Iterate SLD items
        for (const item of sldItems) {
            // Skip non-component items
            if (item.name === 'Connector' || item.name === 'Text Box' || item.name === 'Note') continue;

            const props = item.properties[0] || {};
            const linkedLayoutId = props['_layoutComponentId'];

            // If it has a link and that link exists in the current plan, it's placed.
            if (linkedLayoutId && floorPlan.components.some(c => c.id === linkedLayoutId)) {
                continue;
            }

            // Check if it's already in staging? (Handled by caller usually, but good to check uniqueID)

            // It's unplaced. Map to Layout Component.
            const layoutType = this.findLayoutTypeForSld(item.name);
            if (!layoutType) {
                // console.warn(`No layout equivalent for SLD item: ${item.name}`);
                continue;
            }

            // PHASE 1.3: Use canonical _layoutComponentId instead of temporary staging_* IDs
            // This prevents ID churn during Layout → SLD → Layout roundtrips
            // The SLD item MUST have a _layoutComponentId (ensured by Phase 1.1)
            const canonicalLayoutId = linkedLayoutId || `comp_${crypto.randomUUID()}`;

            // Since aggregation is disabled, quantity should be 1
            // But handle legacy data gracefully
            const quantity = parseInt(props['Quantity'] || '1', 10);

            for (let i = 0; i < quantity; i++) {
                // Use the canonical Layout ID from SLD properties
                // For quantity > 1, only the first gets the canonical ID; rest get unique IDs
                const layoutId = i === 0 ? canonicalLayoutId : `${canonicalLayoutId}_${i}`;

                const comp: LayoutComponent = {
                    id: layoutId, // Use canonical ID, not staging_*
                    type: layoutType,
                    position: { x: 0, y: 0 }, // Will be set on drop
                    rotation: 0,
                    properties: {
                        ...props,
                        name: item.name // Ensure name is preserved
                    },
                    sldItemId: item.uniqueID // Link back to SLD item
                };
                stagingItems.push(comp);
            }
        }

        return stagingItems;
    }

    /**
     * Find LayoutComponentType from SLD item name
     */
    private findLayoutTypeForSld(sldName: string): LayoutComponentType | null {
        // Use the robust SLD->Layout map which handles aliases (e.g. Bell, Call Bell Point)
        const candidates = SLD_TO_LAYOUT_MAP[sldName];
        if (candidates && candidates.length > 0) {
            return candidates[0]; // Return the primary mapping
        }

        // Fallback: try reverse lookup in LAYOUT_TO_SLD_MAP (though SLD_TO_LAYOUT_MAP should cover it)
        for (const [type, name] of Object.entries(LAYOUT_TO_SLD_MAP)) {
            if (name === sldName) return type as LayoutComponentType;
        }
        return null;
    }

    // ... existing getters (getSldIdForLayout, etc) ...

    /**
     * Get SLD item ID linked to a layout component
     */
    getSldIdForLayout(layoutComponentId: string): string | undefined {
        return this.state.layoutToSld.get(layoutComponentId);
    }

    /**
     * Get layout component ID linked to an SLD item
     */
    getLayoutIdForSld(sldItemId: string): string | undefined {
        return this.state.sldToLayout.get(sldItemId);
    }

    /**
     * Get current sync state
     */
    getState(): SyncState {
        return { ...this.state };
    }

    /**
     * Clear all sync links
     */
    reset(): void {
        this.state = {
            layoutToSld: new Map(),
            sldToLayout: new Map(),
            lastSyncTime: 0
        };
    }
}

// Export singleton instance
export const syncEngine = new SyncEngine();
