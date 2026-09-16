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
import { layoutAgentTools } from './LayoutAgentTools';
import { LAYOUT_TO_SLD_MAP } from '../utils/ComponentMapping';
import { useLayoutStore } from '../store/useLayoutStore';
import { useStore } from '../store/useStore';
import { getSkill, getSkillIndex } from '../agent/skills';
import { looksUnfinished } from '../agent/turnHeuristics';
import { normalizeSldOperation, isNormalizeError } from '../agent/sldOperations';
import type { AgentHooks } from '../agent/AgentController';

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
    updateItemFields?: (itemId: string, updates: Partial<Pick<CanvasItem, 'incomer' | 'outgoing' | 'accessories' | 'alternativeCompany1' | 'alternativeCompany2'>>) => { success: true } | { error: string } | void;
    updateItemRaw?: (itemId: string, updates: Partial<CanvasItem>, options?: { recalcNetwork?: boolean }) => { success: true } | { error: string } | void;
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

/**
 * Ceiling on tool calls executed from a single model reply.
 *
 * A model that tries to emit one call per item — seven `layout_set_room_info`
 * calls, or forty `layout_place_component` calls — routinely runs out of output
 * tokens partway through, and the truncated reply executes nothing at all. The
 * prompt asks for at most this many; this constant enforces it, and the model is
 * told what happened so it retries with a batch tool instead.
 */
const MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * How many times a single agent run may be nudged to continue after ending a
 * turn with prose but no tool call.
 *
 * One is enough to recover a model that narrated an action and forgot to emit it.
 * More than that risks arguing with a model that has genuinely finished, and each
 * nudge costs a full request.
 */
const MAX_CONTINUATION_NUDGES = 2;

/**
 * Tools that are never useful during an automated design run.
 *
 * Gemini's function-calling reliability degrades as the declaration list grows:
 * with ~50 tools it starts emitting Python-ish pseudo-code
 * (`print(default_api.layout_suggest_positions(...))`) instead of structured
 * calls, which the API rejects as MALFORMED_FUNCTION_CALL and the whole turn is
 * lost. Trimming the surface for design runs both reduces that failure rate and
 * cuts several thousand prompt tokens per request.
 *
 * These stay available in ordinary chat, where the user may well want them.
 */
const TOOLS_EXCLUDED_FROM_DESIGN_RUNS = new Set([
    'execute_query',
    'get_database_schema',
    'get_table_overview',
    'get_diagram_summary',
    'get_total_load',
    'suggest_cable_size',
    'add_text_to_diagram',
    'list_sheets',
    'add_sheet',
    'rename_sheet',
    'remove_sheet',
    'list_available_items',
    'move_items',
    'normalize_item_properties',
    'normalize_active_sheet_properties',
    'get_item_property_options',
    'set_item_transform',
    'lock_item',
    'duplicate_item',
    'update_connector',
    'delete_connector',
    'delete_item_from_diagram',
    'update_item_fields',
    'undo',
    'redo',
    'layout_connect_components',
    'layout_delete_component',
    'layout_set_room_info', // superseded by the batch variant during a run
    'layout_set_active_floor_plan'
]);

/**
 * Recover tool calls from a MALFORMED_FUNCTION_CALL reply.
 *
 * Gemini occasionally emits Python-flavoured pseudo-code instead of structured
 * function calls:
 *
 *   print(default_api.layout_suggest_positions(roomId = "room_1", count = 3))
 *
 * The API rejects that as malformed and returns no content — but it echoes the
 * text in `finishMessage`, and the model's intent is unambiguous. Parsing it back
 * into real calls turns a dead turn into a working one, which matters because
 * this failure tends to hit the same model on the same step repeatedly.
 *
 * Deliberately conservative: only `name = value` pairs with string, number or
 * boolean literals are accepted. Anything with nested structures is skipped
 * rather than guessed at, and the run continues with whatever parsed cleanly.
 */
function extractCallsFromMalformedText(text: string): any[] {
    const src = (text || '').toString();
    if (!src) return [];

    const calls: any[] = [];

    // ── Strategy 1: Python-style keyword calls ──────────────────────────────
    // default_api.<name>( ... ) or just <name>( ... )
    // Non-greedy up to the matching close paren. Nested parens in string
    // literals are rare enough that a simple non-nesting regex works here.
    const callRegex = /(?:default_api\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(([^()]*)\))/g;

    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(src)) !== null) {
        const name = match[1];
        const argsText = match[2] || '';

        // `print` is the wrapper, not the tool.
        if (name === 'print') continue;

        const args: Record<string, any> = {};
        const argRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?)|(true|false|True|False))/g;

        let argMatch: RegExpExecArray | null;
        while ((argMatch = argRegex.exec(argsText)) !== null) {
            const key = argMatch[1];
            if (argMatch[2] !== undefined) args[key] = argMatch[2];
            else if (argMatch[3] !== undefined) args[key] = argMatch[3];
            else if (argMatch[4] !== undefined) args[key] = Number(argMatch[4]);
            else if (argMatch[5] !== undefined) args[key] = /^true$/i.test(argMatch[5]);
        }

        if (Object.keys(args).length === 0) continue;

        calls.push({
            id: `recovered_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
        });
    }

    if (calls.length > 0) return calls;

    // ── Strategy 2: Brace-style JSON calls ─────────────────────────────────
    // Gemini Flash Lite sometimes emits:
    //   layout_place_components{components:[...],planId:"..."}
    //   layout_place_components({components:[...],planId:"..."})
    // i.e. the tool name immediately followed by a JSON object (with or
    // without wrapping parens).  We find each tool name followed by '{', then
    // grab the balanced brace block and parse it as JSON.
    const braceRegex = /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(\s*)?\{/g;
    let braceMatch: RegExpExecArray | null;
    while ((braceMatch = braceRegex.exec(src)) !== null) {
        const name = braceMatch[1];
        if (name === 'print') continue;

        // Walk forward balancing braces to find the full JSON body.
        const startIdx = braceMatch.index + braceMatch[0].length - 1; // position of the opening '{'
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
                depth--;
                if (depth === 0) { endIdx = i; break; }
            }
        }
        if (endIdx === -1) continue;

        const jsonCandidate = src.slice(startIdx, endIdx + 1);
        try {
            const args = JSON.parse(jsonCandidate);
            if (typeof args === 'object' && args !== null && Object.keys(args).length > 0) {
                calls.push({
                    id: `recovered_${Math.random().toString(36).slice(2, 10)}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) }
                });
            }
        } catch {
            // Not valid JSON — skip this candidate.
        }
    }

    return calls;
}

export class ChatService {
    private history: ChatMessage[] = [];
    private currentDiagramContext: string = '';
    private cachedContentName: string | null = null;

    /**
     * Latched once the API tells us context caching is not permitted.
     *
     * Free-tier keys have a cached-content storage limit of 0, so the create call
     * fails with 429 forever. Without this we retried it before every single
     * request in a run.
     */
    private cacheUnavailable = false;
    private staticSystemPrompt: string = '';
    private diagramCallbacks: DiagramCallbacks | null = null;
    private currentSheets: CanvasSheet[] = [];
    private lastLlmRequestAtMs: number = 0;
    private readonly maxRequestMessages: number = 40;
    private readonly maxRequestChars: number = 60000;

    /**
     * Supervision hooks, set while an agent run is active.
     *
     * When present, every tool call is gated through `beforeToolCall`, which is
     * how Stop and Pause take effect. When absent the service behaves exactly as
     * before, so ordinary chat is unaffected.
     */
    private agentHooks: AgentHooks | null = null;

    /** Skills already injected this conversation, so we do not resend bodies. */
    private loadedSkills = new Set<string>();

    /**
     * How many more provider requests may carry attached images.
     *
     * Images live in `history`, and every provider request replays the whole
     * history — so a floor plan attached to the opening message would be re-sent
     * on all 20+ turns of a design run. At roughly 1.5k vision tokens per image
     * that is tens of thousands of wasted tokens, and on some providers it is the
     * single largest cost in the run.
     *
     * The agent only needs to *look* at the drawing early: it reads room labels
     * and checks the detected walls in Phase 0, then records what it found with
     * layout_set_room_info, after which the information lives in tool state. So
     * we carry the image for the first few requests and drop it afterwards.
     */
    private imageRequestBudget = Number.POSITIVE_INFINITY;

    constructor() {
        this.reset();
    }

    setDiagramCallbacks(callbacks: DiagramCallbacks) {
        this.diagramCallbacks = callbacks;
    }

    setAgentHooks(hooks: AgentHooks | null) {
        this.agentHooks = hooks;
    }

    reset() {
        this.history = [];
        this.loadedSkills = new Set<string>();
        this.imageRequestBudget = Number.POSITIVE_INFINITY;
        this.staticSystemPrompt = `You are the design agent for Sayanho, an electrical design application with two linked views:

- LAYOUT: an architectural floor plan where physical devices are placed in rooms.
- SLD: the single-line schematic where those same devices are wired together.

The two views are linked. A device placed in Layout becomes a symbol in the SLD, and
connections made in the SLD are drawn back over the floor plan. Never treat them as
separate drawings.

## Skills

Domain knowledge lives in skill documents. Load the ones you need with load_skill
before acting — do not work from memory of electrical practice.

${getSkillIndex()}

For a full "design the electrics for this floor plan" request, load
electrical-design-workflow first and follow its phases in order.

## Working rules

1) Read before you write. Call the relevant get_* tool for exact ids, room
   geometry and connection point keys. Never invent an id, a point key, or a
   dropdown value.
2) Prefer batch tools and emit AT MOST 8 tool calls in one turn — ideally 1-3.
   Too many at once overruns your output token limit, truncates the reply, and the
   whole run fails with nothing executed. Use:
   - layout_suggest_positions_batch instead of repeated layout_suggest_positions
   - layout_place_components instead of repeated layout_place_component
   - layout_set_rooms_info instead of repeated layout_set_room_info
   - apply_sld_operations instead of repeated connect_items / set_item_properties
   One batch call carrying 20 items is correct; 20 separate calls is not.
3) You have coordinate and quantity authority. layout_suggest_positions(_batch)
   gives vetted coordinates (recommended counts, sweep clearance checked) — use
   it by default. But you may place by your own numbers instead: your own
   arithmetic on the room polygon vertices in the geometry, or positions read
   from the floor plan image (room centres, inscribed-rectangle centres,
   furniture-aware nudges). You decide which room and how many; the placement
   tools validate every point (inside-a-room gate, fan sweep vs
   walls/doors/windows) and layout_validate re-checks all of it. A placement
   the validator rejects is not placed well — fix the coordinates or the
   detection until it passes. Never invent an id, a point key, or a dropdown
   value; coordinates are the only thing you may originate.
4) One connector per connection point key. If you run out of outputs on a board,
   add another board — never double up on a key.
5) If a tool returns an error, read it and adapt. Do not retry the identical call.
   If two tools contradict each other, say so and investigate — never route around
   the contradiction by building the same thing a second way.
6) SLD symbols for floor-plan devices come from layout_build_sld ONLY. Never use
   add_item_to_diagram for something that exists in the layout: the symbol would
   have no link back to the floor plan, both views would list the device as
   Unplaced, and your wiring would have no counterpart on the plan.
7) Call request_review at the milestones the workflow skill marks. The user can
   inspect and correct your work there, which is cheaper than unwinding later.
8) Verify at the end (layout_validate, validate_diagram, analyze_diagram) and fix
   every error. Report remaining warnings honestly. A design presented as complete
   while loads are unfed is a failure, not a success. Note that validate_diagram
   passes trivially on an empty sheet — check totalItems as well.
9) Never end a turn describing work you have not done. If your message says you
   are placing or wiring something, the tool calls must be in that same turn.
10) State your assumptions. If the floor plan scale is uncalibrated or rooms were
   not detected, say so plainly instead of producing confident numbers from a
   default scale.

## When a floor plan image is attached

You may receive the source floor plan drawing as an image. It is a second,
independent view of the same building — the tool geometry is derived from
automated wall and room detection, which can be wrong.

- Use the image to read room labels and dimension text that detection OCR missed,
  to infer a room's purpose from its fixtures, and to tell boundary (external)
  walls from internal partition walls — AC points and exhaust fans must go on
  boundary walls only.
- Record what you read with layout_set_room_info so the user can see and correct
  your interpretation.
- Cross-check: if the drawing shows walls or rooms the geometry tools do not, or
  the counts disagree, say so explicitly and ask the user to fix the detection.
  Do not quietly design around a detection error — the vectors are what the rest
  of the app uses, so a mismatch is a real problem, not a cosmetic one.
- Coordinates may come from layout_suggest_positions or from your own reading of the image and the room polygon vertices — you have coordinate authority. Every placement is validated (inside-a-room, sweep clearance); layout_validate must pass, so fix or justify any rejected point instead of leaving it.

## Style

Before your first tool call in a turn, give a 1-3 bullet 'Approach'. Keep prose
short; the user watches a live action log, so do not narrate every call.`;

        // Initialize history with ONLY static system prompt to enable prefix caching
        this.history = [{ role: 'system', content: this.staticSystemPrompt }];
        this.cachedContentName = null;
    }

    async initializeContext(sheets: CanvasSheet[]) {
        this.currentSheets = sheets;
        const activeSheetId = this.diagramCallbacks?.getActiveSheetId?.() ?? null;
        // Store dynamic context separately - DO NOT Mutate History[0]
        this.currentDiagramContext = DiagramContextBuilder.buildCompactContext(sheets, activeSheetId);

        // Append a one-line Layout summary. Without this the agent has no idea a
        // floor plan exists until it happens to call a layout tool, and tends to
        // start designing a schematic from nothing.
        const layoutSummary = this.buildLayoutContextLine();
        if (layoutSummary) {
            this.currentDiagramContext = `${this.currentDiagramContext}\n${layoutSummary}`;
        }

        // Ensure history has the static prompt
        if (this.history.length === 0 || this.history[0].role !== 'system') {
            this.history = [{ role: 'system', content: this.staticSystemPrompt }, ...this.history];
        } else {
            // Re-enforce static prompt if it was somehow changed (shouldn't be)
            this.history[0].content = this.staticSystemPrompt;
        }
    }

    /**
     * Compact Layout state for the per-turn context.
     *
     * Deliberately one line: enough for the agent to know whether a plan exists
     * and whether it is usable, not a substitute for calling
     * layout_get_plan_geometry.
     */
    private buildLayoutContextLine(): string {
        try {
            const info = layoutAgentTools.listFloorPlans();
            if (!info || !Array.isArray(info.floorPlans) || info.floorPlans.length === 0) {
                return 'LAYOUT: no floor plans loaded.';
            }

            const parts = info.floorPlans.map((p: any) => {
                const flags: string[] = [];
                if (p.isActive) flags.push('active');
                if (!p.isScaleCalibrated) flags.push('UNCALIBRATED');
                return `${p.name} [${p.id.slice(0, 10)}] rooms=${p.counts.rooms} walls=${p.counts.walls} components=${p.counts.components}${flags.length ? ` (${flags.join(', ')})` : ''}`;
            });

            return `LAYOUT: ${info.count} floor plan(s) — ${parts.join(' | ')}`;
        } catch {
            return '';
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
                        : provider === 'bai' ? 'gpt-5.6-luna'
                            : 'gemini-2.5-flash'
        );
        const baseUrl = settings.baseUrl || (
            provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
                : provider === 'mistral' ? 'https://api.mistral.ai/v1'
                    : provider === 'bai' ? 'https://api.b.ai/v1'
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
            // Enough turns for the agent to read labels and cross-check the
            // detected geometry in Phase 0, then the attachment is dropped from
            // subsequent requests. See imageRequestBudget.
            this.imageRequestBudget = 4;
        }
        this.history.push(userMessage);

        try {
            const reasoning = (provider === 'openrouter' && (settings as any).reasoning) ? (settings as any).reasoning : undefined;
            const callProvider = async () => {
                const result = provider === 'groq'
                    ? await this.callGroq(apiKey, modelName, baseUrl)
                    : provider === 'openrouter'
                        ? await this.callOpenRouter(apiKey, modelName, baseUrl, extraHeaders, reasoning)
                        : provider === 'mistral'
                            ? await this.callMistral(apiKey, modelName, baseUrl)
                            : provider === 'bai'
                                ? await this.callBai(apiKey, modelName, baseUrl)
                                : await this.callGemini(apiKey, modelName);

                // Charged only on a successful response, so a rate-limited retry
                // does not silently burn the agent's chance to look at the plan.
                if (this.imageRequestBudget > 0 && Number.isFinite(this.imageRequestBudget)) {
                    this.imageRequestBudget -= 1;
                }
                return result;
            };

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
            let continuationNudges = 0;

            while (currentTurn < maxTurns) {
                currentTurn++;

                let textResponse = '';
                const toolCalls: any[] = [];

                if (provider === 'groq' || provider === 'openrouter' || provider === 'mistral' || provider === 'bai') {
                    const choice = response?.choices?.[0];
                    const msg = choice?.message;
                    if (!msg) {
                        // Same reasoning as the Gemini branch below: report the
                        // provider's own stop reason rather than a generic string,
                        // so a token-limit stop is not mistaken for a network fault.
                        const finish = choice?.finish_reason;
                        const apiError = (response as any)?.error?.message;
                        if (apiError) throw new Error(`Provider error: ${apiError}`);
                        throw new Error(
                            finish === 'length'
                                ? 'The model hit its output token limit mid-reply. Ask it to work in smaller batches, or raise the output limit.'
                                : finish
                                    ? `The model returned no message (finish_reason: ${finish}).`
                                    : 'The model returned an empty response.'
                        );
                    }
                    const rawContentStr = msg.content ? String(msg.content) : '';
                    const extractedFromText = this.extractToolCallsFromText(rawContentStr);
                    const contentStr = extractedFromText.cleanedText;
                    // OpenRouter calls it `reasoning`; B.AI's DeepSeek/GLM-family
                    // models use the DeepSeek field name `reasoning_content`.
                    const rawReasoningStr = (msg as any).reasoning
                        ? String((msg as any).reasoning)
                        : ((msg as any).reasoning_content ? String((msg as any).reasoning_content) : '');
                    const extractedFromReasoning = this.extractToolCallsFromText(rawReasoningStr);
                    const reasoningStr = extractedFromReasoning.cleanedText;
                    textResponse = contentStr;
                    if ((provider === 'openrouter' || provider === 'bai') && reasoningStr && reasoningStr.trim()) {
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

                    // Gemini sometimes answers a function-calling request with
                    // Python-ish pseudo-code or brace-notation JSON instead of
                    // structured calls, and the API rejects its own output as
                    // MALFORMED_FUNCTION_CALL. The intended calls are sometimes
                    // recoverable from finishMessage, but when finishMessage only
                    // says "Function call is empty", Gemini Flash Lite emits the
                    // call body as plain text parts in candidate.content.parts.
                    // Try both sources before giving up.
                    if (candidate?.finishReason === 'MALFORMED_FUNCTION_CALL') {
                        // Source 1: finishMessage (e.g. Python pseudo-code)
                        const recovered = extractCallsFromMalformedText(candidate?.finishMessage || '');
                        if (recovered.length > 0) {
                            console.warn(`[ChatService] Recovered ${recovered.length} tool call(s) from MALFORMED finishMessage.`);
                            recovered.forEach(tc => toolCalls.push(tc));
                            textResponse = 'Recovered the intended tool calls from a malformed model reply.';
                        }

                        // Source 2: text parts in candidate.content (Gemini Flash Lite
                        // emits the tool call as scattered text parts rather than a
                        // structured functionCall part, so finishMessage is empty).
                        if (toolCalls.length === 0 && candidate?.content?.parts) {
                            const partsText = (candidate.content.parts as any[])
                                .filter(p => typeof p.text === 'string')
                                .map(p => p.text as string)
                                .join('');
                            if (partsText.trim()) {
                                const recoveredFromParts = extractCallsFromMalformedText(partsText);
                                if (recoveredFromParts.length > 0) {
                                    console.warn(`[ChatService] Recovered ${recoveredFromParts.length} tool call(s) from MALFORMED content.parts text.`);
                                    recoveredFromParts.forEach(tc => toolCalls.push(tc));
                                    textResponse = 'Recovered the intended tool calls from a malformed model reply (text parts).';
                                }
                            }
                        }
                    }


                    // Gemini returns a candidate with no `content` when it stops
                    // for a reason other than producing text: MAX_TOKENS,
                    // SAFETY, RECITATION, or MALFORMED_FUNCTION_CALL. The old
                    // message ("No response from AI") threw all of those away,
                    // which made a token-limit stop indistinguishable from a
                    // network failure. Report what actually happened.
                    if (toolCalls.length === 0 && (!candidate || !candidate.content)) {
                        const reason = candidate?.finishReason || response?.promptFeedback?.blockReason;
                        const usage = response?.usageMetadata;

                        const explain = (r?: string): string => {
                            switch (r) {
                                case 'MAX_TOKENS':
                                    return 'The model hit its output token limit mid-reply. This usually means it tried to emit too many tool calls at once — ask it to work in smaller batches, or raise the model\'s output limit.';
                                case 'SAFETY':
                                    return 'The model stopped for safety filtering.';
                                case 'RECITATION':
                                    return 'The model stopped because its reply matched training data too closely.';
                                case 'MALFORMED_FUNCTION_CALL':
                                    return 'The model emitted a malformed tool call. Retry; if it persists the tool schema may be too large for this model.';
                                case 'PROHIBITED_CONTENT':
                                case 'BLOCKLIST':
                                    return 'The request was blocked by content filtering.';
                                default:
                                    return r
                                        ? `The model returned no content (finishReason: ${r}).`
                                        : 'The model returned an empty response with no reason given.';
                            }
                        };

                        const detail = usage
                            ? ` Tokens: ${usage.promptTokenCount ?? '?'} prompt, ${usage.candidatesTokenCount ?? 0} output, ${usage.totalTokenCount ?? '?'} total.`
                            : '';

                        throw new Error(`${explain(reason)}${detail}`);
                    }

                    // A MALFORMED_FUNCTION_CALL candidate has recovered calls but
                    // no `content` at all, so this must tolerate its absence.
                    const parts = candidate?.content?.parts || [];

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

                    // Surface the model's reasoning in the agent log so the user
                    // can see why it is doing what it is doing.
                    this.agentHooks?.onAssistantText(textResponse);
                }

                if (toolCalls.length === 0) {
                    // An agent run that ends its turn with prose instead of tool
                    // calls is usually the model narrating work it then forgot to
                    // perform — observed in a real run as "Placing the decided
                    // loads for the merged living region…" followed by
                    // finish_reason: stop and nothing executed. From the user's
                    // side that looks like the agent quietly abandoning the job
                    // halfway through.
                    //
                    // One nudge per run, and only during an agent run. Chat must
                    // still be able to answer a question and stop.
                    if (this.agentHooks && continuationNudges < MAX_CONTINUATION_NUDGES && looksUnfinished(textResponse)) {
                        continuationNudges++;
                        this.history.push({
                            role: 'user',
                            content: '[SYSTEM] You ended your turn without calling any tool, but your message describes work you were about to do. Nothing was executed. Either perform that work now with the appropriate tool calls, or — if the design is genuinely finished — run layout_validate and validate_diagram, then give your final summary.'
                        });
                        response = await this.callWithThrottleAndRetry(callProvider, requestsPerMinute, retryOnError, maxRetryAttempts);
                        continue;
                    }
                    break;
                }

                // Guard against a model that requests a very large batch of tool
                // calls in one turn. The prompt asks for at most 8, but if it
                // ignores that, executing 40 calls serially is slow and the reply
                // that produced them was probably truncated anyway. Trim and tell
                // the model, so it retries in smaller batches instead of failing.
                let deferredCallCount = 0;
                if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
                    deferredCallCount = toolCalls.length - MAX_TOOL_CALLS_PER_TURN;
                    toolCalls.length = MAX_TOOL_CALLS_PER_TURN;
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

                    // Supervision gate. Checked between tool calls rather than
                    // mid-call so a stop can never leave the stores half-mutated.
                    if (this.agentHooks) {
                        const proceed = await this.agentHooks.beforeToolCall(toolCall.function.name, args);
                        if (!proceed) {
                            this.history.push({
                                role: 'assistant',
                                content: 'Stopped at your request. Everything placed so far is on the canvas and fully editable.'
                            });
                            return [...this.history];
                        }
                    }

                    try {
                        result = await this.handleToolCall(toolCall.function.name, args);
                    } catch (e: any) {
                        result = { error: e.message || 'Tool execution failed' };
                    }

                    this.agentHooks?.afterToolCall(toolCall.function.name, result);

                    const compacted = this.compactToolResult(toolCall.function.name, result);
                    this.history.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(compacted),
                        name: toolCall.function.name
                    } as any);
                    toolCallsExecuted += 1;
                }

                if (deferredCallCount > 0) {
                    this.history.push({
                        role: 'user',
                        content: `[SYSTEM] You requested ${deferredCallCount + MAX_TOOL_CALLS_PER_TURN} tool calls in one turn; only the first ${MAX_TOOL_CALLS_PER_TURN} were executed. Emit at most ${MAX_TOOL_CALLS_PER_TURN} per turn — use a batch tool (layout_place_components, layout_set_rooms_info, apply_sld_operations) where one exists. Continue with the remaining work now.`
                    });
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

    /**
     * Should this request still carry attached images?
     *
     * See imageRequestBudget: the drawing is only useful to the agent for its
     * first few turns, and replaying it on every turn of a long run is the most
     * expensive thing in the request.
     */
    private shouldSendImages(): boolean {
        return this.imageRequestBudget > 0;
    }

    private async callOpenRouter(apiKey: string, model: string, baseUrl: string, extraHeaders?: any, reasoning?: any): Promise<any> {
        const body: any = {
            model: model,
            messages: this.buildOpenAiMessages(),
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

    /**
     * Conversation history in OpenAI Chat Completions shape.
     *
     * Shared by every OpenAI-compatible provider (OpenRouter, Groq, Mistral,
     * B.AI), so image handling and the tool-call round trip stay identical
     * across them instead of drifting per provider.
     */
    private buildOpenAiMessages(): any[] {
        const includeImages = this.shouldSendImages();

        return this.history.map(m => {
            const msg: any = { role: m.role };
            if (m.tool_calls) msg.tool_calls = m.tool_calls;
            if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
            if (m.name) msg.name = m.name;

            if (m.role === 'user' && m.images && m.images.length > 0 && includeImages) {
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
    }

    private async callGemini(apiKey: string, model: string): Promise<any> {
        // 1. Try to use or create cached content for Static Prompt + Tools.
        //
        // `cacheUnavailable` latches after the first refusal. The free tier has
        // TotalCachedContentStorageTokens = 0, so this POST fails with 429 every
        // time — and without the latch we retried it before EVERY request,
        // adding ~2s of latency per turn and a wasted round trip for nothing.
        if (!this.cachedContentName && !this.cacheUnavailable) {
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
            } catch (e: any) {
                // 429 = the key's tier does not allow context caching at all.
                // Anything else may be transient, so only latch on the former.
                const status = e?.response?.status;
                if (status === 429 || status === 403) {
                    this.cacheUnavailable = true;
                    console.warn('[ChatService] Context caching unavailable on this API tier; not retrying for the rest of this conversation.');
                } else {
                    console.warn('[ChatService] Failed to create cache, falling back to standard request', e);
                }
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
        const includeImages = this.shouldSendImages();

        for (const msg of history) {
            if (msg.role === 'system') {
                // In new architecture, system prompt is static and handled via cache or separate field
                // We do NOT add it to contents array for Gemini
                continue;
            }

            const parts: any[] = [];

            // Text content.
            //
            // Skipped for tool messages: their `content` IS the JSON result, and
            // it is already carried below as a structured functionResponse.
            // Pushing both sent every tool result twice — a 6 KB skill document
            // counted twice against the prompt on every subsequent turn, which is
            // most of why a 7-room plan reached 19k prompt tokens.
            if (msg.content && msg.role !== 'tool') {
                parts.push({ text: msg.content });
            }

            // Image content
            if (msg.role === 'user' && msg.images && msg.images.length > 0 && includeImages) {
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

    /**
     * B.AI (https://api.b.ai/v1).
     *
     * B.AI exposes three protocols behind one key: OpenAI Chat Completions,
     * OpenAI Responses, and Anthropic Messages. We use /chat/completions
     * deliberately — this class already speaks that shape for OpenRouter, Groq
     * and Mistral, so tool calls, multimodal content and the reply parser all
     * work unchanged. Responses would need `input`/`max_output_tokens` and a
     * different `output[]` walk for no gain here.
     *
     * The only wire differences from callOpenRouter are the auth header (B.AI
     * accepts `Authorization: Bearer` or `x-api-key`; we send the Bearer form
     * the OpenAI SDK uses) and the omission of OpenRouter's `reasoning` field,
     * which B.AI does not define for this endpoint.
     */
    private async callBai(apiKey: string, model: string, baseUrl: string): Promise<any> {
        const response = await axios.post(
            `${this.normalizeBaseUrl(baseUrl, 'https://api.b.ai/v1')}/chat/completions`,
            {
                model,
                messages: this.buildOpenAiMessages(),
                tools: this.getOpenAiTools(),
                tool_choice: 'auto'
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    }

    /**
     * Trim a user-entered base URL so `${baseUrl}/chat/completions` is valid.
     *
     * The Settings field is free text, and pasting the full endpoint or a
     * trailing slash from the docs is the obvious mistake to make. Both produce
     * a 404 that looks like an outage rather than a typo.
     */
    private normalizeBaseUrl(baseUrl: string, fallback: string): string {
        const raw = (baseUrl || '').trim();
        if (!raw) return fallback;
        return raw
            .replace(/\/+$/, '')
            .replace(/\/chat\/completions$/i, '')
            .replace(/\/responses$/i, '')
            .replace(/\/messages$/i, '');
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

            case 'sld_auto_rate':
                return this.autoRateSldTool();

            case 'undo':
                return this.undoTool();

            case 'redo':
                return this.redoTool();

            case 'apply_sld_operations':
                return this.applySldOperationsTool(args.operations, args.stopOnError);

            // ---------------- Agent: skills ----------------
            case 'load_skill':
                return this.loadSkillTool(args.name);

            case 'request_review':
                return this.requestReviewTool(args.milestone, args.summary);

            // ---------------- Agent: Layout Designer ----------------
            case 'layout_list_floor_plans':
                return layoutAgentTools.listFloorPlans();

            case 'layout_set_active_floor_plan':
                return layoutAgentTools.setActiveFloorPlan(args.planId);

            case 'layout_get_plan_geometry':
                return layoutAgentTools.getPlanGeometry(args.planId);

            case 'layout_get_placed_components':
                return layoutAgentTools.getPlacedComponents(args.planId, args.roomId);

            case 'layout_get_component_catalog':
                return layoutAgentTools.getComponentCatalog();

            case 'layout_suggest_positions':
                return layoutAgentTools.suggestPositions(args);

            case 'layout_suggest_positions_batch':
                return layoutAgentTools.suggestPositionsBatch(args.requests, args.planId);

            case 'layout_place_component':
                return layoutAgentTools.placeComponent(args);

            case 'layout_place_components':
                return layoutAgentTools.placeComponents(args.components, args.planId);

            case 'layout_update_component':
                return layoutAgentTools.updateComponent(args);

            case 'layout_update_components':
                return layoutAgentTools.updateComponents(args.updates, args.planId);

            case 'layout_delete_component':
                return layoutAgentTools.deleteComponent(args.id, args.planId);

            case 'layout_add_text':
                return layoutAgentTools.addText(args);

            case 'layout_update_text':
                return layoutAgentTools.updateText(args);

            case 'layout_delete_text':
                return layoutAgentTools.deleteText(args.id, args.planId);

            case 'layout_delete_connection':
                return layoutAgentTools.deleteConnection(args.id, args.planId);

            case 'layout_set_room_info':
                return layoutAgentTools.setRoomInfo(args);

            case 'layout_set_rooms_info':
                return layoutAgentTools.setRoomsInfo(args.rooms, args.planId);

            case 'layout_connect_components':
                return layoutAgentTools.connectComponents(args);

            case 'layout_get_load_summary':
                return layoutAgentTools.getLoadSummary(args.planId);

            case 'layout_build_sld':
                return layoutAgentTools.buildSldFromLayout({ planId: args.planId });

            case 'layout_arrange_sld':
                return layoutAgentTools.arrangeSld(args.gapFactor);

            case 'layout_validate':
                return layoutAgentTools.validateLayout(args.planId);

            default:
                return { error: `Unknown tool: ${toolName}` };
        }
    }

    // ==================== AGENT TOOLS ====================

    /**
     * Inject a skill document into the conversation.
     *
     * Bodies are only sent once per conversation: a second request returns a
     * reminder instead of ~2k tokens of duplicate markdown, which matters when a
     * design run spans 20+ turns.
     */
    private loadSkillTool(name?: string): any {
        const skill = getSkill(name || '');
        if (!skill) {
            return {
                error: `Unknown skill "${name}".`,
                availableSkills: getSkillIndex()
            };
        }

        if (this.loadedSkills.has(skill.name)) {
            return {
                success: true,
                name: skill.name,
                alreadyLoaded: true,
                note: 'Already provided earlier in this conversation — re-read it from the history rather than reloading.'
            };
        }

        this.loadedSkills.add(skill.name);
        return {
            success: true,
            name: skill.name,
            appliesTo: skill.appliesTo,
            content: skill.content
        };
    }

    /**
     * Pause for user review at a design milestone.
     *
     * Blocks the tool loop until the user approves or rejects in the Agent panel.
     * Outside an agent run there is nothing to block on, so it returns
     * immediately — ordinary chat should never hang waiting for a button.
     */
    private async requestReviewTool(milestone?: string, summary?: string): Promise<any> {
        if (!milestone || !summary) {
            return { error: 'Both milestone and summary are required.' };
        }
        if (!this.agentHooks) {
            return {
                success: true,
                skipped: true,
                note: 'No agent run is active, so there is nothing to pause. Continue.'
            };
        }

        const decision: any = await this.agentHooks.requestReview(milestone, summary);
        // Backwards compatible: older callers resolved a plain boolean.
        const approved = typeof decision === 'boolean' ? decision : !!decision?.approved;
        const rawFeedback = typeof decision === 'object' ? (decision?.feedback || '') : '';
        const userFeedback = String(rawFeedback || '').trim().slice(0, 2000);
        if (approved) {
            return userFeedback
                ? { approved: true, userFeedback, note: `User approved with this comment — follow it before continuing: "${userFeedback}"` }
                : { approved: true, note: 'User approved. Continue to the next phase.' };
        }
        return userFeedback
            ? { approved: false, userFeedback, note: `User stopped here with this comment: "${userFeedback}". Do not continue; end your turn with a short summary of what exists so far.` }
            : { approved: false, note: 'User rejected or stopped. Do not continue; end your turn with a short summary of what exists so far.' };
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

    /**
     * Layout components of the given SLD type that still have no schematic symbol.
     *
     * Used to reject `add_item_to_diagram` calls that would create an unlinked
     * duplicate. Only consulted during an agent run: a human clicking the library
     * has every right to add a loose symbol, and the guard would be an obstacle.
     */
    private findUnlinkedLayoutComponentsFor(itemName: string): Array<{ id: string; label: string }> {
        if (!this.agentHooks) return [];

        const wanted = String(itemName || '').trim().toLowerCase();
        if (!wanted) return [];

        // Schematic-only items have no floor-plan counterpart by definition.
        if (['portal', 'text', 'text box', 'note', 'connector'].includes(wanted)) return [];

        try {
            const layoutState = useLayoutStore.getState();
            const plan = layoutState.getCurrentFloorPlan();
            if (!plan) return [];

            const sldState = useStore.getState();
            const liveSldIds = new Set(sldState.sheets.flatMap(s => s.canvasItems.map(i => i.uniqueID)));

            return plan.components
                .filter(comp => {
                    const sldName = LAYOUT_TO_SLD_MAP[comp.type];
                    if (!sldName || sldName.toLowerCase() !== wanted) return false;
                    return !comp.sldItemId || !liveSldIds.has(comp.sldItemId);
                })
                .map(comp => ({
                    id: comp.id,
                    label: comp.properties?.name || comp.type
                }));
        } catch {
            // The guard must never be the reason a call fails.
            return [];
        }
    }

    private async addItemToDiagram(itemName: string, x?: number, y?: number, properties?: Record<string, any>): Promise<any> {
        if (!this.diagramCallbacks) {
            return { error: 'Diagram callbacks not configured. Cannot modify diagram.' };
        }

        if (!itemName) {
            return { error: 'Please provide an item name to add' };
        }

        // Refuse to build an unlinked duplicate of a floor-plan device.
        //
        // An agent that cannot get layout_build_sld to work will reach for this
        // tool, and the result looks fine on the schematic while being wrong
        // everywhere else: the symbol has no _layoutComponentId, so the layout
        // still reports the component as unsynced, both views list it under
        // "Unplaced" forever, and the connectors drawn between these symbols have
        // no counterpart on the floor plan. Failing loudly here is much cheaper
        // than the user discovering it after a full run.
        const duplicateOf = this.findUnlinkedLayoutComponentsFor(itemName);
        if (duplicateOf.length > 0) {
            return {
                error: `Refusing to add "${itemName}": ${duplicateOf.length} component(s) of this type are already on the floor plan without a schematic symbol (${duplicateOf.slice(0, 4).map(c => c.label).join(', ')}${duplicateOf.length > 4 ? ', …' : ''}). Adding it here would create a symbol with no link to the floor plan, so both views would keep listing those devices as Unplaced. Call layout_build_sld instead — it creates linked symbols for every placed component. add_item_to_diagram is only for schematic-only items such as Portal or Text Box.`,
                layoutComponentsAwaitingSymbol: duplicateOf.slice(0, 10)
            };
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
            const res = this.diagramCallbacks.updateItemRaw(itemId, nextItem, { recalcNetwork: true });
            if (res && 'error' in res) return { error: res.error };
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

        const result = this.diagramCallbacks.updateItemFields(r.id, updates);
        if (result && 'error' in result) return { error: result.error };
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

    /**
     * Backend auto-rating: sizes breakers/cables from network analysis.
     *
     * Mirrors the toolbar's Auto Rating button (App.handleAutoRate): posts the
     * sheets, restores svgContent the backend drops, refreshes visuals, and
     * applies with undo history preserved. Run after wiring, before validate.
     */
    private async autoRateSldTool(): Promise<any> {
        const sheets = useStore.getState().sheets;
        if (!sheets || sheets.length === 0) {
            return { error: 'No SLD sheets to rate. Build the schematic first with layout_build_sld.' };
        }
        if (!sheets.some(s => (s.canvasItems || []).length > 0)) {
            return { error: 'All SLD sheets are empty. Nothing to rate.' };
        }

        try {
            const response = await api.autoRate(sheets);
            const { sheets: updatedSheets, log, success, message } = response;

            if (!success) {
                return {
                    success: false,
                    message: message || 'Auto-rating validation failed.',
                    log: log || '',
                    hint: 'Ensure the network is analyzed, components are connected, and the database is reachable — then fix the reported issue and retry.'
                };
            }

            // Backend strips svgContent — restore from the pre-call sheets.
            updatedSheets.forEach((updatedSheet: any, sheetIndex: number) => {
                const originalSheet = sheets[sheetIndex];
                if (!originalSheet) return;
                (updatedSheet.canvasItems || []).forEach((updatedItem: any) => {
                    if (!updatedItem.svgContent) {
                        const originalItem = (originalSheet.canvasItems || []).find(
                            (orig: any) => orig.uniqueID === updatedItem.uniqueID
                        );
                        if (originalItem?.svgContent) updatedItem.svgContent = originalItem.svgContent;
                    }
                    const newSvg = updateItemVisuals(updatedItem);
                    if (newSvg) updatedItem.svgContent = newSvg;
                });
            });

            useStore.getState().applyAutoRatingResults(updatedSheets);

            const tail = (log || '').slice(-3000);
            return {
                success: true,
                message: message || 'Component ratings updated from network analysis.',
                sheetsRated: updatedSheets.length,
                ...(tail ? { log: tail } : {})
            };
        } catch (error: any) {
            const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
            return {
                error: `Auto-rating failed: ${errorMsg}`,
                hint: 'Ensure: 1) network analysis has been run 2) components are connected 3) database is accessible.'
            };
        }
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

    /**
     * Run a sequence of tool calls in one request.
     *
     * Argument shape is normalised by `normalizeSldOperation`, which accepts all
     * three shapes models actually emit. See that module for why.
     */
    private async applySldOperationsTool(operations?: any[], stopOnError: boolean = true): Promise<any> {
        if (!operations || !Array.isArray(operations) || operations.length === 0) {
            return { error: 'operations must be a non-empty array.' };
        }

        const results: any[] = [];
        let failedCount = 0;

        for (const op of operations) {
            const normalized = normalizeSldOperation(op);
            if (isNormalizeError(normalized)) {
                results.push(normalized);
                failedCount++;
                if (stopOnError) break;
                continue;
            }

            const res = await this.handleToolCall(normalized.tool, normalized.args);
            const isErr = res && typeof res === 'object' && 'error' in res;
            if (isErr) failedCount++;
            results.push({ tool: normalized.tool, result: res });
            if (stopOnError && isErr) break;
        }

        return {
            success: failedCount === 0,
            executedCount: results.length,
            failedCount,
            results,
            ...(failedCount > 0 && results.length < operations.length
                ? { note: `Stopped after ${results.length} of ${operations.length} operations because stopOnError is set.` }
                : {})
        };
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

        // The component catalog is static reference data; the agent only needs
        // enough of it to pick a type, not the full descriptions.
        if (name === 'layout_get_component_catalog' && Array.isArray((result as any).components)) {
            return {
                count: (result as any).count,
                components: (result as any).components.map((c: any) => ({
                    type: c.type,
                    name: c.name,
                    category: c.category,
                    placementType: c.placementType,
                    defaultWattage: c.defaultWattage,
                    sldEquivalent: c.sldEquivalent
                }))
            };
        }

        // Placement results can be large after a 40-item batch. The ids of items
        // that succeeded matter (for wiring); their coordinates do not.
        if (name === 'layout_place_components' && Array.isArray((result as any).placed)) {
            const placed = (result as any).placed;
            return {
                ...result,
                placed: placed.map((p: any) => ({ id: p.id, type: p.type, roomId: p.roomId }))
            };
        }

        // Room geometry is the biggest single payload. Wall lists past the
        // longest few add nothing to a placement decision.
        if (name === 'layout_get_plan_geometry' && Array.isArray((result as any).rooms)) {
            return {
                ...result,
                rooms: (result as any).rooms.map((r: any) => ({
                    ...r,
                    walls: Array.isArray(r.walls) ? r.walls.slice(0, 6) : r.walls,
                    bounds: undefined
                }))
            };
        }

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
        const all = this.buildAllTools();

        // During a supervised design run, hide the tools the workflow never uses.
        // See TOOLS_EXCLUDED_FROM_DESIGN_RUNS: a smaller declaration list measurably
        // improves Gemini's function-calling reliability and saves prompt tokens.
        if (!this.agentHooks) return all;
        return all.filter(t => !TOOLS_EXCLUDED_FROM_DESIGN_RUNS.has(t.name));
    }

    private buildAllTools() {
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
            f("add_text_to_diagram", "Add a text box to the diagram with specific content and styling. Edit it later with set_item_properties (Text, FontSize, Color...), move it with set_item_transform, delete it with delete_item_from_diagram. For floor-plan labels use layout_add_text instead.", {
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
            f("add_item_to_diagram", "Add a new schematic-only component to the SLD canvas. Do NOT use this for anything that exists on the floor plan — call layout_build_sld instead, which creates symbols linked to their Layout components. A symbol added here has no floor-plan link, so the layout keeps reporting the device as missing its symbol and both views list it as Unplaced. Use this only for items with no floor-plan presence (Portal, Text Box, or an isolator the user asked for).", {
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
            f("set_item_properties", "Merge/overwrite properties[0] for an item on the active sheet. Use this to configure the Source after layout_build_sld: Type 1-phase with Voltage 230 V, or Type 3-phase with Voltage 415 V (see board-sizing skill Step 7 for which); Frequency is always 50 Hz in India, never 60 Hz. Changing Type/Bars/Voltage/Pole on a wired board is blocked with an error if it would make existing wiring single-vs-3-phase incompatible — rewire first.", {
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
            f("update_item_fields", "Update incomer/outgoing/accessories and alternative companies. Blocked with an error if the change would make existing wiring single-vs-3-phase incompatible — rewire first, do not retry the identical call.", {
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
            f("connect_items", "Create a connector between two items (source OUT point -> target IN point). Enforces single-phase vs 3-phase compatibility and rejects mismatches with an error naming the correct feeders to use instead — read the error and adapt, do not retry the identical call. Single-phase OUT: Source 1-phase, HTPN way, SPN DB, Busbar R/Y/B tap (or 2-bar chamber), LT Panel SP/DP/1P/2P outgoing, Main/Change-Over Switch 230V DP. 3-phase OUT: Source 3-phase, VTPN, Busbar ALL tap (4-bar), LT Panel TP/FP/TPN/3P/4P outgoing, Main/Change-Over Switch 415V TPN/FP. Incomers: HTPN/VTPN need 3-phase, SPN DB and all end loads/switch-boards need single-phase, Busbar/LT Panel/switches follow their Bars/Pole/Voltage config. Unconfigured panels/portals are permissive.", {
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
            f("sld_auto_rate", "Run backend auto-rating on all SLD sheets: sizes breakers and cables from network analysis and writes the ratings back (undo-safe). Run after wiring is complete, before validate_diagram. Reports success/message plus a process log tail.", { type: "object", properties: {} }),
            f("undo", "Undo the last action.", { type: "object", properties: {} }),
            f("redo", "Redo the last undone action.", { type: "object", properties: {} }),
            f("apply_sld_operations", "Run several SLD tool calls in one request. Each operation is { \"tool\": \"<tool_name>\", ...that tool's arguments }, or { \"tool\": \"<tool_name>\", \"args\": { ... } } — both shapes work. Use it for connect_items and set_item_properties batches.", {
                type: "object",
                properties: {
                    operations: {
                        type: "array",
                        description: "e.g. [{ \"tool\": \"connect_items\", \"sourceItemId\": \"a\", \"sourcePointKey\": \"out1\", \"targetItemId\": \"b\", \"targetPointKey\": \"in\", \"materialType\": \"Wiring\" }]",
                        items: { type: "object" }
                    },
                    stopOnError: { type: "boolean", description: "Stop the sequence on the first failure. Default true." }
                },
                required: ["operations"]
            }),

            // ================= AGENT: SKILLS & SUPERVISION =================

            f("load_skill", "Load a skill document containing domain rules. Call this before designing — do not work from memory of electrical practice.", {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "One of: electrical-design-workflow, load-placement, board-sizing, connection-rules"
                    }
                },
                required: ["name"]
            }),
            f("request_review", "Pause and ask the user to review your work at a design milestone. Blocks until they approve or reject. Use at the milestones the workflow skill marks.", {
                type: "object",
                properties: {
                    milestone: { type: "string", description: "Short milestone name, e.g. 'Loads placed'" },
                    summary: { type: "string", description: "What you did and what you are about to do, in 1-3 sentences the user can check." }
                },
                required: ["milestone", "summary"]
            }),

            // ================= AGENT: LAYOUT DESIGNER =================

            f("layout_list_floor_plans", "List all floor plans with calibration status and element counts. Start here for any layout work.", {
                type: "object", properties: {}
            }),
            f("layout_set_active_floor_plan", "Switch which floor plan subsequent layout edits apply to.", {
                type: "object",
                properties: { planId: { type: "string" } },
                required: ["planId"]
            }),
            f("layout_get_plan_geometry", "Get room-by-room geometry: real areas in m², bounding walls with sides, doors, windows and component counts. Read this before placing anything.", {
                type: "object",
                properties: { planId: { type: "string", description: "Defaults to the active plan" } }
            }),
            f("layout_get_placed_components", "List components already placed on a floor plan, with ids, positions, rooms, wattages and SLD links — plus conduit connection ids and text labels (needed for layout_delete_connection / layout_update_text / layout_delete_text).", {
                type: "object",
                properties: {
                    planId: { type: "string" },
                    roomId: { type: "string", description: "Optional: restrict to one room" }
                }
            }),
            f("layout_get_component_catalog", "List every placeable Layout component type with its category, physical size, default wattage, mounting surface and SLD equivalent.", {
                type: "object", properties: {}
            }),
            f("layout_suggest_positions", "Get vetted coordinates for placing components in a room (recommended counts, sweep clearance checked). Preferred default — but you may place by your own computed coordinates instead; every placement is validated and layout_validate must pass.", {
                type: "object",
                properties: {
                    roomId: { type: "string" },
                    purpose: {
                        type: "string",
                        description: "'wall' for lights (bulb/tube_light are wall mounted), 5A boards and geysers; 'external_wall' for ac_point and exhaust_fan (boundary walls only, never partition walls); 'beside_door' for switch boards; 'ceiling' for ceiling_fan_point only"
                    },
                    count: { type: "number", description: "How many positions you need (default 1)" },
                    planId: { type: "string" }
                },
                required: ["roomId"]
            }),
            f("layout_suggest_positions_batch", "Get coordinates for several rooms and purposes in ONE call. Strongly preferred over repeated layout_suggest_positions calls — this is the most-called tool in a design run and each separate call costs a full round trip.", {
                type: "object",
                properties: {
                    requests: {
                        type: "array",
                        description: "e.g. [{ \"roomId\": \"room_1\", \"purpose\": \"ceiling\", \"count\": 1 }, { \"roomId\": \"room_1\", \"purpose\": \"wall\", \"count\": 4 }, { \"roomId\": \"room_1\", \"purpose\": \"external_wall\", \"count\": 1 }]",
                        items: { type: "object" }
                    },
                    planId: { type: "string" }
                },
                required: ["id"]
            }),
            f("layout_place_component", "Place one component on the floor plan. Give explicit x/y (your own computed point or a suggested one), or a roomId plus anchor. Explicit ceiling-fan points outside every room are refused; sweep overlaps are validated.", {
                type: "object",
                properties: {
                    type: { type: "string", description: "Layout component type from the catalog, e.g. 'tube_light'" },
                    x: { type: "number" },
                    y: { type: "number" },
                    roomId: { type: "string" },
                    anchor: { type: "string", description: "'center' | 'wall' | 'external_wall' | 'beside_door' — used when x/y are omitted. 'external_wall' is forced for ac_point and exhaust_fan." },
                    rotation: { type: "number", description: "Clockwise degrees. Ignored for lights, switch boards, AC and geyser points — wall seating sets orientation automatically (omit it). Only meaningful for other wall-mounted types." },
                    snapToWall: { type: "boolean", description: "Defaults to true for wall-mounted types. For lights, switch boards, AC and geyser points it also seats the fitting just inside the served room (re-seats when dragged across a partition wall) — do not combine with an explicit rotation." },
                    label: { type: "string" },
                    wattage: { type: "number", description: "Overrides the catalog default. Only set when the user specified a rating." },
                    planId: { type: "string" }
                },
                required: ["type"]
            }),
            f("layout_place_components", "Place many components in one call. Strongly preferred over repeated single placements — use one call per room.", {
                type: "object",
                properties: {
                    components: {
                        type: "array",
                        description: "Array of placement specs, same shape as layout_place_component",
                        items: { type: "object" }
                    },
                    planId: { type: "string" }
                },
                required: ["components"]
            }),
            f("layout_update_component", "Move, rotate, relabel or re-rate a placed component. For several fixes at once (e.g. all items from a layout_validate finding), use layout_update_components.", {
                type: "object",
                properties: {
                    id: { type: "string" },
                    x: { type: "number" },
                    y: { type: "number" },
                    rotation: { type: "number" },
                    label: { type: "string" },
                    wattage: { type: "number" },
                    planId: { type: "string" }
                },
                required: ["id"]
            }),
            f("layout_update_components", "Update many placed components in one call. Strongly preferred when fixing several items at once (e.g. every id from a layout_validate group) — one call carries up to 120 updates.", {
                type: "object",
                properties: {
                    updates: {
                        type: "array",
                        description: "Array of update specs, same shape as layout_update_component (id plus x/y, rotation, label, wattage, properties)",
                        items: { type: "object" }
                    },
                    planId: { type: "string" }
                },
                required: ["updates"]
            }),
            f("layout_delete_component", "Delete a placed component. Also removes its linked SLD symbol.", {
                type: "object",
                properties: { id: { type: "string" }, planId: { type: "string" } },
                required: ["id"]
            }),
            f("layout_add_text", "Add a free text label to the floor plan (room tags, area notes). Give x/y, or a roomId to centre it in that room. Text never snaps to walls and never enters load totals.", {
                type: "object",
                properties: {
                    text: { type: "string" },
                    x: { type: "number" },
                    y: { type: "number" },
                    roomId: { type: "string" },
                    fontSize: { type: "number" },
                    color: { type: "string" },
                    planId: { type: "string" }
                },
                required: ["text"]
            }),
            f("layout_update_text", "Edit a floor-plan text label's content, position or styling.", {
                type: "object",
                properties: {
                    id: { type: "string" },
                    text: { type: "string" },
                    x: { type: "number" },
                    y: { type: "number" },
                    fontSize: { type: "number" },
                    color: { type: "string" },
                    planId: { type: "string" }
                },
                required: ["id"]
            }),
            f("layout_delete_text", "Delete a floor-plan text label.", {
                type: "object",
                properties: { id: { type: "string" }, planId: { type: "string" } },
                required: ["id"]
            }),
            f("layout_delete_connection", "Delete a conduit route between placed components (ids from layout_get_placed_components). This only removes the plan overlay — the electrical connection lives in the SLD; use delete_connector there.", {
                type: "object",
                properties: { id: { type: "string" }, planId: { type: "string" } },
                required: ["id"]
            }),
            f("layout_set_room_info", "Name a room and set its type. Do this early so your reasoning and the user's view agree.", {
                type: "object",
                properties: {
                    roomId: { type: "string" },
                    name: { type: "string" },
                    type: {
                        type: "string",
                        description: "bedroom | living_room | kitchen | bathroom | toilet | balcony | corridor | staircase | utility | office | dining | storage | pooja | other"
                    },
                    planId: { type: "string" }
                },
                required: ["roomId"]
            }),
            f("layout_set_rooms_info", "Name and type MANY rooms in one call. Strongly preferred over repeated layout_set_room_info calls — naming every room individually in one turn can overrun your output limit and fail the whole run.", {
                type: "object",
                properties: {
                    rooms: {
                        type: "array",
                        description: "Array of { roomId, name, type }",
                        items: { type: "object" }
                    },
                    planId: { type: "string" }
                },
                required: ["rooms"]
            }),
            f("layout_connect_components", "Draw a physical conduit route between two placed components on the plan. This is NOT the electrical connection — use connect_items in the SLD for that.", {
                type: "object",
                properties: {
                    sourceId: { type: "string" },
                    targetId: { type: "string" },
                    type: { type: "string", description: "power | control | data" },
                    planId: { type: "string" }
                },
                required: ["sourceId", "targetId"]
            }),
            f("layout_get_load_summary", "Total connected load per room and per category, computed from placed components.", {
                type: "object",
                properties: { planId: { type: "string" } }
            }),
            f("layout_build_sld", "THE ONLY correct way to create SLD symbols for floor-plan devices. Materializes every placed Layout component as a linked SLD symbol on the active sheet, adopts any symbols waiting in the Unplaced tray, and returns sldItemId for each so you can wire them. Nothing is wired by this call. Never use add_item_to_diagram for a device that exists in the layout — that produces an unlinked duplicate and leaves both views showing the device as Unplaced.", {
                type: "object",
                properties: { planId: { type: "string" } }
            }),
            f("layout_arrange_sld", "Auto-arrange the active SLD sheet into readable tiers. Downstream-row spacing defaults to the user's saved factor; pass gapFactor (1-3) to override for this run only.", {
                type: "object", properties: { gapFactor: { type: "number" } }
            }),
            f("layout_validate", "Cross-check the layout against the schematic: components with no SLD symbol, loads fed by nothing, components outside any room, wall-mounted items floating off every wall, switch boards over door/window spans, missing calibration.", {
                type: "object",
                properties: { planId: { type: "string" } }
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
