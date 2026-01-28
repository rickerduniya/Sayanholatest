const SETTINGS_KEY = 'sayanho_app_settings';

export interface AppSettings {
    safetyMarginPercentage: number;
    voltageDropEnabled: boolean;
    maxVoltageDropPercentage: number;
    diversificationFactors: Record<string, number>;
    saveImageInColor: boolean;
    showCurrentValues: boolean;
    showCableSpecs: boolean;
    connectorSpecTextFontSize: number;
    aiSettings: {
        provider: 'gemini' | 'groq' | 'openrouter' | 'mistral';
        geminiApiKey: string;
        geminiModelName: string;
        groqApiKey: string;
        groqModelName: string;
        groqBaseUrl: string;
        openrouterApiKey: string;
        openrouterModelName: string;
        openrouterBaseUrl: string;
        openrouterReferer: string;
        openrouterTitle: string;
        openrouterReasoningEnabled: boolean;
        openrouterReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
        openrouterReasoningExclude: boolean;
        mistralApiKey: string;
        mistralModelName: string;
        mistralBaseUrl: string;
        requestsPerMinute: number;
        maxRetryAttempts: number;
        retryOnError: boolean;
        maxToolTurns: number;
        maxToolCalls: number;
        apiKey?: string;
        modelName?: string;
        baseUrl?: string;
        extraHeaders?: Record<string, string>;
    };
}

const DEFAULT_SETTINGS: AppSettings = {
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

export class ApplicationSettings {
    static load(): AppSettings {
        try {
            const stored = localStorage.getItem(SETTINGS_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);

                // Migration: Auto-update legacy/invalid model names
                if (parsed.aiSettings) {
                    const legacyApiKey = parsed.aiSettings.apiKey;
                    const legacyModelName = parsed.aiSettings.modelName;
                    const legacyBaseUrl = parsed.aiSettings.baseUrl;

                    if (!parsed.aiSettings.provider) parsed.aiSettings.provider = 'gemini';
                    if (!parsed.aiSettings.geminiApiKey && legacyApiKey) parsed.aiSettings.geminiApiKey = legacyApiKey;
                    if (!parsed.aiSettings.geminiModelName && legacyModelName) parsed.aiSettings.geminiModelName = legacyModelName;
                    if (!parsed.aiSettings.groqBaseUrl && legacyBaseUrl) parsed.aiSettings.groqBaseUrl = legacyBaseUrl;
                    if (!parsed.aiSettings.openrouterBaseUrl && legacyBaseUrl) parsed.aiSettings.openrouterBaseUrl = legacyBaseUrl;

                    if (parsed.aiSettings.geminiModelName === 'gemini-1.5-flash' || parsed.aiSettings.geminiModelName === 'gemini-1.5-flash-latest') {
                        parsed.aiSettings.geminiModelName = 'gemini-2.5-flash';
                    }
                }

                // Migration: Auto-update legacy max voltage drop
                let mv = parsed.maxVoltageDropPercentage;
                // Handle possible string type from legacy storage
                if (typeof mv === 'string') mv = parseFloat(mv);

                // Check for 3.0 (allow small epsilon just in case, or exact 3)
                if (typeof mv === 'number' && Math.abs(mv - 3.0) < 0.1) {
                    parsed.maxVoltageDropPercentage = 7.0;
                    // Force save the migrated value so we don't rely on this check forever
                    // Merging with defaults here to be safe
                    const migrated = {
                        ...DEFAULT_SETTINGS,
                        ...parsed,
                        maxVoltageDropPercentage: 7.0
                    };
                    try {
                        localStorage.setItem(SETTINGS_KEY, JSON.stringify(migrated));
                    } catch (e) {
                        console.error("Failed to save migrated settings", e);
                    }
                }

                // Merge with defaults to ensure all keys exist
                return {
                    ...DEFAULT_SETTINGS,
                    ...parsed,
                    diversificationFactors: {
                        ...DEFAULT_SETTINGS.diversificationFactors,
                        ...(parsed.diversificationFactors || {})
                    },
                    aiSettings: {
                        ...DEFAULT_SETTINGS.aiSettings,
                        ...(parsed.aiSettings || {})
                    }
                };
            }
        } catch (e) {
            console.error("Failed to load settings", e);
        }
        return { ...DEFAULT_SETTINGS };
    }

    static save(settings: AppSettings): void {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.error("Failed to save settings", e);
        }
    }

    static getSafetyMarginPercentage(): number {
        return this.load().safetyMarginPercentage;
    }

    static getDiversificationFactor(loadType: string): number {
        const settings = this.load();
        return settings.diversificationFactors[loadType] || 1.0;
    }

    static getVoltageDropEnabled(): boolean {
        return this.load().voltageDropEnabled;
    }

    static getMaxVoltageDropPercentage(): number {
        return this.load().maxVoltageDropPercentage;
    }

    static getSaveImageInColor(): boolean {
        return this.load().saveImageInColor;
    }

    static getShowCurrentValues(): boolean {
        return this.load().showCurrentValues;
    }

    static getShowCableSpecs(): boolean {
        return this.load().showCableSpecs;
    }

    static getConnectorSpecTextFontSize(): number {
        return this.load().connectorSpecTextFontSize;
    }

    static getAiSettings() {
        const ai = this.load().aiSettings;
        const provider = ai.provider || 'gemini';
        const common = {
            requestsPerMinute: typeof ai.requestsPerMinute === 'number' ? ai.requestsPerMinute : DEFAULT_SETTINGS.aiSettings.requestsPerMinute,
            maxRetryAttempts: typeof ai.maxRetryAttempts === 'number' ? ai.maxRetryAttempts : DEFAULT_SETTINGS.aiSettings.maxRetryAttempts,
            retryOnError: typeof ai.retryOnError === 'boolean' ? ai.retryOnError : DEFAULT_SETTINGS.aiSettings.retryOnError,
            maxToolTurns: typeof ai.maxToolTurns === 'number' ? ai.maxToolTurns : DEFAULT_SETTINGS.aiSettings.maxToolTurns,
            maxToolCalls: typeof ai.maxToolCalls === 'number' ? ai.maxToolCalls : DEFAULT_SETTINGS.aiSettings.maxToolCalls
        };
        if (provider === 'groq') {
            return {
                provider,
                apiKey: ai.groqApiKey || '',
                modelName: ai.groqModelName || 'llama-3.1-8b-instant',
                baseUrl: ai.groqBaseUrl || 'https://api.groq.com/openai/v1',
                ...common
            };
        }
        if (provider === 'openrouter') {
            const extraHeaders: Record<string, string> = {};
            if ((ai.openrouterReferer || '').trim()) extraHeaders['HTTP-Referer'] = ai.openrouterReferer.trim();
            if ((ai.openrouterTitle || '').trim()) extraHeaders['X-Title'] = ai.openrouterTitle.trim();
            return {
                provider,
                apiKey: ai.openrouterApiKey || '',
                modelName: ai.openrouterModelName || 'openai/gpt-4o-mini',
                baseUrl: ai.openrouterBaseUrl || 'https://openrouter.ai/api/v1',
                reasoning: {
                    enabled: typeof ai.openrouterReasoningEnabled === 'boolean' ? ai.openrouterReasoningEnabled : DEFAULT_SETTINGS.aiSettings.openrouterReasoningEnabled,
                    effort: (ai.openrouterReasoningEffort || DEFAULT_SETTINGS.aiSettings.openrouterReasoningEffort) as any,
                    exclude: typeof ai.openrouterReasoningExclude === 'boolean' ? ai.openrouterReasoningExclude : DEFAULT_SETTINGS.aiSettings.openrouterReasoningExclude
                },
                ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
                ...common
            };
        }
        if (provider === 'mistral') {
            return {
                provider,
                apiKey: ai.mistralApiKey || '',
                modelName: ai.mistralModelName || 'mistral-small-latest',
                baseUrl: ai.mistralBaseUrl || 'https://api.mistral.ai/v1',
                ...common
            };
        }
        return {
            provider: 'gemini' as const,
            apiKey: ai.geminiApiKey || '',
            modelName: ai.geminiModelName || 'gemini-2.5-flash',
            baseUrl: '',
            ...common
        };
    }
}

