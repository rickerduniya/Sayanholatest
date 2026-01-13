import React, { useState, useEffect, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../services/api';
import { useTheme } from '../context/ThemeContext';
import { ItemData, CanvasItem } from '../types';
import { getItemDefinition, LOAD_ITEM_DEFAULTS, DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { sortOptionStringsAsc } from '../utils/sortUtils';
import { fetchProperties } from '../utils/api';
import { CacheService } from '../services/CacheService';

import { UNIFIED_ITEM_CATEGORIES } from '../utils/UnifiedDefinition';

const CATEGORIES: Record<string, string[]> = Object.fromEntries(
    UNIFIED_ITEM_CATEGORIES.map(c => [c.label, c.sldItems])
);

// Color styles for categories
const CATEGORY_STYLES: Record<string, string> = Object.fromEntries(
    UNIFIED_ITEM_CATEGORIES.filter(c => c.styleClass).map(c => [c.label, c.styleClass!])
);

const getItemCategory = (name: string): string => {
    for (const [category, items] of Object.entries(CATEGORIES)) {
        if (items.some(i => name.includes(i) || name === i)) {
            return category;
        }
    }
    return "Others";
};

export const Sidebar = () => {
    const { addItem, sheets, activeSheetId, stagingItems, removeStagingItem } = useStore();
    const currentSheet = sheets.find(s => s.sheetId === activeSheetId);
    const placedIds = useMemo(() => new Set(sheets.flatMap(s => s.canvasItems).map(i => i.uniqueID)), [sheets]);
    const visibleStagingItems = useMemo(() => stagingItems.filter(i => !placedIds.has(i.uniqueID)), [stagingItems, placedIds]);
    const [items, setItems] = useState<ItemData[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedItem, setSelectedItem] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'library' | 'unplaced'>('library');
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
        return Object.fromEntries(UNIFIED_ITEM_CATEGORIES.map(c => [c.label, true]));
    });

    const { colors } = useTheme();

    useEffect(() => {
        const fetchItems = async () => {
            try {
                const fetchedItems = await api.getItems();
                setItems(fetchedItems);
            } catch (error) {
                console.error('Failed to fetch items:', error);
            }
        };
        fetchItems();
    }, []);

    const groupedItems = useMemo(() => {
        const groups: Record<string, ItemData[]> = {};

        // Ensure all categories exist in order
        Object.keys(CATEGORIES).forEach(key => groups[key] = []);

        items.forEach(item => {
            if (searchQuery && !item.name.toLowerCase().includes(searchQuery.toLowerCase())) {
                return;
            }
            const category = getItemCategory(item.name);
            if (!groups[category]) groups[category] = [];
            groups[category].push(item);
        });

        // Remove empty groups
        Object.keys(groups).forEach(key => {
            if (groups[key].length === 0) delete groups[key];
        });

        return groups;
    }, [items, searchQuery]);

    const handleDragStart = (e: React.DragEvent, itemName: string) => {
        const item = items.find(i => i.name === itemName);
        if (item) {
            e.dataTransfer.setData('application/json', JSON.stringify(item));
            e.dataTransfer.effectAllowed = 'move';
        }
    };

    const handleAddClick = async () => {
        if (!selectedItem || !currentSheet) return;

        const itemData = items.find(i => i.name === selectedItem);
        if (!itemData) return;

        // Create new item at fixed position (300, 300)
        const newItem: CanvasItem = {
            uniqueID: crypto.randomUUID(),
            name: itemData.name,
            position: { x: 300, y: 300 },
            size: itemData.size,
            connectionPoints: itemData.connectionPoints,
            properties: [],
            alternativeCompany1: '',
            alternativeCompany2: '',
            svgContent: undefined,
            iconPath: itemData.iconPath,
            locked: false,
            idPoints: {},
            incomer: {},
            outgoing: [],
            accessories: []
        };

        try {
            // Fetch properties
            const props = await api.getItemProperties(itemData.name, 1);
            if (props?.properties && props.properties.length > 0) {
                newItem.properties = [props.properties[0]];
            } else if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }

            // Apply defaults from ITEM_DEFAULTS
            const defaults = LOAD_ITEM_DEFAULTS[newItem.name];
            if (defaults) {
                newItem.properties[0] = { ...defaults, ...newItem.properties[0] };
            }

            // Geometry Calculation based on properties
            // Some items have dynamic size based on Way/Pole/Rating
            // We need to ensure properties are set before geometry calc

            // Initialize Geometry for known types
            const definition = getItemDefinition(newItem.name);
            let staticDef = null;
            if (!definition) {
                // Try to find static definition if possible
            } else {
                staticDef = definition;
            }

            if (staticDef && !["HTPN", "VTPN", "SPN DB"].includes(newItem.name)) {
                newItem.size = staticDef.size;
                newItem.connectionPoints = staticDef.connectionPoints;
            }

            // Initialize Distribution Boards (Way-based)
            if (["HTPN", "VTPN", "SPN DB"].includes(newItem.name)) {
                if (!newItem.properties[0]) newItem.properties[0] = {};
                let wayVal = newItem.properties[0]["Way"];
                if (!wayVal || wayVal.includes(',')) {
                    if (newItem.name === "SPN DB") wayVal = "2+4";
                    else wayVal = "4";
                }
                newItem.properties[0]["Way"] = wayVal;

                // Backend initialization populates outgoing/incomer/accessories
                try {
                    const initData = await api.initializeItem(newItem.name, newItem.properties);
                    if (initData) {
                        if (initData.incomer) newItem.incomer = initData.incomer;
                        if (initData.outgoing) newItem.outgoing = initData.outgoing;
                        if (initData.accessories) newItem.accessories = initData.accessories;
                    }
                } catch (err) {
                    console.error(`[Sidebar] Failed to initialize item accessories:`, err);
                }

                // Ensure outgoing defaults (minimum >= threshold) for newly generated outgoings
                const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(newItem.name);
                if (threshold > 0 && newItem.outgoing && newItem.outgoing.length > 0) {
                    const parseRating = (s: string) => {
                        const m = (s || '').toString().match(/(\d+(?:\.\d+)?)/);
                        return m ? parseFloat(m[1]) : NaN;
                    };

                    let defaultRating = "";
                    try {
                        const pole = newItem.name === "VTPN" ? "TP" : "SP";
                        const mcb = await fetchProperties("MCB");

                        const allRatings = sortOptionStringsAsc(
                            Array.from(new Set(
                                (mcb.properties || [])
                                    .map(p => p["Current Rating"])
                                    .filter(Boolean)
                            ))
                        );

                        const poleRatingsRaw = (mcb.properties || [])
                            .filter(p => {
                                const pPole = (p["Pole"] || "").toString();
                                if (!pPole) return false;
                                return pPole === pole || pPole.includes(pole);
                            })
                            .map(p => p["Current Rating"])
                            .filter(Boolean);
                        const poleRatings = sortOptionStringsAsc(Array.from(new Set(poleRatingsRaw)));
                        const ratings = poleRatings.length > 0 ? poleRatings : allRatings;

                        defaultRating = ratings.find(r => {
                            const v = parseRating(r);
                            return Number.isFinite(v) && v >= threshold;
                        }) || ratings[0] || "";
                    } catch (e) {
                        console.error('[Sidebar] Failed to fetch outgoing rating options for defaults', e);
                    }

                    if (defaultRating) {
                        newItem.outgoing = newItem.outgoing.map(o => ({ ...(o || {}), "Current Rating": defaultRating }));
                    }
                }
            }

            const result = calculateGeometry(newItem);
            if (result) {
                newItem.size = result.size;
                newItem.connectionPoints = result.connectionPoints;
            }
        } catch (error) {
            console.error('[Sidebar] Error initializing item props:', error);
        }

        // Fetch SVG Content (with caching using item name as key)
        if (itemData.iconPath) {
            try {
                const iconName = itemData.iconPath.split('/').pop();
                // Use item name as cache key for consistency
                const cacheKey = CacheService.generateKey('sidebar_svg', { name: itemData.name });
                const cachedSvg = CacheService.get<string>(cacheKey);

                if (cachedSvg) {
                    console.log('[Sidebar] ✓ Cache HIT for', itemData.name);
                    newItem.svgContent = cachedSvg;
                } else {
                    console.log('[Sidebar] Cache MISS for', itemData.name, '- fetching...');
                    const url = api.getIconUrl(iconName!);
                    const encodedUrl = encodeURI(url);
                    const response = await fetch(encodedUrl);
                    if (response.ok) {
                        const svgText = await response.text();
                        CacheService.set(cacheKey, svgText);
                        console.log('[Sidebar] ✓ Cached SVG for', itemData.name);
                        newItem.svgContent = svgText;
                    }
                }
            } catch (e) {
                console.error("Failed to fetch SVG content", e);
            }
        }

        // Initialize LT Cubical Panel (uses Incomer Count and outgoing array)
        if (newItem.name === "LT Cubical Panel") {
            // Geometry will be calculated after backend initializes outgoing array
            const result = calculateGeometry(newItem);
            if (result) {
                newItem.size = result.size;
                newItem.connectionPoints = result.connectionPoints;
            }
        }

        // Update visuals if needed
        if (newItem.svgContent && newItem.properties[0]) {
            const updatedSvg = updateItemVisuals(newItem);
            if (updatedSvg) {
                newItem.svgContent = updatedSvg;
            }
        }

        // Add item to canvas
        addItem(newItem);
    };

    const toggleGroup = (group: string) => {
        setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
    };

    const handlePlaceStagingItem = (item: CanvasItem) => {
        // Place item at default position or allow drag?
        // For simplicity, we place at center view or 300,300, or just add logic.
        // We reuse handleAddClick logic partially or just direct add.
        // Staging items already have properties but might need geometry recalc?
        // Usually they are fully formed.

        // We set position to visible area (simulated)
        const itemToPlace = { ...item, x: 300, y: 300, uniqueID: crypto.randomUUID() }; // Generate new ID on placement or keep unique? 
        // Sync usually keeps ID if we want linked. But if we drag from staging, we are effectively 'placing' it.
        // Let's keep ID to maintain link to Layout if possible.
        // BUT if user wants multiple placements?
        // "Unplaced" implies moving FROM staging TO canvas.
        addItem({ ...item, position: { x: 300, y: 300 } });
        removeStagingItem(item.uniqueID);
    };

    return (
        <div className="flex flex-col h-full select-none" style={{ backgroundColor: colors.panelBackground }}>
            {/* Tabs */}
            <div className="flex border-b" style={{ borderColor: colors.border }}>
                <button
                    className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'library' ? 'border-b-2 border-blue-500' : 'opacity-60 hover:opacity-100'}`}
                    style={{ color: activeTab === 'library' ? colors.text : colors.text }}
                    onClick={() => setActiveTab('library')}
                >
                    Library
                </button>
                <button
                    className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === 'unplaced' ? 'border-b-2 border-blue-500' : 'opacity-60 hover:opacity-100'}`}
                    style={{ color: activeTab === 'unplaced' ? colors.text : colors.text }}
                    onClick={() => setActiveTab('unplaced')}
                >
                    Unplaced ({visibleStagingItems.length})
                </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto min-h-0 allow-scroll flex flex-col">
                {activeTab === 'library' ? (
                    <>
                        {/* Search Box */}
                        <div className="p-4 border-b" style={{ borderColor: colors.border }}>
                            <input
                                type="text"
                                placeholder="Search components..."
                                className="w-full px-3 py-2 text-sm rounded-lg bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500 dark:placeholder-gray-400"
                                style={{
                                    color: colors.text,
                                }}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        {/* Grouped Item List */}
                        <div className="flex-1 overflow-y-auto px-2 py-2">
                            {Object.keys(groupedItems).length === 0 ? (
                                <div className="text-center opacity-50 py-4 text-sm" style={{ color: colors.text }}>
                                    No items found
                                </div>
                            ) : (
                                Object.entries(groupedItems).map(([category, categoryItems]) => (
                                    <div key={category} className="mb-2">
                                        <button
                                            onClick={() => toggleGroup(category)}
                                            className={`
                                                flex items-center w-full px-2 py-1.5 mb-1 text-xs font-bold uppercase tracking-wider rounded-md transition-all
                                                ${CATEGORY_STYLES[category] || 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-200'}
                                                hover:brightness-95 dark:hover:brightness-110
                                            `}
                                        >
                                            {expandedGroups[category] ? <ChevronDown size={14} className="mr-1" /> : <ChevronRight size={14} className="mr-1" />}
                                            {category} ({categoryItems.length})
                                        </button>

                                        {expandedGroups[category] && (
                                            <div className="pl-1 space-y-1 animate-fade-in">
                                                {categoryItems.map((item) => (
                                                    <div
                                                        key={item.name}
                                                        className={`
                                                            px-3 py-2 text-sm cursor-grab active:cursor-grabbing select-none rounded-md transition-all
                                                            ${selectedItem === item.name ? 'bg-blue-500/20 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/50' : 'hover:bg-black/5 dark:hover:bg-white/5'}
                                                        `}
                                                        style={{ color: selectedItem === item.name ? undefined : colors.text }}
                                                        onClick={() => setSelectedItem(item.name)}
                                                        draggable
                                                        onDragStart={(e) => handleDragStart(e, item.name)}
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            {/* Optional: Add icon preview if available */}
                                                            <span>{item.name}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        {/* Bottom Buttons */}
                        <div className="p-4 mt-auto border-t" style={{ borderColor: colors.border }}>
                            <button
                                onClick={handleAddClick}
                                disabled={!selectedItem}
                                className={`
                                    w-full py-2.5 text-sm font-semibold text-white rounded-lg transition-all shadow-lg flex items-center justify-center gap-2
                                    ${!selectedItem ? 'bg-gray-400/50 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 hover:shadow-blue-500/30 active:scale-95'}
                                `}
                            >
                                Add Component
                            </button>
                        </div>
                    </>
                ) : (
                    // Unplaced Items Tab
                    <div className="flex-1 p-4 space-y-3">
                        {visibleStagingItems.length === 0 ? (
                            <div className="text-center py-10 opacity-50 text-sm" style={{ color: colors.text }}>
                                <div className="text-2xl mb-2">📥</div>
                                No unplaced items.<br />
                                Create items in Layout to see them here.
                            </div>
                        ) : (
                            visibleStagingItems.map(item => (
                                <div
                                    key={item.uniqueID}
                                    className="p-3 rounded-lg border flex items-center gap-3 bg-opacity-50 group hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-grab active:cursor-grabbing"
                                    style={{
                                        borderColor: colors.border,
                                        backgroundColor: colors.panelBackground,
                                        color: colors.text
                                    }}
                                    draggable
                                    onDragStart={(e) => {
                                        e.dataTransfer.setData('application/json', JSON.stringify({
                                            ...item,
                                            _isStagingItem: true
                                        }));
                                        e.dataTransfer.effectAllowed = 'move';
                                    }}
                                >
                                    <div className="w-8 h-8 flex-shrink-0 bg-white/10 rounded flex items-center justify-center">
                                        <div className="text-[10px] font-mono">{item.name.substring(0, 2)}</div>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium text-xs truncate">{item.name}</div>
                                        <div className="text-[10px] opacity-70 truncate">Drag to canvas</div>
                                    </div>
                                    <div className="text-xs opacity-40">⋮⋮</div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
