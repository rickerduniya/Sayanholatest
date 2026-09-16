import type { CanvasItem, Connector } from '../types';

export type PhaseKind = 'single' | 'three' | 'unknown';

export interface PhaseInfo {
    kind: PhaseKind;
    /** Human-readable label, e.g. "HTPN incomer (4-pole FP, 3-phase)" */
    label: string;
}

const getProps = (item?: CanvasItem | null): Record<string, string> =>
    ((item?.properties?.[0] || {}) as Record<string, string>);

const norm = (v: unknown): string => (v ?? '').toString().trim();

export function isSinglePhasePole(pole?: string): boolean {
    if (!pole) return false;
    const u = pole.trim().toUpperCase();
    return (
        u.startsWith('DP') ||
        u.startsWith('SP') ||
        u.startsWith('1P') ||
        u.startsWith('2P')
    );
}

export function isThreePhasePole(pole?: string): boolean {
    if (!pole) return false;
    const u = pole.trim().toUpperCase();
    // TPN starts with TP, FP is four-pole (3-phase + N)
    return (
        u.startsWith('TP') ||
        u.startsWith('FP') ||
        u.startsWith('3P') ||
        u.startsWith('4P')
    );
}

/** 1-based index parsed from `out{N}...`, or -1 when not parseable. */
export function getOutgoingSlotIndex(pointKey?: string): number {
    if (!pointKey) return -1;
    const m = /^out(\d+)/i.exec(pointKey.trim());
    if (!m) return -1;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n - 1 : -1;
}

/** Section number parsed from `in{N}` (LT panel), or -1. */
function getIncomerSection(pointKey?: string): number {
    if (!pointKey) return -1;
    const m = /^in(\d+)\s*$/i.exec(pointKey.trim());
    if (!m) return -1;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : -1;
}

function isSinglePhaseSwitchVoltage(voltage: string, itemName: string): boolean {
    const v = (voltage || '').toUpperCase();
    if (itemName === 'Main Switch') return v.includes('DP') || v.includes('230V');
    if (itemName === 'Change Over Switch') return v.includes('DP') || v.includes('230V');
    return false;
}

function isThreePhaseSwitchVoltage(voltage: string): boolean {
    const v = (voltage || '').toUpperCase();
    return v.includes('TPN') || v.includes('FP') || v.includes('415V') || v.includes('440V');
}

// ---------------------------------------------------------------------------
// Outgoing side: what kind of supply does this OUT point provide?
// ---------------------------------------------------------------------------

export function getOutgoingPhaseType(item: CanvasItem, pointKey: string): PhaseInfo {
    const name = item.name || '';
    const props = getProps(item);
    const outgoings = item.outgoing || [];

    if (name === 'Source') {
        const t = norm(props['Type']);
        if (/3[\s-]?phase/i.test(t)) return { kind: 'three', label: 'Source (3-phase)' };
        if (/1[\s-]?phase/i.test(t) || /single/i.test(t)) return { kind: 'single', label: 'Source (1-phase)' };
        return { kind: 'unknown', label: 'Source (unconfigured type)' };
    }

    if (name.includes('HTPN')) {
        // Every HTPN way is an SP single-phase tap (R/Y/B encoded in the point key).
        return { kind: 'single', label: `HTPN way ${pointKey} (single-phase)` };
    }

    if (name.includes('VTPN')) {
        // VTPN feeders are TP three-phase.
        return { kind: 'three', label: `VTPN outgoing ${pointKey} (3-phase)` };
    }

    if (name === 'SPN DB') {
        return { kind: 'single', label: `SPN DB outgoing ${pointKey} (single-phase)` };
    }

    if (name === 'Busbar Chamber') {
        const bars = norm(props['Bars'] || '4');
        if (bars === '2') {
            return { kind: 'single', label: `Busbar tap ${pointKey} (2-bar single-phase)` };
        }
        const idx = getOutgoingSlotIndex(pointKey);
        const configured = idx >= 0 && idx < outgoings.length ? norm(outgoings[idx]?.['Phase']) : '';
        const fallback = ['R', 'Y', 'B'][Math.max(idx, 0) % 3];
        const phase = (configured || fallback).toUpperCase();
        if (phase === 'ALL') {
            return { kind: 'three', label: `Busbar tap ${pointKey} (3-phase ALL)` };
        }
        // R/Y/B (or unconfigured default round-robin) are single-phase taps.
        return { kind: 'single', label: `Busbar tap ${pointKey} (single-phase ${phase || fallback})` };
    }

    if (name.includes('Cubical Panel') || name.includes('Cubicle Panel')) {
        const idx = getOutgoingSlotIndex(pointKey);
        const out = idx >= 0 && idx < outgoings.length ? outgoings[idx] : undefined;
        if (!out) {
            return { kind: 'unknown', label: `LT Panel outgoing ${pointKey} (unconfigured)` };
        }
        const pole = norm(out['Pole']);
        const phase = norm(out['Phase']);
        if (isSinglePhasePole(pole)) {
            return { kind: 'single', label: `LT Panel outgoing ${pointKey} (single-phase ${pole}${phase ? `, ${phase}` : ''})` };
        }
        if (isThreePhasePole(pole) || pole !== '') {
            // Any configured non-single pole (TP/FP/TPN/...) is a 3-phase feeder.
            // Unknown non-empty pole strings default to three-phase to stay safe,
            // since panel feeders are three-phase unless explicitly DP/SP/1P.
            if (isThreePhasePole(pole)) {
                return { kind: 'three', label: `LT Panel outgoing ${pointKey} (3-phase ${pole})` };
            }
            return { kind: 'three', label: `LT Panel outgoing ${pointKey} (3-phase ${pole})` };
        }
        return { kind: 'unknown', label: `LT Panel outgoing ${pointKey} (unconfigured pole)` };
    }

    if (name === 'Main Switch' || name === 'Change Over Switch') {
        const voltage = norm(props['Voltage']);
        if (!voltage) return { kind: 'unknown', label: `${name} outgoing (unconfigured voltage)` };
        if (isSinglePhaseSwitchVoltage(voltage, name)) {
            return { kind: 'single', label: `${name} outgoing (single-phase ${voltage})` };
        }
        if (isThreePhaseSwitchVoltage(voltage)) {
            return { kind: 'three', label: `${name} outgoing (3-phase ${voltage})` };
        }
        return { kind: 'unknown', label: `${name} outgoing (unconfigured voltage)` };
    }

    if (name === 'Point Switch Board' || name === 'Avg. 5A Switch Board') {
        return { kind: 'single', label: `${name} outgoing ${pointKey} (single-phase)` };
    }

    if (name === 'Portal') {
        return { kind: 'unknown', label: 'Portal (phase follows linked net)' };
    }

    // Loads and anything else have no meaningful OUT; treat as unknown so we
    // never block on a guess.
    return { kind: 'unknown', label: `${name || 'Item'} outgoing ${pointKey}` };
}

// ---------------------------------------------------------------------------
// Incoming side: what kind of supply does this IN point require?
// ---------------------------------------------------------------------------

export function getIncomingPhaseType(item: CanvasItem, pointKey: string): PhaseInfo {
    const name = item.name || '';
    const props = getProps(item);

    if (name.includes('HTPN')) {
        // HTPN incomer is always FP (4-pole) => needs a 3-phase feed.
        return { kind: 'three', label: 'HTPN incomer (4-pole FP, 3-phase)' };
    }

    if (name.includes('VTPN')) {
        return { kind: 'three', label: 'VTPN incomer (3-phase)' };
    }

    if (name === 'SPN DB') {
        return { kind: 'single', label: 'SPN DB incomer (DP, single-phase)' };
    }

    if (name === 'Busbar Chamber') {
        const bars = norm(props['Bars'] || '4');
        if (bars === '2') {
            return { kind: 'single', label: 'Busbar incomer (2-bar single-phase)' };
        }
        return { kind: 'three', label: 'Busbar incomer (4-bar 3-phase)' };
    }

    if (name.includes('Cubical Panel') || name.includes('Cubicle Panel')) {
        const sec = getIncomerSection(pointKey);
        if (sec < 1) {
            return { kind: 'unknown', label: `LT Panel incomer ${pointKey} (unknown section)` };
        }
        const type = norm(props[`Incomer${sec}_Type`]);
        const pole = norm(props[`Incomer${sec}_Pole`] || (type === 'Main Switch Open' ? 'TPN' : ''));
        if (isSinglePhasePole(pole)) {
            return { kind: 'single', label: `LT Panel incomer ${sec} (single-phase ${pole})` };
        }
        if (pole !== '') {
            return { kind: 'three', label: `LT Panel incomer ${sec} (3-phase ${pole || type})` };
        }
        if (type !== '') {
            // Configured type without an explicit pole (e.g. MCCB/ACB/SFU) is
            // three-phase in practice.
            return { kind: 'three', label: `LT Panel incomer ${sec} (3-phase ${type})` };
        }
        return { kind: 'unknown', label: `LT Panel incomer ${sec} (unconfigured)` };
    }

    if (name === 'Main Switch' || name === 'Change Over Switch') {
        const voltage = norm(props['Voltage']);
        if (!voltage) return { kind: 'unknown', label: `${name} incomer (unconfigured voltage)` };
        if (isSinglePhaseSwitchVoltage(voltage, name)) {
            return { kind: 'single', label: `${name} incomer (single-phase ${voltage})` };
        }
        if (isThreePhaseSwitchVoltage(voltage)) {
            return { kind: 'three', label: `${name} incomer (3-phase ${voltage})` };
        }
        return { kind: 'unknown', label: `${name} incomer (unconfigured voltage)` };
    }

    if (name === 'Source') {
        return { kind: 'unknown', label: 'Source has no incomer' };
    }

    if (name === 'Portal') {
        return { kind: 'unknown', label: 'Portal (phase follows linked net)' };
    }

    // Loads, switch boards and everything else are single-phase incomers.
    return { kind: 'single', label: `${name} incomer (single-phase)` };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PhaseValidationResult {
    ok: boolean;
    error?: string;
    sourceKind?: PhaseKind;
    targetKind?: PhaseKind;
}

const THREE_SOURCE_HINT =
    'Feed it from a 3-phase outgoing: Source (3-phase), VTPN outgoing, Busbar ALL tap (4-bar), LT Panel 3-phase outgoing (TP/FP/TPN), or Main/Change-Over Switch at 415V.';
const SINGLE_SOURCE_HINT =
    'Feed it from a single-phase outgoing: Source (1-phase), HTPN way, SPN DB outgoing, Busbar R/Y/B tap, LT Panel single-phase outgoing (SP/DP/1P with R/Y/B), or Main/Change-Over Switch at 230V DP.';

export function validateConnectionPhase(
    sourceItem: CanvasItem,
    sourcePointKey: string,
    targetItem: CanvasItem,
    targetPointKey: string
): PhaseValidationResult {
    const src = getOutgoingPhaseType(sourceItem, sourcePointKey);
    const dst = getIncomingPhaseType(targetItem, targetPointKey);

    // Unknown on either side means "not enough configuration to judge" —
    // allow the connection so half-configured panels don't deadlock the user.
    if (src.kind === 'unknown' || dst.kind === 'unknown') {
        return { ok: true, sourceKind: src.kind, targetKind: dst.kind };
    }

    if (src.kind === dst.kind) {
        return { ok: true, sourceKind: src.kind, targetKind: dst.kind };
    }

    if (src.kind === 'single' && dst.kind === 'three') {
        return {
            ok: false,
            sourceKind: src.kind,
            targetKind: dst.kind,
            error:
                `Incompatible connection: single-phase outgoing (${src.label}) cannot feed a 3-phase incomer (${dst.label}). ` +
                THREE_SOURCE_HINT
        };
    }

    // src three-phase feeding a single-phase incomer: also a mismatch (wrong
    // cable/core and wrong voltage). The single-phase load must be fed from a
    // single-phase tap of the 3-phase board, not from its 3-phase feeder.
    return {
        ok: false,
        sourceKind: src.kind,
        targetKind: dst.kind,
        error:
            `Incompatible connection: 3-phase outgoing (${src.label}) cannot feed a single-phase incomer (${dst.label}). ` +
            SINGLE_SOURCE_HINT
    };
}

export interface IncompatibleConnectorInfo {
    connector: Connector;
    error: string;
}

/**
 * Check every connector touching `updatedItem` (with its NEW configuration)
 * against the counterpart items' current configuration.
 * Used to block a property save that would invalidate existing wiring.
 */
export function findIncompatibleConnectorsForItem(
    updatedItem: CanvasItem,
    allConnectors: Connector[],
    allItems: CanvasItem[]
): IncompatibleConnectorInfo[] {
    const byId = new Map<string, CanvasItem>();
    for (const it of allItems) byId.set(it.uniqueID, it);
    // The updated item replaces its old snapshot for validation purposes.
    byId.set(updatedItem.uniqueID, updatedItem);

    const issues: IncompatibleConnectorInfo[] = [];
    for (const c of allConnectors) {
        const sid = c.sourceItem?.uniqueID;
        const tid = c.targetItem?.uniqueID;
        const touchesSource = sid === updatedItem.uniqueID;
        const touchesTarget = tid === updatedItem.uniqueID;
        if (!touchesSource && !touchesTarget) continue;

        const srcItem = byId.get(sid || '') || c.sourceItem;
        const dstItem = byId.get(tid || '') || c.targetItem;
        if (!srcItem || !dstItem) continue;

        const result = validateConnectionPhase(srcItem, c.sourcePointKey, dstItem, c.targetPointKey);
        if (!result.ok && result.error) {
            issues.push({ connector: c, error: result.error });
        }
    }
    return issues;
}

/**
 * Scan a whole sheet for phase-incompatible connectors (e.g. legacy projects
 * created before this restriction existed).
 */
export function findAllIncompatibleConnectors(
    allConnectors: Connector[],
    allItems: CanvasItem[]
): IncompatibleConnectorInfo[] {
    const byId = new Map<string, CanvasItem>();
    for (const it of allItems) byId.set(it.uniqueID, it);
    const issues: IncompatibleConnectorInfo[] = [];
    for (const c of allConnectors) {
        const srcItem = byId.get(c.sourceItem?.uniqueID || '') || c.sourceItem;
        const dstItem = byId.get(c.targetItem?.uniqueID || '') || c.targetItem;
        if (!srcItem || !dstItem) continue;
        const result = validateConnectionPhase(srcItem, c.sourcePointKey, dstItem, c.targetPointKey);
        if (!result.ok && result.error) {
            issues.push({ connector: c, error: result.error });
        }
    }
    return issues;
}
