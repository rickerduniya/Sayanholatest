// Layout Toolbar - Enhanced drawing tools and actions for floor plan editing
// Features: drawing tools, wire routing, measurement mode, sync action

import React, { useState } from 'react';
import {
    MousePointer2,
    Hand,
    Pencil,
    Square,
    DoorOpen,
    LayoutGrid,
    Trash2,
    Undo2,
    Redo2,
    ZoomIn,
    ZoomOut,
    Maximize,
    Upload,
    Box,
    ArrowUpFromLine,
    Grid3X3,
    Ruler,
    Zap,
    Sparkles,
    Bug,
    Copy,
    Check,
    X
} from 'lucide-react';
import { useLayoutStore } from '../store/useLayoutStore';
import { useTheme } from '../context/ThemeContext';
import { DrawingTool } from '../types/layout';

interface LayoutToolbarProps {
    scale: number;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFitView: () => void;
    onUploadPlan: () => void;
    onScaleCalibrate?: () => void;
    showMagicWires: boolean;
    onToggleMagicWires: () => void;
}

interface ToolButtonProps {
    icon: React.ReactNode;
    label: string;
    shortcut?: string;
    active?: boolean;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    variant?: 'default' | 'danger' | 'success';
}

const ToolButton: React.FC<ToolButtonProps> = ({
    icon,
    label,
    shortcut,
    active,
    onClick,
    disabled,
    variant = 'default'
}) => {
    const { colors } = useTheme();

    const variantStyles = {
        default: active
            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
            : 'hover:bg-black/10 dark:hover:bg-white/10',
        danger: 'hover:bg-red-500/20 text-red-600 dark:text-red-400',
        success: 'hover:bg-green-500/20 text-green-600 dark:text-green-400'
    };

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={shortcut ? `${label} (${shortcut})` : label}
            className={`
                p-1 rounded transition-colors relative group
                ${variantStyles[variant]}
                ${disabled ? 'opacity-30 cursor-not-allowed' : ''}
            `}
            style={active || variant !== 'default' ? {} : { color: colors.text }}
        >
            {icon}

            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                <div className="bg-gray-900 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap">
                    {label}
                    {shortcut && (
                        <span className="ml-1 text-gray-400 border border-gray-600 px-1 rounded text-[9px]">
                            {shortcut}
                        </span>
                    )}
                </div>
            </div>
        </button>
    );
};

const Divider: React.FC = () => (
    <div className="w-px h-6 mx-1" style={{ backgroundColor: 'rgba(0,0,0,0.15)' }} />
);

const ToolGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="flex items-center gap-0.5 relative">
        {children}
    </div>
);

export const LayoutToolbar: React.FC<LayoutToolbarProps> = ({
    scale,
    onZoomIn,
    onZoomOut,
    onFitView,
    onUploadPlan,
    onScaleCalibrate,
    showMagicWires,
    onToggleMagicWires
}) => {
    const { colors } = useTheme();
    const {
        getCurrentFloorPlan,
        updateFloorPlan,
        drawingState,
        setActiveTool,
        setGridSnap,
        undo,
        redo,
        deleteSelected,
        takeSnapshot,
        selectedElementIds,
        undoStack,
        redoStack,
        apiDebugData,
        setWallThickness,
        setContinuousWallMode
    } = useLayoutStore();

    const activeTool = drawingState.activeTool;
    const [showDebug, setShowDebug] = useState(false);
    const [copied, setCopied] = useState(false);

    const handleDetectRooms = async () => {
        console.error('[Detect Rooms] clicked');
        const plan = getCurrentFloorPlan();
        if (!plan) {
            console.error('[Detect Rooms] no active floor plan');
            return;
        }
        try {
            takeSnapshot();
            const { FloorplanApiService } = await import('../services/FloorplanApiService');
            const rooms = FloorplanApiService.detectRoomsFromPlan({
                width: plan.width,
                height: plan.height,
                walls: plan.walls,
                doors: plan.doors,
                windows: plan.windows
            });
            console.error('[Detect Rooms] rooms detected:', rooms.length);
            updateFloorPlan(plan.id, { rooms });
        } catch (e) {
            console.error('[Detect Rooms] failed', e);
        }
    };

    const handleCopyDebug = () => {
        if (!apiDebugData) return;
        const text = JSON.stringify(apiDebugData, null, 2);
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const selectionTools: { tool: DrawingTool; icon: React.ReactNode; label: string; shortcut: string }[] = [
        { tool: 'select', icon: <MousePointer2 size={16} />, label: 'Select', shortcut: 'V' },
        { tool: 'pan', icon: <Hand size={16} />, label: 'Pan', shortcut: 'Space' },
    ];

    const drawingTools: { tool: DrawingTool; icon: React.ReactNode; label: string; shortcut: string }[] = [
        { tool: 'wall', icon: <Pencil size={16} />, label: 'Draw Wall', shortcut: 'W' },
        { tool: 'room', icon: <Square size={16} />, label: 'Draw Room', shortcut: 'R' },
        { tool: 'door', icon: <DoorOpen size={16} />, label: 'Add Door', shortcut: 'D' },
        { tool: 'window', icon: <Grid3X3 size={16} />, label: 'Add Window', shortcut: 'N' },
        { tool: 'stair', icon: <ArrowUpFromLine size={16} />, label: 'Add Stairs', shortcut: 'S' },
        { tool: 'pick', icon: <Pencil size={16} className="rotate-180" />, label: 'Pick Thickness', shortcut: 'P' },
    ];

    return (
        <>
            <div
                className="rounded-xl shadow-lg p-2 flex items-center gap-1"
                style={{ backgroundColor: colors.panelBackground, color: colors.text, border: `1px solid ${colors.border}` }}
            >
                <ToolGroup>
                    {selectionTools.map(({ tool, icon, label, shortcut }) => (
                        <ToolButton
                            key={tool}
                            icon={icon}
                            label={label}
                            shortcut={shortcut}
                            active={activeTool === tool}
                            onClick={() => setActiveTool(tool)}
                        />
                    ))}
                </ToolGroup>

                <Divider />

                <ToolGroup>
                    {drawingTools.map(({ tool, icon, label, shortcut }) => (
                        <ToolButton
                            key={tool}
                            icon={icon}
                            label={label}
                            shortcut={shortcut}
                            active={activeTool === tool}
                            onClick={() => setActiveTool(tool)}
                        />
                    ))}
                </ToolGroup>

                {activeTool === 'wall' && (
                    <>
                        <Divider />
                        <ToolGroup>
                            <div className="flex items-center gap-2 px-2 border-x border-black/5 dark:border-white/5">
                                <span className="text-[10px] font-bold uppercase opacity-50 tracking-tighter">Wall T:</span>
                                <input
                                    type="number"
                                    min="1"
                                    max="100"
                                    value={drawingState.wallThickness}
                                    onChange={(e) => setWallThickness(parseInt(e.target.value) || 10)}
                                    className="w-10 bg-black/10 dark:bg-white/10 rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    style={{ color: colors.text }}
                                />
                                <span className="text-[10px] opacity-40">px</span>
                            </div>

                            <ToolButton
                                icon={<Sparkles size={14} className={drawingState.continuousWallMode ? "text-blue-500" : "opacity-30"} />}
                                label={drawingState.continuousWallMode ? "Mode: Continuous (Chain)" : "Mode: Single Line"}
                                active={drawingState.continuousWallMode}
                                onClick={() => setContinuousWallMode(!drawingState.continuousWallMode)}
                            />
                        </ToolGroup>
                    </>
                )}

                <Divider />

                <div className="flex items-center gap-1">
                    {onScaleCalibrate && (
                        <ToolButton
                            icon={<Ruler size={16} />}
                            label="Calibrate Scale"
                            onClick={() => onScaleCalibrate()}
                        />
                    )}
                    <ToolButton
                        icon={<Zap size={16} className={showMagicWires ? "fill-current" : ""} />}
                        label="Magic Wiring"
                        active={showMagicWires}
                        onClick={onToggleMagicWires}
                        variant={showMagicWires ? 'success' : 'default'}
                    />
                </div>

                <Divider />

                <ToolButton
                    icon={<LayoutGrid size={16} />}
                    label={`Grid Snap: ${drawingState.gridSnap ? 'ON' : 'OFF'}`}
                    shortcut="G"
                    active={drawingState.gridSnap}
                    onClick={() => setGridSnap(!drawingState.gridSnap)}
                />

                <Divider />

                <div className="flex items-center gap-1">
                    <ToolButton
                        icon={<Trash2 size={16} />}
                        label="Delete Selected"
                        shortcut="Del"
                        disabled={selectedElementIds.length === 0}
                        onClick={deleteSelected}
                        variant="danger"
                    />
                    <ToolButton
                        icon={<Sparkles size={16} />}
                        label="Detect Rooms"
                        onClick={() => handleDetectRooms()}
                    />
                    <ToolButton
                        icon={<Upload size={16} />}
                        label="Upload Plan"
                        onClick={onUploadPlan}
                    />
                    <ToolButton
                        icon={copied ? <Check size={16} /> : <Bug size={16} />}
                        label={apiDebugData ? (copied ? 'Copied API Debug JSON' : 'Copy API Debug JSON') : 'No API Debug Data'}
                        shortcut="Shift+Click to View"
                        disabled={!apiDebugData}
                        onClick={(e) => {
                            if (!apiDebugData) return;
                            if (e.shiftKey) {
                                setShowDebug(true);
                                return;
                            }
                            handleCopyDebug();
                        }}
                        variant={copied ? 'success' : 'default'}
                    />
                </div>

                <Divider />

                <ToolGroup>
                    <ToolButton
                        icon={<Undo2 size={16} />}
                        label="Undo"
                        shortcut="Ctrl+Z"
                        onClick={undo}
                        disabled={undoStack.length === 0}
                    />
                    <ToolButton
                        icon={<Redo2 size={16} />}
                        label="Redo"
                        shortcut="Ctrl+Y"
                        onClick={redo}
                        disabled={redoStack.length === 0}
                    />
                </ToolGroup>

                <Divider />

                <ToolGroup>
                    <ToolButton
                        icon={<ZoomOut size={16} />}
                        label="Zoom Out"
                        shortcut="-"
                        onClick={onZoomOut}
                    />

                    <span
                        className="text-xs px-2 min-w-[50px] text-center font-mono"
                        style={{ color: colors.text }}
                    >
                        {Math.round(scale * 100)}%
                    </span>

                    <ToolButton
                        icon={<ZoomIn size={16} />}
                        label="Zoom In"
                        shortcut="+"
                        onClick={onZoomIn}
                    />
                    <ToolButton
                        icon={<Maximize size={16} />}
                        label="Fit View"
                        shortcut="Shift+1"
                        onClick={onFitView}
                    />
                </ToolGroup>
            </div>

            {showDebug && apiDebugData && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <div className="bg-[#1e1e1e] border border-white/20 rounded-lg shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden">
                        <div className="flex items-center justify-between p-4 border-b border-white/10 bg-[#252525]">
                            <h3 className="text-white font-medium flex items-center gap-2">
                                <Bug size={18} className="text-blue-400" />
                                Smart Detection Debug Data
                                <span className="text-xs text-gray-400 font-normal">
                                    ({new Date(apiDebugData.timestamp).toLocaleTimeString()})
                                </span>
                            </h3>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleCopyDebug}
                                    className={`
                                        flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors
                                        ${copied ? 'bg-green-500/20 text-green-400' : 'bg-white/5 hover:bg-white/10 text-gray-300'}
                                    `}
                                >
                                    {copied ? <Check size={14} /> : <Copy size={14} />}
                                    {copied ? 'Copied!' : 'Copy JSON'}
                                </button>
                                <button
                                    onClick={() => setShowDebug(false)}
                                    className="p-1.5 hover:bg-white/10 rounded text-gray-400 hover:text-white transition-colors"
                                >
                                    <X size={20} />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 overflow-auto p-4 bg-[#111] text-xs font-mono">
                            <div className="grid grid-cols-2 gap-4 h-full">
                                <div className="flex flex-col gap-2">
                                    <h4 className="text-blue-400 font-bold uppercase tracking-wider text-[10px]">Request Config</h4>
                                    <pre className="bg-[#0a0a0a] p-3 rounded border border-white/5 overflow-auto flex-1 text-green-300">
                                        {JSON.stringify(apiDebugData.request, null, 2)}
                                    </pre>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <h4 className="text-purple-400 font-bold uppercase tracking-wider text-[10px]">Raw Response</h4>
                                    <pre className="bg-[#0a0a0a] p-3 rounded border border-white/5 overflow-auto flex-1 text-yellow-300">
                                        {JSON.stringify(apiDebugData.response, null, 2)}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
