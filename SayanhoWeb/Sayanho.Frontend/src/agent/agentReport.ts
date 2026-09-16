// Formats an agent run into shareable text.
//
// The agent panel shows a deliberately terse log: one line per action, reasoning
// truncated, tool payloads hidden. That is right for watching a run, and wrong for
// reporting one — when a design comes out wrong the useful evidence is exactly
// what the panel hides: the arguments the agent passed, the full result it got
// back, and its complete reasoning.
//
// Two formats, because they serve different purposes:
//
//   Markdown — for pasting into a chat or an issue. Readable by a human, and by
//              an LLM being asked "why did this go wrong?".
//   JSON     — for attaching to a bug report or diffing two runs.
//
// Nothing here touches the run. It is a pure projection of AgentSnapshot.

import { AgentSnapshot, AgentEvent } from './AgentController';

export interface ReportOptions {
    /** Include the model's reasoning text. On by default — usually the point. */
    includeReasoning?: boolean;
    /** Include tool arguments and full results. On by default. */
    includeToolPayloads?: boolean;
    /** Environment context: model, provider, floor plan summary. */
    context?: ReportContext;
}

export interface ReportContext {
    provider?: string;
    model?: string;
    floorPlans?: Array<{
        name: string;
        rooms: number;
        walls: number;
        components: number;
        calibrated: boolean;
        hasImage: boolean;
    }>;
    sldSheetCount?: number;
    imagesAttached?: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Elapsed time from run start, so timings are relative and comparable. */
const relativeTime = (at: number, startedAt: number | null): string => {
    if (!startedAt) return '';
    const ms = Math.max(0, at - startedAt);
    const totalSeconds = Math.floor(ms / 1000);
    return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
};

const STATUS_TEXT: Record<AgentSnapshot['status'], string> = {
    idle: 'Not started',
    running: 'Still running',
    paused: 'Paused',
    awaiting_review: 'Waiting for review',
    stopping: 'Stopping',
    stopped: 'Stopped by user',
    completed: 'Completed',
    error: 'Failed'
};

const KIND_LABEL: Record<AgentEvent['kind'], string> = {
    status: 'STATUS',
    thought: 'REASONING',
    tool: 'ACTION',
    milestone: 'MILESTONE',
    error: 'ERROR',
    info: 'INFO'
};

/**
 * Pretty-print a stored JSON string.
 *
 * Payloads are stored compact (and possibly truncated with a suffix). Re-indenting
 * makes them readable; a truncated blob will not parse, so we fall back to the raw
 * string rather than losing it.
 */
const formatJson = (raw?: string): string | null => {
    if (!raw) return null;
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
};

export function buildMarkdownReport(snapshot: AgentSnapshot, options: ReportOptions = {}): string {
    const includeReasoning = options.includeReasoning !== false;
    const includeToolPayloads = options.includeToolPayloads !== false;
    const ctx = options.context;

    const lines: string[] = [];
    const started = snapshot.startedAt ? new Date(snapshot.startedAt) : null;

    lines.push('# Sayanho Design Agent — activity report');
    lines.push('');
    lines.push(`- **Outcome:** ${STATUS_TEXT[snapshot.status]}`);
    if (started) lines.push(`- **Started:** ${started.toISOString()}`);
    if (snapshot.startedAt) {
        const last = snapshot.events[snapshot.events.length - 1];
        if (last) lines.push(`- **Duration:** ${relativeTime(last.at, snapshot.startedAt)} (mm:ss)`);
    }
    lines.push(`- **Actions taken:** ${snapshot.toolCallCount}`);

    const failures = snapshot.events.filter(e => e.ok === false || e.kind === 'error').length;
    lines.push(`- **Failed actions:** ${failures}`);

    if (ctx?.provider || ctx?.model) {
        lines.push(`- **Model:** ${ctx.model || 'unknown'}${ctx.provider ? ` (${ctx.provider})` : ''}`);
    }
    if (typeof ctx?.imagesAttached === 'number') {
        lines.push(`- **Floor plan images sent:** ${ctx.imagesAttached}`);
    }
    if (snapshot.lastError) {
        lines.push(`- **Error:** ${snapshot.lastError}`);
    }
    lines.push('');

    if (snapshot.goal) {
        lines.push('## Goal');
        lines.push('');
        lines.push(snapshot.goal.replace(/^Goal:\s*/i, ''));
        lines.push('');
    }

    if (ctx?.floorPlans && ctx.floorPlans.length > 0) {
        lines.push('## Project state');
        lines.push('');
        lines.push('| Floor plan | Rooms | Walls | Components | Calibrated | Has image |');
        lines.push('|---|---|---|---|---|---|');
        ctx.floorPlans.forEach(p => {
            lines.push(`| ${p.name} | ${p.rooms} | ${p.walls} | ${p.components} | ${p.calibrated ? 'yes' : 'NO'} | ${p.hasImage ? 'yes' : 'no'} |`);
        });
        if (typeof ctx.sldSheetCount === 'number') {
            lines.push('');
            lines.push(`SLD sheets: ${ctx.sldSheetCount}`);
        }
        lines.push('');
    }

    lines.push('## Activity');
    lines.push('');

    if (snapshot.events.length === 0) {
        lines.push('_No activity recorded._');
        return lines.join('\n');
    }

    snapshot.events.forEach(event => {
        if (event.kind === 'thought' && !includeReasoning) return;

        const time = relativeTime(event.at, snapshot.startedAt);
        const stamp = time ? `\`${time}\` ` : '';

        if (event.kind === 'tool') {
            // Pending actions have ok === undefined; that only happens if the run
            // was still in flight when the report was taken, which is worth showing.
            const mark = event.ok === false ? '❌' : event.ok === true ? '✅' : '⏳';
            lines.push(`### ${stamp}${mark} ${event.message}`);
            if (event.tool) lines.push(`*tool:* \`${event.tool}\``);
            if (event.detail) lines.push(`*result:* ${event.detail}`);

            if (includeToolPayloads) {
                const args = formatJson(event.args);
                if (args && args !== '{}') {
                    lines.push('');
                    lines.push('<details><summary>Arguments</summary>');
                    lines.push('');
                    lines.push('```json');
                    lines.push(args);
                    lines.push('```');
                    lines.push('');
                    lines.push('</details>');
                }
                const result = formatJson(event.resultJson);
                if (result) {
                    lines.push('');
                    lines.push('<details><summary>Full result</summary>');
                    lines.push('');
                    lines.push('```json');
                    lines.push(result);
                    lines.push('```');
                    lines.push('');
                    lines.push('</details>');
                }
            }
            lines.push('');
            return;
        }

        if (event.kind === 'thought') {
            lines.push(`### ${stamp}💭 Reasoning`);
            lines.push('');
            lines.push(event.message);
            lines.push('');
            return;
        }

        if (event.kind === 'milestone') {
            lines.push(`### ${stamp}🚩 Milestone`);
            lines.push('');
            lines.push(event.message);
            lines.push('');
            return;
        }

        const icon = event.kind === 'error' ? '⚠️' : 'ℹ️';
        lines.push(`${stamp}${icon} **${KIND_LABEL[event.kind]}:** ${event.message}`);
        lines.push('');
    });

    return lines.join('\n');
}

export function buildJsonReport(snapshot: AgentSnapshot, options: ReportOptions = {}): string {
    const includeReasoning = options.includeReasoning !== false;
    const includeToolPayloads = options.includeToolPayloads !== false;

    const payload = {
        report: 'sayanho-agent-activity',
        generatedAt: new Date().toISOString(),
        outcome: snapshot.status,
        outcomeText: STATUS_TEXT[snapshot.status],
        goal: snapshot.goal,
        startedAt: snapshot.startedAt ? new Date(snapshot.startedAt).toISOString() : null,
        actionCount: snapshot.toolCallCount,
        failedActionCount: snapshot.events.filter(e => e.ok === false || e.kind === 'error').length,
        lastError: snapshot.lastError,
        context: options.context ?? null,
        events: snapshot.events
            .filter(e => includeReasoning || e.kind !== 'thought')
            .map(e => ({
                elapsed: relativeTime(e.at, snapshot.startedAt),
                kind: e.kind,
                message: e.message,
                ...(e.tool ? { tool: e.tool } : {}),
                ...(e.ok !== undefined ? { ok: e.ok } : {}),
                ...(e.detail ? { detail: e.detail } : {}),
                ...(includeToolPayloads && e.args ? { args: e.args } : {}),
                ...(includeToolPayloads && e.resultJson ? { result: e.resultJson } : {})
            }))
    };

    return JSON.stringify(payload, null, 2);
}

/**
 * Copy to clipboard, falling back to a hidden textarea.
 *
 * navigator.clipboard is unavailable on insecure origins, which includes some
 * local-network dev setups (http://10.x.x.x:3000). A report you cannot copy is
 * useless, so the fallback matters.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
    } catch {
        return false;
    }
}

/** Offer the report as a file, for runs too large to paste comfortably. */
export function downloadReport(text: string, extension: 'md' | 'json'): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([text], {
        type: extension === 'json' ? 'application/json' : 'text/markdown'
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sayanho-agent-${stamp}.${extension}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
