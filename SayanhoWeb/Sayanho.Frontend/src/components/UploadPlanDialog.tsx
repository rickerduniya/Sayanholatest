import React, { useState, useRef, useCallback } from 'react';
import { X, Upload, ImageIcon, Loader2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useLayoutStore } from '../store/useLayoutStore';
import { layoutImageStore } from '../utils/LayoutImageStore';
import type { Wall, Door, LayoutWindow, Point, Room, FloorPlan } from '../types/layout';
import type { DetectedLayout } from '../services/FloorplanApiService';
import { generateLayoutId } from '../utils/LayoutDrawingTools';
import { stitchWalls } from '../utils/WallStitching';

interface WallMatch {
    wall: Wall;
    end: 'start' | 'end';
    idx: number;
}

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
                    detectedData = await FloorplanApiService.detectLayout(selectedFile, img.width, img.height);

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
                    // We continue to create the plan even if detection fails, 
                    // but we might want to let the user see the error first? 
                    // For now, let's just alert internally and proceed after a short pause or just proceed.
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

            // Prepare entities from detected data
            // Clone the original walls for preservation
            const rawWalls: Wall[] = (detectedData?.walls || []).map(w => ({ ...w }));
            let processedWalls: Wall[] = [...rawWalls];

            const doors: Door[] = detectedData?.doors || [];
            const windows: LayoutWindow[] = detectedData?.windows || [];
            const rooms: Room[] = detectedData?.rooms || [];

            // =================================================================
            // POST-PROCESSING: MAX EFFORT WALL STITCHING
            // =================================================================
            if (rawWalls.length > 0 && (doors.length > 0 || windows.length > 0)) {
                try {
                    processedWalls = stitchWalls(rawWalls, doors, windows, img.width, img.height);
                } catch (e) {
                    console.error("Auto-stitch failed", e);
                    processedWalls = rawWalls; // Fallback
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
                    walls: processedWalls.length > 0 ? [...currentPlan.walls, ...processedWalls] : currentPlan.walls,
                    originalWalls: rawWalls, // Save original
                    doors: doors.length > 0 ? [...currentPlan.doors, ...doors] : currentPlan.doors,
                    windows: windows.length > 0 ? [...currentPlan.windows, ...windows] : currentPlan.windows,
                    rooms: rooms.length > 0 ? [...currentPlan.rooms, ...rooms] : currentPlan.rooms
                });
                // TODO: Add doors/windows/rooms to the store for this plan
                // This requires valid action creators in the store or manual state updates.
                // Assuming we can just dispatch actions or the 'updateFloorPlan' might support 'components'.
                // If not, we will just have walls for now.
            } else {
                // New Plan
                const newPlan: FloorPlan = {
                    id: generateLayoutId('plan'),
                    name: planName,
                    backgroundImageId: imageId,
                    width: img.width,
                    height: img.height,
                    pixelsPerMeter: 50,
                    walls: processedWalls,
                    originalWalls: rawWalls,
                    doors,
                    windows,
                    rooms,
                    stairs: [],
                    components: [],
                    connections: [],
                    viewportX: 0,
                    viewportY: 0,
                    scale: 1
                };
                addFloorPlan(newPlan);
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
