import { describe, it, expect } from 'vitest';
import { normalizeSldOperation, isNormalizeError } from '../sldOperations';

const CONNECT = {
    sourceItemId: 'a',
    sourcePointKey: 'out1',
    targetItemId: 'b',
    targetPointKey: 'in',
    materialType: 'Wiring'
};

describe('normalizeSldOperation', () => {
    it('accepts the nested args shape', () => {
        const r = normalizeSldOperation({ tool: 'connect_items', args: CONNECT });
        expect(isNormalizeError(r)).toBe(false);
        if (isNormalizeError(r)) return;
        expect(r.tool).toBe('connect_items');
        expect(r.args).toEqual(CONNECT);
    });

    it('accepts the params shape the agent actually tried first', () => {
        // Verbatim from the observed run — this shape silently produced an
        // empty-argument call and failed with a message about the payload.
        const r = normalizeSldOperation({
            tool: 'add_item_to_diagram',
            params: { itemName: 'Source', x: 700, y: 20 }
        });
        expect(isNormalizeError(r)).toBe(false);
        if (isNormalizeError(r)) return;
        expect(r.args).toEqual({ itemName: 'Source', x: 700, y: 20 });
    });

    it('accepts the flat shape the agent tried second', () => {
        const r = normalizeSldOperation({ tool: 'add_item_to_diagram', itemName: 'HTPN', x: 700, y: 120 });
        expect(isNormalizeError(r)).toBe(false);
        if (isNormalizeError(r)) return;
        expect(r.args).toEqual({ itemName: 'HTPN', x: 700, y: 120 });
    });

    it('accepts "arguments" and "parameters" as containers', () => {
        for (const key of ['arguments', 'parameters']) {
            const r = normalizeSldOperation({ tool: 'connect_items', [key]: CONNECT });
            expect(isNormalizeError(r)).toBe(false);
            if (isNormalizeError(r)) continue;
            expect(r.args).toEqual(CONNECT);
        }
    });

    it('reads the tool name from name or type as well as tool', () => {
        for (const key of ['tool', 'name', 'type']) {
            const r = normalizeSldOperation({ [key]: 'auto_arrange' });
            expect(isNormalizeError(r)).toBe(false);
            if (isNormalizeError(r)) continue;
            expect(r.tool).toBe('auto_arrange');
        }
    });

    it('does not leak wrapper keys into the arguments', () => {
        const r = normalizeSldOperation({ tool: 'set_item_properties', itemId: 'x', properties: { Way: '2+10 way' } });
        expect(isNormalizeError(r)).toBe(false);
        if (isNormalizeError(r)) return;
        expect(r.args).not.toHaveProperty('tool');
        expect(r.args).toEqual({ itemId: 'x', properties: { Way: '2+10 way' } });
    });

    it('rejects a missing tool name with an actionable message', () => {
        const r = normalizeSldOperation({ itemName: 'Source' });
        expect(isNormalizeError(r)).toBe(true);
        if (!isNormalizeError(r)) return;
        expect(r.error).toContain('"tool"');
    });

    it('rejects nesting', () => {
        const r = normalizeSldOperation({ tool: 'apply_sld_operations', operations: [] });
        expect(isNormalizeError(r)).toBe(true);
    });

    it('rejects non-objects', () => {
        expect(isNormalizeError(normalizeSldOperation(null))).toBe(true);
        expect(isNormalizeError(normalizeSldOperation('connect_items'))).toBe(true);
        expect(isNormalizeError(normalizeSldOperation([{ tool: 'x' }]))).toBe(true);
    });

    it('treats an array-valued args container as flat arguments', () => {
        const r = normalizeSldOperation({ tool: 'auto_arrange', args: ['nonsense'] });
        expect(isNormalizeError(r)).toBe(false);
        if (isNormalizeError(r)) return;
        expect(r.args).toEqual({});
    });
});
