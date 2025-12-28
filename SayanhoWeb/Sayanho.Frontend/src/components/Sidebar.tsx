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

const CATEGORIES: Record<string, string[]> = {
    "Distribution Boards": ["VTPN", "HTPN", "SPN DB", "LT Cubical Panel"],
    "Switchgear": ["Main Switch", "Change Over Switch"],
    "Appliances": ["AC Point", "Geyser Point", "Computer Point"],
    "Lighting": ["Light Point", "Tube Light", "Bulb"],
    "Fans": ["Ceiling Fan", "Exhaust Fan", "Ceiling Rose"],
    "Switch Boards": [
        "Point Switch Board",
        "Avg. 5A Switch Board", "2 Switch Board", "3 Switch Board", "4 Switch Board",
        "6 Switch Board", "8 Switch Board", "12 Switch Board", "18 Switch Board"
    ],
    "Sockets": ["5A Socket", "15A Socket", "5A Socket Board", "15A Socket Board"],
    "Infrastructure": ["Source", "Portal", "Generator"],
    "Meters": ["1 Phase Meter", "3 Phase Meter"],
    "Others": ["Bell", "Bell Push", "Call Bell Point"]
};

// Color styles for categories (Light Mode: Soft Background / Dark Mode: Translucent Background)
const CATEGORY_STYLES: Record<string, string> = {
    "Distribution Boards": "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200",
    "Switchgear": "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
    "Appliances": "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200",
    "Lighting": "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    "Fans": "bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200",
    "Switch Boards": "bg-slate-200 text-slate-900 dark:bg-slate-800/60 dark:text-slate-300",
    "Sockets": "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200",
    "Infrastructure": "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
    "Meters": "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
    "Others": "bg-pink-100 text-pink-900 dark:bg-pink-900/40 dark:text-pink-200"
};

const getItemCategory = (name: string): string => {
    for (const [category, items] of Object.entries(CATEGORIES)) {
        if (items.some(i => name.includes(i) || name === i)) {
            return category;
        }
    }
    return "Others";
};

export const Sidebar = () => {
    const { addItem, sheets, activeSheetId } = useStore();
    const currentSheet = sheets.find(s => s.sheetId === activeSheetId);
    const [items, setItems] = useState<ItemData[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedItem, setSelectedItem] = useState<string | null>(null);
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
        "Distribution Boards": true,
        "Switchgear": true,
        "Lighting": true,
        "Switch Boards": true,
        "Sockets": true,
        "Appliances": true,
        "Fans": true,
        "Infrastructure": true,
        "Meters": true,
        "Others": true
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
            newItem.alternativeCompany1 = props?.alternativeCompany1 || '';
            newItem.alternativeCompany2 = props?.alternativeCompany2 || '';
        } catch (err) {
            console.error('Failed to load properties', err);
            if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }
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

        // Apply local definitions for static items
        const staticDef = getItemDefinition(newItem.name);
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

            const result = calculateGeometry(newItem);
            if (result) {
                newItem.size = result.size;
                newItem.connectionPoints = result.connectionPoints;
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

    return (
        <div className="flex flex-col h-full select-none" style={{ backgroundColor: colors.panelBackground }}>
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
            <div className="flex-1 overflow-y-auto min-h-0 allow-scroll px-2 py-2">
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
        </div>
    );
};
