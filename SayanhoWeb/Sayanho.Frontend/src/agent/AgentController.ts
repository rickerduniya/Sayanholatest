// AgentController — run/pause/stop supervision for the design agent.
//
// The requirement is "fully agentic, but the user can stop it and work by hand at
// any moment". That shapes the design:
//
//  - Control is cooperative, checked between tool calls. A hard abort mid-tool
//    could leave the stores half-mutated (components placed but not linked to
//    SLD), so we let the current tool finish and stop before the next one.
//    Worst case the user waits one tool call, typically well under a second.
//
//  - Stopping is not a rollback. Everything the agent placed stays on the canvas,
//    in undo history, fully editable by hand. That is the point: the agent gets
//    you 90 % there and you take over.
//
//  - Milestones pause and wait for approval. The workflow skill marks the natural
//    review points (after load placement, after the board schedule, before SLD
//    generation) because those are the decisions that are expensive to unwind.
//
// The controller owns no domain logic. It is a gate plus an event log that the UI
// subscribes to.

export type AgentStatus =
    | 'idle'
    | 'running'
    | 'paused'          // user pressed pause
    | 'awaiting_review' // milestone reached, waiting for approve/reject
    | 'stopping'        // stop requested, finishing current tool call
    | 'stopped'
    | 'completed'
    | 'error';

export type AgentEventKind =
    | 'status'
    | 'thought'    // assistant prose between tool calls
    | 'tool'       // a tool was executed
    | 'milestone'  // review requested
    | 'error'
    | 'info';

export interface AgentEvent {
    id: number;
    at: number;
    kind: AgentEventKind;
    message: string;
    /** Tool name, when kind === 'tool'. */
    tool?: string;
    /** Compact result summary, when kind === 'tool'. */
    detail?: string;
    ok?: boolean;
    /**
     * Arguments the tool was called with, JSON-stringified and size-capped.
     *
     * Not shown in the panel — it would drown the log — but included in the
     * copyable report, where the whole point is being able to see exactly what
     * the agent asked for when something came out wrong.
     */
    args?: string;
    /**
     * Full tool result, JSON-stringified and size-capped. Same rationale as
     * `args`: `detail` is a one-line summary for the UI, this is the evidence.
     */
    resultJson?: string;
}

export interface AgentMilestone {
    name: string;
    summary: string;
}

export interface AgentSnapshot {
    status: AgentStatus;
    events: AgentEvent[];
    toolCallCount: number;
    startedAt: number | null;
    milestone: AgentMilestone | null;
    lastError: string | null;
    /** The goal text this run was started with, for the copyable report header. */
    goal: string | null;
}

type Listener = (snapshot: AgentSnapshot) => void;

/**
 * Hooks handed to ChatService so the tool loop can be supervised without
 * ChatService knowing anything about the UI.
 */
export interface ReviewDecision {
    approved: boolean;
    /** Optional user comment typed at the milestone. Passed back to the LLM. */
    feedback?: string;
}

export interface AgentHooks {
    /** Called before each tool call. Return false to abandon the run. */
    beforeToolCall: (tool: string, args: any) => Promise<boolean>;
    afterToolCall: (tool: string, result: any) => void;
    onAssistantText: (text: string) => void;
    /** Blocks until the user answers. Resolves {approved:false} if they reject or stop. */
    requestReview: (name: string, summary: string) => Promise<ReviewDecision>;
}

const MAX_EVENTS = 400;

export class AgentController {
    private status: AgentStatus = 'idle';
    private events: AgentEvent[] = [];
    private listeners = new Set<Listener>();
    private nextEventId = 1;
    private toolCallCount = 0;
    private startedAt: number | null = null;
    private milestone: AgentMilestone | null = null;
    private lastError: string | null = null;
    private goal: string | null = null;

    private stopRequested = false;
    private pauseRequested = false;

    /** Resolvers waiting on a pause to lift or a review to be answered. */
    private resumeWaiters: Array<() => void> = [];
    private reviewResolver: ((decision: ReviewDecision) => void) | null = null;

    // -----------------------------------------------------------------------
    // Subscription
    // -----------------------------------------------------------------------

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => { this.listeners.delete(listener); };
    }

    getSnapshot(): AgentSnapshot {
        return {
            status: this.status,
            events: this.events,
            toolCallCount: this.toolCallCount,
            startedAt: this.startedAt,
            milestone: this.milestone,
            lastError: this.lastError,
            goal: this.goal
        };
    }

    private emit() {
        const snapshot = this.getSnapshot();
        this.listeners.forEach(l => {
            try {
                l(snapshot);
            } catch (e) {
                console.error('[AgentController] listener failed', e);
            }
        });
    }

    private setStatus(next: AgentStatus) {
        if (this.status === next) return;
        this.status = next;
        this.emit();
    }

    private log(kind: AgentEventKind, message: string, extra?: Partial<AgentEvent>) {
        this.events = [
            ...this.events,
            {
                id: this.nextEventId++,
                at: Date.now(),
                kind,
                message,
                ...extra
            }
        ].slice(-MAX_EVENTS);
        this.emit();
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    isBusy(): boolean {
        return this.status === 'running'
            || this.status === 'paused'
            || this.status === 'awaiting_review'
            || this.status === 'stopping';
    }

    /**
     * Whether the UI's automatic Layout↔SLD staging sync should stand down.
     *
     * The LayoutDesigner auto-syncs on component-count change, which drops a
     * staged copy of every new component into the "Unplaced" tray. That is
     * correct for a human — they will drag them onto the schematic — but during
     * an agent run it races the agent: components appear in the tray, then
     * `layout_build_sld` sees them as "already represented", and the sheet ends
     * up empty while the tray is full. The agent then hand-builds a parallel,
     * unlinked set of symbols, which is exactly the duplicate-items failure.
     *
     * Suppressing the auto-sync while the agent works makes `layout_build_sld`
     * the single path from Layout to SLD. A final sync runs when the agent
     * finishes, so anything it left unmaterialized still reaches the tray.
     */
    isSuppressingAutoSync(): boolean {
        return this.isBusy();
    }

    beginRun(goal: string) {
        this.stopRequested = false;
        this.pauseRequested = false;
        this.toolCallCount = 0;
        this.startedAt = Date.now();
        this.milestone = null;
        this.lastError = null;
        this.goal = goal;
        this.events = [];
        this.setStatus('running');
        this.log('info', goal);
    }

    /**
     * Add an informational line to the activity log.
     *
     * Used for things that happen around the tool loop rather than inside it —
     * e.g. attaching the floor plan image before the first request — so the user
     * can see them in the same timeline as the agent's own actions.
     */
    note(message: string) {
        this.log('info', message);
    }

    finishRun(outcome: 'completed' | 'stopped' | 'error', message?: string) {
        // A stop that arrives while the model is mid-thought still ends as
        // 'stopped', so the UI never claims success for a halted run.
        const finalStatus = this.stopRequested && outcome !== 'error' ? 'stopped' : outcome;

        if (outcome === 'error' && message) {
            this.lastError = message;
            this.log('error', message);
        } else if (message) {
            this.log('info', message);
        }

        this.milestone = null;
        this.releaseAllWaiters();
        this.setStatus(finalStatus);
    }

    // -----------------------------------------------------------------------
    // User controls
    // -----------------------------------------------------------------------

    /**
     * Ask the agent to stop. Takes effect before the next tool call.
     *
     * Nothing already done is undone — the user keeps the partial design and can
     * continue manually.
     */
    requestStop() {
        if (!this.isBusy()) return;
        this.stopRequested = true;
        this.pauseRequested = false;
        this.log('info', 'Stop requested — finishing the current step, then handing control back to you.');
        this.setStatus('stopping');

        // A stop while paused or awaiting review must not deadlock.
        if (this.reviewResolver) {
            const resolve = this.reviewResolver;
            this.reviewResolver = null;
            resolve({ approved: false });
        }
        this.releaseAllWaiters();
    }

    requestPause() {
        if (this.status !== 'running') return;
        this.pauseRequested = true;
        this.log('info', 'Paused. Edit anything you like; press Resume when ready.');
        this.setStatus('paused');
    }

    resume() {
        if (this.status !== 'paused') return;
        this.pauseRequested = false;
        this.log('info', 'Resumed.');
        this.setStatus('running');
        this.releaseAllWaiters();
    }

    /** Answer a milestone review, with optional user comment for the agent. */
    resolveReview(approved: boolean, feedback?: string) {
        if (!this.reviewResolver) return;
        const resolve = this.reviewResolver;
        this.reviewResolver = null;
        this.milestone = null;

        const cleanFeedback = (feedback || '').trim().slice(0, 2000);
        if (cleanFeedback) {
            this.log('info', `${approved ? 'Milestone approved' : 'Milestone rejected'} with comment: ${cleanFeedback}`);
        } else {
            this.log('info', approved ? 'Milestone approved — continuing.' : 'Milestone rejected — stopping here.');
        }
        if (!approved) this.stopRequested = true;

        this.setStatus(approved ? 'running' : 'stopping');
        resolve(cleanFeedback ? { approved, feedback: cleanFeedback } : { approved });
    }

    private releaseAllWaiters() {
        const waiters = this.resumeWaiters;
        this.resumeWaiters = [];
        waiters.forEach(w => w());
    }

    private waitForResume(): Promise<void> {
        return new Promise(resolve => { this.resumeWaiters.push(resolve); });
    }

    // -----------------------------------------------------------------------
    // Hooks for ChatService
    // -----------------------------------------------------------------------

    createHooks(): AgentHooks {
        return {
            beforeToolCall: async (tool: string, args: any) => {
                if (this.stopRequested) return false;

                // Block here while paused. The agent's own loop is suspended, so
                // the user has exclusive access to the canvas meanwhile.
                while (this.pauseRequested && !this.stopRequested) {
                    await this.waitForResume();
                }
                if (this.stopRequested) return false;

                this.toolCallCount += 1;
                this.log('tool', describeToolIntent(tool, args), {
                    tool,
                    args: stringifyForReport(args)
                });
                return true;
            },

            afterToolCall: (tool: string, result: any) => {
                const ok = !(result && typeof result === 'object' && 'error' in result);
                const detail = summarizeToolResult(result);
                const resultJson = stringifyForReport(result);

                // Replace the pending entry for this tool with its outcome,
                // so the log reads as one line per action rather than two.
                const lastIndex = [...this.events].reverse().findIndex(e => e.kind === 'tool' && e.tool === tool && e.ok === undefined);
                if (lastIndex >= 0) {
                    const index = this.events.length - 1 - lastIndex;
                    const updated = [...this.events];
                    updated[index] = { ...updated[index], ok, detail, resultJson };
                    this.events = updated;
                    this.emit();
                } else {
                    this.log('tool', tool, { tool, ok, detail, resultJson });
                }
            },

            onAssistantText: (text: string) => {
                const trimmed = (text || '').trim();
                if (!trimmed) return;
                // The panel truncates for readability; the copyable report needs
                // the model's full reasoning, so keep it on the event and let the
                // UI shorten it at render time.
                this.log('thought', trimmed);
            },

            requestReview: (name: string, summary: string) => {
                if (this.stopRequested) return Promise.resolve({ approved: false });

                this.milestone = { name, summary };
                this.log('milestone', `${name}: ${summary}`);
                this.setStatus('awaiting_review');

                return new Promise<ReviewDecision>(resolve => {
                    this.reviewResolver = resolve;
                });
            }
        };
    }
}

// ---------------------------------------------------------------------------
// Human-readable log lines
// ---------------------------------------------------------------------------

/**
 * Cap on any single JSON blob kept for the report.
 *
 * A `layout_get_plan_geometry` result on a large building runs to tens of KB, and
 * a handful of those would make the copied report unusable in a chat message. The
 * head of the payload is what diagnoses a problem; the tail rarely is.
 */
const MAX_JSON_CHARS = 2000;

const stringifyForReport = (value: any): string | undefined => {
    if (value === undefined || value === null) return undefined;
    try {
        const json = typeof value === 'string' ? value : JSON.stringify(value);
        if (!json) return undefined;
        return json.length > MAX_JSON_CHARS
            ? `${json.slice(0, MAX_JSON_CHARS)}… [truncated, ${json.length} chars total]`
            : json;
    } catch {
        return '[unserializable]';
    }
};

/**
 * Turn a tool call into a sentence a non-programmer can follow.
 *
 * The agent log is the user's only window into what is happening to their
 * drawing, so raw `place_components({...})` dumps are not good enough.
 */
function describeToolIntent(tool: string, args: any): string {
    const a = args || {};
    switch (tool) {
        case 'layout_list_floor_plans':      return 'Looking at the floor plans';
        case 'layout_get_plan_geometry':     return 'Reading room geometry and areas';
        case 'layout_get_placed_components': return 'Checking what is already placed';
        case 'layout_get_component_catalog': return 'Reading the component library';
        case 'layout_suggest_positions':     return `Working out positions (${a.purpose || 'wall'}${a.count ? ` × ${a.count}` : ''})`;
        case 'layout_suggest_positions_batch': {
            const n = Array.isArray(a.requests) ? a.requests.length : 0;
            return `Working out positions for ${n} request${n === 1 ? '' : 's'}`;
        }
        case 'layout_place_component':       return `Placing ${a.type || 'component'}`;
        case 'layout_place_components':      return `Placing ${Array.isArray(a.components) ? a.components.length : 'several'} components`;
        case 'layout_update_component':      return 'Adjusting a component';
        case 'layout_delete_component':      return 'Removing a component';
        case 'layout_set_room_info':         return `Naming room${a.name ? ` "${a.name}"` : ''}`;
        case 'layout_connect_components':    return 'Drawing a route on the plan';
        case 'layout_get_load_summary':      return 'Totalling the connected load';
        case 'layout_build_sld':             return 'Generating schematic symbols from the layout';
        case 'layout_validate':              return 'Cross-checking layout against schematic';
        case 'layout_arrange_sld':           return 'Tidying the schematic';
        case 'load_skill':                   return `Loading design rules: ${a.name || 'skill'}`;
        case 'request_review':               return `Pausing for your review: ${a.milestone || 'checkpoint'}`;
        case 'get_diagram_state_json':       return 'Reading schematic state';
        case 'connect_items':                return 'Wiring two items';
        case 'apply_sld_operations':         return `Applying ${Array.isArray(a.operations) ? a.operations.length : 'several'} schematic operations`;
        case 'add_item_to_diagram':          return `Adding ${a.itemName || 'item'} to the schematic`;
        case 'validate_diagram':             return 'Validating the schematic';
        case 'analyze_diagram':              return 'Analysing loads and currents';
        case 'get_phase_balance':            return 'Checking phase balance';
        case 'auto_arrange':                 return 'Auto-arranging the schematic';
        default:                             return tool.replace(/_/g, ' ');
    }
}

function summarizeToolResult(result: any): string | undefined {
    if (!result || typeof result !== 'object') return undefined;
    if ('error' in result) return String(result.error).slice(0, 200);

    if (typeof result.placedCount === 'number') {
        return result.failedCount
            ? `${result.placedCount} placed, ${result.failedCount} failed`
            : `${result.placedCount} placed`;
    }
    if (typeof result.createdCount === 'number') return `${result.createdCount} symbols created`;
    if (typeof result.roomCount === 'number') return `${result.roomCount} rooms, ${result.totalAreaSqm ?? '?'} m²`;
    if (Array.isArray(result.positions)) return `${result.positions.length} positions`;
    if (typeof result.errorCount === 'number') return `${result.errorCount} errors, ${result.warningCount ?? 0} warnings`;
    if (typeof result.totalWatts === 'number') return `${result.totalWatts} W total`;
    if (result.id) return String(result.id).slice(0, 24);
    if (result.success) return 'done';
    return undefined;
}

export const agentController = new AgentController();
