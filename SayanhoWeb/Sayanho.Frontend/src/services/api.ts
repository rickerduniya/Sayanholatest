import axios from 'axios';
import { CanvasSheet, ItemData } from '../types';
import { apiTracer } from '../utils/apiTracer';
import { useStore } from '../store/useStore';
import { stripSheetsForApi, compressPayload, logPayloadStats, filterTextBoxesFromSheets } from '../utils/payloadUtils';

import { CacheService } from './CacheService';

const API_URL = import.meta.env.VITE_API_URL;
// Debug logging for API
const DEBUG = true;
let __reqId = 0;
if (DEBUG) {
    axios.interceptors.request.use((config) => {
        const rid = ++__reqId;
        const startTime = performance.now();
        (config as any).metadata = { start: startTime, rid };
        const method = (config.method || 'GET').toUpperCase();
        const url = config.url || '';
        const tracePayload = (config as any).tracePayload; // Check for uncompressed payload for tracing
        const body = config.data;
        const size = body instanceof Blob
            ? `blob(${body.size})`
            : (typeof body === 'string' ? `${body.length} chars` : (body ? 'json' : ''));
        console.log(`[API][REQ ${rid}] ${method} ${url}`, { params: config.params, size, body: body instanceof Blob ? undefined : body });

        // Add trace entry for request
        apiTracer.addTrace({
            id: rid,
            timestamp: new Date().toISOString(),
            method,
            url,
            requestHeaders: config.headers as Record<string, string>,
            requestBody: tracePayload || (body instanceof Blob ? `[Blob: ${body.size} bytes]` : body),
            requestParams: config.params
        });

        return config;
    });
    axios.interceptors.response.use(
        (response) => {
            const meta = (response.config as any).metadata || { start: performance.now(), rid: '?' };
            const dur = Math.round(performance.now() - meta.start);
            const rid = meta.rid;
            const isBlob = response.request?.responseType === 'blob' || response.data instanceof Blob;
            console.log(`[API][RES ${rid}] ${response.status} ${response.statusText} in ${dur}ms`, {
                url: response.config.url,
                data: isBlob ? `blob(${(response.data as Blob)?.size ?? '?'} bytes)` : response.data
            });

            // Update trace entry with response
            const traces = apiTracer.getTraces();
            const traceEntry = traces.find(t => t.id === rid);
            if (traceEntry) {
                traceEntry.duration = dur;
                traceEntry.responseStatus = response.status;
                traceEntry.responseStatusText = response.statusText;
                traceEntry.responseHeaders = response.headers as Record<string, string>;
                traceEntry.responseBody = isBlob
                    ? `[Blob: ${(response.data as Blob)?.size ?? '?'} bytes, type: ${(response.data as Blob)?.type ?? 'unknown'}]`
                    : response.data;
            }

            return response;
        },
        (error) => {
            const cfg = error.config || {};
            const meta = (cfg as any).metadata || { start: performance.now(), rid: '?' };
            const dur = Math.round(performance.now() - meta.start);
            const rid = meta.rid;
            console.warn(`[API][ERR ${rid}] in ${dur}ms`, {
                url: cfg.url,
                method: cfg.method,
                message: error.message,
                status: error.response?.status
            });

            // Update trace entry with error
            const traces = apiTracer.getTraces();
            const traceEntry = traces.find(t => t.id === rid);
            if (traceEntry) {
                traceEntry.duration = dur;
                traceEntry.error = error.message;
                if (error.response) {
                    traceEntry.responseStatus = error.response.status;
                    traceEntry.responseStatusText = error.response.statusText;
                    traceEntry.responseHeaders = error.response.headers as Record<string, string>;
                    traceEntry.responseBody = error.response.data;
                }
            }

            return Promise.reject(error);
        }
    );
}

const stableStringify = (value: any): string => {
    if (value === null || value === undefined) return String(value);
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
};

const hashString = (str: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
};

export const api = {
    getItems: async (): Promise<ItemData[]> => {
        const cacheKey = CacheService.generateKey('items');
        const cached = CacheService.get<ItemData[]>(cacheKey);
        if (cached) return cached;

        const response = await axios.get(`${API_URL}/items`);
        CacheService.set(cacheKey, response.data);
        return response.data;
    },

    getItemProperties: async (name: string, condition: number = 1): Promise<{
        properties: Record<string, string>[];
        alternativeCompany1: string;
        alternativeCompany2: string;
    }> => {
        const cacheKey = CacheService.generateKey('properties', { name, condition });
        const cached = CacheService.get<{
            properties: Record<string, string>[];
            alternativeCompany1: string;
            alternativeCompany2: string;
        }>(cacheKey);
        if (cached) return cached;

        const response = await axios.get(`${API_URL}/items/properties`, {
            params: { name, condition }
        });
        CacheService.set(cacheKey, response.data);
        return response.data;
    },

    getMaterialProperties: async (materialType: string): Promise<{
        properties: Record<string, string>[];
        alternativeCompany1: string;
        alternativeCompany2: string;
        laying?: Record<string, string> | null;
    }> => {
        const response = await axios.get(`${API_URL}/properties/${encodeURIComponent(materialType)}`);
        return {
            properties: response.data?.properties ?? response.data?.Properties ?? [],
            alternativeCompany1: response.data?.alternativeCompany1 ?? response.data?.AlternativeCompany1 ?? '',
            alternativeCompany2: response.data?.alternativeCompany2 ?? response.data?.AlternativeCompany2 ?? '',
            laying: response.data?.laying ?? response.data?.Laying ?? null
        };
    },

    getDiagrams: async () => {
        const response = await axios.get(`${API_URL}/diagram`);
        return response.data;
    },

    getDiagram: async (id: string): Promise<CanvasSheet[]> => {
        const response = await axios.get(`${API_URL}/diagram/${encodeURIComponent(id)}`);
        // Handle multi-sheet project structure (check both cases)
        if (response.data.CanvasSheets) {
            return response.data.CanvasSheets;
        }
        if (response.data.canvasSheets) {
            return response.data.canvasSheets;
        }
        // Handle legacy single sheet (wrap in array)
        return [response.data];
    },

    saveDiagram: async (sheets: CanvasSheet[], projectName: string, explicitProjectId: string | null = null): Promise<any> => {
        // Optimize payload: strip undoStack, redoStack, svgContent, use IDs for connectors
        const optimizedSheets = stripSheetsForApi(sheets, true);

        // Determine Project ID:
        // 1. If explicit (overwrite existing), use it.
        // 2. If null (new project), send null/empty (Backend will generate).
        // Legacy fallback: previously used sheets[0].sheetId. We avoid this for "Save As".

        const projectData = {
            projectId: explicitProjectId || '',
            name: projectName,
            canvasSheets: optimizedSheets
        };

        // Log payload reduction for debugging
        logPayloadStats({ canvasSheets: sheets }, projectData, 'saveDiagram');

        // Compress the payload
        const compressed = await compressPayload(projectData);
        console.log(`[Payload] saveDiagram: compressed to ${(compressed.size / 1024).toFixed(1)}KB`);

        const response = await axios.post(`${API_URL}/diagram`, compressed, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Encoding': 'gzip'
            },
            tracePayload: projectData // Pass uncompressed data for tracing
        } as any);
        return response.data;
    },

    analyzeNetwork: async (sheet: CanvasSheet): Promise<CanvasSheet> => {
        const response = await axios.post(`${API_URL}/analysis`, sheet);
        return response.data;
    },

    autoRate: async (sheets: CanvasSheet[]): Promise<{
        sheets: CanvasSheet[];
        log: string;
        success: boolean;
        message: string;
    }> => {
        const settings = useStore.getState().settings;
        // Filter out text boxes - they're not electrical components
        const electricalSheets = filterTextBoxesFromSheets(sheets);
        const optimizedSheets = stripSheetsForApi(electricalSheets);
        const payload = { sheets: optimizedSheets, settings };

        logPayloadStats({ sheets: electricalSheets, settings }, payload, 'autoRate');

        const compressed = await compressPayload(payload);
        console.log(`[Payload] autoRate: compressed to ${(compressed.size / 1024).toFixed(1)}KB`);

        const response = await axios.post(`${API_URL}/analysis/auto-rate`, compressed, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Encoding': 'gzip'
            },
            tracePayload: payload // Pass uncompressed data for tracing
        } as any);
        return response.data;
    },

    initializeItem: async (name: string, properties: Record<string, string>[]): Promise<{
        incomer: Record<string, string>;
        outgoing: Record<string, string>[];
        accessories: Record<string, string>[];
    }> => {
        const propsStr = stableStringify(properties);
        const cacheKey = CacheService.generateKey('initializeItem', { name, h: hashString(propsStr) });
        const cached = CacheService.get<{
            incomer: Record<string, string>;
            outgoing: Record<string, string>[];
            accessories: Record<string, string>[];
        }>(cacheKey);
        if (cached) return cached;

        const response = await axios.post(`${API_URL}/item-initialization/initialize`, {
            name,
            properties
        });
        CacheService.set(cacheKey, response.data);
        return response.data;
    },

    getIconUrl: (iconName: string): string => {
        // Icons are served from /api/icons/{iconName}
        return `${API_URL}/icons/${iconName}`;
    },

    deleteProject: async (projectId: string): Promise<void> => {
        await axios.delete(`${API_URL}/diagram/${encodeURIComponent(projectId)}`);
    },

    generateEstimate: async (sheets: CanvasSheet[]) => {
        // Filter out text boxes - they're not electrical components
        const electricalSheets = filterTextBoxesFromSheets(sheets);
        const optimizedSheets = stripSheetsForApi(electricalSheets);

        logPayloadStats(electricalSheets, optimizedSheets, 'generateEstimate');

        const compressed = await compressPayload(optimizedSheets);
        console.log(`[Payload] generateEstimate: compressed to ${(compressed.size / 1024).toFixed(1)}KB`);

        const response = await axios.post(`${API_URL}/estimate`, compressed, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Encoding': 'gzip'
            },
            responseType: 'blob',
            tracePayload: optimizedSheets // Pass uncompressed data for tracing
        } as any);
        return response.data;
    },

    downloadVoltageDropReport: async (sheets: CanvasSheet[]) => {
        const settings = useStore.getState().settings;
        // Filter out text boxes - they're not electrical components
        const electricalSheets = filterTextBoxesFromSheets(sheets);
        const optimizedSheets = stripSheetsForApi(electricalSheets);
        const payload = { sheets: optimizedSheets, settings };

        logPayloadStats({ sheets: electricalSheets, settings }, payload, 'downloadVoltageDropReport');

        const compressed = await compressPayload(payload);
        console.log(`[Payload] downloadVoltageDropReport: compressed to ${(compressed.size / 1024).toFixed(1)}KB`);

        const response = await axios.post(`${API_URL}/report/voltage-drop`, compressed, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Encoding': 'gzip'
            },
            responseType: 'blob',
            tracePayload: payload // Pass uncompressed data for tracing
        } as any);
        return response.data;
    },

    checkHealth: async (): Promise<boolean> => {
        try {
            await axios.get(`${API_URL}/`);
            return true;
        } catch (e) {
            return false;
        }
    }
};
