// Argument-shape normalisation for apply_sld_operations.
//
// Models write batched operations three different ways and the schema cannot
// disambiguate for them. In an observed run the agent tried two shapes, got
// "Please provide an item name to add" both times — an error about the payload,
// not about the wrapper — and abandoned batching for the remaining 60 calls.

const RESERVED = new Set(['tool', 'name', 'type', 'args', 'arguments', 'params', 'parameters']);

export interface NormalizedOperation {
    tool: string;
    args: Record<string, any>;
}

/**
 * Pull the tool name and arguments out of one operation entry.
 *
 * Accepts, in order of preference:
 *   { tool: "connect_items", args:   { ... } }
 *   { tool: "connect_items", params: { ... } }
 *   { tool: "connect_items", ...flat arguments }
 *
 * Returns an error string rather than throwing, so one malformed entry can be
 * reported without losing the rest of the batch.
 */
export function normalizeSldOperation(op: any): NormalizedOperation | { error: string } {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
        return { error: 'Each operation must be an object.' };
    }

    const tool = String(op.tool || op.name || op.type || '').trim();
    if (!tool) {
        return { error: 'Operation missing tool name. Use { "tool": "<tool_name>", ... }.' };
    }
    if (tool === 'apply_sld_operations') {
        return { error: 'Nested apply_sld_operations is not allowed.' };
    }

    const nested = op.args ?? op.arguments ?? op.params ?? op.parameters;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return { tool, args: { ...nested } };
    }

    const args: Record<string, any> = {};
    for (const [k, v] of Object.entries(op)) {
        if (!RESERVED.has(k)) args[k] = v;
    }
    return { tool, args };
}

export function isNormalizeError(v: NormalizedOperation | { error: string }): v is { error: string } {
    return 'error' in v;
}
