import React, { useState, useEffect } from 'react';
import { ApplicationSettings, AppSettings } from '../utils/ApplicationSettings';
import { useTheme } from '../context/ThemeContext';
import { useStore } from '../store/useStore';

interface SettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void;
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose, onSave }) => {
    const { colors } = useTheme();
    const { settings: storeSettings, updateSettings } = useStore();
    const [activeTab, setActiveTab] = useState<'calculation' | 'image' | 'ai'>('calculation');
    const [settings, setSettings] = useState<AppSettings | null>(null);

    useEffect(() => {
        if (isOpen) {
            // Load from local storage first to get full settings object (including AI, diversification, etc.)
            // Then overlay store settings to ensure sync
            const loaded = ApplicationSettings.load();
            setSettings({
                ...loaded,
                maxVoltageDropPercentage: storeSettings.maxVoltageDropPercentage,
                safetyMarginPercentage: storeSettings.safetyMarginPercentage,
                voltageDropEnabled: storeSettings.voltageDropEnabled
            });
        }
    }, [isOpen, storeSettings]);

    if (!isOpen || !settings) return null;

    const handleSave = () => {
        if (settings) {
            ApplicationSettings.save(settings);
            // Update store with relevant settings
            updateSettings({
                maxVoltageDropPercentage: settings.maxVoltageDropPercentage,
                safetyMarginPercentage: settings.safetyMarginPercentage,
                voltageDropEnabled: settings.voltageDropEnabled
            });
            onSave();
            onClose();
        }
    };

    const handleReset = () => {
        if (confirm("Reset all settings to default values?")) {
            // Re-load defaults by clearing storage or just creating a new default object
            // Since ApplicationSettings.load() handles defaults if storage is empty, 
            // we can just manually set defaults here or clear storage. 
            // Let's use the default object structure directly.
            const defaults: AppSettings = {
                safetyMarginPercentage: 25.0,
                voltageDropEnabled: true,
                maxVoltageDropPercentage: 7.0,
                diversificationFactors: {
                    "Bulb": 1.0,
                    "Tube Light": 1.0,
                    "Ceiling Fan": 1.0,
                    "Exhaust Fan": 1.0,
                    "Split AC": 1.0,
                    "Geyser": 1.0,
                    "Call Bell": 1.0
                },
                saveImageInColor: true,
                showCurrentValues: true,
                showCableSpecs: true,
                connectorSpecTextFontSize: 10,
                aiSettings: {
                    provider: 'gemini',
                    geminiApiKey: '',
                    geminiModelName: 'gemini-2.5-flash',
                    groqApiKey: '',
                    groqModelName: 'llama-3.1-8b-instant',
                    groqBaseUrl: 'https://api.groq.com/openai/v1',
                    openrouterApiKey: '',
                    openrouterModelName: 'openai/gpt-4o-mini',
                    openrouterBaseUrl: 'https://openrouter.ai/api/v1',
                    openrouterReferer: '',
                    openrouterTitle: '',
                    openrouterReasoningEnabled: true,
                    openrouterReasoningEffort: 'medium',
                    openrouterReasoningExclude: false,
                    mistralApiKey: '',
                    mistralModelName: 'mistral-small-latest',
                    mistralBaseUrl: 'https://api.mistral.ai/v1',
                    requestsPerMinute: 30,
                    maxRetryAttempts: 2,
                    retryOnError: true,
                    maxToolTurns: 24,
                    maxToolCalls: 60
                }
            };
            setSettings(defaults);
        }
    };

    const updateDiversificationFactor = (key: string, value: number) => {
        setSettings(prev => prev ? ({
            ...prev,
            diversificationFactors: {
                ...prev.diversificationFactors,
                [key]: value
            }
        }) : null);
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div
                className="w-[500px] rounded-lg shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
                style={{ backgroundColor: colors.panelBackground, color: colors.text }}
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-4 py-3 border-b flex justify-between items-center" style={{ borderColor: colors.border }}>
                    <h2 className="font-semibold text-lg">Application Settings</h2>
                    <button onClick={onClose} className="opacity-60 hover:opacity-100">&times;</button>
                </div>

                {/* Tabs */}
                <div className="flex border-b" style={{ borderColor: colors.border }}>
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activeTab === 'calculation' ? 'border-b-2 border-blue-500 text-blue-500' : 'opacity-70 hover:opacity-100'}`}
                        onClick={() => setActiveTab('calculation')}
                    >
                        Calculation Settings
                    </button>
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activeTab === 'image' ? 'border-b-2 border-blue-500 text-blue-500' : 'opacity-70 hover:opacity-100'}`}
                        onClick={() => setActiveTab('image')}
                    >
                        Save Image Settings
                    </button>
                    <button
                        className={`px-4 py-2 text-sm font-medium ${activeTab === 'ai' ? 'border-b-2 border-blue-500 text-blue-500' : 'opacity-70 hover:opacity-100'}`}
                        onClick={() => setActiveTab('ai')}
                    >
                        AI Settings
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto flex-1">
                    {activeTab === 'calculation' ? (
                        <div className="space-y-6">
                            {/* Safety Margin */}
                            <div className="flex items-center justify-between">
                                <label className="font-bold text-sm">Safety Margin (%):</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    step="0.1"
                                    value={settings.safetyMarginPercentage}
                                    onChange={e => setSettings({ ...settings, safetyMarginPercentage: parseFloat(e.target.value) })}
                                    className="w-24 px-2 py-1 rounded border text-right"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                />
                            </div>

                            {/* Voltage Drop */}
                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Voltage Drop Consideration:</label>
                                <div className="flex items-center">
                                    <input
                                        type="checkbox"
                                        checked={settings.voltageDropEnabled}
                                        onChange={e => setSettings({ ...settings, voltageDropEnabled: e.target.checked })}
                                        className="mr-2"
                                    />
                                    <span className="text-sm">Enable voltage drop calculation</span>
                                </div>
                                <div className="flex items-center justify-between ml-6">
                                    <span className="text-sm">Max Voltage Drop (%):</span>
                                    <input
                                        type="number"
                                        min="0.1"
                                        max="10"
                                        step="0.1"
                                        value={settings.maxVoltageDropPercentage}
                                        onChange={e => setSettings({ ...settings, maxVoltageDropPercentage: parseFloat(e.target.value) })}
                                        className="w-24 px-2 py-1 rounded border text-right"
                                        style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                    />
                                </div>
                            </div>

                            {/* Diversification Factors */}
                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Diversification Factors:</label>
                                <div className="grid grid-cols-1 gap-2 pl-4">
                                    {Object.entries(settings.diversificationFactors).map(([key, value]) => (
                                        <div key={key} className="flex items-center justify-between">
                                            <span className="text-sm">{key}:</span>
                                            <input
                                                type="number"
                                                min="0.1"
                                                max="2.0"
                                                step="0.05"
                                                value={value}
                                                onChange={e => updateDiversificationFactor(key, parseFloat(e.target.value))}
                                                className="w-24 px-2 py-1 rounded border text-right"
                                                style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                    ) : activeTab === 'ai' ? (
                        <div className="space-y-6">
                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Provider:</label>
                                <select
                                    value={settings.aiSettings?.provider || 'gemini'}
                                    onChange={e => setSettings({
                                        ...settings,
                                        aiSettings: { ...settings.aiSettings, provider: e.target.value as any }
                                    })}
                                    className="w-full px-3 py-2 rounded border"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                >
                                    <option value="gemini">Gemini</option>
                                    <option value="groq">Groq</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="mistral">Mistral</option>
                                </select>
                            </div>

                            {(settings.aiSettings?.provider || 'gemini') === 'gemini' ? (
                                <>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Gemini API Key:</label>
                                        <input
                                            type="password"
                                            value={(settings.aiSettings as any)?.geminiApiKey || ''}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, geminiApiKey: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="AIza..."
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Gemini Model Name:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.geminiModelName || 'gemini-2.5-flash'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, geminiModelName: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="e.g. gemini-2.5-flash"
                                        />
                                    </div>
                                </>
                            ) : (settings.aiSettings?.provider === 'groq') ? (
                                <>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Groq API Key:</label>
                                        <input
                                            type="password"
                                            value={(settings.aiSettings as any)?.groqApiKey || ''}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, groqApiKey: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="gsk_..."
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Groq Model:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.groqModelName || 'llama-3.1-8b-instant'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, groqModelName: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="e.g. llama-3.1-8b-instant"
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Groq Base URL:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.groqBaseUrl || 'https://api.groq.com/openai/v1'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, groqBaseUrl: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="https://api.groq.com/openai/v1"
                                        />
                                    </div>
                                </>
                            ) : (settings.aiSettings?.provider === 'openrouter') ? (
                                <>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">OpenRouter API Key:</label>
                                        <input
                                            type="password"
                                            value={(settings.aiSettings as any)?.openrouterApiKey || ''}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, openrouterApiKey: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="sk-or-..."
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">OpenRouter Model:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.openrouterModelName || 'openai/gpt-4o-mini'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, openrouterModelName: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="e.g. moonshotai/kimi-k2-instruct-0905"
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">OpenRouter Base URL:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.openrouterBaseUrl || 'https://openrouter.ai/api/v1'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, openrouterBaseUrl: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="https://openrouter.ai/api/v1"
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">HTTP-Referer (Optional):</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.openrouterReferer || ''}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, openrouterReferer: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="https://yourapp.example"
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">X-Title (Optional):</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.openrouterTitle || ''}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, openrouterTitle: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="Sayanho"
                                        />
                                    </div>

                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Reasoning tokens:</label>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                checked={(settings.aiSettings as any)?.openrouterReasoningEnabled ?? true}
                                                onChange={e => setSettings({
                                                    ...settings,
                                                    aiSettings: { ...settings.aiSettings, openrouterReasoningEnabled: e.target.checked }
                                                })}
                                            />
                                            <span className="text-sm">Enable reasoning (OpenRouter reasoning config)</span>
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Reasoning effort:</label>
                                        <select
                                            value={(settings.aiSettings as any)?.openrouterReasoningEffort || 'medium'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, openrouterReasoningEffort: e.target.value as any }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                        >
                                            <option value="minimal">minimal</option>
                                            <option value="low">low</option>
                                            <option value="medium">medium</option>
                                            <option value="high">high</option>
                                            <option value="xhigh">xhigh</option>
                                        </select>
                                    </div>

                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Exclude reasoning from response:</label>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                checked={(settings.aiSettings as any)?.openrouterReasoningExclude ?? false}
                                                onChange={e => setSettings({
                                                    ...settings,
                                                    aiSettings: { ...settings.aiSettings, openrouterReasoningExclude: e.target.checked }
                                                })}
                                            />
                                            <span className="text-sm">Hide reasoning text (still used internally)</span>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Mistral API Key:</label>
                                        <input
                                            type="password"
                                            value={(settings.aiSettings as any)?.mistralApiKey || ''}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, mistralApiKey: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder=""
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Mistral Model:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.mistralModelName || 'mistral-small-latest'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, mistralModelName: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="e.g. mistral-small-latest"
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <label className="font-bold text-sm block">Mistral Base URL:</label>
                                        <input
                                            type="text"
                                            value={(settings.aiSettings as any)?.mistralBaseUrl || 'https://api.mistral.ai/v1'}
                                            onChange={e => setSettings({
                                                ...settings,
                                                aiSettings: { ...settings.aiSettings, mistralBaseUrl: e.target.value }
                                            })}
                                            className="w-full px-3 py-2 rounded border"
                                            style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                            placeholder="https://api.mistral.ai/v1"
                                        />
                                    </div>
                                </>
                            )}

                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Requests per minute:</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="600"
                                    step="1"
                                    value={(settings.aiSettings as any)?.requestsPerMinute ?? 30}
                                    onChange={e => setSettings({
                                        ...settings,
                                        aiSettings: { ...settings.aiSettings, requestsPerMinute: Math.max(1, Math.min(600, parseInt(e.target.value || '1', 10))) }
                                    })}
                                    className="w-full px-3 py-2 rounded border"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                />
                            </div>

                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Retry on error:</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={(settings.aiSettings as any)?.retryOnError ?? true}
                                        onChange={e => setSettings({
                                            ...settings,
                                            aiSettings: { ...settings.aiSettings, retryOnError: e.target.checked }
                                        })}
                                    />
                                    <span className="text-sm">Retry when the API says “retry after … seconds”</span>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Max retry attempts:</label>
                                <input
                                    type="number"
                                    min="0"
                                    max="10"
                                    step="1"
                                    value={(settings.aiSettings as any)?.maxRetryAttempts ?? 2}
                                    onChange={e => setSettings({
                                        ...settings,
                                        aiSettings: { ...settings.aiSettings, maxRetryAttempts: Math.max(0, Math.min(10, parseInt(e.target.value || '0', 10))) }
                                    })}
                                    className="w-full px-3 py-2 rounded border"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                />
                            </div>

                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Max tool turns:</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="100"
                                    step="1"
                                    value={(settings.aiSettings as any)?.maxToolTurns ?? 24}
                                    onChange={e => setSettings({
                                        ...settings,
                                        aiSettings: { ...settings.aiSettings, maxToolTurns: Math.max(1, Math.min(100, parseInt(e.target.value || '1', 10))) }
                                    })}
                                    className="w-full px-3 py-2 rounded border"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                />
                            </div>

                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Max tool calls:</label>
                                <input
                                    type="number"
                                    min="1"
                                    max="300"
                                    step="1"
                                    value={(settings.aiSettings as any)?.maxToolCalls ?? 60}
                                    onChange={e => setSettings({
                                        ...settings,
                                        aiSettings: { ...settings.aiSettings, maxToolCalls: Math.max(1, Math.min(300, parseInt(e.target.value || '1', 10))) }
                                    })}
                                    className="w-full px-3 py-2 rounded border"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                />
                            </div>

                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Legacy Base URL (Unused):</label>
                                <input
                                    type="text"
                                    value={(settings.aiSettings as any)?.baseUrl || ''}
                                    onChange={e => setSettings({
                                        ...settings,
                                        aiSettings: { ...settings.aiSettings, baseUrl: e.target.value }
                                    })}
                                    className="w-full px-3 py-2 rounded border"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                    placeholder=""
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {/* Color Mode */}
                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Image Color Mode:</label>
                                <div className="pl-4 space-y-2">
                                    <div className="flex items-center">
                                        <input
                                            type="radio"
                                            name="colorMode"
                                            checked={settings.saveImageInColor}
                                            onChange={() => setSettings({ ...settings, saveImageInColor: true })}
                                            className="mr-2"
                                        />
                                        <span className="text-sm">Color</span>
                                    </div>
                                    <div className="flex items-center">
                                        <input
                                            type="radio"
                                            name="colorMode"
                                            checked={!settings.saveImageInColor}
                                            onChange={() => setSettings({ ...settings, saveImageInColor: false })}
                                            className="mr-2"
                                        />
                                        <span className="text-sm">Black and White</span>
                                    </div>
                                </div>
                            </div>

                            {/* Display Options */}
                            <div className="space-y-3">
                                <label className="font-bold text-sm block">Display Options:</label>
                                <div className="pl-4 space-y-2">
                                    <div className="flex items-center">
                                        <input
                                            type="checkbox"
                                            checked={settings.showCurrentValues}
                                            onChange={e => setSettings({ ...settings, showCurrentValues: e.target.checked })}
                                            className="mr-2"
                                        />
                                        <span className="text-sm">Show current values</span>
                                    </div>
                                    <div className="flex items-center">
                                        <input
                                            type="checkbox"
                                            checked={settings.showCableSpecs}
                                            onChange={e => setSettings({ ...settings, showCableSpecs: e.target.checked })}
                                            className="mr-2"
                                        />
                                        <span className="text-sm">Show cable specifications</span>
                                    </div>
                                </div>
                            </div>

                            {/* Connector Spec Text Font Size */}
                            <div className="flex items-center justify-between">
                                <label className="font-bold text-sm">Connector Spec Text Font Size:</label>
                                <input
                                    type="number"
                                    min="6"
                                    max="20"
                                    step="1"
                                    value={settings.connectorSpecTextFontSize}
                                    onChange={e => setSettings({ ...settings, connectorSpecTextFontSize: parseInt(e.target.value) })}
                                    className="w-24 px-2 py-1 rounded border text-right"
                                    style={{ backgroundColor: colors.canvasBackground, borderColor: colors.border, color: colors.text }}
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t flex justify-end space-x-3" style={{ borderColor: colors.border, backgroundColor: colors.panelBackground }}>
                    <button
                        onClick={handleReset}
                        className="px-4 py-2 text-sm rounded hover:bg-gray-200 dark:hover:bg-gray-700 mr-auto"
                        style={{ color: colors.text }}
                    >
                        Reset to Defaults
                    </button>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                        style={{ color: colors.text }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                        OK
                    </button>
                </div>
            </div>

        </div>
    );
};
