import React, { useEffect, useState, useRef } from 'react';
import Konva from 'konva';
import { Group, Rect, Image as KonvaImage, Circle, Transformer, Text } from 'react-konva';
import { CanvasItem as CanvasItemType } from '../types';
import { api } from '../services/api';
import { CacheService } from '../services/CacheService';


interface ItemComponentProps {
    item: CanvasItemType;
    isSelected: boolean;
    onSelect: (e?: any) => void;
    onDragEnd: (x: number, y: number) => void;
    onDragMove?: (x: number, y: number) => void;
    onConnectionPointClick?: (key: string, e: any) => void;
    onConnectionPointMouseDown?: (key: string, e: any) => void;
    onConnectionPointMouseUp?: (key: string, e: any) => void;
    onConnectionPointMouseEnter?: (key: string, e: any) => void;
    onConnectionPointMouseLeave?: (key: string, e: any) => void;
    showConnectionPoints?: boolean;
    onDragStart?: (e?: any) => void;
    onResizeEnd?: (w: number, h: number) => void;
    onContextMenu?: (stageX: number, stageY: number) => void;
    onDoubleClick?: () => void;
    panMode?: boolean;
}

import { useTheme } from '../context/ThemeContext';

export const ItemComponent: React.FC<ItemComponentProps> = ({
    item,
    isSelected,
    onSelect,
    onDragEnd,
    onDragMove,
    onConnectionPointClick,
    onConnectionPointMouseDown,
    onConnectionPointMouseUp,
    onConnectionPointMouseEnter,
    onConnectionPointMouseLeave,
    showConnectionPoints,
    onDragStart,
    onResizeEnd,
    onContextMenu,
    onDoubleClick,
    panMode
}) => {
    const { theme } = useTheme();
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [inPointImg, setInPointImg] = useState<HTMLImageElement | null>(null);
    const [outPointImg, setOutPointImg] = useState<HTMLImageElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const groupRef = useRef<any>(null);
    const transformerRef = useRef<any>(null);

    useEffect(() => {
        const loadPointIcons = () => {
            const inImg = new window.Image();
            inImg.src = '/assets/in_point.png';
            inImg.onload = () => setInPointImg(inImg);

            const outImg = new window.Image();
            outImg.src = '/assets/out_point.png';
            outImg.onload = () => setOutPointImg(outImg);
        };
        loadPointIcons();
    }, []);

    useEffect(() => {
        let isMounted = true;
        const loadIcon = async () => {
            try {
                let src = '';
                let svgString = '';

                // 1. Get SVG Content (either from item or fetch)
                if (item.svgContent) {
                    svgString = item.svgContent;
                } else if (item.iconPath) {
                    const iconName = item.iconPath.split('/').pop();
                    const url = iconName ? encodeURI(api.getIconUrl(iconName)) : '';

                    if (url) {
                        const cacheKey = CacheService.generateKey('icon_svg', { url });
                        const cachedSvg = CacheService.get<string>(cacheKey);

                        if (cachedSvg) {
                            svgString = cachedSvg;
                        } else {
                            try {
                                const resp = await fetch(url);
                                if (resp.ok) {
                                    svgString = await resp.text();
                                    CacheService.set(cacheKey, svgString);
                                }
                            } catch (e) {
                                console.error('[ItemComponent] Failed to fetch icon:', url, e);
                            }
                        }
                    }
                }


                // 2. Modify SVG for Dark Mode if needed
                if (svgString) {
                    try {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(svgString, "image/svg+xml");
                        // Select common SVG shapes and text
                        const elements = doc.querySelectorAll('path, circle, rect, line, polyline, polygon, text');
                        const targetColor = theme === 'dark' ? '#ffffff' : '#000000';

                        elements.forEach(el => {
                            const fill = el.getAttribute('fill');
                            const stroke = el.getAttribute('stroke');
                            const style = el.getAttribute('style') || '';

                            // 1. Remove white background fills
                            if (fill && (fill === 'white' || fill === '#ffffff' || fill === '#fff')) {
                                el.setAttribute('fill', 'none');
                            }

                            // 2. Replace black strokes with target color
                            if (stroke && (stroke === 'black' || stroke === '#000000' || stroke === '#000')) {
                                el.setAttribute('stroke', targetColor);
                            }
                            if (style.includes('stroke:black') || style.includes('stroke:#000')) {
                                el.setAttribute('style', style.replace(/stroke:\s*(black|#000000|#000)/gi, `stroke:${targetColor}`));
                            }

                            // 3. Replace black fills with target color
                            if (fill && (fill === 'black' || fill === '#000000' || fill === '#000')) {
                                el.setAttribute('fill', targetColor);
                            }
                            if (style.includes('fill:black') || style.includes('fill:#000')) {
                                el.setAttribute('style', style.replace(/fill:\s*(black|#000000|#000)/gi, `fill:${targetColor}`));
                            }

                            // 4. Handle implicit default fill (which is black)
                            // If an element has NO fill and NO stroke defined, SVG defaults to black fill.
                            // We must apply target color here.
                            // Exclude if 'fill' is explicitly 'none'
                            if (!fill && !stroke && !style.includes('fill:') && !style.includes('stroke:')) {
                                el.setAttribute('fill', targetColor);
                            }
                        });

                        svgString = new XMLSerializer().serializeToString(doc);
                    } catch (e) {
                        console.error('[ItemComponent] SVG parsing error:', e);
                    }

                    const blob = new Blob([svgString], { type: 'image/svg+xml' });
                    src = URL.createObjectURL(blob);
                }

                // 3. Load Image
                if (src && isMounted) {
                    const img = new window.Image();
                    img.crossOrigin = 'Anonymous';
                    img.onload = () => {
                        if (isMounted) {
                            setImage(img);
                            imageRef.current = img;
                        }
                    };
                    img.src = src;
                }
            } catch (error) {
                console.error('[ItemComponent] Error loading icon for', item.name, error);
            }
        };

        loadIcon();

        return () => {
            isMounted = false;
            if (imageRef.current && imageRef.current.src.startsWith('blob:')) {
                URL.revokeObjectURL(imageRef.current.src);
            }
        };
    }, [item.svgContent, item.iconPath, item.name, theme]);

    return (
        <Group
            id={item.uniqueID}
            x={item.position.x}
            y={item.position.y}
            draggable={!item.locked && !panMode}
            onDragStart={(e) => onDragStart?.(e)}
            onDragMove={(e) => onDragMove?.(e.target.x(), e.target.y())}
            onDragEnd={(e) => onDragEnd(e.target.x(), e.target.y())}
            onClick={(e) => {
                if (e.evt.button === 0) {
                    onSelect(e);
                }
            }}
            onTap={onSelect}
            onDblClick={() => onDoubleClick?.()}
            onDblTap={() => onDoubleClick?.()}
            ref={groupRef}
            onTransformEnd={() => {
                const node = groupRef.current;
                if (!node) return;
                const newW = Math.max(10, item.size.width * node.scaleX());
                const newH = Math.max(10, item.size.height * node.scaleY());
                node.scaleX(1);
                node.scaleY(1);
                onResizeEnd?.(Math.round(newW), Math.round(newH));
            }}
            onContextMenu={(e) => {
                e.evt.preventDefault();
                const cx = (e.evt as MouseEvent).clientX;
                const cy = (e.evt as MouseEvent).clientY;
                onContextMenu?.(cx, cy);
            }}
        >
            {isSelected && (
                <Rect
                    x={-4}
                    y={-4}
                    width={item.size.width + 8}
                    height={item.size.height + 8}
                    fill="transparent"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dash={[8, 4]}
                    listening={false}
                />
            )}

            <Rect
                width={item.size.width}
                height={item.size.height}
                fill="transparent"
                stroke={isSelected ? "#4f46e5" : "transparent"}
                strokeWidth={isSelected ? 1 : 0}
                cornerRadius={2}
            />

            {image && (
                <KonvaImage
                    image={image}
                    x={item.rotation === 90 ? item.size.width : item.rotation === 180 ? item.size.width : item.rotation === 270 ? 0 : 0}
                    y={item.rotation === 90 ? 0 : item.rotation === 180 ? item.size.height : item.rotation === 270 ? item.size.height : 0}
                    width={item.rotation === 90 || item.rotation === 270 ? item.size.height : item.size.width}
                    height={item.rotation === 90 || item.rotation === 270 ? item.size.width : item.size.height}
                    rotation={item.rotation || 0}
                    listening={false}
                />
            )}

            {/* Portal label badge */}
            {item.name === 'Portal' && (
                <Group x={4} y={-18} listening={false}>
                    <Rect
                        fill={theme === 'dark' ? '#1f2937' : '#f3f4f6'}
                        stroke={theme === 'dark' ? '#374151' : '#d1d5db'}
                        strokeWidth={1}
                        cornerRadius={4}
                        width={Math.min(160, Math.max(40, (item.properties?.[0]?.Label || item.properties?.[0]?.label || 'Portal').length * 7 + 12))}
                        height={18}
                    />
                    <Text
                        text={(item.properties?.[0]?.Label || item.properties?.[0]?.label || 'Portal') as string}
                        fontSize={12}
                        fill={theme === 'dark' ? '#e5e7eb' : '#111827'}
                        x={6}
                        y={2}
                    />
                </Group>
            )}

            {/* Connection Points */}
            {(showConnectionPoints !== false) && Object.entries(item.connectionPoints).map(([key, point]) => {
                const k = key.toLowerCase();
                const isInput = k === 'in' || k.startsWith('in');
                const pointImg = isInput ? inPointImg : outPointImg;
                const size = 12; // Size of the connection point icon

                return (
                    <Group
                        key={key}
                        x={point.x}
                        y={point.y}
                        onClick={(e) => {
                            e.cancelBubble = true;
                            onConnectionPointClick?.(key, e);
                        }}
                        onMouseDown={(e) => {
                            e.cancelBubble = true;
                            onConnectionPointMouseDown?.(key, e);
                        }}
                        onMouseUp={(e) => {
                            e.cancelBubble = true;
                            onConnectionPointMouseUp?.(key, e);
                        }}
                        onMouseEnter={(e) => {
                            const stage = e.target.getStage();
                            if (stage) stage.container().style.cursor = 'crosshair';
                            onConnectionPointMouseEnter?.(key, e);
                        }}
                        onMouseLeave={(e) => {
                            const stage = e.target.getStage();
                            if (stage) stage.container().style.cursor = 'default';
                            onConnectionPointMouseLeave?.(key, e);
                        }}
                    >
                        {/* Hit Area (Invisible but larger for touch) */}
                        <Circle
                            radius={16}
                            fill="transparent"
                            stroke="transparent"
                        />

                        {/* Visual Icon */}
                        {pointImg ? (
                            <KonvaImage
                                image={pointImg}
                                x={-size / 2}
                                y={-size / 2}
                                width={size}
                                height={size}
                                listening={false}
                            />
                        ) : (
                            <Circle
                                radius={4}
                                fill={isInput ? "#ef4444" : "#3b82f6"}
                                stroke="white"
                                strokeWidth={1}
                                listening={false}
                            />
                        )}
                    </Group>
                );
            })}
        </Group>
    );
};
