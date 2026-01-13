// Layout Sidebar - Enhanced component palette for electrical layout design
// Features: search, all SLD-equivalent components, categorized view, sync indicators

import React, { useState, useMemo } from 'react';
import { useLayoutStore } from '../store/useLayoutStore';
import { useTheme } from '../context/ThemeContext';
import {
    LAYOUT_COMPONENT_CATEGORIES,
    LAYOUT_COMPONENT_DEFINITIONS,
    searchComponents,
    getSortedCategories
} from '../utils/LayoutComponentDefinitions';
import { LayoutComponentType, LayoutComponentDef } from '../types/layout';
import { ChevronDown, ChevronRight, Search, Zap, Info } from 'lucide-react';

export const LayoutSidebar: React.FC = () => {
    const { theme, colors } = useTheme();
    const {
        setActiveTool,
        setSelectedComponentType,
        drawingState,
        getCurrentFloorPlan
    } = useLayoutStore();

    const [searchQuery, setSearchQuery] = useState('');
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
        new Set(['lighting', 'power', 'switches', 'distribution'])
    );
    const [hoveredComponent, setHoveredComponent] = useState<LayoutComponentType | null>(null);

    const currentPlan = getCurrentFloorPlan();

    // Get sorted categories
    const sortedCategories = useMemo(() => getSortedCategories(), []);

    // Search filtered components
    const filteredComponents = useMemo(() => {
        if (!searchQuery.trim()) return null;
        return searchComponents(searchQuery);
    }, [searchQuery]);

    // Count components on current floor plan by type
    const componentCounts = useMemo(() => {
        if (!currentPlan) return {};
        const counts: Record<string, number> = {};
        for (const comp of currentPlan.components) {
            counts[comp.type] = (counts[comp.type] || 0) + 1;
        }
        return counts;
    }, [currentPlan?.components]);

    const toggleCategory = (category: string) => {
        setExpandedCategories(prev => {
            const next = new Set(prev);
            if (next.has(category)) {
                next.delete(category);
            } else {
                next.add(category);
            }
            return next;
        });
    };

    const handleComponentClick = (type: LayoutComponentType) => {
        setActiveTool('component');
        setSelectedComponentType(type);
    };

    const isSelected = (type: LayoutComponentType) =>
        drawingState.activeTool === 'component' &&
        drawingState.selectedComponentType === type;

    // Enhanced category styling - matches SLD sidebar
    const CATEGORY_STYLES: Record<string, string> = {
        lighting: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
        power: 'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200',
        switches: 'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200',
        switchboards: 'bg-slate-200 text-slate-900 dark:bg-slate-700/60 dark:text-slate-200',
        hvac: 'bg-cyan-100 text-cyan-900 dark:bg-cyan-900/40 dark:text-cyan-200',
        distribution: 'bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200',
        switchgear: 'bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200',
        meters: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200',
        appliances: 'bg-pink-100 text-pink-900 dark:bg-pink-900/40 dark:text-pink-200',
        infrastructure: 'bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200',
        safety: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200'
    };

    // Render a single component button
    const renderComponentButton = (def: LayoutComponentDef) => {
        const selected = isSelected(def.type);
        const count = componentCounts[def.type] || 0;
        const isHovered = hoveredComponent === def.type;

        return (
            <button
                key={def.type}
                onClick={() => handleComponentClick(def.type)}
                onMouseEnter={() => setHoveredComponent(def.type)}
                onMouseLeave={() => setHoveredComponent(null)}
                className={`
                    w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs
                    transition-all duration-150 group relative
                    ${selected
                        ? 'bg-blue-500 text-white shadow-md'
                        : 'hover:bg-white/10'
                    }
                `}
                style={selected ? {} : { color: colors.text }}
                title={def.description}
            >
                {/* Symbol */}
                <span
                    className="w-7 h-7 flex items-center justify-center rounded text-sm font-mono shrink-0"
                    style={{
                        backgroundColor: selected
                            ? 'rgba(255,255,255,0.2)'
                            : (theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)')
                    }}
                >
                    {def.symbol}
                </span>

                {/* Name */}
                <span className="flex-1 text-left truncate">
                    {def.name}
                </span>

                {/* Count badge */}
                {count > 0 && (
                    <span className={`
                        px-1.5 py-0.5 rounded-full text-[10px] font-medium
                        ${selected ? 'bg-white/30 text-white' : 'bg-blue-500/20 text-blue-600 dark:text-blue-400'}
                    `}>
                        {count}
                    </span>
                )}

                {/* Sync indicator */}
                {def.sldEquivalent && (
                    <span
                        className={`text-[10px] ${selected ? 'opacity-70' : 'opacity-40'}`}
                        title={`Syncs with SLD: ${def.sldEquivalent}`}
                    >
                        ⟷
                    </span>
                )}

                {/* Wattage tooltip on hover */}
                {isHovered && def.defaultWattage && (
                    <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 pointer-events-none">
                        <div className="bg-gray-900 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap flex items-center gap-1">
                            <Zap size={10} className="text-yellow-400" />
                            {def.defaultWattage}W
                        </div>
                    </div>
                )}
            </button>
        );
    };

    const [activeTab, setActiveTab] = useState<'library' | 'unplaced'>('library');
    const stagingComponents = useLayoutStore(state => state.stagingComponents);
    const allPlacedLayoutIds = useLayoutStore(state => state.floorPlans.flatMap(p => p.components.map(c => c.id)));
    const allPlacedSldIds = useLayoutStore(state => state.floorPlans.flatMap(p => p.components.map(c => c.sldItemId)).filter(Boolean) as string[]);
    const placedLayoutIdSet = useMemo(() => new Set(allPlacedLayoutIds), [allPlacedLayoutIds]);
    const placedSldIdSet = useMemo(() => new Set(allPlacedSldIds), [allPlacedSldIds]);
    const visibleStagingComponents = useMemo(
        () => stagingComponents.filter(c => !placedLayoutIdSet.has(c.id) && (!c.sldItemId || !placedSldIdSet.has(c.sldItemId))),
        [stagingComponents, placedLayoutIdSet, placedSldIdSet]
    );

    return (
        <div className="h-full flex flex-col">
            {/* Header */}
            <div
                className="px-3 py-2.5 border-b font-semibold text-sm flex items-center justify-between"
                style={{ borderColor: colors.border, color: colors.text }}
            >
                <div className="flex items-center gap-2">
                    <Zap size={16} className="text-blue-500" />
                    Components
                </div>
            </div>

            {/* Tabs */}
            <div className="flex p-1 mx-2 mt-2 rounded-lg bg-gray-100 dark:bg-white/5 space-x-1">
                <button
                    onClick={() => setActiveTab('library')}
                    className={`
                        flex-1 py-1 text-xs font-medium rounded-md transition-all
                        ${activeTab === 'library'
                            ? 'bg-white dark:bg-gray-700 shadow text-blue-600 dark:text-blue-400'
                            : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}
                    `}
                >
                    Library
                </button>
                <button
                    onClick={() => setActiveTab('unplaced')}
                    className={`
                        flex-1 py-1 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1
                        ${activeTab === 'unplaced'
                            ? 'bg-white dark:bg-gray-700 shadow text-blue-600 dark:text-blue-400'
                            : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}
                    `}
                >
                    Unplaced
                    {visibleStagingComponents.length > 0 && (
                        <span className="bg-blue-500 text-white px-1.5 rounded-full text-[9px] min-w-[14px] h-3.5 flex items-center justify-center">
                            {visibleStagingComponents.length}
                        </span>
                    )}
                </button>
            </div>

            {/* Search Box */}
            <div className="px-2 py-2 border-b" style={{ borderColor: colors.border }}>
                <div className="relative">
                    <Search
                        size={14}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-40"
                        style={{ color: colors.text }}
                    />
                    <input
                        type="text"
                        placeholder="Search components..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        style={{ color: colors.text }}
                    />
                </div>
            </div>

            {/* Component List */}
            <div className="flex-1 overflow-y-auto p-2">
                {activeTab === 'library' ? (
                    <>
                        {/* Search Results */}
                        {filteredComponents && (
                            <div className="mb-4">
                                <div className="text-xs font-medium mb-2 opacity-60" style={{ color: colors.text }}>
                                    Search Results ({filteredComponents.length})
                                </div>
                                <div className="space-y-1">
                                    {filteredComponents.map(def => renderComponentButton(def))}
                                </div>
                                {filteredComponents.length === 0 && (
                                    <div className="text-xs opacity-50 text-center py-4" style={{ color: colors.text }}>
                                        No components found
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Category List */}
                        {!filteredComponents && sortedCategories.map(({ key, name, icon, components }) => {
                            const isExpanded = expandedCategories.has(key);
                            const categoryStyle = CATEGORY_STYLES[key] || 'bg-gray-100 dark:bg-gray-800';
                            const categoryCount = components.reduce(
                                (sum, def) => sum + (componentCounts[def.type] || 0),
                                0
                            );

                            return (
                                <div key={key} className="mb-2">
                                    {/* Category Header */}
                                    <button
                                        onClick={() => toggleCategory(key)}
                                        className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${categoryStyle}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span>{icon}</span>
                                            <span>{name}</span>
                                            <span className="opacity-60">({components.length})</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {categoryCount > 0 && (
                                                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-black/10 dark:bg-white/10">
                                                    {categoryCount} placed
                                                </span>
                                            )}
                                            {isExpanded ? (
                                                <ChevronDown size={14} />
                                            ) : (
                                                <ChevronRight size={14} />
                                            )}
                                        </div>
                                    </button>

                                    {/* Components */}
                                    {isExpanded && (
                                        <div className="mt-1 ml-1 space-y-0.5">
                                            {components.map(def => renderComponentButton(def))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </>
                ) : (
                    // Unplaced Items View
                    <div className="space-y-2">
                        {visibleStagingComponents.length === 0 ? (
                            <div className="text-center py-8 opacity-50 text-xs" style={{ color: colors.text }}>
                                <div className="mb-2 text-2xl">✨</div>
                                No unplaced items.<br />
                                Create items in SLD view to see them here.
                            </div>
                        ) : (
                            visibleStagingComponents.map(comp => {
                                const def = LAYOUT_COMPONENT_DEFINITIONS[comp.type];
                                return (
                                    <div
                                        key={comp.id}
                                        className="p-2 rounded-md border border-white/10 bg-white/5 flex items-center gap-3 group hover:bg-white/10 transition-colors cursor-grab active:cursor-grabbing"
                                        draggable
                                        onDragStart={(e) => {
                                            e.dataTransfer.setData('application/json', JSON.stringify({
                                                ...comp,
                                                _isStagingComponent: true
                                            }));
                                            e.dataTransfer.effectAllowed = 'move';
                                        }}
                                    >
                                        <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center text-sm font-mono" style={{ color: colors.text }}>
                                            {def?.symbol || '?'}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium truncate" style={{ color: colors.text }}>
                                                {comp.properties.name || def?.name}
                                            </div>
                                            <div className="text-[10px] opacity-60 truncate" style={{ color: colors.text }}>
                                                Drag to canvas
                                            </div>
                                        </div>
                                        <div className="text-xs opacity-40">⋮⋮</div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}
            </div>

            {/* Footer with stats */}
            <div
                className="px-3 py-2 border-t text-[10px] space-y-1"
                style={{ borderColor: colors.border, color: colors.text }}
            >
                {currentPlan ? (
                    <div className="flex justify-between opacity-60">
                        <span>Components placed:</span>
                        <span className="font-medium">{currentPlan.components.length}</span>
                    </div>
                ) : (
                    <div className="opacity-60">
                        Select or create a floor plan
                    </div>
                )}
                <div className="flex items-center gap-1 opacity-40">
                    <Info size={10} />
                    <span>Click component, then click canvas</span>
                </div>
            </div>
        </div>
    );
};
