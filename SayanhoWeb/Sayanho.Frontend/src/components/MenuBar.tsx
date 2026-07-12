import React, { useState, useRef, useEffect } from 'react';
import { useTheme } from '../context/ThemeContext';

interface MenuBarProps {
    onLoad: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onSaveImage: () => void;
    onSettings: () => void;
    onGenerateEstimate: () => void;
    onOpenVoltageDrop: () => void;
    onOpenNetworkMonitor: () => void;
    onSaveLocal: () => void;
    onLoadLocal: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
    onLoad, onSave, onSaveAs, onSaveImage,
    onSettings, onGenerateEstimate, onOpenVoltageDrop, onOpenNetworkMonitor,
    onSaveLocal, onLoadLocal
}) => {
    const { colors } = useTheme();
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setActiveMenu(null);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    const handleMenuClick = (menuName: string) => {
        setActiveMenu(activeMenu === menuName ? null : menuName);
    };

    const MenuItem: React.FC<{ label: string; onClick?: () => void }> = ({ label, onClick }) => (
        <div
            className="px-4 py-1 hover:bg-blue-500 hover:text-white cursor-pointer text-sm whitespace-nowrap"
            onClick={(e) => {
                e.stopPropagation();
                if (onClick) onClick();
                setActiveMenu(null);
            }}
            style={{ color: colors.text }}
        >
            {label}
        </div>
    );

    const MenuSeparator = () => (
        <div className="h-px bg-gray-300 my-1" />
    );

    return (
        <div
            className="flex items-center h-6 px-1 select-none z-50 relative"
            style={{ color: colors.menuText }}
            ref={menuRef}
        >
            {/* File Menu */}
            <div className="relative">
                <div
                    className={`px-2 py-0.5 cursor-pointer hover:bg-blue-100 ${activeMenu === 'File' ? 'bg-blue-200' : ''}`}
                    onClick={() => handleMenuClick('File')}
                    style={{ color: colors.menuText }}
                >
                    File
                </div>
                {activeMenu === 'File' && (
                    <div
                        className="absolute left-0 top-full min-w-[200px] shadow-lg border py-1 z-50"
                        style={{ backgroundColor: colors.panelBackground, borderColor: colors.border }}
                    >
                        <MenuItem label="Load Project" onClick={onLoad} />
                        <MenuItem label="Save Project" onClick={onSave} />
                        <MenuItem label="Save Project As..." onClick={onSaveAs} />
                        <MenuSeparator />
                        <MenuItem label="Save to File" onClick={onSaveLocal} />
                        <MenuItem label="Load from File" onClick={onLoadLocal} />
                        <MenuSeparator />
                        <MenuItem label="Save as Image" onClick={onSaveImage} />
                        <MenuSeparator />
                        <MenuItem label="Generate Estimate" onClick={onGenerateEstimate} />
                        <MenuSeparator />
                        <MenuItem label="Settings" onClick={onSettings} />
                    </div>
                )}
            </div>

            {/* Tools Menu */}
            <div className="relative">
                <div
                    className={`px-2 py-0.5 cursor-pointer hover:bg-blue-100 ${activeMenu === 'Tools' ? 'bg-blue-200' : ''}`}
                    onClick={() => handleMenuClick('Tools')}
                    style={{ color: colors.menuText }}
                >
                    Tools
                </div>
                {activeMenu === 'Tools' && (
                    <div
                        className="absolute left-0 top-full min-w-[200px] shadow-lg border py-1 z-50"
                        style={{ backgroundColor: colors.panelBackground, borderColor: colors.border }}
                    >
                        <MenuItem
                            label="Calculate Voltage Drop"
                            onClick={onOpenVoltageDrop}
                        />
                        <MenuItem
                            label="Network Monitor"
                            onClick={onOpenNetworkMonitor}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};
