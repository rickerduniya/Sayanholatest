import axios from 'axios';
import { ApplicationSettings } from '../utils/ApplicationSettings';
import { api } from './api';
import { CanvasSheet, CanvasItem, Connector } from '../types';
import { DiagramContextBuilder } from '../utils/DiagramContextBuilder';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { fetchProperties } from '../utils/api';
import { sortOptionStringsAsc } from '../utils/sortUtils';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: any[];
    name?: string; // For tool responses in Gemini
    images?: string[]; // Array of base64 data URIs
}

// Callbacks for diagram manipulation
export interface DiagramCallbacks {
    addItem: (itemName: string, position?: { x: number; y: number }, properties?: Record<string, any>) => Promise<CanvasItem | null>;
    deleteItem: (itemId: string) => void;
    calculateNetwork: () => void;
    getSheets: () => CanvasSheet[];
    getCurrentSheet?: () => CanvasSheet | undefined;
    getActiveSheetId?: () => string | null;
    setActiveSheet?: (sheetId: string) => void;
    addSheet?: (name?: string) => void;
    renameSheet?: (sheetId: string, name: string) => void;
    removeSheet?: (sheetId: string) => void;
    moveItems?: (moves: { itemId: string; x: number; y: number }[]) => void;
    updateItemProperties?: (itemId: string, properties: Record<string, string>) => void;
    updateItemTransform?: (itemId: string, x: number, y: number, width: number, height: number, rotation: number) => void;
    updateItemLock?: (itemId: string, locked: boolean) => void;
    updateItemFields?: (itemId: string, updates: Partial<Pick<CanvasItem, 'incomer' | 'outgoing' | 'accessories' | 'alternativeCompany1' | 'alternativeCompany2'>>) => void;
    updateItemRaw?: (itemId: string, updates: Partial<CanvasItem>, options?: { recalcNetwork?: boolean }) => void;
    duplicateItem?: (itemId: string) => void;
    connectItems?: (args: {
        sourceItemId: string;
        sourcePointKey: string;
        targetItemId: string;
        targetPointKey: string;
        materialType?: 'Cable' | 'Wiring';
    }) => Promise<{ connector: Connector; connectorIndex: number } | { error: string }>;
    updateConnector?: (connectorIndex: number, updates: Partial<Connector>) => void;
    deleteConnector?: (connectorIndex: number) => void;
    autoLayoutActiveSheet?: () => void;
    listAvailableItems?: () => Array<{ name: string; connectionPointKeys?: string[] }>;
    undo?: () => void;
    redo?: () => void;
    showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const API_URL = import.meta.env.VITE_API_URL;

export class ChatService {
    private history: ChatMessage[] = [];
    private currentDiagramContext: string = '';
    private cachedContentName: string | null = null;
    private staticSystemPrompt: string = '';
    private diagramCallbacks: DiagramCallbacks | null = null;
    private currentSheets: CanvasSheet[] = [];
    private lastLlmRequestAtMs: number = 0;
    private readonly maxRequestMessages: number = 40;
    private readonly maxRequestChars: number = 60000;

    constructor() {
        this.reset();
    }

    setDiagramCallbacks(callbacks: DiagramCallbacks) {
        this.diagramCallbacks = callbacks;
    }

    reset() {
        this.history = [];
        this.staticSystemPrompt = `You are the AI assistant for the Sayanho electrical SLD editor.

Rules:
1) For any diagram edit, call get_diagram_state_json first to get exact IDs and point keys.
2) Use only the provided tools to make edits. Do not invent IDs, point keys, or dropdown values.
3) Never claim an option is unavailable unless get_item_property_options or set_item_properties proves it.
4) If set_item_properties fails, do not auto-substitute. Return the error.
5) After edits, run validate_diagram (and analyze_diagram when currents are relevant).

SLD connection guide (use exactly):
- Source is extreme upstream (place at top). Downstream flows downward.
- AC Point and Geyser Point connect to HTPN outgoings (dedicated circuits).
- All other loads connect to Point Switch Board out ports (not directly to SPN DB).
- Avg. 5A Switch Board connects to SPN DB (power circuit representation).
- Use Point Switch Board to fan-out to multiple loads; each out port can feed only one load.
- Never connect more than one connector to the same item connection point key.
- Before connecting, always read the real connectionPointKeys from get_diagram_state_json (keys can vary by item/way).

Layout guide:
- Arrange in vertical tiers: Source → (switchgear) → HTPN/HTPN chain → SPN DBs → switch boards → loads.
- Keep consistent columns per room/zone; align boards above their downstream items; avoid crossing by spacing columns.
- After bulk edits, use auto_arrange if the layout is messy.

When calling tools, include a short 'Approach' (1-3 bullets) before the first tool call in a turn.`;

        // Initialize history with ONLY static system prompt to enable prefix caching
        this.history = [{ role: 'system', content: this.staticSystemPrompt }];
        this.cachedContentName = null;
    }

    async initializeContext(sheets: CanvasSheet[]) {
        this.currentSheets = sheets;
        const activeSheetId = this.diagramCallbacks?.getActiveSheetId?.() ?? null;
        // Store dynamic context separately - DO NOT Mutate History[0]
        this.currentDiagramContext = DiagramContextBuilder.buildCompactContext(sheets, activeSheetId);

        // Ensure history has the static prompt
        if (this.history.length === 0 || this.history[0].role !== 'system') {
            this.history = [{ role: 'system', content: this.staticSystemPrompt }, ...this.history];
        } else {
            // Re-enforce static prompt if it was somehow changed (shouldn't be)
            this.history[0].content = this.staticSystemPrompt;
        }
    }

    getHistory(): ChatMessage[] {
        return [...this.history];
    }

    async sendMessage(content: string, isDatabaseQuery: boolean = false, images?: string[]): Promise<ChatMessage[]> {
        const settings = ApplicationSettings.getAiSettings();
        const apiKey = settings.apiKey;
        const provider = (settings as any).provider || 'gemini';
        const modelName = settings.modelName || (
            provider === 'groq' ? 'llama-3.1-8b-instant'
                : provider === 'openrouter' ? 'openai/gpt-4o-mini'
                    : provider === 'mistral' ? 'mistral-small-latest'
                        : 'gemini-2.5-flash'
        );
        const baseUrl = settings.baseUrl || (
            provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
                : provider === 'mistral' ? 'https://api.mistral.ai/v1'
                    : 'https://api.groq.com/openai/v1'
        );
        const extraHeaders = ((settings as any).extraHeaders && typeof (settings as any).extraHeaders === 'object') ? (settings as any).extraHeaders : undefined;
        const requestsPerMinute = typeof (settings as any).requestsPerMinute === 'number' ? (settings as any).requestsPerMinute : 30;
        const retryOnError = typeof (settings as any).retryOnError === 'boolean' ? (settings as any).retryOnError : true;
        const maxRetryAttempts = typeof (settings as any).maxRetryAttempts === 'number' ? (settings as any).maxRetryAttempts : 2;
        const maxToolTurns = typeof (settings as any).maxToolTurns === 'number' ? (settings as any).maxToolTurns : 24;
        const maxToolCalls = typeof (settings as any).maxToolCalls === 'number' ? (settings as any).maxToolCalls : 60;

        if (!apiKey) {
            throw new Error("API Key not configured.");
        }

        try {
            const latestSheets = this.diagramCallbacks?.getSheets?.() || this.currentSheets;
            await this.initializeContext(latestSheets);
        } catch {
        }

        // Universal Optimization: Inject dynamic context into the user message
        let finalContent = content;

        // Append dynamic context to the user message
        // This ensures the generic System Prompt remains static (cacheable)
        // and the dynamic state is seen as part of the current turn.
        if (this.currentDiagramContext) {
            finalContent = `${content}\n\n---\n${this.currentDiagramContext}`;
        }

        if (isDatabaseQuery) {
            finalContent = `[USER EXPLICITLY MARKED THIS AS A DATABASE QUERY. YOU MUST USE DATABASE TOOLS]\n${finalContent}`;
        }

        const userMessage: ChatMessage = { role: 'user', content: finalContent };
        if (images && images.length > 0) {
            userMessage.images = images;
        }
        this.history.push(userMessage);

        try {
            const reasoning = (provider === 'openrouter' && (settings as any).reasoning) ? (settings as any).reasoning : undefined;
            const callProvider = async () => provider === 'groq'
                ? await this.callGroq(apiKey, modelName, baseUrl)
                : provider === 'openrouter'
                    ? await this.callOpenRouter(apiKey, modelName, baseUrl, extraHeaders, reasoning)
                    : provider === 'mistral'
                        ? await this.callMistral(apiKey, modelName, baseUrl)
                        : await this.callGemini(apiKey, modelName);

            let response: any;
            try {
                response = await this.callWithThrottleAndRetry(callProvider, requestsPerMinute, retryOnError, maxRetryAttempts);
            } catch (error: any) {
                const errStr = JSON.stringify(error?.response?.data || error?.message || '');
                if (errStr.includes("thought_signature")) {
                    console.warn("[ChatService] Detected missing thought_signature error. Resetting history and retrying.");

                    // Keep the last user message
                    const lastUserMsg = this.history[this.history.length - 1];

                    // Reset history and context
                    this.history = [];
                    const latestSheets = this.diagramCallbacks?.getSheets?.() || this.currentSheets;
                    await this.initializeContext(latestSheets);

                    // Restore last message
                    if (lastUserMsg) {
                        this.history.push(lastUserMsg);
                    }

                    // Retry
                    response = await this.callWithThrottleAndRetry(callProvider, requestsPerMinute, retryOnError, maxRetryAttempts);
                } else {
                    throw error;
                }
            }

            const maxTurns = Math.max(1, Math.min(100, Math.floor(maxToolTurns)));
            const maxCalls = Math.max(1, Math.min(300, Math.floor(maxToolCalls)));
            let currentTurn = 0;
            let toolCallsExecuted = 0;

            while (currentTurn < maxTurns) {
                currentTurn++;

                let textResponse = '';
                const toolCalls: any[] = [];

                if (provider === 'groq' || provider === 'openrouter' || provider === 'mistral') {
                    const choice = response?.choices?.[0];
                    const msg = choice?.message;
                    if (!msg) throw new Error("No response from AI");
                    const rawContentStr = msg.content ? String(msg.content) : '';
                    const extractedFromText = this.extractToolCallsFromText(rawContentStr);
                    const contentStr = extractedFromText.cleanedText;
                    const rawReasoningStr = (msg as any).reasoning ? String((msg as any).reasoning) : '';
                    const extractedFromReasoning = this.extractToolCallsFromText(rawReasoningStr);
                    const reasoningStr = extractedFromReasoning.cleanedText;
                    textResponse = contentStr;
                    if (provider === 'openrouter' && reasoningStr && reasoningStr.trim()) {
                        textResponse = `${contentStr || ''}${contentStr ? '\n\n' : ''}**Reasoning**\n\n\`\`\`\n${reasoningStr}\n\`\`\``;
                    }
                    if (Array.isArray(msg.tool_calls)) {
                        msg.tool_calls.forEach((tc: any) => {
                            const fn = tc?.function;
                            const name = fn?.name;
                            const args = fn?.arguments;
                            if (!name) return;
                            toolCalls.push({
                                id: tc?.id || ('call_' + Math.random().toString(36).substr(2, 9)),
                                type: tc?.type || 'function',
                                function: {
                                    name,
                                    arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
                                }
                            });
                        });
                    } else {
                        if (extractedFromText.toolCalls.length > 0) extractedFromText.toolCalls.forEach(tc => toolCalls.push(tc));
                        if (extractedFromReasoning.toolCalls.length > 0) extractedFromReasoning.toolCalls.forEach(tc => toolCalls.push(tc));
                    }
                } else {
                    const candidate = response.candidates?.[0];
                    if (!candidate || !candidate.content) {
                        throw new Error("No response from AI");
                    }

                    const parts = candidate.content.parts || [];

                    for (const part of parts) {
                        if (part.text) {
                            textResponse += part.text;
                        }
                        if (part.thought) {
                            textResponse += (textResponse ? '\n\n' : '') + "**Reasoning**\n\n```\n" + part.thought + "\n```";
                        }
                        if (part.functionCall) {
                            // CRITICAL: thoughtSignature is a SIBLING to functionCall in the part, not nested inside functionCall
                            toolCalls.push({
                                id: 'call_' + Math.random().toString(36).substr(2, 9),
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args || {})
                                },
                                // Store thoughtSignature at the tool call level (sibling pattern)
                                thoughtSignature: part.thoughtSignature || undefined
                            });
                        }
                    }
                }

                if (textResponse || toolCalls.length > 0) {
                    if (!textResponse.trim() && toolCalls.length > 0) {
                        const lines = toolCalls.slice(0, 6).map(tc => {
                            const name = tc?.function?.name || 'tool';
                            return `- ${name}`;
                        });
                        textResponse = `Approach:\n- Executing required tools\n\nActions:\n${lines.join('\n')}`;
                    }
                    const assistantMsg: ChatMessage = {
                        role: 'assistant',
                        content: textResponse,
                        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                    };
                    this.history.push(assistantMsg);
                }

                if (toolCalls.length === 0) {
                    break;
                }

                // Handle all tool calls
                for (const toolCall of toolCalls) {
                    if (toolCallsExecuted >= maxCalls) {
                        this.history.push({
                            role: 'assistant',
                            content: `Stopped: reached the safety limit of ${maxCalls} tool calls. Increase Max tool calls in AI Settings if needed.`
                        });
                        return [...this.history];
                    }
                    let result;
                    const args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};

                    try {
                        result = await this.handleToolCall(toolCall.function.name, args);
                    } catch (e: any) {
                        result = { error: e.message || 'Tool execution failed' };
                    }

                    const compacted = this.compactToolResult(toolCall.function.name, result);
                    this.history.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(compacted),
                        name: toolCall.function.name
                    } as any);
                    toolCallsExecuted += 1;
                }

                response = await this.callWithThrottleAndRetry(callProvider, requestsPerMinute, retryOnError, maxRetryAttempts);
            }

            if (currentTurn >= maxTurns) {
                this.history.push({
                    role: 'assistant',
                    content: `Stopped: reached the safety limit of ${maxTurns} tool turns. Increase Max tool turns in AI Settings if needed.`
                });
            }

            return [...this.history];
        } catch (error: any) {
            console.error("LLM Error", error);
            throw new Error(error.message || "Failed to communicate with AI");
        }
    }

    private async sleep(ms: number): Promise<void> {
        if (!Number.isFinite(ms) || ms <= 0) return;
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private extractToolCallsFromText(text: string): { cleanedText: string; toolCalls: any[] } {
        const src = (text || '').toString();
        const toolCalls: any[] = [];
        let cleanedText = src;

        const convert = (v: string) => {
            const s = (v ?? '').toString().trim();
            if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
            if (s.toLowerCase() === 'true') return true;
            if (s.toLowerCase() === 'false') return false;
            return s;
        };

        const blocks = src.match(/<tool_call>[\s\S]*?<\/tool_call>/gi) || [];
        if (blocks.length === 0) return { cleanedText, toolCalls };

        for (const block of blocks) {
            const fnMatch = block.match(/<function\s*=\s*([a-zA-Z0-9_:-]+)\s*>/i);
            const name = fnMatch?.[1]?.trim();
            if (!name) continue;

            const args: Record<string, any> = {};
            const paramRegex = /<parameter\s*=\s*([a-zA-Z0-9_:-]+)\s*>([\s\S]*?)<\/parameter>/gi;
            let m: RegExpExecArray | null;
            while ((m = paramRegex.exec(block)) !== null) {
                const key = (m[1] || '').trim();
                const val = convert(m[2] || '');
                if (!key) continue;
                args[key] = val;
            }

            toolCalls.push({
                id: `text_tool_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: {
                    name,
                    arguments: JSON.stringify(args)
                }
            });
        }

        if (toolCalls.length > 0) {
            cleanedText = cleanedText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
        }

        return { cleanedText, toolCalls };
    }

    private getMinDelayMsFromRpm(requestsPerMinute: number): number {
        const rpm = Number.isFinite(requestsPerMinute) ? requestsPerMinute : 0;
        if (rpm <= 0) return 0;
        return Math.ceil(60000 / Math.max(1, rpm));
    }

    private async enforceRequestSpacing(requestsPerMinute: number): Promise<void> {
        const minDelayMs = this.getMinDelayMsFromRpm(requestsPerMinute);
        if (minDelayMs <= 0) return;
        const now = Date.now();
        const elapsed = now - this.lastLlmRequestAtMs;
        const waitMs = minDelayMs - elapsed;
        if (waitMs > 0) await this.sleep(waitMs);
        this.lastLlmRequestAtMs = Date.now();
    }

    private parseRetryAfterSeconds(error: any): number | null {
        const headers = error?.response?.headers || {};
        const retryAfterHeader = headers['retry-after'] ?? headers['Retry-After'];
        const headerVal = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
        if (headerVal !== undefined && headerVal !== null && `${headerVal}`.trim() !== '') {
            const n = parseFloat(`${headerVal}`);
            if (Number.isFinite(n) && n > 0) return n;
        }

        const data = error?.response?.data;
        const msg = (data?.error?.message || data?.message || error?.message || '').toString();
        const m1 = msg.match(/retry\s*after\s*([0-9]+(?:\.[0-9]+)?)\s*(seconds|secs|sec|s)?/i);
        if (m1) {
            const n = parseFloat(m1[1]);
            if (Number.isFinite(n) && n > 0) return n;
        }
        const m2 = msg.match(/try\s*again\s*in\s*([0-9]+(?:\.[0-9]+)?)\s*(seconds|secs|sec|s)?/i);
        if (m2) {
            const n = parseFloat(m2[1]);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    }

    // ==================== PROVIDER IMPLEMENTATIONS ====================

    private async callOpenRouter(apiKey: string, model: string, baseUrl: string, extraHeaders?: any, reasoning?: any): Promise<any> {
        const messages = this.history.map(m => {
            const msg: any = { role: m.role };
            if (m.tool_calls) msg.tool_calls = m.tool_calls;
            if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
            if (m.name) msg.name = m.name;

            if (m.role === 'user' && m.images && m.images.length > 0) {
                // Multimodal content array
                msg.content = [
                    { type: 'text', text: m.content },
                    ...m.images.map(img => ({
                        type: 'image_url',
                        image_url: { url: img } // img is already data URI
                    }))
                ];
            } else {
                msg.content = m.content;
            }
            return msg;
        });

        const body: any = {
            model: model,
            messages: messages,
            tools: this.getOpenAiTools(),
            tool_choice: "auto"
        };
        if (reasoning) body.reasoning = reasoning;

        const response = await axios.post(`${baseUrl}/chat/completions`, body, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...extraHeaders
            }
        });
        return response.data;
    }

    private async callGemini(apiKey: string, model: string): Promise<any> {
        // 1. Try to use or create cached content for Static Prompt + Tools
        if (!this.cachedContentName) {
            try {
                // Create cache
                const cacheUrl = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`;
                const tools = [{ functionDeclarations: this.getGeminiTools() }];
                const systemInstruction = { parts: [{ text: this.staticSystemPrompt }] };

                const cacheBody = {
                    model: `models/${model}`,
                    systemInstruction: systemInstruction,
                    tools: tools,
                    contents: [], // Cache logic: we cache system+tools, contents are empty in cache definition
                    ttl: "3600s"
                };

                const cacheRes = await axios.post(cacheUrl, cacheBody, {
                    headers: { 'Content-Type': 'application/json' }
                });

                if (cacheRes.data && cacheRes.data.name) {
                    this.cachedContentName = cacheRes.data.name;
                    console.log("[ChatService] Created Gemini Cache:", this.cachedContentName);
                }
            } catch (e) {
                console.warn("[ChatService] Failed to create cache, falling back to standard request", e);
            }
        }

        // 2. Prepare request
        const { contents } = this.convertHistoryToGemini(this.history); // System prompt is excluded from contents if present in history

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        let body: any = {
            contents: contents
        };

        if (this.cachedContentName) {
            // optimized mode
            body.cachedContent = this.cachedContentName;
            // Tools and System Instruction are implied by cachedContent
        } else {
            // legacy/fallback mode
            body.systemInstruction = { parts: [{ text: this.staticSystemPrompt }] };
            body.tools = [{ functionDeclarations: this.getGeminiTools() }];
        }

        try {
            const response = await axios.post(url, body, {
                headers: { 'Content-Type': 'application/json' }
            });
            return response.data;
        } catch (e: any) {
            // If cache not found (404), clear it and retry standard
            if (this.cachedContentName && e.response && e.response.status === 404) {
                console.warn("[ChatService] Cache not found (404), validating cache and retrying...");
                this.cachedContentName = null;
                return this.callGemini(apiKey, model); // Recursive retry (once)
            }
            throw e;
        }
    }

    private convertHistoryToGemini(history: ChatMessage[]): { contents: any[], systemInstruction: string } {
        let systemInstruction = "";
        const contents: any[] = [];

        for (const msg of history) {
            if (msg.role === 'system') {
                // In new architecture, system prompt is static and handled via cache or separate field
                // We do NOT add it to contents array for Gemini
                continue;
            }

            const parts: any[] = [];

            // Text content
            if (msg.content) {
                parts.push({ text: msg.content });
            }

            // Image content
            if (msg.role === 'user' && msg.images && msg.images.length > 0) {
                msg.images.forEach(imgDataUri => {
                    // Extract base64 and mime type
                    // Data URI format: data:[<mediatype>][;base64],<data>
                    const matches = imgDataUri.match(/^data:([^;]+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        parts.push({
                            inline_data: {
                                mime_type: matches[1],
                                data: matches[2]
                            }
                        });
                    }
                });
            }

            // Tool calls - reconstruct Gemini format with thoughtSignature as sibling
            if (msg.tool_calls) {
                msg.tool_calls.forEach((tc: any) => {
                    const partObj: any = {
                        functionCall: {
                            name: tc.function.name,
                            args: JSON.parse(tc.function.arguments)
                        }
                    };
                    // CRITICAL: thoughtSignature must be a sibling to functionCall, not inside it
                    if (tc.thoughtSignature) {
                        partObj.thoughtSignature = tc.thoughtSignature;
                    }
                    parts.push(partObj);
                });
            }

            // Tool responses
            if (msg.role === 'tool') {
                parts.push({
                    functionResponse: {
                        name: msg.name,
                        response: JSON.parse(msg.content)
                    }
                });
            }

            // Map roles
            // User -> user
            // Assistant -> model (even if it has tool_calls)
            // Tool -> function
            let role = 'user';
            if (msg.role === 'assistant') role = 'model';
            if (msg.role === 'tool') role = 'user';

            contents.push({ role, parts });
        }

        return { contents, systemInstruction };
    }

    // Existing stubs for other providers remain, but we should make sure they
    // handle (or ignore) images gracefully if they don't support them.
    // For now, only Gemini and OpenRouter (which covers OpenAI/Anthropic) are fully updated for vision.

    private async callGroq(apiKey: string, model: string, baseUrl: string): Promise<any> {
        // Groq officially supports vision now with Llama 3.2 11B/90B
        return this.callOpenRouter(apiKey, model, baseUrl);
    }

    private async callMistral(apiKey: string, model: string, baseUrl: string): Promise<any> {
        return this.callOpenRouter(apiKey, model, baseUrl);
    }


    private async callWithThrottleAndRetry<T>(
        fn: () => Promise<T>,
        requestsPerMinute: number,
        retryOnError: boolean,
        maxRetryAttempts: number
    ): Promise<T> {
        const maxAttempts = Math.max(0, Math.floor(maxRetryAttempts));
        let attempt = 0;
        while (true) {
            await this.enforceRequestSpacing(requestsPerMinute);
            try {
                return await fn();
            } catch (e: any) {
                const retryAfterSec = this.parseRetryAfterSeconds(e);
                if (!retryOnError || retryAfterSec === null || attempt >= maxAttempts) {
                    throw e;
                }
                attempt += 1;
                await this.sleep(Math.ceil(retryAfterSec * 1000));
            }
        }
    }

    private async handleToolCall(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            // Database tools
            case 'execute_query':
                return this.executeQuery(args.query);

            case 'get_database_schema':
                return this.getSchema();

            case 'get_table_overview':
                return this.executeQuery(`SELECT * FROM "${args.tableName}" LIMIT 5`);

            // Diagram analysis tools
            case 'get_diagram_summary':
                return this.getDiagramSummary(args.sheetName);

            case 'get_diagram_state_json':
                return this.getDiagramStateJson(args.scope);

            case 'validate_diagram':
                return this.validateDiagramTool();

            case 'analyze_diagram':
                return this.analyzeDiagram();

            case 'get_total_load':
                return this.getTotalLoad(args.phase);

            case 'get_phase_balance':
                return this.getPhaseBalance();

            case 'suggest_cable_size':
                return this.suggestCableSize(args.current, args.phases);

            case 'add_text_to_diagram':
                return this.addTextToDiagram(args.text, args.x, args.y, args);

            // Diagram modification tools
            case 'add_item_to_diagram':
                return this.addItemToDiagram(args.itemName, args.x, args.y, args.properties);

            case 'delete_item_from_diagram':
                return this.deleteItemFromDiagram(args.itemId, args.itemName);

            case 'list_sheets':
                return this.listSheets();

            case 'set_active_sheet':
                return this.setActiveSheetTool(args.sheetId, args.sheetName);

            case 'add_sheet':
                return this.addSheetTool(args.name);

            case 'rename_sheet':
                return this.renameSheetTool(args.sheetId, args.name);

            case 'remove_sheet':
                return this.removeSheetTool(args.sheetId);

            case 'list_available_items':
                return this.listAvailableItemsTool();

            case 'move_items':
                return this.moveItemsTool(args.moves);

            case 'set_item_properties':
                return this.setItemPropertiesTool(args.itemId, args.properties);

            case 'normalize_item_properties':
                return this.normalizeItemPropertiesTool(args.itemId);

            case 'normalize_active_sheet_properties':
                return this.normalizeActiveSheetPropertiesTool();

            case 'get_item_property_options':
                return this.getItemPropertyOptionsTool(args.itemName);

            case 'set_item_transform':
                return this.setItemTransformTool(args.itemId, args.x, args.y, args.width, args.height, args.rotation);

            case 'lock_item':
                return this.lockItemTool(args.itemId, args.locked);

            case 'update_item_fields':
                return this.updateItemFieldsTool(args.itemId, args);

            case 'duplicate_item':
                return this.duplicateItemTool(args.itemId);

            case 'connect_items':
                return this.connectItemsTool(args);

            case 'update_connector':
                return this.updateConnectorTool(args.connectorIndex, args.updates);

            case 'delete_connector':
                return this.deleteConnectorTool(args.connectorIndex);

            case 'auto_arrange':
                return this.autoLayoutActiveSheetTool();

            case 'undo':
                return this.undoTool();

            case 'redo':
                return this.redoTool();

            case 'apply_sld_operations':
                return this.applySldOperationsTool(args.operations, args.stopOnError);

            default:
                return { error: `Unknown tool: ${toolName}` };
        }
    }

    // ==================== DIAGRAM ANALYSIS TOOLS ====================

    private getDiagramSummary(sheetName?: string): any {
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        return DiagramContextBuilder.getDiagramSummary(sheets, sheetName);
    }

    private getDiagramStateJson(scope?: 'active' | 'all'): any {
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        const activeSheetId = this.diagramCallbacks?.getActiveSheetId?.() ?? null;
        const resolvedScope: 'active' | 'all' = scope === 'all' ? 'all' : 'active';
        return DiagramContextBuilder.getDiagramStateJson(sheets, activeSheetId, resolvedScope);
    }

    private validateDiagramTool(): any {
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        return DiagramContextBuilder.validateDiagram(sheets);
    }

    private analyzeDiagram(): any {
        try {
            // Trigger network calculation
            this.diagramCallbacks?.calculateNetwork();

            const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;

            // Return analysis results
            const loadAnalysis = DiagramContextBuilder.getLoadAnalysis(sheets);
            const phaseBalance = DiagramContextBuilder.getPhaseBalance(sheets);

            // Get connection currents
            const connectionCurrents: any[] = [];
            sheets.forEach(sheet => {
                sheet.storedConnectors.forEach(conn => {
                    connectionCurrents.push({
                        from: conn.sourceItem?.name || 'Unknown',
                        to: conn.targetItem?.name || 'Unknown',
                        current: conn.currentValues?.Current || '0 A',
                        phase: conn.currentValues?.Phase || 'Unknown',
                        R_Current: conn.currentValues?.R_Current,
                        Y_Current: conn.currentValues?.Y_Current,
                        B_Current: conn.currentValues?.B_Current
                    });
                });
            });

            return {
                success: true,
                message: 'Network analysis complete',
                totalPower: `${loadAnalysis.totalPower.toFixed(2)} W`,
                totalCurrent: `${loadAnalysis.totalCurrent.toFixed(2)} A`,
                phaseBalance: phaseBalance,
                connections: connectionCurrents
            };
        } catch (e: any) {
            return { error: e.message || 'Analysis failed' };
        }
    }

    private getTotalLoad(phase?: string): any {
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        const analysis = DiagramContextBuilder.getLoadAnalysis(sheets);

        if (phase && ['R', 'Y', 'B'].includes(phase.toUpperCase())) {
            const p = phase.toUpperCase() as 'R' | 'Y' | 'B';
            return {
                phase: p,
                power: `${analysis.perPhase[p].power.toFixed(2)} W`,
                current: `${analysis.perPhase[p].current.toFixed(2)} A`,
                items: analysis.perPhase[p].items
            };
        }

        return {
            totalPower: `${analysis.totalPower.toFixed(2)} W`,
            totalCurrent: `${analysis.totalCurrent.toFixed(2)} A`,
            perPhase: {
                R: { power: `${analysis.perPhase.R.power.toFixed(2)} W`, current: `${analysis.perPhase.R.current.toFixed(2)} A` },
                Y: { power: `${analysis.perPhase.Y.power.toFixed(2)} W`, current: `${analysis.perPhase.Y.current.toFixed(2)} A` },
                B: { power: `${analysis.perPhase.B.power.toFixed(2)} W`, current: `${analysis.perPhase.B.current.toFixed(2)} A` }
            },
            itemBreakdown: analysis.itemBreakdown.map(i => ({
                name: i.name,
                power: `${i.power.toFixed(2)} W`,
                phase: i.phase
            }))
        };
    }

    private getPhaseBalance(): any {
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        return DiagramContextBuilder.getPhaseBalance(sheets);
    }

    private suggestCableSize(current: number, phases?: string): any {
        if (!current || current <= 0) {
            return { error: 'Please provide a valid current value in Amps' };
        }
        return DiagramContextBuilder.getCableRecommendation(current, phases || '1-phase');
    }

    // ==================== DIAGRAM MODIFICATION TOOLS ====================

    private async addTextToDiagram(text: string, x?: number, y?: number, styles?: any): Promise<any> {
        if (!this.diagramCallbacks) {
            return { error: 'Diagram callbacks not configured.' };
        }
        if (!text) {
            return { error: 'Text content is required.' };
        }

        try {
            const position = { x: x || 300, y: y || 300 };
            const properties: Record<string, any> = {
                "Text": text,
                "FontSize": styles?.fontSize || "16",
                "Color": styles?.color || "default",
                "Align": styles?.align || "left",
                "Bold": styles?.bold ? "true" : "false",
                "Italic": styles?.italic ? "true" : "false",
                "Underline": styles?.underline ? "true" : "false",
                "FontFamily": "Arial" // Default
            };

            const newItem = await this.diagramCallbacks.addItem("Text", position, properties);
            if (!newItem) {
                return { error: 'Failed to create text item.' };
            }

            return { success: true, itemId: newItem.uniqueID, message: `Added text "${text}"` };
        } catch (e: any) {
            return { error: e.message || 'Failed to add text.' };
        }
    }

    private async addItemToDiagram(itemName: string, x?: number, y?: number, properties?: Record<string, any>): Promise<any> {
        if (!this.diagramCallbacks) {
            return { error: 'Diagram callbacks not configured. Cannot modify diagram.' };
        }

        if (!itemName) {
            return { error: 'Please provide an item name to add' };
        }

        try {
            const position = { x: x || 300, y: y || 300 };
            const newItem = await this.diagramCallbacks.addItem(itemName, position, properties);

            if (newItem) {
                let warning: string | undefined;
                if (properties && typeof properties === 'object' && Object.keys(properties).length > 0) {
                    const safeProps: Record<string, string> = {};
                    Object.entries(properties).forEach(([k, v]) => {
                        if (v === undefined || v === null) return;
                        safeProps[String(k)] = String(v);
                    });
                    const applied = await this.applyItemPropertiesLikeHuman(newItem.uniqueID, safeProps);
                    if (applied && typeof applied === 'object' && 'error' in applied) {
                        warning = String((applied as any).error || 'Failed to apply requested properties.');
                        this.diagramCallbacks.showToast(`Added ${itemName}, but could not apply requested properties.`, 'error');
                    }
                }
                this.diagramCallbacks.showToast(`Added ${itemName} to diagram`, 'success');
                return {
                    success: true,
                    message: `Successfully added ${itemName} to the diagram`,
                    ...(warning ? { warning } : {}),
                    item: {
                        name: newItem.name,
                        id: newItem.uniqueID,
                        shortId: newItem.uniqueID.substring(0, 8),
                        position: position
                    }
                };
            } else {
                return { error: `Failed to add ${itemName}. Item may not exist in the database.` };
            }
        } catch (e: any) {
            return { error: e.message || `Failed to add ${itemName}` };
        }
    }

    private deleteItemFromDiagram(itemId?: string, itemName?: string): any {
        if (!this.diagramCallbacks) {
            return { error: 'Diagram callbacks not configured. Cannot modify diagram.' };
        }

        const sheets = this.diagramCallbacks.getSheets();

        // Find item by ID or name
        let targetItem: CanvasItem | null = null;
        for (const sheet of sheets) {
            for (const item of sheet.canvasItems) {
                if (itemId && item.uniqueID.startsWith(itemId)) {
                    targetItem = item;
                    break;
                }
                if (itemName && item.name.toLowerCase() === itemName.toLowerCase()) {
                    targetItem = item;
                    break;
                }
            }
            if (targetItem) break;
        }

        if (!targetItem) {
            return { error: `Item not found: ${itemId || itemName}` };
        }

        try {
            this.diagramCallbacks.deleteItem(targetItem.uniqueID);
            this.diagramCallbacks.showToast(`Deleted ${targetItem.name}`, 'info');
            return {
                success: true,
                message: `Successfully deleted ${targetItem.name} from the diagram`,
                deletedItem: {
                    name: targetItem.name,
                    id: targetItem.uniqueID,
                    shortId: targetItem.uniqueID.substring(0, 8)
                }
            };
        } catch (e: any) {
            return { error: e.message || 'Failed to delete item' };
        }
    }

    private listSheets(): any {
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        const activeSheetId = this.diagramCallbacks?.getActiveSheetId?.() ?? null;
        return {
            activeSheetId,
            sheets: sheets.map(s => ({ sheetId: s.sheetId, name: s.name, isActive: s.sheetId === activeSheetId }))
        };
    }

    private setActiveSheetTool(sheetId?: string, sheetName?: string): any {
        if (!this.diagramCallbacks?.setActiveSheet) return { error: 'setActiveSheet not available.' };
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;

        let targetId = sheetId;
        if (!targetId && sheetName) {
            const found = sheets.find(s => s.name.toLowerCase() === sheetName.toLowerCase());
            targetId = found?.sheetId;
        }

        if (!targetId) return { error: 'Please provide sheetId or sheetName.' };
        const exists = sheets.some(s => s.sheetId === targetId);
        if (!exists) return { error: `Sheet not found: ${targetId}` };

        this.diagramCallbacks.setActiveSheet(targetId);
        return { success: true, activeSheetId: targetId };
    }

    private addSheetTool(name?: string): any {
        if (!this.diagramCallbacks?.addSheet) return { error: 'addSheet not available.' };
        this.diagramCallbacks.addSheet(name);
        const sheets = this.diagramCallbacks.getSheets();
        const activeSheetId = this.diagramCallbacks?.getActiveSheetId?.() ?? null;
        const active = sheets.find(s => s.sheetId === activeSheetId);
        return { success: true, activeSheet: active ? { sheetId: active.sheetId, name: active.name } : null };
    }

    private renameSheetTool(sheetId?: string, name?: string): any {
        if (!this.diagramCallbacks?.renameSheet) return { error: 'renameSheet not available.' };
        if (!sheetId || !name) return { error: 'sheetId and name are required.' };
        this.diagramCallbacks.renameSheet(sheetId, name);
        return { success: true };
    }

    private removeSheetTool(sheetId?: string): any {
        if (!this.diagramCallbacks?.removeSheet) return { error: 'removeSheet not available.' };
        if (!sheetId) return { error: 'sheetId is required.' };
        this.diagramCallbacks.removeSheet(sheetId);
        return { success: true };
    }

    private async listAvailableItemsTool(): Promise<any> {
        try {
            const fromCb = this.diagramCallbacks?.listAvailableItems?.();
            if (fromCb && fromCb.length > 0) return { items: fromCb };
            const items = await api.getItems();
            return { items: items.map(i => ({ name: i.name, connectionPointKeys: Object.keys(i.connectionPoints || {}) })) };
        } catch (e: any) {
            return { error: e?.message || 'Failed to list available items' };
        }
    }

    private getActiveSheet(): CanvasSheet | undefined {
        const fromCb = this.diagramCallbacks?.getCurrentSheet?.();
        if (fromCb) return fromCb;
        const sheets = this.diagramCallbacks?.getSheets() || this.currentSheets;
        const activeSheetId = this.diagramCallbacks?.getActiveSheetId?.() ?? null;
        return sheets.find(s => s.sheetId === activeSheetId) || sheets[0];
    }

    private resolveActiveSheetItemId(prefixOrId: string): { id: string } | { error: string } {
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };
        const q = (prefixOrId || '').trim();
        if (!q) return { error: 'itemId is required.' };
        const matches = sheet.canvasItems.filter(i => i.uniqueID === q || i.uniqueID.startsWith(q));
        if (matches.length === 0) return { error: `Item not found on active sheet: ${q}` };
        if (matches.length > 1) return { error: `Ambiguous itemId prefix: ${q}` };
        return { id: matches[0].uniqueID };
    }

    private moveItemsTool(moves?: Array<{ itemId: string; x: number; y: number }>): any {
        if (!this.diagramCallbacks?.moveItems) return { error: 'moveItems not available.' };
        if (!moves || !Array.isArray(moves) || moves.length === 0) return { error: 'moves must be a non-empty array.' };
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };

        const resolved: Array<{ itemId: string; x: number; y: number }> = [];
        for (const m of moves) {
            const r = this.resolveActiveSheetItemId(m.itemId);
            if ('error' in r) return { error: r.error };
            resolved.push({ itemId: r.id, x: Number(m.x), y: Number(m.y) });
        }

        this.diagramCallbacks.moveItems(resolved);
        return { success: true, movedCount: resolved.length };
    }

    private setItemPropertiesTool(itemId?: string, properties?: Record<string, any>): any {
        if (!this.diagramCallbacks?.updateItemRaw && !this.diagramCallbacks?.updateItemProperties) {
            return { error: 'Item update actions not available.' };
        }
        if (!itemId) return { error: 'itemId is required.' };
        if (!properties || typeof properties !== 'object') return { error: 'properties must be an object.' };
        const r = this.resolveActiveSheetItemId(itemId);
        if ('error' in r) return { error: r.error };

        const safeProps: Record<string, string> = {};
        Object.entries(properties).forEach(([k, v]) => {
            if (v === undefined || v === null) return;
            safeProps[String(k)] = String(v);
        });

        return this.applyItemPropertiesLikeHuman(r.id, safeProps);
    }

    private async normalizeItemPropertiesTool(itemId?: string): Promise<any> {
        if (!this.diagramCallbacks?.updateItemRaw && !this.diagramCallbacks?.updateItemProperties) {
            return { error: 'Item update actions not available.' };
        }
        if (!itemId) return { error: 'itemId is required.' };
        const r = this.resolveActiveSheetItemId(itemId);
        if ('error' in r) return { error: r.error };
        const sheet = this.getActiveSheet();
        const item = sheet?.canvasItems.find(i => i.uniqueID === r.id);
        if (!item) return { error: 'Item not found.' };
        const currentProps = (item.properties?.[0] || {}) as Record<string, string>;

        let rows: Record<string, string>[] = [];
        try {
            const resp = await api.getItemProperties(item.name, 2);
            rows = resp?.properties || [];
        } catch {
            return { error: `Failed to fetch property rows for ${item.name}.` };
        }
        if (rows.length === 0) return { success: true, normalized: false, reason: 'No database property rows.' };

        const dynamicKeys = Object.keys(rows[0] || {}).filter(k => !['Item', 'Rate', 'Description', 'GS'].includes(k));
        const desiredUpdates: Record<string, string> = {};
        for (const k of dynamicKeys) {
            const v = (currentProps[k] ?? '').toString().trim();
            if (v) desiredUpdates[k] = v;
        }
        if (Object.keys(desiredUpdates).length === 0) {
            return { success: true, normalized: false, reason: 'No dropdown properties set.' };
        }

        return this.applyItemPropertiesLikeHuman(r.id, desiredUpdates, rows);
    }

    private async normalizeActiveSheetPropertiesTool(): Promise<any> {
        if (!this.diagramCallbacks?.updateItemRaw && !this.diagramCallbacks?.updateItemProperties) {
            return { error: 'Item update actions not available.' };
        }
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };

        const rowsCache = new Map<string, Record<string, string>[]>();
        const results: Array<{ itemId: string; name: string; result: any }> = [];

        for (const it of sheet.canvasItems) {
            const currentProps = (it.properties?.[0] || {}) as Record<string, string>;
            if (!currentProps || Object.keys(currentProps).length === 0) continue;

            let rows = rowsCache.get(it.name);
            if (!rows) {
                try {
                    const resp = await api.getItemProperties(it.name, 2);
                    rows = resp?.properties || [];
                    rowsCache.set(it.name, rows);
                } catch {
                    results.push({ itemId: it.uniqueID, name: it.name, result: { error: 'Failed to fetch property rows.' } });
                    continue;
                }
            }
            if (!rows || rows.length === 0) continue;

            const dynamicKeys = Object.keys(rows[0] || {}).filter(k => !['Item', 'Rate', 'Description', 'GS'].includes(k));
            const desiredUpdates: Record<string, string> = {};
            for (const k of dynamicKeys) {
                const v = (currentProps[k] ?? '').toString().trim();
                if (v) desiredUpdates[k] = v;
            }
            if (Object.keys(desiredUpdates).length === 0) continue;

            const res = await this.applyItemPropertiesLikeHuman(it.uniqueID, desiredUpdates, rows);
            results.push({ itemId: it.uniqueID, name: it.name, result: res });
        }

        const normalizedCount = results.filter(r => r.result && typeof r.result === 'object' && !('error' in r.result)).length;
        return { success: true, normalizedCount, results };
    }

    private async getItemPropertyOptionsTool(itemName?: string): Promise<any> {
        const name = (itemName || '').toString().trim();
        if (!name) return { error: 'itemName is required.' };
        try {
            const resp = await api.getItemProperties(name, 2);
            const rows = resp?.properties || [];
            if (rows.length === 0) return { error: `No property rows found for ${name}.` };
            const dynamicKeys = Object.keys(rows[0] || {}).filter(k => !['Item', 'Rate', 'Description', 'GS'].includes(k));
            const options: Record<string, string[]> = {};
            for (const k of dynamicKeys) {
                options[k] = Array.from(new Set(rows.map(r => (r[k] ?? '').toString()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
            }
            return { itemName: name, options };
        } catch (e: any) {
            return { error: e?.message || `Failed to fetch property options for ${name}.` };
        }
    }

    private normalizeWayForCompare(itemName: string, value: string): string {
        const raw = (value || '').toString().trim();
        if (!raw) return raw;
        const cleaned = raw.replace(/\s*way\s*/gi, '').trim();
        if (itemName === 'SPN DB') {
            const m = cleaned.match(/(\d+)\s*\+\s*(\d+)/);
            if (m) return `${m[1]}+${m[2]}`;
        }
        const n = cleaned.match(/^(\d+)/);
        return n ? n[1] : cleaned;
    }

    private parseRateValue(rate: string | undefined): number {
        const s = (rate || '').toString();
        const m = s.match(/(\d+(?:\.\d+)?)/);
        if (!m) return Number.POSITIVE_INFINITY;
        const v = Number(m[1]);
        return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
    }

    private normalizePropValue(itemName: string, key: string, value: any): string {
        const s = (value ?? '').toString();
        const collapsed = s.replace(/\s+/g, ' ').trim();
        if (key === 'Way') return this.normalizeWayForCompare(itemName, collapsed);
        return collapsed.toLowerCase();
    }

    private async coerceToValidPropertyRow(
        itemName: string,
        currentProps: Record<string, string>,
        desiredUpdates: Record<string, string>,
        rowsOverride?: Record<string, string>[]
    ): Promise<{ props: Record<string, string> } | { error: string; available?: Record<string, string[]> }> {
        const keys = Object.keys(desiredUpdates || {});
        if (keys.length === 0) return { props: { ...currentProps } };

        let rows: Record<string, string>[] = [];
        try {
            if (rowsOverride) {
                rows = rowsOverride;
            } else {
                const resp = await api.getItemProperties(itemName, 2);
                rows = resp?.properties || [];
            }
        } catch {
            return { props: { ...currentProps, ...desiredUpdates } };
        }

        if (rows.length === 0) return { props: { ...currentProps, ...desiredUpdates } };

        const dynamicKeys = Object.keys(rows[0] || {}).filter(k => !['Item', 'Rate', 'Description', 'GS'].includes(k));
        const touchesDynamic = keys.some(k => dynamicKeys.includes(k));
        if (!touchesDynamic) {
            return { props: { ...currentProps, ...desiredUpdates } };
        }

        const desiredNorm: Record<string, string> = {};
        for (const [k, v] of Object.entries(desiredUpdates)) {
            desiredNorm[k] = this.normalizePropValue(itemName, k, v);
        }

        const rowMatchesDesired = (row: Record<string, string>) => {
            for (const [k, v] of Object.entries(desiredNorm)) {
                if (!(k in row)) continue;
                const rv = this.normalizePropValue(itemName, k, row[k]);
                if (rv !== v) return false;
            }
            return true;
        };

        let candidates = rows.filter(rowMatchesDesired);

        if (candidates.length === 0) {
            const available: Record<string, string[]> = {};
            for (const k of Object.keys(desiredNorm)) {
                const vals = Array.from(new Set(rows.map(r => (r[k] ?? '').toString()).filter(Boolean)));
                if (vals.length > 0) available[k] = vals;
            }
            return {
                error: `Invalid selection for ${itemName}. Requested properties don't match any valid combination.`,
                available
            };
        }

        const keepKeys = Object.keys(currentProps).filter(k => !(k in desiredNorm));
        const stableFiltered = candidates.filter(row => {
            for (const k of keepKeys) {
                if (!(k in row)) continue;
                const want = this.normalizePropValue(itemName, k, currentProps[k]);
                if (!want) continue;
                const have = this.normalizePropValue(itemName, k, row[k]);
                if (have !== want) return false;
            }
            return true;
        });
        if (stableFiltered.length > 0) candidates = stableFiltered;

        candidates.sort((a, b) => {
            const ar = this.parseRateValue(a['Rate']);
            const br = this.parseRateValue(b['Rate']);
            if (ar !== br) return ar - br;
            const ac = (a['Company'] || '').toString().localeCompare((b['Company'] || '').toString());
            if (ac !== 0) return ac;
            return JSON.stringify(a).localeCompare(JSON.stringify(b));
        });

        const chosen = candidates[0];
        const finalProps: Record<string, string> = { ...currentProps, ...chosen };
        Object.entries(desiredUpdates).forEach(([k, v]) => {
            if (!(k in chosen)) finalProps[k] = String(v);
        });
        return { props: finalProps };
    }

    private async applyItemPropertiesLikeHuman(itemId: string, properties: Record<string, string>, rowsOverride?: Record<string, string>[]): Promise<any> {
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };
        const item = sheet.canvasItems.find(i => i.uniqueID === itemId);
        if (!item) return { error: 'Item not found.' };

        const currentProps = (item.properties?.[0] || {}) as Record<string, string>;
        const updates: Record<string, string> = { ...properties };

        const coerced = await this.coerceToValidPropertyRow(item.name, currentProps, updates, rowsOverride);
        if ('error' in coerced) {
            const details = coerced.available ? ` Available options: ${JSON.stringify(coerced.available)}` : '';
            return { error: coerced.error + details };
        }
        const finalProps = coerced.props;

        let nextItem: CanvasItem = { ...item, properties: [finalProps] };

        const shouldInit = ['HTPN', 'VTPN', 'SPN DB', 'Main Switch', 'Change Over Switch', 'Point Switch Board'].includes(item.name);

        if (shouldInit) {
            try {
                const initData = await api.initializeItem(item.name, [finalProps]);
                if (initData?.incomer) nextItem = { ...nextItem, incomer: initData.incomer };
                if (initData?.outgoing) nextItem = { ...nextItem, outgoing: initData.outgoing };
                if (initData?.accessories) nextItem = { ...nextItem, accessories: initData.accessories };
            } catch {
            }

            if (['HTPN', 'VTPN', 'SPN DB'].includes(item.name)) {
                const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(item.name);
                if (threshold > 0 && nextItem.outgoing && nextItem.outgoing.length > 0) {
                    const parseRating = (s: string) => {
                        const m = (s || '').toString().match(/(\d+(?:\.\d+)?)/);
                        return m ? parseFloat(m[1]) : NaN;
                    };

                    let defaultRating = '';
                    try {
                        const pole = item.name === 'VTPN' ? 'TP' : 'SP';
                        const mcb = await fetchProperties('MCB');
                        const allRatings = sortOptionStringsAsc(
                            Array.from(new Set((mcb.properties || []).map(p => p['Current Rating']).filter(Boolean)))
                        );
                        const poleRatingsRaw = (mcb.properties || [])
                            .filter(p => {
                                const pPole = (p['Pole'] || '').toString();
                                if (!pPole) return false;
                                return pPole === pole || pPole.includes(pole);
                            })
                            .map(p => p['Current Rating'])
                            .filter(Boolean);
                        const poleRatings = sortOptionStringsAsc(Array.from(new Set(poleRatingsRaw)));
                        const ratings = poleRatings.length > 0 ? poleRatings : allRatings;
                        defaultRating = ratings.find(r => {
                            const v = parseRating(r);
                            return Number.isFinite(v) && v >= threshold;
                        }) || ratings[0] || '';
                    } catch {
                    }
                    if (defaultRating) {
                        nextItem = {
                            ...nextItem,
                            outgoing: nextItem.outgoing.map(o => ({ ...(o || {}), 'Current Rating': defaultRating }))
                        };
                    }
                }
            }

            const geometry = calculateGeometry(nextItem);
            if (geometry) {
                nextItem = { ...nextItem, size: geometry.size, connectionPoints: geometry.connectionPoints };
            }
        }

        if (nextItem.svgContent && nextItem.properties?.[0]) {
            const updatedSvg = updateItemVisuals(nextItem);
            if (updatedSvg) nextItem = { ...nextItem, svgContent: updatedSvg };
        }

        if (this.diagramCallbacks?.updateItemRaw) {
            this.diagramCallbacks.updateItemRaw(itemId, nextItem, { recalcNetwork: true });
        } else if (this.diagramCallbacks?.updateItemProperties) {
            this.diagramCallbacks.updateItemProperties(itemId, finalProps);
        }

        return { success: true };
    }

    private setItemTransformTool(itemId?: string, x?: number, y?: number, width?: number, height?: number, rotation?: number): any {
        if (!this.diagramCallbacks?.updateItemTransform) return { error: 'updateItemTransform not available.' };
        if (!itemId) return { error: 'itemId is required.' };
        const r = this.resolveActiveSheetItemId(itemId);
        if ('error' in r) return { error: r.error };

        const sheet = this.getActiveSheet();
        const item = sheet?.canvasItems.find(i => i.uniqueID === r.id);
        if (!item) return { error: 'Item not found.' };

        const nx = Number.isFinite(Number(x)) ? Number(x) : item.position.x;
        const ny = Number.isFinite(Number(y)) ? Number(y) : item.position.y;
        const nw = Number.isFinite(Number(width)) ? Math.max(1, Number(width)) : item.size.width;
        const nh = Number.isFinite(Number(height)) ? Math.max(1, Number(height)) : item.size.height;
        const nr = Number.isFinite(Number(rotation)) ? Number(rotation) : (item.rotation ?? 0);

        this.diagramCallbacks.updateItemTransform(r.id, nx, ny, nw, nh, nr);
        return { success: true };
    }

    private lockItemTool(itemId?: string, locked?: boolean): any {
        if (!this.diagramCallbacks?.updateItemLock) return { error: 'updateItemLock not available.' };
        if (!itemId) return { error: 'itemId is required.' };
        const r = this.resolveActiveSheetItemId(itemId);
        if ('error' in r) return { error: r.error };
        this.diagramCallbacks.updateItemLock(r.id, !!locked);
        return { success: true };
    }

    private updateItemFieldsTool(itemId?: string, args?: any): any {
        if (!this.diagramCallbacks?.updateItemFields) return { error: 'updateItemFields not available.' };
        if (!itemId) return { error: 'itemId is required.' };
        const r = this.resolveActiveSheetItemId(itemId);
        if ('error' in r) return { error: r.error };

        const updates: Partial<Pick<CanvasItem, 'incomer' | 'outgoing' | 'accessories' | 'alternativeCompany1' | 'alternativeCompany2'>> = {};
        if (args?.incomer && typeof args.incomer === 'object') updates.incomer = args.incomer;
        if (Array.isArray(args?.outgoing)) updates.outgoing = args.outgoing;
        if (Array.isArray(args?.accessories)) updates.accessories = args.accessories;
        if (args?.alternativeCompany1 !== undefined) updates.alternativeCompany1 = String(args.alternativeCompany1);
        if (args?.alternativeCompany2 !== undefined) updates.alternativeCompany2 = String(args.alternativeCompany2);

        this.diagramCallbacks.updateItemFields(r.id, updates);
        return { success: true };
    }

    private duplicateItemTool(itemId?: string): any {
        if (!this.diagramCallbacks?.duplicateItem) return { error: 'duplicateItem not available.' };
        if (!itemId) return { error: 'itemId is required.' };
        const r = this.resolveActiveSheetItemId(itemId);
        if ('error' in r) return { error: r.error };
        this.diagramCallbacks.duplicateItem(r.id);
        return { success: true };
    }

    private async connectItemsTool(args: any): Promise<any> {
        if (!this.diagramCallbacks?.connectItems) return { error: 'connectItems not available.' };
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };

        const src = this.resolveActiveSheetItemId(args?.sourceItemId);
        if ('error' in src) return { error: src.error };
        const dst = this.resolveActiveSheetItemId(args?.targetItemId);
        if ('error' in dst) return { error: dst.error };

        const result = await this.diagramCallbacks.connectItems({
            sourceItemId: src.id,
            sourcePointKey: String(args?.sourcePointKey || ''),
            targetItemId: dst.id,
            targetPointKey: String(args?.targetPointKey || ''),
            materialType: (args?.materialType === 'Wiring' ? 'Wiring' : 'Cable')
        });

        if ('error' in result) return { error: result.error };

        return {
            success: true,
            connectorIndex: result.connectorIndex,
            connector: {
                materialType: result.connector.materialType,
                sourceItemId: result.connector.sourceItem.uniqueID,
                sourcePointKey: result.connector.sourcePointKey,
                targetItemId: result.connector.targetItem.uniqueID,
                targetPointKey: result.connector.targetPointKey,
                isVirtual: !!result.connector.isVirtual,
                properties: result.connector.properties || {}
            }
        };
    }

    private updateConnectorTool(connectorIndex?: number, updates?: any): any {
        if (!this.diagramCallbacks?.updateConnector) return { error: 'updateConnector not available.' };
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };
        const idx = Number(connectorIndex);
        if (!Number.isFinite(idx) || idx < 0 || idx >= sheet.storedConnectors.length) {
            return { error: 'connectorIndex is invalid.' };
        }
        if (!updates || typeof updates !== 'object') return { error: 'updates must be an object.' };

        const safeUpdates: Partial<Connector> = {};
        if (updates.materialType === 'Cable' || updates.materialType === 'Wiring') safeUpdates.materialType = updates.materialType;
        if (updates.properties && typeof updates.properties === 'object') {
            const p: Record<string, string> = {};
            Object.entries(updates.properties).forEach(([k, v]) => {
                if (v === undefined || v === null) return;
                p[String(k)] = String(v);
            });
            safeUpdates.properties = p;
        }
        if (updates.isVirtual !== undefined) safeUpdates.isVirtual = !!updates.isVirtual;
        if (updates.length !== undefined) safeUpdates.length = Number(updates.length);

        this.diagramCallbacks.updateConnector(idx, safeUpdates);
        return { success: true };
    }

    private deleteConnectorTool(connectorIndex?: number): any {
        if (!this.diagramCallbacks?.deleteConnector) return { error: 'deleteConnector not available.' };
        const sheet = this.getActiveSheet();
        if (!sheet) return { error: 'No active sheet.' };
        const idx = Number(connectorIndex);
        if (!Number.isFinite(idx) || idx < 0 || idx >= sheet.storedConnectors.length) {
            return { error: 'connectorIndex is invalid.' };
        }
        this.diagramCallbacks.deleteConnector(idx);
        return { success: true };
    }

    private autoLayoutActiveSheetTool(): any {
        if (!this.diagramCallbacks?.autoLayoutActiveSheet) return { error: 'autoLayoutActiveSheet not available.' };
        this.diagramCallbacks.autoLayoutActiveSheet();
        return { success: true };
    }

    private undoTool(): any {
        if (!this.diagramCallbacks?.undo) return { error: 'undo not available.' };
        this.diagramCallbacks.undo();
        return { success: true };
    }

    private redoTool(): any {
        if (!this.diagramCallbacks?.redo) return { error: 'redo not available.' };
        this.diagramCallbacks.redo();
        return { success: true };
    }

    private async applySldOperationsTool(operations?: any[], stopOnError: boolean = true): Promise<any> {
        if (!operations || !Array.isArray(operations) || operations.length === 0) {
            return { error: 'operations must be a non-empty array.' };
        }

        const results: any[] = [];
        for (const op of operations) {
            const tool = String(op?.tool || op?.name || op?.type || '');
            const args = op?.args || op?.arguments || {};
            if (!tool) {
                const err = { error: 'Operation missing tool name.' };
                results.push(err);
                if (stopOnError) break;
                continue;
            }
            if (tool === 'apply_sld_operations') {
                const err = { error: 'Nested apply_sld_operations is not allowed.' };
                results.push(err);
                if (stopOnError) break;
                continue;
            }
            const res = await this.handleToolCall(tool, args);
            results.push({ tool, result: res });
            if (stopOnError && res && typeof res === 'object' && 'error' in res) break;
        }

        return { success: true, results };
    }

    // ==================== DATABASE TOOLS ====================

    private async executeQuery(query: string) {
        try {
            const response = await axios.post(`${API_URL}/chat/query`, { query });
            return response.data;
        } catch (e: any) {
            return { error: e.response?.data?.message || e.message };
        }
    }

    private async getSchema() {
        try {
            const response = await axios.get(`${API_URL}/chat/schema`);
            return response.data;
        } catch (e: any) {
            return { error: e.response?.data?.message || e.message };
        }
    }

    // ==================== GEMINI API ====================



    private buildGroqMessages(): Array<Record<string, any>> {
        const messages: Array<Record<string, any>> = [];
        const requestHistory = this.getRequestHistory();
        for (const msg of requestHistory) {
            if (msg.role === 'system') {
                messages.push({ role: 'system', content: msg.content });
            } else if (msg.role === 'user') {
                messages.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                const m: any = { role: 'assistant', content: msg.content || '' };
                if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    m.tool_calls = msg.tool_calls.map((tc: any) => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.function?.name,
                            arguments: tc.function?.arguments
                        }
                    }));
                }
                messages.push(m);
            } else if (msg.role === 'tool') {
                messages.push({
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: msg.content
                });
            }
        }
        return messages;
    }



    private getRequestHistory(): ChatMessage[] {
        const all = this.history;
        if (all.length <= 1) return all;

        const system = all.find(m => m.role === 'system') || all[0];
        const rest = all.filter(m => m !== system);

        const picked: ChatMessage[] = [];
        for (let i = rest.length - 1; i >= 0; i--) {
            picked.push(rest[i]);
            if (picked.length >= this.maxRequestMessages) break;
        }
        picked.reverse();

        while (picked.length > 0 && picked[0].role === 'tool') {
            const idx = rest.indexOf(picked[0]);
            if (idx <= 0) break;
            const prev = rest[idx - 1];
            if (!prev) break;
            picked.unshift(prev);
        }

        const withSystem = [system, ...picked];
        let totalChars = withSystem.reduce((acc, m) => acc + (m.content?.length || 0) + 40, 0);
        while (withSystem.length > 2 && totalChars > this.maxRequestChars) {
            const removed = withSystem.splice(1, 1)[0];
            totalChars -= (removed?.content?.length || 0) + 40;
        }
        return withSystem;
    }

    private compactToolResult(toolName: string, result: any): any {
        const name = (toolName || '').toString();
        if (!result || typeof result !== 'object') return result;

        const truncate = (v: any, max: number) => {
            const s = (v ?? '').toString();
            if (s.length <= max) return s;
            return s.slice(0, max - 1) + '…';
        };

        if (name === 'list_available_items' && Array.isArray((result as any).items)) {
            const items = (result as any).items.map((i: any) => i?.name).filter(Boolean);
            return { items };
        }

        if (name === 'get_diagram_state_json' && (result as any).sheets) {
            try {
                const wantedProps = new Set(['Way', 'Current Rating', 'Voltage', 'Power', 'Phase', 'Type', 'Text', 'FontSize', 'Color', 'Align', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'FontFamily']);
                const out: any = {
                    activeSheetId: (result as any).activeSheetId ?? null,
                    sheetCount: (result as any).sheetCount ?? undefined,
                    totalItems: (result as any).totalItems ?? undefined,
                    totalConnectors: (result as any).totalConnectors ?? undefined,
                    sheets: []
                };
                (result as any).sheets.forEach((s: any) => {
                    const sheetOut: any = {
                        sheetId: s.sheetId,
                        name: s.name,
                        itemCount: s.itemCount,
                        connectorCount: s.connectorCount,
                        items: [],
                        connectors: []
                    };
                    (s.items || []).forEach((it: any) => {
                        const p: Record<string, string> = {};
                        Object.entries(it.properties || {}).forEach(([k, v]) => {
                            if (!wantedProps.has(k)) return;
                            if (!v) return;
                            p[k] = truncate(v, 40);
                        });
                        sheetOut.items.push({
                            id: it.id,
                            shortId: it.shortId,
                            name: it.name,
                            position: it.position,
                            connectionPointKeys: it.connectionPointKeys,
                            properties: p
                        });
                    });
                    (s.connectors || []).forEach((c: any) => {
                        sheetOut.connectors.push({
                            index: c.index,
                            materialType: c.materialType,
                            sourceItemId: c.sourceItemId,
                            sourcePointKey: c.sourcePointKey,
                            targetItemId: c.targetItemId,
                            targetPointKey: c.targetPointKey,
                            isVirtual: c.isVirtual,
                            currentValues: c.currentValues ? { Current: c.currentValues.Current } : {}
                        });
                    });
                    out.sheets.push(sheetOut);
                });
                return out;
            } catch {
                return result;
            }
        }

        if (name === 'execute_query' && Array.isArray((result as any).rows)) {
            const rows = (result as any).rows;
            if (rows.length > 30) return { ...result, rows: rows.slice(0, 30), truncated: true };
        }

        if (name === 'get_database_schema' && (result as any).tables && Array.isArray((result as any).tables)) {
            const tables = (result as any).tables;
            if (tables.length > 80) return { ...result, tables: tables.slice(0, 80), truncated: true };
        }

        return result;
    }

    // Returns shared tool definitions (Gemini format: name, description, parameters)
    private getGeminiTools() {
        // Helper to construct definition
        const f = (name: string, description: string, parameters: any) => ({ name, description, parameters });

        return [
            f("execute_query", "Execute a read-only SQL query on the application database.", {
                type: "object",
                properties: { query: { type: "string", description: "The SQL SELECT query to execute." } },
                required: ["query"]
            }),
            f("get_database_schema", "Get the FULL database schema. Call this FIRST before database queries.", { type: "object", properties: {} }),
            f("get_table_overview", "Get the first 5 rows of a specific table before querying.", {
                type: "object",
                properties: { tableName: { type: "string", description: "The name of the table to inspect." } },
                required: ["tableName"]
            }),
            f("get_diagram_summary", "Get a complete summary of all items and connections.", {
                type: "object",
                properties: { sheetName: { type: "string", description: "Optional: filter by sheet name" } }
            }),
            f("get_diagram_state_json", "Get machine-readable diagram state. Use this before edits.", {
                type: "object",
                properties: { scope: { type: "string", description: "active_sheet or all_sheets (default active_sheet)" } }
            }),
            f("validate_diagram", "Run QA checks on the active sheet.", { type: "object", properties: {} }),
            f("analyze_diagram", "Analyze the electrical diagram network.", { type: "object", properties: {} }),
            f("get_total_load", "Get total connected load and current by phase.", {
                type: "object",
                properties: { phase: { type: "string", description: "Optional: R, Y, or B" } }
            }),
            f("get_phase_balance", "Analyze phase balance across the system.", { type: "object", properties: {} }),
            f("suggest_cable_size", "Suggest cable size based on current.", {
                type: "object",
                properties: {
                    current: { type: "number", description: "Current in Amps" },
                    phases: { type: "string", description: "1-phase or 3-phase" }
                },
                required: ["current"]
            }),
            f("add_text_to_diagram", "Add a text box to the diagram with specific content and styling.", {
                type: "object",
                properties: {
                    text: { type: "string", description: "The text content to display" },
                    x: { type: "number", description: "X position (default 300)" },
                    y: { type: "number", description: "Y position (default 300)" },
                    fontSize: { type: "string", description: "Font size (e.g., '16', '24')" },
                    color: { type: "string", description: "Color hex code or name (e.g. '#FF0000', 'red')" },
                    align: { type: "string", description: "Text alignment: 'left', 'center', 'right'" },
                    bold: { type: "boolean" },
                    italic: { type: "boolean" },
                    underline: { type: "boolean" }
                },
                required: ["text"]
            }),
            f("add_item_to_diagram", "Add a new component to the canvas.", {
                type: "object",
                properties: {
                    itemName: { type: "string", description: "Item name" },
                    x: { type: "number", description: "Optional X (default 300)" },
                    y: { type: "number", description: "Optional Y (default 300)" },
                    properties: { type: "object", description: "Optional properties to apply after adding" }
                },
                required: ["itemName"]
            }),
            f("delete_item_from_diagram", "Delete an item by ID or name.", {
                type: "object",
                properties: {
                    itemId: { type: "string", description: "Item ID (prefix ok)" },
                    itemName: { type: "string", description: "Item name" }
                }
            }),
            f("list_sheets", "List all sheets and indicate which one is active.", { type: "object", properties: {} }),
            f("set_active_sheet", "Switch active sheet by sheetId or sheetName.", {
                type: "object",
                properties: {
                    sheetId: { type: "string", description: "Target sheetId" },
                    sheetName: { type: "string", description: "Target sheet name" }
                }
            }),
            f("add_sheet", "Create a new sheet and make it active.", {
                type: "object",
                properties: { name: { type: "string", description: "Optional sheet name" } }
            }),
            f("rename_sheet", "Rename a sheet.", {
                type: "object",
                properties: { sheetId: { type: "string" }, name: { type: "string" } },
                required: ["sheetId", "name"]
            }),
            f("remove_sheet", "Remove a sheet by sheetId.", {
                type: "object",
                properties: { sheetId: { type: "string" } },
                required: ["sheetId"]
            }),
            f("list_available_items", "List items that can be added.", { type: "object", properties: {} }),
            f("move_items", "Move multiple items.", {
                type: "object",
                properties: {
                    moves: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: { itemId: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
                            required: ["itemId", "x", "y"]
                        }
                    }
                },
                required: ["moves"]
            }),
            f("set_item_properties", "Merge/overwrite properties[0] for an item on the active sheet.", {
                type: "object",
                properties: { itemId: { type: "string" }, properties: { type: "object" } },
                required: ["itemId", "properties"]
            }),
            f("normalize_item_properties", "Snap an item's dropdown properties to a valid database row.", {
                type: "object",
                properties: { itemId: { type: "string" } },
                required: ["itemId"]
            }),
            f("normalize_active_sheet_properties", "Fix invalid dropdown selections for all items on active sheet.", { type: "object", properties: {} }),
            f("get_item_property_options", "Get valid dropdown options for an item from the database.", {
                type: "object",
                properties: { itemName: { type: "string" } },
                required: ["itemName"]
            }),
            f("set_item_transform", "Set position/size/rotation for an item.", {
                type: "object",
                properties: {
                    itemId: { type: "string" },
                    x: { type: "number" },
                    y: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                    rotation: { type: "number" }
                },
                required: ["itemId"]
            }),
            f("lock_item", "Lock or unlock an item.", {
                type: "object",
                properties: { itemId: { type: "string" }, locked: { type: "boolean" } },
                required: ["itemId", "locked"]
            }),
            f("update_item_fields", "Update incomer/outgoing/accessories and alternative companies.", {
                type: "object",
                properties: {
                    itemId: { type: "string" },
                    incomer: { type: "object" },
                    outgoing: { type: "array", items: { type: "object" } },
                    accessories: { type: "array", items: { type: "object" } },
                    alternativeCompany1: { type: "string" },
                    alternativeCompany2: { type: "string" }
                },
                required: ["itemId"]
            }),
            f("duplicate_item", "Duplicate an item.", {
                type: "object",
                properties: { itemId: { type: "string" } },
                required: ["itemId"]
            }),
            f("connect_items", "Create a connector between two items.", {
                type: "object",
                properties: {
                    sourceItemId: { type: "string" },
                    sourcePointKey: { type: "string" },
                    targetItemId: { type: "string" },
                    targetPointKey: { type: "string" },
                    materialType: { type: "string" }
                },
                required: ["sourceItemId", "sourcePointKey", "targetItemId", "targetPointKey"]
            }),
            f("update_connector", "Update a connector by index.", {
                type: "object",
                properties: {
                    connectorIndex: { type: "number" },
                    updates: { type: "object" }
                },
                required: ["connectorIndex", "updates"]
            }),
            f("delete_connector", "Delete a connector by index.", {
                type: "object",
                properties: { connectorIndex: { type: "number" } },
                required: ["connectorIndex"]
            }),
            f("auto_arrange", "Auto-arrange items on the active sheet.", { type: "object", properties: {} }),
            f("undo", "Undo the last action.", { type: "object", properties: {} }),
            f("redo", "Redo the last undone action.", { type: "object", properties: {} }),
            f("apply_sld_operations", "Execute a sequence of tool operations.", {
                type: "object",
                properties: {
                    operations: { type: "array", items: { type: "object" } },
                    stopOnError: { type: "boolean" }
                },
                required: ["operations"]
            })
        ];
    }

    private getOpenAiTools() {
        return this.getGeminiTools().map(tool => ({
            type: 'function' as const,
            function: tool
        }));
    }


}

export const chatService = new ChatService();
