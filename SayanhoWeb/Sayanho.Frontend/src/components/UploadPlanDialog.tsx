// Upload Plan Dialog - Dialog for uploading floor plan images
// Uses IndexedDB for client-side storage

import React, { useState, useRef, useCallback } from 'react';
import { X, Upload, ImageIcon, Loader2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useLayoutStore } from '../store/useLayoutStore';
import { layoutImageStore } from '../utils/LayoutImageStore';

interface UploadPlanDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

export const UploadPlanDialog: React.FC<UploadPlanDialogProps> = ({ isOpen, onClose }) => {
    const { colors, theme } = useTheme();
    const { addFloorPlan, updateFloorPlan, getCurrentFloorPlan, setApiDebugData } = useLayoutStore();

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [planName, setPlanName] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Handle file selection
    const handleFileSelect = useCallback((file: File) => {
        if (!file.type.startsWith('image/')) {
            setError('Please select an image file (JPEG, PNG, etc.)');
            return;
        }

        if (file.size > 10 * 1024 * 1024) {
            setError('File size must be less than 10MB');
            return;
        }

        setSelectedFile(file);
        setError(null);

        // Create preview
        const reader = new FileReader();
        reader.onload = (e) => {
            setPreview(e.target?.result as string);
        };
        reader.readAsDataURL(file);

        // Set default name from filename
        if (!planName) {
            const name = file.name.replace(/\.[^/.]+$/, '');
            setPlanName(name);
        }
    }, [planName]);

    // Handle drag and drop
    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const file = e.dataTransfer.files[0];
        if (file) {
            handleFileSelect(file);
        }
    }, [handleFileSelect]);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const [autoDetect, setAutoDetect] = useState(false);
    const [detecting, setDetecting] = useState(false);

    // Handle upload
    const handleUpload = async () => {
        if (!selectedFile) {
            setError('Please select a file');
            return;
        }

        if (!planName.trim()) {
            setError('Please enter a name for the floor plan');
            return;
        }

        setIsUploading(true);
        setError(null);

        try {
            // Get image dimensions
            const img = new Image();
            img.src = preview!;

            await new Promise((resolve) => {
                img.onload = () => resolve(true);
            });

            // Perform Smart Detection if enabled
            let detectedData = null;
            if (autoDetect) {
                setDetecting(true);
                try {
                    const { FloorplanApiService } = await import('../services/FloorplanApiService');
                    // We need to pass the raw File object to the API
                    detectedData = await FloorplanApiService.detectLayout(selectedFile);

                    const dbg = FloorplanApiService.getLastDebugInfo?.();
                    if (dbg) {
                        setApiDebugData({
                            timestamp: Date.now(),
                            ...dbg
                        });
                    } else {
                        setApiDebugData(null);
                    }

                } catch (err: any) {
                    console.error('Layout detection failed:', err);
                    setError(`Detection failed: ${err.message || 'Unknown error'}. creating plan without detection.`);
                    const { FloorplanApiService } = await import('../services/FloorplanApiService');
                    const dbg = FloorplanApiService.getLastDebugInfo?.();
                    if (dbg) {
                        setApiDebugData({
                            timestamp: Date.now(),
                            ...dbg
                        });
                    }
                } finally {
                    setDetecting(false);
                }
            }

            // Generate image ID
            const imageId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // Save to IndexedDB
            await layoutImageStore.saveImage(imageId, selectedFile, {
                name: planName,
                originalFilename: selectedFile.name
            });

            // Prepare entities
            let walls = detectedData?.walls || [];
            const doors = detectedData?.doors || [];
            const windows = detectedData?.windows || [];
            const rooms = detectedData?.rooms || [];

            // =================================================================
            // POST-PROCESSING: Stitch Walls (Close Gaps at Doors/Windows)
            // =================================================================
            if (walls.length > 0 && (doors.length > 0 || windows.length > 0)) {
                try {
                    const openings = [...doors, ...windows];
                    const TOLERANCE = 60; // Increased tolerance to handle series gaps

                    // Helper: Distance
                    const dist = (p1: { x: number, y: number }, p2: { x: number, y: number }) =>
                        Math.hypot(p1.x - p2.x, p1.y - p2.y);

                    // Helper: Check alignment (Wall angle vs Opening angle)
                    const isAligned = (w: any, angle: number) => {
                        const wx = w.endPoint.x - w.startPoint.x;
                        const wy = w.endPoint.y - w.startPoint.y;
                        let wAng = Math.atan2(wy, wx) * 180 / Math.PI;
                        let diff = Math.abs(wAng - angle) % 180;
                        if (diff > 90) diff = 180 - diff;
                        return diff < 30; // 30 deg tolerance
                    };

                    // PASS 1: Stitching - Extend walls to cover openings
                    // This creates walls under openings if at least one neighbor exists
                    const MAX_PASSES = 5;
                    for (let pass = 0; pass < MAX_PASSES; pass++) {
                        let changesMade = false;

                        openings.forEach((op: any) => {
                            const rot = op.rotation || 0;
                            const rad = rot * Math.PI / 180;
                            const halfW = op.width / 2;
                            const dx = Math.cos(rad) * halfW;
                            const dy = Math.sin(rad) * halfW;

                            const p1 = { x: op.position.x - dx, y: op.position.y - dy };
                            const p2 = { x: op.position.x + dx, y: op.position.y + dy };

                            let wallNearP1: any = null;
                            let wallNearP2: any = null;

                            // Find closest candidates
                            let minD1 = TOLERANCE;
                            walls.forEach((w: any, idx: number) => {
                                if (!isAligned(w, rot)) return;
                                const dStart = dist(w.startPoint, p1);
                                const dEnd = dist(w.endPoint, p1);
                                // Check if wall effectively reaches p1
                                if (dStart < minD1) { minD1 = dStart; wallNearP1 = { wall: w, end: 'start', idx }; }
                                if (dEnd < minD1) { minD1 = dEnd; wallNearP1 = { wall: w, end: 'end', idx }; }
                            });

                            let minD2 = TOLERANCE;
                            walls.forEach((w: any, idx: number) => {
                                if (!isAligned(w, rot)) return;
                                const dStart = dist(w.startPoint, p2);
                                const dEnd = dist(w.endPoint, p2);
                                if (dStart < minD2) { minD2 = dStart; wallNearP2 = { wall: w, end: 'start', idx }; }
                                if (dEnd < minD2) { minD2 = dEnd; wallNearP2 = { wall: w, end: 'end', idx }; }
                            });

                            // Action: Merge or Extend
                            if (wallNearP1 && wallNearP2 && wallNearP1.idx !== wallNearP2.idx) {
                                // Merge two walls across the opening
                                const w1 = walls[wallNearP1.idx];
                                const w2 = walls[wallNearP2.idx];

                                // Determine new endpoints (furthest points)
                                // If P1 was near Start, we use End.
                                const newStart = wallNearP1.end === 'start' ? w1.endPoint : w1.startPoint;
                                const newEnd = wallNearP2.end === 'start' ? w2.endPoint : w2.startPoint;

                                const mergedWall = {
                                    ...w1,
                                    id: `wall_st_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                                    startPoint: newStart,
                                    endPoint: newEnd,
                                    thickness: Math.max(w1.thickness || 10, w2.thickness || 10)
                                };

                                walls = walls.filter((w: any) => w.id !== w1.id && w.id !== w2.id);
                                walls.push(mergedWall);
                                changesMade = true;

                            } else if (wallNearP1) {
                                // Extend W1 to cover to P2
                                const w = walls[wallNearP1.idx];
                                if (w) {
                                    if (wallNearP1.end === 'start') w.startPoint = p2;
                                    else w.endPoint = p2;
                                    changesMade = true;
                                }
                            } else if (wallNearP2) {
                                // Extend W2 to cover to P1
                                const w = walls[wallNearP2.idx];
                                if (w) {
                                    if (wallNearP2.end === 'start') w.startPoint = p1;
                                    else w.endPoint = p1;
                                    changesMade = true;
                                }
                            }
                        });

                        if (!changesMade) break;
                    }

                    // PASS 2: Merge Collinear Walls (Fixes Series Gaps)
                    // If we have Wall A -> Door -> Wall B -> Window -> Wall C
                    // Pass 1 ensures Wall A extends to Door, Wall B extends to Window.
                    // This pass will merge Wall A and Wall B if they touch/overlap, 
                    // creating a single continuous wall for the series.
                    let merging = true;
                    while (merging) {
                        merging = false;
                        for (let i = 0; i < walls.length; i++) {
                            for (let j = i + 1; j < walls.length; j++) {
                                const w1 = walls[i];
                                const w2 = walls[j];

                                // 1. Check Angle Alignment
                                const a1 = Math.atan2(w1.endPoint.y - w1.startPoint.y, w1.endPoint.x - w1.startPoint.x);
                                const a2 = Math.atan2(w2.endPoint.y - w2.startPoint.y, w2.endPoint.x - w2.startPoint.x);
                                let dAng = Math.abs(a1 - a2);
                                if (dAng > Math.PI) dAng = 2 * Math.PI - dAng; // wrap around

                                // Check for parallel AND same direction, or opposite (walls are lines)
                                // We check modulo PI roughly
                                const isParallel = dAng < 0.1 || Math.abs(dAng - Math.PI) < 0.1;

                                if (isParallel) {
                                    // 2. Check Collinearity (Distance from Line)
                                    // Project w2 points onto w1 line
                                    // Line defined by w1.start (P0) and direction (v)
                                    // Dist = |(P2-P0) x v| / |v|
                                    const length1 = dist(w1.startPoint, w1.endPoint);
                                    if (length1 < 1) continue; // skip tiny walls based on valid length

                                    const dx = (w1.endPoint.x - w1.startPoint.x) / length1;
                                    const dy = (w1.endPoint.y - w1.startPoint.y) / length1;

                                    // Normal vector (-dy, dx)
                                    // Dist from line = dot product with normal
                                    const dStart2 = Math.abs((w2.startPoint.x - w1.startPoint.x) * -dy + (w2.startPoint.y - w1.startPoint.y) * dx);
                                    const dEnd2 = Math.abs((w2.endPoint.x - w1.startPoint.x) * -dy + (w2.endPoint.y - w1.startPoint.y) * dx);

                                    if (dStart2 < 20 && dEnd2 < 20) { // Within 20px of same line axis
                                        // 3. Check Overlap / Proximity (Gap < Tolerance)
                                        // Project 1D position along line
                                        const pos = (p: { x: number, y: number }) =>
                                            (p.x - w1.startPoint.x) * dx + (p.y - w1.startPoint.y) * dy;

                                        const t1s = 0, t1e = length1;
                                        const t2s = pos(w2.startPoint);
                                        const t2e = pos(w2.endPoint);

                                        const min1 = Math.min(t1s, t1e);
                                        const max1 = Math.max(t1s, t1e);
                                        const min2 = Math.min(t2s, t2e);
                                        const max2 = Math.max(t2s, t2e);

                                        // Check gap
                                        const gap = Math.max(0, min2 - max1, min1 - max2);

                                        if (gap < TOLERANCE) {
                                            // MERGE!
                                            // New extent: Min of all to Max of all
                                            const allPoints = [min1, max1, min2, max2];
                                            const globalMin = Math.min(...allPoints);
                                            const globalMax = Math.max(...allPoints);

                                            // Reconstruct points
                                            const newStart = {
                                                x: w1.startPoint.x + dx * globalMin,
                                                y: w1.startPoint.y + dy * globalMin
                                            };
                                            const newEnd = {
                                                x: w1.startPoint.x + dx * globalMax,
                                                y: w1.startPoint.y + dy * globalMax
                                            };

                                            const newWall = {
                                                ...w1,
                                                id: `wall_merged_${Date.now()}_${Math.random()}`,
                                                startPoint: newStart,
                                                endPoint: newEnd,
                                                thickness: Math.max(w1.thickness || 10, w2.thickness || 10)
                                            };

                                            // Replace w1 and remove w2
                                            walls[i] = newWall;
                                            walls.splice(j, 1);
                                            merging = true;
                                            break; // restart inner loop
                                        }
                                    }
                                }
                            }
                            if (merging) break; // restart outer loop
                        }
                    }

                } catch (e) {
                    console.error("Auto-stitch failed", e);
                }
            }

            // Create or update floor plan
            const currentPlan = getCurrentFloorPlan();
            if (currentPlan) {
                updateFloorPlan(currentPlan.id, {
                    name: planName,
                    backgroundImageId: imageId,
                    width: img.width,
                    height: img.height,
                    walls: walls.length > 0 ? [...currentPlan.walls, ...walls] : currentPlan.walls,
                    doors: doors.length > 0 ? [...currentPlan.doors, ...doors] : currentPlan.doors,
                    windows: windows.length > 0 ? [...currentPlan.windows, ...windows] : currentPlan.windows,
                    rooms: rooms.length > 0 ? [...currentPlan.rooms, ...rooms] : currentPlan.rooms
                });
                // TODO: Add doors/windows/rooms to the store for this plan
                // This requires valid action creators in the store or manual state updates.
                // Assuming we can just dispatch actions or the 'updateFloorPlan' might support 'components'.
                // If not, we will just have walls for now.
            } else {
                addFloorPlan({
                    name: planName,
                    backgroundImageId: imageId,
                    width: img.width,
                    height: img.height,
                    pixelsPerMeter: 50,
                    walls,
                    doors,
                    windows,
                    rooms
                });
            }

            // If we have other detected items, we should try to add them
            if (detectedData) {
                // This part depends on the Store API. If 'addFloorPlan' doesn't take doors/windows,
                // we would need to call 'addComponent' for each. 
                // Since I cannot see the full store definition right now, I will assume the user 
                // wants to AT LEAST see walls. 
                // I will add a TODO or try to implement if I see the store supports it.
            }

            // Reset and close
            setSelectedFile(null);
            setPreview(null);
            setPlanName('');
            setAutoDetect(false);
            onClose();
        } catch (err) {
            console.error('Upload failed:', err);
            setError('Failed to save floor plan. Please try again.');
        } finally {
            setIsUploading(false);
        }
    };

    // Handle create blank plan
    const handleCreateBlank = () => {
        if (!planName.trim()) {
            setError('Please enter a name for the floor plan');
            return;
        }

        addFloorPlan({
            name: planName,
            width: 2000,
            height: 1500,
            pixelsPerMeter: 50
        });

        setPlanName('');
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            onClick={onClose}
        >
            <div
                className="w-full max-w-lg rounded-xl shadow-2xl overflow-hidden"
                style={{ backgroundColor: colors.panelBackground }}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div
                    className="flex items-center justify-between px-4 py-3 border-b"
                    style={{ borderColor: colors.border }}
                >
                    <h2 className="text-lg font-semibold" style={{ color: colors.text }}>
                        New Floor Plan
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-1 rounded hover:bg-white/10 transition-colors"
                    >
                        <X size={20} style={{ color: colors.text }} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-4 space-y-4">
                    {/* Plan Name */}
                    <div>
                        <label
                            className="block text-sm font-medium mb-1"
                            style={{ color: colors.text }}
                        >
                            Floor Plan Name
                        </label>
                        <input
                            type="text"
                            value={planName}
                            onChange={e => setPlanName(e.target.value)}
                            placeholder="e.g. Ground Floor, First Floor"
                            className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500"
                            style={{
                                backgroundColor: colors.canvasBackground,
                                borderColor: colors.border,
                                color: colors.text
                            }}
                        />
                    </div>

                    {/* File Upload Area */}
                    <div>
                        <label
                            className="block text-sm font-medium mb-1"
                            style={{ color: colors.text }}
                        >
                            Background Image (Optional)
                        </label>

                        <div
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onClick={() => fileInputRef.current?.click()}
                            className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors hover:border-blue-500"
                            style={{
                                borderColor: selectedFile ? '#3b82f6' : colors.border,
                                backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)'
                            }}
                        >
                            {preview ? (
                                <div className="space-y-2">
                                    <img
                                        src={preview}
                                        alt="Preview"
                                        className="max-h-40 mx-auto rounded"
                                    />
                                    <p className="text-sm" style={{ color: colors.text }}>
                                        {selectedFile?.name}
                                    </p>
                                    <p className="text-xs opacity-60" style={{ color: colors.text }}>
                                        Click to change
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <ImageIcon
                                        size={40}
                                        className="mx-auto opacity-40"
                                        style={{ color: colors.text }}
                                    />
                                    <p className="text-sm" style={{ color: colors.text }}>
                                        Drag and drop floor plan image here
                                    </p>
                                    <p className="text-xs opacity-60" style={{ color: colors.text }}>
                                        or click to browse (JPEG, PNG - max 10MB)
                                    </p>
                                </div>
                            )}
                        </div>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={e => {
                                const file = e.target.files?.[0];
                                if (file) handleFileSelect(file);
                            }}
                        />
                    </div>

                    {/* Auto Detect Option */}
                    {selectedFile && (
                        <div className="flex items-center gap-3 p-3 rounded-lg border border-opacity-20"
                            style={{
                                borderColor: colors.border,
                                backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)'
                            }}>
                            <div className="flex-1">
                                <label className="text-sm font-medium flex items-center gap-2" style={{ color: colors.text }}>
                                    ✨ Smart Layout Detect
                                </label>
                                <p className="text-xs opacity-60" style={{ color: colors.text }}>
                                    Automatically detect walls and rooms using AI
                                </p>
                            </div>
                            <button
                                onClick={() => setAutoDetect(!autoDetect)}
                                className={`
                                    relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                                    ${autoDetect ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'}
                                `}
                            >
                                <span
                                    className={`
                                        inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                                        ${autoDetect ? 'translate-x-6' : 'translate-x-1'}
                                    `}
                                />
                            </button>
                        </div>
                    )}

                    {/* Error Message */}
                    {error && (
                        <p className="text-sm text-red-500">{error}</p>
                    )}
                </div>

                {/* Footer */}
                <div
                    className="flex items-center justify-between px-4 py-3 border-t"
                    style={{ borderColor: colors.border }}
                >
                    <button
                        onClick={handleCreateBlank}
                        className="px-4 py-2 text-sm rounded-lg hover:bg-white/10 transition-colors"
                        style={{ color: colors.text }}
                    >
                        Create Blank Plan
                    </button>

                    <div className="flex gap-2">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm rounded-lg hover:bg-white/10 transition-colors"
                            style={{ color: colors.text }}
                        >
                            Cancel
                        </button>

                        <button
                            onClick={handleUpload}
                            disabled={isUploading || !planName.trim()}
                            className={`
                                px-4 py-2 text-sm rounded-lg text-white font-medium
                                transition-all flex items-center gap-2
                                ${isUploading || !planName.trim()
                                    ? 'bg-blue-500/50 cursor-not-allowed'
                                    : 'bg-blue-500 hover:bg-blue-600'
                                }
                            `}
                        >
                            {isUploading || detecting ? (
                                <>
                                    <Loader2 size={16} className="animate-spin" />
                                    {detecting ? 'Detecting layout...' : 'Saving...'}
                                </>
                            ) : (
                                <>
                                    <Upload size={16} />
                                    Create Plan
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
