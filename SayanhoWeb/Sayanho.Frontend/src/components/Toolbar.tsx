import React from 'react';
import { useTheme } from '../context/ThemeContext';
import {
    Save, FolderOpen, ZoomIn, ZoomOut,
    PanelLeftClose, PanelLeftOpen,
    MenuSquare, MessageSquare,
    Zap, Type, Moon, Sun,
    Undo, Redo, Image as ImageIcon,
    MousePointer2, Hand, Calculator, Copy,
    Eye, EyeOff, RotateCcw, Maximize, LayoutGrid
} from 'lucide-react';

interface ToolbarProps {
    onLoad: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onSetZoom: (scale: number) => void;
    onResetZoom: () => void;
    onFitContent: () => void;
    scale: number;
    showLeftPanel: boolean;
    onToggleLeftPanel: () => void;
    showMenu: boolean;
    onToggleMenu: () => void;
    showChat: boolean;
    onToggleChat: () => void;
    onAutoRate: () => void;
    onAddText: () => void;
    onUndo: () => void;
    onRedo: () => void;
    panMode: boolean;
    onSetPanMode: (mode: boolean) => void;
    onCalculate: () => void;
    onAutoArrange: () => void;
    onCopyTrace: () => void;
    showCurrentValues: boolean;
    onToggleShowCurrentValues: () => void;
    isAddTextMode: boolean;
}

export const Toolbar: React.FC<ToolbarProps> = ({
    onLoad, onZoomIn, onZoomOut, onSetZoom, onResetZoom, onFitContent, scale,
    showLeftPanel, onToggleLeftPanel,
    showMenu, onToggleMenu,
    showChat, onToggleChat,
    onAutoRate, onAddText,
    onUndo, onRedo,
    panMode, onSetPanMode,
    onCalculate,
    onAutoArrange,
    onCopyTrace,
    showCurrentValues,
    onToggleShowCurrentValues,
    isAddTextMode
}) => {
    const { theme, toggleTheme, colors } = useTheme();

    const ToolbarButton: React.FC<{
        icon: React.ReactNode;
        onClick: () => void;
        tooltip: string;
        active?: boolean;
        disabled?: boolean;
    }> = ({ icon, onClick, tooltip, active, disabled }) => (
        <button
            onClick={onClick}
            disabled={disabled}
            title={tooltip}
            className={`p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${active ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : ''} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{ color: active ? undefined : colors.text }}
        >
            {icon}
        </button>
    );

    const ToolbarSeparator = () => (
        <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1" />
    );

    return (
        <div
            className="flex items-center h-8 px-2 gap-1"
            style={{ color: colors.text, backgroundColor: colors.panelBackground }}
        >
            {/* Moved to File Menu */}
            {/* <ToolbarButton icon={<FolderOpen size={16} />} onClick={onLoad} tooltip="Load Project" />
            <ToolbarButton icon={<Save size={16} />} onClick={onSave} tooltip="Save Project" />
            <ToolbarButton icon={<ImageIcon size={16} />} onClick={onSaveImage} tooltip="Save as Image" /> */}

            <ToolbarSeparator />

            <ToolbarButton
                icon={<MousePointer2 size={16} />}
                onClick={() => onSetPanMode(false)}
                tooltip="Select Mode"
                active={!panMode}
            />
            <ToolbarButton
                icon={<Hand size={16} />}
                onClick={() => onSetPanMode(true)}
                tooltip="Pan Mode"
                active={panMode}
            />

            <ToolbarSeparator />

            <ToolbarButton icon={<ZoomIn size={16} />} onClick={onZoomIn} tooltip="Zoom In" />

            <div className="flex items-center gap-1">
                <input
                    type="number"
                    value={Math.round(scale * 100)}
                    onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val) && val > 0 && val <= 500) {
                            onSetZoom(val / 100);
                        }
                    }}
                    className="w-12 text-xs text-center font-medium bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-0 appearance-none"
                    style={{ color: colors.text }}
                    min="10"
                    max="500"
                />
                <span className="text-xs font-medium -ml-1" style={{ color: colors.text }}>%</span>
            </div>

            <ToolbarButton icon={<ZoomOut size={16} />} onClick={onZoomOut} tooltip="Zoom Out" />
            <ToolbarButton icon={<RotateCcw size={14} />} onClick={onResetZoom} tooltip="Reset Zoom (65%)" />
            <ToolbarButton icon={<Maximize size={16} />} onClick={onFitContent} tooltip="Fit to Content" />
            <ToolbarButton icon={<LayoutGrid size={16} />} onClick={onAutoArrange} tooltip="Auto Arrange" />

            <ToolbarSeparator />

            <ToolbarButton
                icon={showLeftPanel ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                onClick={onToggleLeftPanel}
                tooltip="Toggle Left Panel"
                active={showLeftPanel}
            />
            <ToolbarButton
                icon={<MenuSquare size={16} />}
                onClick={onToggleMenu}
                tooltip="Toggle Menu"
                active={showMenu}
            />
            <ToolbarButton
                icon={<MessageSquare size={16} />}
                onClick={onToggleChat}
                tooltip="Toggle Chat Panel"
                active={showChat}
            />

            <ToolbarSeparator />

            <ToolbarButton icon={<Zap size={16} />} onClick={onAutoRate} tooltip="Auto Rating" />

            <ToolbarButton
                icon={showCurrentValues ? <Eye size={16} /> : <EyeOff size={16} />}
                onClick={onToggleShowCurrentValues}
                tooltip="Toggle Current Values"
                active={showCurrentValues}
            />
            <ToolbarButton icon={<Type size={16} />} onClick={onAddText} tooltip="Add Text Box" active={isAddTextMode} />


            <ToolbarSeparator />

            <ToolbarButton
                icon={theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
                onClick={toggleTheme}
                tooltip="Toggle Theme"
            />

            <ToolbarSeparator />

            <ToolbarButton icon={<Undo size={16} />} onClick={onUndo} tooltip="Undo" />
            <ToolbarButton icon={<Redo size={16} />} onClick={onRedo} tooltip="Redo" />
        </div>
    );
};
