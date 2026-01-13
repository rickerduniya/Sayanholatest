// View Mode Toggle - Switch between SLD and Layout views

import React from 'react';
import { useLayoutStore } from '../store/useLayoutStore';
import { useTheme } from '../context/ThemeContext';
import { Zap, Home } from 'lucide-react';
import { ViewMode } from '../types/layout';

export const ViewModeToggle: React.FC = () => {
    const { colors, theme } = useTheme();
    const { activeView, setActiveView, setActiveTool } = useLayoutStore();

    const modes: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
        { key: 'sld', label: 'SLD', icon: <Zap size={14} /> },
        { key: 'layout', label: 'Layout', icon: <Home size={14} /> }
    ];

    return (
        <div
            className="flex items-center rounded-full p-0.5"
            style={{ backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}
        >
            {modes.map(mode => (
                <button
                    key={mode.key}
                    onClick={() => {
                        setActiveView(mode.key);
                        if (mode.key === 'layout') {
                            setActiveTool('select');
                        }
                    }}
                    className={`
                        flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium
                        transition-all duration-200
                        ${activeView === mode.key
                            ? 'bg-blue-500 text-white shadow-md'
                            : 'hover:bg-white/10'
                        }
                    `}
                    style={activeView === mode.key ? {} : { color: colors.text }}
                >
                    {mode.icon}
                    {mode.label}
                </button>
            ))}
        </div>
    );
};
