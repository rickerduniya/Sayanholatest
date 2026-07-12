import React, { useEffect, useMemo, useState } from 'react';
import { CanvasItem } from '../types';
import { FloorPlan, LayoutComponent } from '../types/layout';
import { useLayoutStore } from '../store/useLayoutStore';
import { layoutImageStore } from '../utils/LayoutImageStore';
import { useTheme } from '../context/ThemeContext';

interface LayoutConnectionPreviewProps {
    sourceItem: CanvasItem;
    targetItem?: CanvasItem;
}

interface LocatedComponent {
    floorPlan: FloorPlan;
    component: LayoutComponent;
}

const getLayoutComponentId = (item?: CanvasItem): string | undefined =>
    item?.properties?.[0]?.['_layoutComponentId'];

const findComponent = (floorPlans: FloorPlan[], componentId?: string): LocatedComponent | undefined => {
    if (!componentId) return undefined;

    for (const floorPlan of floorPlans) {
        const component = floorPlan.components.find(candidate => candidate.id === componentId);
        if (component) return { floorPlan, component };
    }

    return undefined;
};

const roomLabelPosition = (points: { x: number; y: number }[]) => {
    if (points.length === 0) return { x: 0, y: 0 };
    const totals = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
    return { x: totals.x / points.length, y: totals.y / points.length };
};

/**
 * A compact, read-only floor-plan view used while wiring in SLD mode. It keeps
 * the connection workflow in the SLD canvas while making the real-world item
 * locations visible at the same time.
 */
export const LayoutConnectionPreview: React.FC<LayoutConnectionPreviewProps> = ({ sourceItem, targetItem }) => {
    const floorPlans = useLayoutStore(state => state.floorPlans);
    const { colors, theme } = useTheme();

    const preview = useMemo(() => {
        const source = findComponent(floorPlans, getLayoutComponentId(sourceItem));
        const target = findComponent(floorPlans, getLayoutComponentId(targetItem));

        if (!source) return undefined;

        const sharesFloorPlan = !target || target.floorPlan.id === source.floorPlan.id;
        return {
            floorPlan: source.floorPlan,
            source: source.component,
            target: sharesFloorPlan ? target?.component : undefined,
            targetOnAnotherPlan: Boolean(target && !sharesFloorPlan)
        };
    }, [floorPlans, sourceItem, targetItem]);

    const [backgroundImage, setBackgroundImage] = useState<string | null>(null);

    useEffect(() => {
        let isActive = true;
        const imageId = preview?.floorPlan.backgroundImageId;

        if (!imageId) {
            setBackgroundImage(null);
            return () => { isActive = false; };
        }

        layoutImageStore.getImageAsDataUrl(imageId)
            .then(image => {
                if (isActive) setBackgroundImage(image);
            })
            .catch(() => {
                if (isActive) setBackgroundImage(null);
            });

        return () => { isActive = false; };
    }, [preview?.floorPlan.backgroundImageId]);

    if (!preview) return null;

    const { floorPlan, source, target, targetOnAnotherPlan } = preview;
    const width = Math.max(floorPlan.width, 1);
    const height = Math.max(floorPlan.height, 1);
    const markerSize = Math.max(10, Math.min(width, height) * 0.022);
    const minorMarkerSize = Math.max(4, markerSize * 0.38);
    const targetIsPlaced = Boolean(targetItem && target);

    return (
        <div
            className="absolute bottom-4 right-4 w-[360px] rounded-xl border shadow-2xl overflow-hidden z-[60]"
            style={{
                backgroundColor: colors.panelBackground,
                borderColor: colors.border,
                color: colors.text,
                pointerEvents: 'none'
            }}
            aria-live="polite"
        >
            <div className="px-3 py-2 border-b flex items-center justify-between gap-3" style={{ borderColor: colors.border }}>
                <div>
                    <p className="text-xs font-semibold">Layout connection preview</p>
                    <p className="text-[11px] opacity-70 truncate max-w-[220px]">{floorPlan.name}</p>
                </div>
                <div className="text-[10px] text-right opacity-80">
                    <div><span className="font-semibold text-emerald-500">A</span> {sourceItem.name}</div>
                    {targetItem && <div><span className="font-semibold text-orange-500">B</span> {targetItem.name}</div>}
                </div>
            </div>

            <div className="p-2">
                <svg
                    viewBox={`0 0 ${width} ${height}`}
                    className="w-full h-[210px] rounded-lg border"
                    style={{
                        backgroundColor: theme === 'dark' ? '#111827' : '#f8fafc',
                        borderColor: colors.border
                    }}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label="Floor plan showing the SLD connection endpoints"
                >
                    <defs>
                        <pattern id="layout-connection-grid" width="50" height="50" patternUnits="userSpaceOnUse">
                            <path d="M 50 0 L 0 0 0 50" fill="none" stroke={theme === 'dark' ? '#334155' : '#cbd5e1'} strokeWidth="1" />
                        </pattern>
                        <marker id="layout-connection-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                            <path d="M 0 0 L 6 3 L 0 6 z" fill="#2563eb" />
                        </marker>
                    </defs>

                    <rect width={width} height={height} fill="url(#layout-connection-grid)" />
                    {backgroundImage && (
                        <image href={backgroundImage} x="0" y="0" width={width} height={height} opacity="0.3" preserveAspectRatio="none" />
                    )}

                    {floorPlan.rooms.map(room => {
                        const labelPosition = roomLabelPosition(room.polygon);
                        return (
                            <g key={room.id}>
                                <polygon
                                    points={room.polygon.map(point => `${point.x},${point.y}`).join(' ')}
                                    fill={room.color || (theme === 'dark' ? '#1e3a5f' : '#dbeafe')}
                                    fillOpacity="0.22"
                                    stroke={theme === 'dark' ? '#64748b' : '#94a3b8'}
                                    strokeWidth="2"
                                />
                                {room.name && (
                                    <text x={labelPosition.x} y={labelPosition.y} textAnchor="middle" fontSize="22" fill={theme === 'dark' ? '#cbd5e1' : '#475569'} opacity="0.8">
                                        {room.name}
                                    </text>
                                )}
                            </g>
                        );
                    })}

                    {floorPlan.walls.map(wall => (
                        <line
                            key={wall.id}
                            x1={wall.startPoint.x}
                            y1={wall.startPoint.y}
                            x2={wall.endPoint.x}
                            y2={wall.endPoint.y}
                            stroke={theme === 'dark' ? '#e2e8f0' : '#334155'}
                            strokeWidth={Math.max(4, wall.thickness || 4)}
                            strokeLinecap="round"
                        />
                    ))}

                    {floorPlan.components.map(component => {
                        const isSource = component.id === source.id;
                        const isTarget = component.id === target?.id;
                        const fill = isSource ? '#10b981' : isTarget ? '#f97316' : (theme === 'dark' ? '#94a3b8' : '#64748b');
                        const radius = isSource || isTarget ? markerSize : minorMarkerSize;

                        return (
                            <circle
                                key={component.id}
                                cx={component.position.x}
                                cy={component.position.y}
                                r={radius}
                                fill={fill}
                                fillOpacity={isSource || isTarget ? 1 : 0.62}
                                stroke={isSource || isTarget ? '#ffffff' : 'none'}
                                strokeWidth={isSource || isTarget ? Math.max(2, markerSize * 0.18) : 0}
                            />
                        );
                    })}

                    {target && (
                        <line
                            x1={source.position.x}
                            y1={source.position.y}
                            x2={target.position.x}
                            y2={target.position.y}
                            stroke="#2563eb"
                            strokeWidth={Math.max(4, markerSize * 0.42)}
                            strokeDasharray={`${markerSize} ${markerSize * 0.55}`}
                            markerEnd="url(#layout-connection-arrow)"
                        />
                    )}

                    <text x={source.position.x} y={source.position.y + markerSize * 0.36} textAnchor="middle" fontSize={markerSize} fontWeight="700" fill="#ffffff">A</text>
                    {target && (
                        <text x={target.position.x} y={target.position.y + markerSize * 0.36} textAnchor="middle" fontSize={markerSize} fontWeight="700" fill="#ffffff">B</text>
                    )}
                </svg>

                <p className="mt-2 px-1 text-[11px] opacity-80">
                    {targetOnAnotherPlan
                        ? 'The selected items are on different floor plans, so a shared layout route cannot be shown.'
                        : targetIsPlaced
                            ? 'A → B shows the actual placed items on the layout.'
                            : targetItem
                                ? 'The target item is not yet placed on this layout.'
                                : 'Select or hover over a target connection point to preview its layout location.'}
                </p>
            </div>
        </div>
    );
};
