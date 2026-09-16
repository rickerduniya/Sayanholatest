// Layout Inspector — properties panel for the current Layout Designer selection.
//
// Before this existed, most element properties were unreachable from the Layout
// view: wall thickness could only be set *before* drawing, doors and windows
// could only be resized by dragging their handles, room names came from OCR or
// nothing, and component labels/wattage could not be edited at all. Anything you
// got slightly wrong had to be deleted and redone.
//
// Design notes:
//  - Mirrors the SLD side's right-hand properties panel so the two views feel
//    like one app.
//  - Numeric fields commit on blur/Enter rather than per keystroke, so undo
//    history gets one entry per edit instead of one per character.
//  - With nothing selected the panel becomes a shortcut reference, which is
//    where a new user actually looks for help.

import React, { useEffect, useMemo, useState } from 'react';
import {
    Trash2,
    Copy,
    RotateCw,
    Ruler,
    DoorOpen,
    Square,
    Type as TypeIcon,
    Zap,
    Layers,
    Keyboard
} from 'lucide-react';
import { useLayoutStore } from '../store/useLayoutStore';
import { useTheme } from '../context/ThemeContext';
import { LAYOUT_COMPONENT_DEFINITIONS } from '../utils/LayoutComponentDefinitions';
import {
    getWallLength,
    getWallAngle,
    calculateRoomArea,
    getAreaLabel,
    getDistanceLabelWithUnit
} from '../utils/LayoutDrawingTools';
import { RoomType } from '../types/layout';

const ROOM_TYPES: RoomType[] = [
    'bedroom', 'living_room', 'kitchen', 'bathroom', 'toilet', 'balcony',
    'corridor', 'staircase', 'utility', 'office', 'dining', 'storage',
    'pooja', 'other'
];

const prettyRoomType = (type: RoomType) =>
    type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// ---------------------------------------------------------------------------
// Small field primitives
// ---------------------------------------------------------------------------

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] opacity-60 shrink-0">{label}</span>
        <div className="flex-1 min-w-0 flex justify-end">{children}</div>
    </div>
);

const ReadOnlyValue: React.FC<{ value: string }> = ({ value }) => (
    <span className="text-[11px] font-mono opacity-80 truncate">{value}</span>
);

/**
 * Number input that only reports a value when editing finishes.
 *
 * Committing per keystroke would push a snapshot onto the undo stack for every
 * digit and would fight the user as they retype a value (e.g. clearing "150"
 * momentarily produces 0 and the element jumps).
 */
const NumberField: React.FC<{
    value: number;
    onCommit: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
}> = ({ value, onCommit, min, max, step = 1, suffix }) => {
    const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));

    // Re-sync when the element changes underneath us (e.g. dragged on canvas).
    useEffect(() => {
        setDraft(String(Math.round(value * 100) / 100));
    }, [value]);

    const commit = () => {
        const parsed = parseFloat(draft);
        if (!Number.isFinite(parsed)) {
            setDraft(String(Math.round(value * 100) / 100));
            return;
        }
        let next = parsed;
        if (min !== undefined) next = Math.max(min, next);
        if (max !== undefined) next = Math.min(max, next);
        if (next !== value) onCommit(next);
        setDraft(String(Math.round(next * 100) / 100));
    };

    return (
        <div className="flex items-center gap-1">
            <input
                type="number"
                value={draft}
                step={step}
                min={min}
                max={max}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') {
                        setDraft(String(Math.round(value * 100) / 100));
                        (e.target as HTMLInputElement).blur();
                    }
                    // Canvas shortcuts must not fire while typing here.
                    e.stopPropagation();
                }}
                className="w-16 rounded bg-black/10 px-1.5 py-0.5 text-right text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-white/10"
            />
            {suffix && <span className="text-[10px] opacity-40">{suffix}</span>}
        </div>
    );
};

const TextField: React.FC<{
    value: string;
    onCommit: (value: string) => void;
    placeholder?: string;
}> = ({ value, onCommit, placeholder }) => {
    const [draft, setDraft] = useState(value);

    useEffect(() => setDraft(value), [value]);

    return (
        <input
            type="text"
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft !== value) onCommit(draft); }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                }
                if (e.key === 'Escape') {
                    setDraft(value);
                    (e.target as HTMLInputElement).blur();
                }
                e.stopPropagation();
            }}
            className="w-full min-w-0 rounded bg-black/10 px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-white/10"
        />
    );
};

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string; subtitle?: string }> = ({
    icon, title, subtitle
}) => (
    <div className="flex items-center gap-2 pb-1">
        <span className="text-blue-500">{icon}</span>
        <div className="min-w-0">
            <p className="text-xs font-semibold leading-tight truncate">{title}</p>
            {subtitle && <p className="text-[10px] leading-tight opacity-50 truncate">{subtitle}</p>}
        </div>
    </div>
);

// ---------------------------------------------------------------------------
// Shortcut reference (shown when nothing is selected)
// ---------------------------------------------------------------------------

const SHORTCUTS: Array<[string, string]> = [
    ['V', 'Select'],
    ['W', 'Draw wall'],
    ['R', 'Draw room'],
    ['D', 'Add door'],
    ['N', 'Add window'],
    ['T', 'Add text'],
    ['P', 'Pick wall thickness'],
    ['Space', 'Hold to pan'],
    ['Shift', 'Lock wall to 45°'],
    ['Shift+drag', 'Add to selection'],
    ['Ctrl+A', 'Select all'],
    ['Ctrl+D', 'Duplicate'],
    ['Arrows', 'Nudge 1px (Shift = 10px)'],
    ['Del', 'Delete selection'],
    ['Esc', 'Cancel / deselect'],
    ['Shift+1', 'Fit view']
];

// ---------------------------------------------------------------------------

export const LayoutInspector: React.FC = () => {
    const { colors } = useTheme();
    const {
        getCurrentFloorPlan,
        selectedElementIds,
        updateWall,
        updateRoom,
        updateDoor,
        updateWindow,
        updateComponent,
        updateTextItem,
        deleteSelected,
        duplicateSelection,
        rotateSelection,
        takeSnapshot
    } = useLayoutStore();

    const plan = getCurrentFloorPlan();
    const unit = plan?.measurementUnit || 'm';
    const ppm = plan?.pixelsPerMeter || 50;

    /**
     * Resolve the selection into concrete elements. All element kinds share one
     * id namespace, so we have to look in each collection.
     */
    const selection = useMemo(() => {
        if (!plan || selectedElementIds.length === 0) return null;

        const ids = new Set(selectedElementIds);
        return {
            walls: plan.walls.filter(w => ids.has(w.id)),
            rooms: plan.rooms.filter(r => ids.has(r.id)),
            doors: plan.doors.filter(d => ids.has(d.id)),
            windows: plan.windows.filter(w => ids.has(w.id)),
            components: plan.components.filter(c => ids.has(c.id)),
            textItems: (plan.textItems || []).filter(t => ids.has(t.id))
        };
    }, [plan, selectedElementIds]);

    const totalSelected = selection
        ? selection.walls.length + selection.rooms.length + selection.doors.length +
          selection.windows.length + selection.components.length + selection.textItems.length
        : 0;

    // Every inspector edit is a discrete user action, so snapshot before it.
    // The individual update* store actions deliberately do not snapshot because
    // they are also called on every frame of a canvas drag.
    const withSnapshot = <T extends (...args: any[]) => void>(fn: T) => ((...args: Parameters<T>) => {
        takeSnapshot();
        fn(...args);
    }) as T;

    // -----------------------------------------------------------------------
    // Empty state — becomes the shortcut cheat sheet
    // -----------------------------------------------------------------------
    if (!plan) {
        return (
            <div className="h-full flex flex-col p-3" style={{ color: colors.text }}>
                <SectionHeader icon={<Layers size={14} />} title="No floor plan" />
                <p className="text-[11px] leading-relaxed opacity-60">
                    Upload a floor plan image or add a blank plan to start drafting.
                </p>
            </div>
        );
    }

    if (totalSelected === 0) {
        return (
            <div className="h-full flex flex-col overflow-hidden" style={{ color: colors.text }}>
                <div className="px-3 pt-3">
                    <SectionHeader
                        icon={<Keyboard size={14} />}
                        title="Shortcuts"
                        subtitle="Select an element to edit it"
                    />
                </div>
                <div className="flex-1 overflow-y-auto px-3 pb-3">
                    <div className="space-y-1">
                        {SHORTCUTS.map(([keys, label]) => (
                            <div key={keys} className="flex items-center justify-between gap-2">
                                <span className="text-[11px] opacity-70 truncate">{label}</span>
                                <kbd
                                    className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-mono opacity-80"
                                    style={{ borderColor: colors.border }}
                                >
                                    {keys}
                                </kbd>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    // -----------------------------------------------------------------------
    // Shared action bar
    // -----------------------------------------------------------------------
    const actions = (
        <div className="flex items-center gap-1 pt-2">
            <button
                type="button"
                onClick={() => duplicateSelection()}
                className="flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                title="Duplicate (Ctrl+D)"
            >
                <Copy size={12} /> Duplicate
            </button>
            <button
                type="button"
                onClick={() => rotateSelection(90)}
                className="flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                title="Rotate 90°"
            >
                <RotateCw size={12} /> Rotate
            </button>
            <button
                type="button"
                onClick={() => deleteSelected()}
                className="flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] text-red-500 transition-colors hover:bg-red-500/10"
                title="Delete (Del)"
            >
                <Trash2 size={12} /> Delete
            </button>
        </div>
    );

    // -----------------------------------------------------------------------
    // Multi-selection — only offer bulk actions, not per-element fields
    // -----------------------------------------------------------------------
    if (totalSelected > 1) {
        const parts: string[] = [];
        if (selection!.walls.length) parts.push(`${selection!.walls.length} wall${selection!.walls.length > 1 ? 's' : ''}`);
        if (selection!.rooms.length) parts.push(`${selection!.rooms.length} room${selection!.rooms.length > 1 ? 's' : ''}`);
        if (selection!.doors.length) parts.push(`${selection!.doors.length} door${selection!.doors.length > 1 ? 's' : ''}`);
        if (selection!.windows.length) parts.push(`${selection!.windows.length} window${selection!.windows.length > 1 ? 's' : ''}`);
        if (selection!.components.length) parts.push(`${selection!.components.length} component${selection!.components.length > 1 ? 's' : ''}`);
        if (selection!.textItems.length) parts.push(`${selection!.textItems.length} text`);

        // Bulk wall thickness is worth exposing: re-tracing detected walls one by
        // one to fix a uniform thickness error is the slowest task in the tool.
        const wallThicknesses = new Set(selection!.walls.map(w => w.thickness));
        const commonThickness = wallThicknesses.size === 1 ? [...wallThicknesses][0] : null;

        return (
            <div className="h-full overflow-y-auto p-3" style={{ color: colors.text }}>
                <SectionHeader
                    icon={<Layers size={14} />}
                    title={`${totalSelected} selected`}
                    subtitle={parts.join(' · ')}
                />

                {selection!.walls.length > 1 && (
                    <div className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: colors.border }}>
                        <Row label="Wall thickness">
                            <NumberField
                                value={commonThickness ?? 10}
                                min={1}
                                max={100}
                                suffix="px"
                                onCommit={(next) => {
                                    takeSnapshot();
                                    selection!.walls.forEach(w => updateWall(w.id, { thickness: next }));
                                }}
                            />
                        </Row>
                        {commonThickness === null && (
                            <p className="text-[10px] opacity-50">Mixed values — setting applies to all.</p>
                        )}
                    </div>
                )}

                {actions}
            </div>
        );
    }

    // -----------------------------------------------------------------------
    // Single selection
    // -----------------------------------------------------------------------
    const wall = selection!.walls[0];
    const room = selection!.rooms[0];
    const door = selection!.doors[0];
    const win = selection!.windows[0];
    const component = selection!.components[0];
    const textItem = selection!.textItems[0];

    return (
        <div className="h-full overflow-y-auto p-3 space-y-1.5" style={{ color: colors.text }}>
            {wall && (
                <>
                    <SectionHeader icon={<Ruler size={14} />} title="Wall" />
                    <Row label="Thickness">
                        <NumberField
                            value={wall.thickness}
                            min={1}
                            max={100}
                            suffix="px"
                            onCommit={withSnapshot((next: number) => updateWall(wall.id, { thickness: next }))}
                        />
                    </Row>
                    <Row label="Length">
                        <ReadOnlyValue value={getDistanceLabelWithUnit(getWallLength(wall), ppm, unit)} />
                    </Row>
                    <Row label="Angle">
                        <ReadOnlyValue value={`${getWallAngle(wall).toFixed(1)}°`} />
                    </Row>
                    <Row label="Start">
                        <ReadOnlyValue value={`${Math.round(wall.startPoint.x)}, ${Math.round(wall.startPoint.y)}`} />
                    </Row>
                    <Row label="End">
                        <ReadOnlyValue value={`${Math.round(wall.endPoint.x)}, ${Math.round(wall.endPoint.y)}`} />
                    </Row>
                </>
            )}

            {room && (
                <>
                    <SectionHeader icon={<Square size={14} />} title="Room" />
                    <Row label="Name">
                        <TextField
                            value={room.name}
                            placeholder="Room name"
                            onCommit={withSnapshot((next: string) => updateRoom(room.id, { name: next }))}
                        />
                    </Row>
                    <Row label="Type">
                        <select
                            value={room.type}
                            onChange={(e) => {
                                takeSnapshot();
                                updateRoom(room.id, { type: e.target.value as RoomType });
                            }}
                            className="w-full min-w-0 rounded bg-black/10 px-1 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-white/10"
                            style={{ color: colors.text }}
                        >
                            {ROOM_TYPES.map(type => (
                                <option key={type} value={type}>{prettyRoomType(type)}</option>
                            ))}
                        </select>
                    </Row>
                    <Row label="Area">
                        <ReadOnlyValue value={getAreaLabel(calculateRoomArea(room), ppm, unit)} />
                    </Row>
                    <Row label="Corners">
                        <ReadOnlyValue value={String(room.polygon.length)} />
                    </Row>
                    {room.detectedName && (
                        <Row label="Detected">
                            <ReadOnlyValue value={room.detectedName} />
                        </Row>
                    )}
                </>
            )}

            {door && (
                <>
                    <SectionHeader icon={<DoorOpen size={14} />} title="Door" />
                    <Row label="Width">
                        <NumberField
                            value={door.width}
                            min={20}
                            suffix="px"
                            onCommit={withSnapshot((next: number) => updateDoor(door.id, { width: next }))}
                        />
                    </Row>
                    <Row label="Real width">
                        <ReadOnlyValue value={getDistanceLabelWithUnit(door.width, ppm, unit)} />
                    </Row>
                    <Row label="Type">
                        <select
                            value={door.type}
                            onChange={(e) => {
                                takeSnapshot();
                                updateDoor(door.id, { type: e.target.value as 'single' | 'double' | 'sliding' });
                            }}
                            className="w-full min-w-0 rounded bg-black/10 px-1 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-white/10"
                            style={{ color: colors.text }}
                        >
                            <option value="single">Single</option>
                            <option value="double">Double</option>
                            <option value="sliding">Sliding</option>
                        </select>
                    </Row>
                    <Row label="On wall">
                        <ReadOnlyValue value={door.wallId === 'orphan' ? 'Detached' : 'Attached'} />
                    </Row>
                </>
            )}

            {win && (
                <>
                    <SectionHeader icon={<Square size={14} />} title="Window" />
                    <Row label="Width">
                        <NumberField
                            value={win.width}
                            min={20}
                            suffix="px"
                            onCommit={withSnapshot((next: number) => updateWindow(win.id, { width: next }))}
                        />
                    </Row>
                    <Row label="Depth">
                        <NumberField
                            value={win.height}
                            min={4}
                            suffix="px"
                            onCommit={withSnapshot((next: number) => updateWindow(win.id, { height: next }))}
                        />
                    </Row>
                    <Row label="Real width">
                        <ReadOnlyValue value={getDistanceLabelWithUnit(win.width, ppm, unit)} />
                    </Row>
                    <Row label="On wall">
                        <ReadOnlyValue value={win.wallId === 'orphan' ? 'Detached' : 'Attached'} />
                    </Row>
                </>
            )}

            {component && (() => {
                const def = LAYOUT_COMPONENT_DEFINITIONS[component.type];
                const hostRoom = component.roomId
                    ? plan.rooms.find(r => r.id === component.roomId)
                    : undefined;

                return (
                    <>
                        <SectionHeader
                            icon={<Zap size={14} />}
                            title={def?.name || component.type}
                            subtitle={def?.sldEquivalent ? `Syncs with SLD · ${def.sldEquivalent}` : 'Layout only'}
                        />
                        <Row label="Label">
                            <TextField
                                value={component.properties?.name || ''}
                                placeholder={def?.name || 'Label'}
                                onCommit={withSnapshot((next: string) => updateComponent(component.id, {
                                    properties: { ...component.properties, name: next }
                                }))}
                            />
                        </Row>
                        <Row label="Rotation">
                            <NumberField
                                value={component.rotation || 0}
                                step={15}
                                suffix="°"
                                onCommit={withSnapshot((next: number) => updateComponent(component.id, {
                                    rotation: ((next % 360) + 360) % 360
                                }))}
                            />
                        </Row>
                        <Row label="Wattage">
                            <NumberField
                                value={Number(component.properties?.wattage ?? def?.defaultWattage ?? 0)}
                                min={0}
                                step={5}
                                suffix="W"
                                onCommit={withSnapshot((next: number) => updateComponent(component.id, {
                                    properties: { ...component.properties, wattage: String(next) }
                                }))}
                            />
                        </Row>
                        <Row label="Position">
                            <ReadOnlyValue value={`${Math.round(component.position.x)}, ${Math.round(component.position.y)}`} />
                        </Row>
                        <Row label="Room">
                            <ReadOnlyValue value={hostRoom?.name || 'Unassigned'} />
                        </Row>
                        <Row label="SLD link">
                            <ReadOnlyValue value={component.sldItemId ? 'Linked' : 'Not linked'} />
                        </Row>
                    </>
                );
            })()}

            {textItem && (
                <>
                    <SectionHeader icon={<TypeIcon size={14} />} title="Text" />
                    <Row label="Content">
                        <TextField
                            value={textItem.text}
                            onCommit={withSnapshot((next: string) => updateTextItem(textItem.id, { text: next }))}
                        />
                    </Row>
                    <Row label="Font size">
                        <NumberField
                            value={textItem.fontSize || 14}
                            min={6}
                            max={200}
                            suffix="px"
                            onCommit={withSnapshot((next: number) => updateTextItem(textItem.id, { fontSize: next }))}
                        />
                    </Row>
                    <Row label="Rotation">
                        <NumberField
                            value={textItem.rotation || 0}
                            step={15}
                            suffix="°"
                            onCommit={withSnapshot((next: number) => updateTextItem(textItem.id, {
                                rotation: ((next % 360) + 360) % 360
                            }))}
                        />
                    </Row>
                    <Row label="Colour">
                        <input
                            type="color"
                            value={textItem.color || '#000000'}
                            onChange={(e) => {
                                takeSnapshot();
                                updateTextItem(textItem.id, { color: e.target.value });
                            }}
                            className="h-5 w-8 cursor-pointer border-none bg-transparent p-0"
                        />
                    </Row>
                    <Row label="Align">
                        <select
                            value={textItem.align || 'left'}
                            onChange={(e) => {
                                takeSnapshot();
                                updateTextItem(textItem.id, { align: e.target.value as 'left' | 'center' | 'right' });
                            }}
                            className="w-full min-w-0 rounded bg-black/10 px-1 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-white/10"
                            style={{ color: colors.text }}
                        >
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                            <option value="right">Right</option>
                        </select>
                    </Row>
                </>
            )}

            <div className="border-t pt-1" style={{ borderColor: colors.border }}>
                {actions}
            </div>
        </div>
    );
};
