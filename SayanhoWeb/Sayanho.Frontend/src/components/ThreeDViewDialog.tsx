// 3D View Dialog - Simple 3D visualization of floor plan using Three.js
// Shows walls extruded to 3D with components placed
// @ts-nocheck - React Three Fiber components have known TypeScript issues with JSX types

import React, { useRef, useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { X, RotateCcw } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useLayoutStore } from '../store/useLayoutStore';
import { Wall, Room, Door, LayoutComponent, Window as LayoutWindow } from '../types/layout';
import { LAYOUT_COMPONENT_DEFINITIONS } from '../utils/LayoutComponentDefinitions';

interface ThreeDViewDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

// Wall mesh component
const Wall3D: React.FC<{ wall: Wall; height: number; pixelsPerMeter: number }> = ({
    wall,
    height,
    pixelsPerMeter
}) => {
    const length = Math.hypot(
        wall.endPoint.x - wall.startPoint.x,
        wall.endPoint.y - wall.startPoint.y
    ) / pixelsPerMeter;

    const angle = Math.atan2(
        wall.endPoint.y - wall.startPoint.y,
        wall.endPoint.x - wall.startPoint.x
    );

    const centerX = (wall.startPoint.x + wall.endPoint.x) / 2 / pixelsPerMeter;
    const centerZ = (wall.startPoint.y + wall.endPoint.y) / 2 / pixelsPerMeter;
    const thickness = wall.thickness / pixelsPerMeter;

    return (
        <mesh
            position={[centerX, height / 2, centerZ]}
            rotation={[0, -angle, 0]}
        >
            <boxGeometry args={[length, height, thickness]} />
            <meshStandardMaterial color="#d1d5db" />
        </mesh>
    );
};

// Room floor
const RoomFloor3D: React.FC<{ room: Room; pixelsPerMeter: number }> = ({ room, pixelsPerMeter }) => {
    const shape = useMemo(() => {
        const shapeObj = new THREE.Shape();
        const points = room.polygon.map(p => ({
            x: p.x / pixelsPerMeter,
            y: p.y / pixelsPerMeter
        }));

        if (points.length > 0) {
            shapeObj.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                shapeObj.lineTo(points[i].x, points[i].y);
            }
            shapeObj.closePath();
        }

        return shapeObj;
    }, [room.polygon, pixelsPerMeter]);

    // Room type to color
    const colors: Record<string, string> = {
        bedroom: '#93c5fd',
        living_room: '#fde047',
        kitchen: '#fca5a5',
        bathroom: '#86efac',
        other: '#e5e7eb'
    };

    return (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
            <shapeGeometry args={[shape]} />
            <meshStandardMaterial
                color={colors[room.type] || colors.other}
                transparent
                opacity={0.5}
            />
        </mesh>
    );
};

// Door opening
const Door3D: React.FC<{ door: Door; wall: Wall; height: number; pixelsPerMeter: number }> = ({
    door,
    wall,
    height,
    pixelsPerMeter
}) => {
    const x = door.position.x / pixelsPerMeter;
    const z = door.position.y / pixelsPerMeter;
    const width = door.width / pixelsPerMeter;
    const doorHeight = height * 0.8;

    const wallAngle = Math.atan2(
        wall.endPoint.y - wall.startPoint.y,
        wall.endPoint.x - wall.startPoint.x
    );

    return (
        <group position={[x, doorHeight / 2, z]} rotation={[0, -wallAngle, 0]}>
            <mesh>
                <boxGeometry args={[width, doorHeight, 0.05]} />
                <meshStandardMaterial color="#8b4513" />
            </mesh>
        </group>
    );
};

// Window
const Window3D: React.FC<{ window: LayoutWindow; wall: Wall; wallHeight: number; pixelsPerMeter: number }> = ({
    window: win,
    wall,
    wallHeight,
    pixelsPerMeter
}) => {
    const x = win.position.x / pixelsPerMeter;
    const z = win.position.y / pixelsPerMeter;
    const width = win.width / pixelsPerMeter;
    const height = (win.height || 40) / pixelsPerMeter;

    const wallAngle = Math.atan2(
        wall.endPoint.y - wall.startPoint.y,
        wall.endPoint.x - wall.startPoint.x
    );

    return (
        <mesh
            position={[x, wallHeight * 0.6, z]}
            rotation={[0, -wallAngle, 0]}
        >
            <boxGeometry args={[width, height, 0.05]} />
            <meshStandardMaterial color="#60a5fa" transparent opacity={0.7} />
        </mesh>
    );
};

// Electrical component
const Component3D: React.FC<{ component: LayoutComponent; pixelsPerMeter: number }> = ({
    component,
    pixelsPerMeter
}) => {
    const def = LAYOUT_COMPONENT_DEFINITIONS[component.type];
    const x = component.position.x / pixelsPerMeter;
    const z = component.position.y / pixelsPerMeter;

    // Different heights for different component types
    const heights: Record<string, number> = {
        ceiling_light: 2.4,
        led_panel: 2.4,
        wall_light: 1.8,
        socket_5a: 0.3,
        socket_15a: 0.3,
        socket_20a: 0.3,
        switch_1way: 1.2,
        switch_2way: 1.2,
        ac_point: 2.2,
        default: 1.0
    };

    const height = heights[component.type] || heights.default;

    return (
        <group position={[x, height, z]}>
            <mesh>
                <sphereGeometry args={[0.1, 16, 16]} />
                <meshStandardMaterial
                    color={def.category === 'lighting' ? '#fbbf24' : '#3b82f6'}
                    emissive={def.category === 'lighting' ? '#fbbf24' : undefined}
                    emissiveIntensity={def.category === 'lighting' ? 0.5 : 0}
                />
            </mesh>
        </group>
    );
};

// Main 3D Scene
const Scene: React.FC = () => {
    const { getCurrentFloorPlan } = useLayoutStore();
    const plan = getCurrentFloorPlan();

    const wallHeight = 2.5; // meters
    const pixelsPerMeter = plan?.pixelsPerMeter || 50;

    // Center offset to keep scene centered
    const centerX = plan ? plan.width / 2 / pixelsPerMeter : 0;
    const centerZ = plan ? plan.height / 2 / pixelsPerMeter : 0;

    if (!plan) {
        return null;
    }

    return (
        <group position={[-centerX, 0, -centerZ]}>
            {/* Floor */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, 0, centerZ]}>
                <planeGeometry args={[plan.width / pixelsPerMeter, plan.height / pixelsPerMeter]} />
                <meshStandardMaterial color="#f3f4f6" />
            </mesh>

            {/* Rooms */}
            {plan.rooms.map(room => (
                <RoomFloor3D
                    key={room.id}
                    room={room}
                    pixelsPerMeter={pixelsPerMeter}
                />
            ))}

            {/* Walls */}
            {plan.walls.map(wall => (
                <Wall3D
                    key={wall.id}
                    wall={wall}
                    height={wallHeight}
                    pixelsPerMeter={pixelsPerMeter}
                />
            ))}

            {/* Doors */}
            {plan.doors.map(door => {
                const wall = plan.walls.find(w => w.id === door.wallId);
                if (!wall) return null;
                return (
                    <Door3D
                        key={door.id}
                        door={door}
                        wall={wall}
                        height={wallHeight}
                        pixelsPerMeter={pixelsPerMeter}
                    />
                );
            })}

            {/* Windows */}
            {plan.windows.map(win => {
                const wall = plan.walls.find(w => w.id === win.wallId);
                if (!wall) return null;
                return (
                    <Window3D
                        key={win.id}
                        window={win}
                        wall={wall}
                        wallHeight={wallHeight}
                        pixelsPerMeter={pixelsPerMeter}
                    />
                );
            })}

            {/* Components */}
            {plan.components.map(comp => (
                <Component3D
                    key={comp.id}
                    component={comp}
                    pixelsPerMeter={pixelsPerMeter}
                />
            ))}
        </group>
    );
};

export const ThreeDViewDialog: React.FC<ThreeDViewDialogProps> = ({ isOpen, onClose }) => {
    const { colors, theme } = useTheme();
    const controlsRef = useRef<any>(null);

    if (!isOpen) return null;

    const resetCamera = () => {
        if (controlsRef.current) {
            controlsRef.current.reset();
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
            onClick={onClose}
        >
            <div
                className="w-full max-w-5xl h-[80vh] rounded-xl shadow-2xl overflow-hidden flex flex-col"
                style={{ backgroundColor: colors.panelBackground }}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between px-4 py-3 border-b"
                    style={{ borderColor: colors.border }}
                >
                    <h2 className="text-lg font-semibold" style={{ color: colors.text }}>
                        3D View
                    </h2>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={resetCamera}
                            className="p-2 rounded hover:bg-white/10 transition-colors"
                            title="Reset Camera"
                        >
                            <RotateCcw size={18} style={{ color: colors.text }} />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 rounded hover:bg-white/10 transition-colors"
                        >
                            <X size={18} style={{ color: colors.text }} />
                        </button>
                    </div>
                </div>

                {/* 3D Canvas */}
                <div className="flex-1" style={{ backgroundColor: theme === 'dark' ? '#1f2937' : '#f3f4f6' }}>
                    <Canvas shadows>
                        <PerspectiveCamera makeDefault position={[15, 15, 15]} fov={50} />
                        <OrbitControls
                            ref={controlsRef}
                            enablePan={true}
                            enableZoom={true}
                            enableRotate={true}
                            minDistance={5}
                            maxDistance={50}
                            maxPolarAngle={Math.PI / 2}
                        />

                        {/* Lighting */}
                        <ambientLight intensity={0.6} />
                        <directionalLight
                            position={[10, 20, 10]}
                            intensity={0.8}
                            castShadow
                        />
                        <directionalLight
                            position={[-10, 10, -10]}
                            intensity={0.3}
                        />

                        {/* Scene */}
                        <Suspense fallback={null}>
                            <Scene />
                        </Suspense>

                        {/* Grid helper */}
                        <gridHelper args={[50, 50, '#6b7280', '#374151']} />
                    </Canvas>
                </div>

                {/* Footer with instructions */}
                <div
                    className="px-4 py-2 border-t text-xs flex items-center justify-between"
                    style={{ borderColor: colors.border, color: colors.text }}
                >
                    <span className="opacity-60">
                        🖱️ Orbit: Left drag | Pan: Right drag | Zoom: Scroll
                    </span>
                    <span className="opacity-60">
                        Wall height: 2.5m
                    </span>
                </div>
            </div>
        </div>
    );
};
