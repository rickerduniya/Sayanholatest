// Scale Calibration Dialog - Set pixels per meter for accurate measurements
// User draws a known distance on the floor plan to calibrate scale

import React, { useState, useEffect } from 'react';
import { X, Ruler, Check, RotateCcw } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useLayoutStore } from '../store/useLayoutStore';

interface ScaleCalibrationDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

export const ScaleCalibrationDialog: React.FC<ScaleCalibrationDialogProps> = ({
    isOpen,
    onClose
}) => {
    const { colors, theme } = useTheme();
    const { getCurrentFloorPlan, updateFloorPlan } = useLayoutStore();

    const currentPlan = getCurrentFloorPlan();

    const [knownDistance, setKnownDistance] = useState('1');
    const [unit, setUnit] = useState<'m' | 'ft'>('m');
    const [pixelDistance, setPixelDistance] = useState('100');
    const [calibrated, setCalibrated] = useState(false);

    // Calculate pixels per meter
    const calculatePixelsPerMeter = (): number => {
        const knowDistValue = parseFloat(knownDistance) || 1;
        const pixelValue = parseFloat(pixelDistance) || 100;

        // Convert feet to meters if needed
        const distanceInMeters = unit === 'ft' ? knowDistValue * 0.3048 : knowDistValue;

        return pixelValue / distanceInMeters;
    };

    const handleCalibrate = () => {
        if (!currentPlan) return;

        const ppm = calculatePixelsPerMeter();
        updateFloorPlan(currentPlan.id, { pixelsPerMeter: ppm });
        setCalibrated(true);

        // Reset after showing success
        setTimeout(() => {
            onClose();
            setCalibrated(false);
        }, 1500);
    };

    const handleReset = () => {
        if (!currentPlan) return;
        updateFloorPlan(currentPlan.id, { pixelsPerMeter: 50 }); // Default value
        setKnownDistance('1');
        setPixelDistance('100');
    };

    // Calculate example measurements
    const ppm = calculatePixelsPerMeter();
    const roomWidth4m = (4 * ppm).toFixed(0);
    const doorWidth1m = (1 * ppm).toFixed(0);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fade-in">
            <div
                className="w-full max-w-md rounded-2xl shadow-2xl p-6 animate-scale-in"
                style={{ backgroundColor: colors.menuBackground }}
            >
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-blue-500/10">
                            <Ruler className="text-blue-500" size={24} />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold" style={{ color: colors.text }}>
                                Scale Calibration
                            </h2>
                            <p className="text-xs opacity-60" style={{ color: colors.text }}>
                                Set the scale for accurate measurements
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                    >
                        <X size={20} style={{ color: colors.text }} />
                    </button>
                </div>

                {/* Calibration Form */}
                <div className="space-y-6">
                    {/* Known Distance Input */}
                    <div>
                        <label className="block text-sm font-medium mb-2" style={{ color: colors.text }}>
                            Known Real-World Distance
                        </label>
                        <div className="flex gap-2">
                            <input
                                type="number"
                                value={knownDistance}
                                onChange={(e) => setKnownDistance(e.target.value)}
                                placeholder="1"
                                step="0.1"
                                min="0.1"
                                className="flex-1 px-4 py-2 rounded-lg text-sm bg-white/10 border border-white/20 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                style={{ color: colors.text }}
                            />
                            <select
                                value={unit}
                                onChange={(e) => setUnit(e.target.value as 'm' | 'ft')}
                                className="px-4 py-2 rounded-lg text-sm bg-white/10 border border-white/20 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                style={{ color: colors.text }}
                            >
                                <option value="m">meters</option>
                                <option value="ft">feet</option>
                            </select>
                        </div>
                        <p className="text-xs opacity-50 mt-1" style={{ color: colors.text }}>
                            Enter the actual distance you measured on your floor plan
                        </p>
                    </div>

                    {/* Pixel Distance Input */}
                    <div>
                        <label className="block text-sm font-medium mb-2" style={{ color: colors.text }}>
                            Distance in Pixels (on screen)
                        </label>
                        <input
                            type="number"
                            value={pixelDistance}
                            onChange={(e) => setPixelDistance(e.target.value)}
                            placeholder="100"
                            step="1"
                            min="1"
                            className="w-full px-4 py-2 rounded-lg text-sm bg-white/10 border border-white/20 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            style={{ color: colors.text }}
                        />
                        <p className="text-xs opacity-50 mt-1" style={{ color: colors.text }}>
                            Draw a line on your floor plan and note the pixel length
                        </p>
                    </div>

                    {/* Preview */}
                    <div
                        className="p-4 rounded-lg"
                        style={{ backgroundColor: theme === 'dark' ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.05)' }}
                    >
                        <div className="text-xs font-medium mb-3" style={{ color: colors.text }}>
                            Calculated Scale Preview
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                                <span className="text-xs opacity-60" style={{ color: colors.text }}>Pixels per Meter:</span>
                                <div className="font-mono font-bold text-blue-500">
                                    {ppm.toFixed(1)} px/m
                                </div>
                            </div>
                            <div>
                                <span className="text-xs opacity-60" style={{ color: colors.text }}>4m Room Width:</span>
                                <div className="font-mono" style={{ color: colors.text }}>
                                    {roomWidth4m} px
                                </div>
                            </div>
                            <div>
                                <span className="text-xs opacity-60" style={{ color: colors.text }}>1m Door Width:</span>
                                <div className="font-mono" style={{ color: colors.text }}>
                                    {doorWidth1m} px
                                </div>
                            </div>
                            <div>
                                <span className="text-xs opacity-60" style={{ color: colors.text }}>Current Setting:</span>
                                <div className="font-mono" style={{ color: colors.text }}>
                                    {currentPlan?.pixelsPerMeter?.toFixed(1) || '50'} px/m
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-3">
                        <button
                            onClick={handleReset}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-white/20 hover:bg-white/10 transition-colors text-sm font-medium"
                            style={{ color: colors.text }}
                        >
                            <RotateCcw size={16} />
                            Reset to Default
                        </button>
                        <button
                            onClick={handleCalibrate}
                            disabled={calibrated}
                            className={`
                                flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-all
                                ${calibrated
                                    ? 'bg-green-500'
                                    : 'bg-blue-500 hover:bg-blue-600'}
                            `}
                        >
                            {calibrated ? (
                                <>
                                    <Check size={16} />
                                    Calibrated!
                                </>
                            ) : (
                                <>
                                    <Ruler size={16} />
                                    Apply Scale
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
