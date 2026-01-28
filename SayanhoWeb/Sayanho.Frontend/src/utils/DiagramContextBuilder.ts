/**
 * DiagramContextBuilder - Utility for building rich diagram context for AI interactions
 * 
 * This utility analyzes the current diagram state and provides structured information
 * that the AI can use to understand and interact with the electrical diagram.
 */

import { CanvasSheet, CanvasItem, Connector } from '../types';
import { ApplicationSettings } from './ApplicationSettings';

export interface LoadAnalysis {
    totalPower: number;
    totalCurrent: number;
    perPhase: {
        R: { power: number; current: number; items: string[] };
        Y: { power: number; current: number; items: string[] };
        B: { power: number; current: number; items: string[] };
        unassigned: { power: number; current: number; items: string[] };
    };
    itemBreakdown: Array<{ name: string; power: number; phase: string }>;
}

export interface PhaseBalanceResult {
    isBalanced: boolean;
    imbalancePercent: number;
    maxPhase: string;
    minPhase: string;
    recommendation: string;
    phasePowers: { R: number; Y: number; B: number };
}

export interface CableRecommendation {
    minSize: string;
    recommended: string;
    current: number;
    options: Array<{
        size: string;
        rating: string;
        suitability: string;
    }>;
}

export interface DiagramSummary {
    totalItems: number;
    totalConnectors: number;
    sheets: Array<{
        name: string;
        itemCount: number;
        connectorCount: number;
        items: Array<{
            name: string;
            id: string;
            properties: Record<string, string>;
        }>;
    }>;
    itemTypes: Record<string, number>;
    connectionTypes: { Cable: number; Wiring: number };
}

export interface DiagramStateJson {
    activeSheetId: string | null;
    sheetCount: number;
    totalItems: number;
    totalConnectors: number;
    sheets: Array<{
        sheetId: string;
        name: string;
        scale: number;
        viewportX: number;
        viewportY: number;
        itemCount: number;
        connectorCount: number;
        items: Array<{
            id: string;
            shortId: string;
            name: string;
            position: { x: number; y: number };
            size: { width: number; height: number };
            rotation: number;
            locked: boolean;
            connectionPointKeys: string[];
            properties: Record<string, string>;
        }>;
        connectors: Array<{
            index: number;
            materialType: string;
            sourceItemId: string;
            sourcePointKey: string;
            targetItemId: string;
            targetPointKey: string;
            isVirtual: boolean;
            properties: Record<string, string>;
            currentValues: Record<string, string>;
        }>;
    }>;
}

// Cable sizing lookup table (current rating in Amps)
const CABLE_RATINGS: Record<string, number> = {
    '0.5': 3,
    '0.75': 6,
    '1.0': 10,
    '1.5': 15,
    '2.5': 21,
    '4': 28,
    '6': 36,
    '10': 50,
    '16': 68,
    '25': 89,
    '35': 110,
    '50': 134,
    '70': 171,
    '95': 207,
    '120': 239,
    '150': 275,
    '185': 314,
    '240': 370
};

export class DiagramContextBuilder {
    /**
     * Build a comprehensive markdown summary of the diagram for AI context
     */
    static buildContext(sheets: CanvasSheet[]): string {
        let context = "## Current Diagram State\n\n";

        sheets.forEach((sheet, idx) => {
            context += `### Sheet ${idx + 1}: ${sheet.name}\n`;
            context += `- Items: ${sheet.canvasItems.length}\n`;
            context += `- Connections: ${sheet.storedConnectors.length}\n\n`;

            if (sheet.canvasItems.length > 0) {
                context += "**Items:**\n";
                sheet.canvasItems.forEach(item => {
                    const props = item.properties?.[0] || {};
                    const propStr = Object.entries(props)
                        .filter(([k, v]) => v && !['Label', 'NetId', 'Direction'].includes(k))
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ');
                    context += `- ${item.name} (ID: ${item.uniqueID.substring(0, 8)})${propStr ? ` [${propStr}]` : ''}\n`;
                });
                context += "\n";
            }

            if (sheet.storedConnectors.length > 0) {
                context += "**Connections:**\n";
                sheet.storedConnectors.forEach((conn, i) => {
                    const source = conn.sourceItem?.name || 'Unknown';
                    const target = conn.targetItem?.name || 'Unknown';
                    const current = conn.currentValues?.Current || '0 A';
                    const type = conn.materialType || 'Unknown';
                    const cable = conn.properties?.Size || '';
                    context += `- ${source} → ${target} (${type}${cable ? `, ${cable}` : ''}, Current: ${current})\n`;
                });
                context += "\n";
            }
        });

        return context;
    }

    static buildCompactContext(sheets: CanvasSheet[], activeSheetId: string | null): string {
        const active = sheets.find(s => s.sheetId === activeSheetId) || sheets[0];
        if (!active) return '## Diagram Snapshot\n\n(no sheets)\n';

        const truncate = (v: any, max: number) => {
            const s = (v ?? '').toString().replace(/\s+/g, ' ').trim();
            return s.length > max ? s.slice(0, max - 1) + '…' : s;
        };

        const pickProps = (name: string, props: Record<string, string>) => {
            const wanted = new Set<string>(['Way', 'Current Rating', 'Voltage', 'Power', 'Phase', 'Type', 'Text', 'FontSize', 'Color', 'Align', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'FontFamily']);
            const out: Record<string, string> = {};
            Object.entries(props || {}).forEach(([k, v]) => {
                if (!wanted.has(k)) return;
                if (!v) return;
                out[k] = truncate(v, 64);
            });
            return out;
        };

        const byId = new Map(active.canvasItems.map(i => [i.uniqueID, i] as const));

        let context = `## Diagram Snapshot\n\n`;
        context += `sheet=${truncate(active.name, 48)} items=${active.canvasItems.length} connectors=${active.storedConnectors.length}\n\n`;

        if (active.canvasItems.length > 0) {
            context += `items:\n`;
            active.canvasItems.forEach(it => {
                const props = pickProps(it.name, (it.properties?.[0] || {}) as Record<string, string>);
                const propStr = Object.keys(props).length > 0
                    ? ' ' + Object.entries(props).map(([k, v]) => `${k}=${v}`).join(' ')
                    : '';
                const cp = Object.keys(it.connectionPoints || {});
                context += `- ${it.uniqueID.substring(0, 8)} ${truncate(it.name, 28)} cp=${cp.join(',')}${propStr}\n`;
            });
            context += `\n`;
        }

        if (active.storedConnectors.length > 0) {
            context += `connectors:\n`;
            active.storedConnectors.forEach((c, idx) => {
                const sId = c.sourceItem?.uniqueID || '';
                const tId = c.targetItem?.uniqueID || '';
                const sShort = sId ? sId.substring(0, 8) : '????????';
                const tShort = tId ? tId.substring(0, 8) : '????????';
                const current = truncate(c.currentValues?.Current || '', 16);
                const material = truncate(c.materialType || '', 10);
                const virtual = c.isVirtual ? ' virtual' : '';
                const srcName = byId.get(sId)?.name || c.sourceItem?.name || '';
                const dstName = byId.get(tId)?.name || c.targetItem?.name || '';
                const hint = srcName && dstName ? ` ${truncate(srcName, 16)}→${truncate(dstName, 16)}` : '';
                context += `- #${idx} ${sShort}:${c.sourcePointKey} -> ${tShort}:${c.targetPointKey} ${material}${virtual}${current ? ` I=${current}` : ''}${hint}\n`;
            });
            context += `\n`;
        }

        context += `instructions: call get_diagram_state_json for full details before edits.\n`;
        return context;
    }

    static getDiagramStateJson(
        sheets: CanvasSheet[],
        activeSheetId: string | null,
        scope: 'active' | 'all' = 'active'
    ): DiagramStateJson {
        const selectedSheets = scope === 'all'
            ? sheets
            : sheets.filter(s => s.sheetId === activeSheetId);

        const sheetPayload = selectedSheets.map(sheet => {
            const items = sheet.canvasItems.map(item => ({
                id: item.uniqueID,
                shortId: item.uniqueID.substring(0, 8),
                name: item.name,
                position: { x: item.position.x, y: item.position.y },
                size: { width: item.size.width, height: item.size.height },
                rotation: item.rotation ?? 0,
                locked: !!item.locked,
                connectionPointKeys: Object.keys(item.connectionPoints || {}),
                properties: (item.properties?.[0] || {}) as Record<string, string>
            }));

            const connectors = sheet.storedConnectors.map((c, index) => ({
                index,
                materialType: c.materialType || 'Unknown',
                sourceItemId: c.sourceItem?.uniqueID || '',
                sourcePointKey: c.sourcePointKey || '',
                targetItemId: c.targetItem?.uniqueID || '',
                targetPointKey: c.targetPointKey || '',
                isVirtual: !!c.isVirtual,
                properties: (c.properties || {}) as Record<string, string>,
                currentValues: (c.currentValues || {}) as Record<string, string>
            }));

            return {
                sheetId: sheet.sheetId,
                name: sheet.name,
                scale: sheet.scale,
                viewportX: sheet.viewportX,
                viewportY: sheet.viewportY,
                itemCount: items.length,
                connectorCount: connectors.length,
                items,
                connectors
            };
        });

        const totalItems = sheetPayload.reduce((acc, s) => acc + s.itemCount, 0);
        const totalConnectors = sheetPayload.reduce((acc, s) => acc + s.connectorCount, 0);

        return {
            activeSheetId,
            sheetCount: sheets.length,
            totalItems,
            totalConnectors,
            sheets: sheetPayload
        };
    }

    static validateDiagram(sheets: CanvasSheet[]): { isValid: boolean; errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];

        const getPortalMeta = (it: CanvasItem) => (it.properties?.[0] || {}) as Record<string, string>;
        const getDir = (it: CanvasItem) => (getPortalMeta(it)['Direction'] || getPortalMeta(it)['direction'] || '').toLowerCase();
        const getNetId = (it: CanvasItem) => (getPortalMeta(it)['NetId'] || getPortalMeta(it)['netId'] || '').trim();

        for (const sheet of sheets) {
            const itemById = new Map(sheet.canvasItems.map(i => [i.uniqueID, i] as const));

            const portalConnCount = new Map<string, number>();

            sheet.storedConnectors.forEach((c, idx) => {
                const sid = c.sourceItem?.uniqueID;
                const tid = c.targetItem?.uniqueID;
                if (!sid || !tid) {
                    errors.push(`[${sheet.name}] Connector ${idx}: missing source/target item`);
                    return;
                }

                const src = itemById.get(sid) || c.sourceItem;
                const dst = itemById.get(tid) || c.targetItem;

                if (!src) warnings.push(`[${sheet.name}] Connector ${idx}: source item not found in sheet items`);
                if (!dst) warnings.push(`[${sheet.name}] Connector ${idx}: target item not found in sheet items`);

                if (src?.name === 'Portal' && dst?.name === 'Portal') {
                    errors.push(`[${sheet.name}] Connector ${idx}: portal-to-portal is not allowed`);
                }

                if (src?.connectionPoints && !src.connectionPoints[c.sourcePointKey]) {
                    errors.push(`[${sheet.name}] Connector ${idx}: invalid sourcePointKey ${c.sourcePointKey}`);
                }
                if (dst?.connectionPoints && !dst.connectionPoints[c.targetPointKey]) {
                    errors.push(`[${sheet.name}] Connector ${idx}: invalid targetPointKey ${c.targetPointKey}`);
                }

                [src, dst].forEach(it => {
                    if (!it || it.name !== 'Portal') return;
                    portalConnCount.set(it.uniqueID, (portalConnCount.get(it.uniqueID) || 0) + 1);
                });
            });

            portalConnCount.forEach((count, portalId) => {
                if (count > 1) {
                    errors.push(`[${sheet.name}] Portal ${portalId.substring(0, 8)}: has ${count} connectors (max 1)`);
                }
            });

            const portals = sheet.canvasItems.filter(i => i.name === 'Portal');
            const byNet = new Map<string, CanvasItem[]>();
            portals.forEach(p => {
                const netId = getNetId(p);
                if (!netId) return;
                if (!byNet.has(netId)) byNet.set(netId, []);
                byNet.get(netId)!.push(p);
            });
            byNet.forEach((arr, netId) => {
                if (arr.length !== 2) warnings.push(`[${sheet.name}] NetId ${netId}: expected 2 portals, found ${arr.length}`);
                const dirs = arr.map(getDir).filter(Boolean);
                if (dirs.length > 0 && !(dirs.includes('in') && dirs.includes('out'))) {
                    warnings.push(`[${sheet.name}] NetId ${netId}: expected one in and one out portal`);
                }
            });
        }

        return { isValid: errors.length === 0, errors, warnings };
    }

    /**
     * Get detailed load analysis across all sheets
     */
    static getLoadAnalysis(sheets: CanvasSheet[]): LoadAnalysis {
        const result: LoadAnalysis = {
            totalPower: 0,
            totalCurrent: 0,
            perPhase: {
                R: { power: 0, current: 0, items: [] },
                Y: { power: 0, current: 0, items: [] },
                B: { power: 0, current: 0, items: [] },
                unassigned: { power: 0, current: 0, items: [] }
            },
            itemBreakdown: []
        };

        sheets.forEach(sheet => {
            sheet.canvasItems.forEach(item => {
                const props = item.properties?.[0] || {};
                const powerStr = props['Power'] || '';

                if (powerStr) {
                    const power = parseFloat(powerStr.split(' ')[0]) || 0;
                    const phase = props['Phase'] || 'unassigned';
                    const diversification = ApplicationSettings.getDiversificationFactor(item.name);
                    const effectivePower = power * diversification;
                    const voltage = phase === 'ALL' ? 415 : 230;
                    const current = effectivePower / voltage;

                    result.totalPower += effectivePower;
                    result.totalCurrent += current;

                    result.itemBreakdown.push({
                        name: item.name,
                        power: effectivePower,
                        phase: phase
                    });

                    if (phase === 'R' || phase === 'Y' || phase === 'B') {
                        result.perPhase[phase].power += effectivePower;
                        result.perPhase[phase].current += current;
                        result.perPhase[phase].items.push(item.name);
                    } else if (phase === 'ALL') {
                        // 3-phase load is divided equally
                        const perPhasePower = effectivePower / 3;
                        const perPhaseCurrent = current / 3;
                        result.perPhase.R.power += perPhasePower;
                        result.perPhase.R.current += perPhaseCurrent;
                        result.perPhase.Y.power += perPhasePower;
                        result.perPhase.Y.current += perPhaseCurrent;
                        result.perPhase.B.power += perPhasePower;
                        result.perPhase.B.current += perPhaseCurrent;
                    } else {
                        result.perPhase.unassigned.power += effectivePower;
                        result.perPhase.unassigned.current += current;
                        result.perPhase.unassigned.items.push(item.name);
                    }
                }
            });
        });

        return result;
    }

    /**
     * Check phase balance and provide recommendations
     */
    static getPhaseBalance(sheets: CanvasSheet[]): PhaseBalanceResult {
        const load = this.getLoadAnalysis(sheets);
        const phases = ['R', 'Y', 'B'] as const;
        const powers = {
            R: load.perPhase.R.power,
            Y: load.perPhase.Y.power,
            B: load.perPhase.B.power
        };

        const maxPower = Math.max(powers.R, powers.Y, powers.B);
        const minPower = Math.min(powers.R, powers.Y, powers.B);
        const avgPower = (powers.R + powers.Y + powers.B) / 3;

        const maxPhase = phases.find(p => powers[p] === maxPower) || 'R';
        const minPhase = phases.find(p => powers[p] === minPower) || 'R';

        // Calculate imbalance as percentage deviation from average
        const imbalancePercent = avgPower > 0
            ? ((maxPower - minPower) / avgPower) * 100
            : 0;

        // Industry standard: less than 10% is balanced
        const isBalanced = imbalancePercent <= 10;

        let recommendation = '';
        if (isBalanced) {
            recommendation = 'Phases are well balanced. No action needed.';
        } else if (imbalancePercent <= 20) {
            recommendation = `Minor imbalance detected. Consider moving some loads from Phase ${maxPhase} to Phase ${minPhase}.`;
        } else {
            recommendation = `Significant phase imbalance! Move loads from Phase ${maxPhase} (${powers[maxPhase].toFixed(0)}W) to Phase ${minPhase} (${powers[minPhase].toFixed(0)}W).`;
        }

        return {
            isBalanced,
            imbalancePercent: Math.round(imbalancePercent * 10) / 10,
            maxPhase,
            minPhase,
            recommendation,
            phasePowers: powers
        };
    }

    /**
     * Get cable size recommendation based on current
     */
    static getCableRecommendation(current: number, phases: string = '1-phase'): CableRecommendation {
        const is3Phase = phases.includes('3');
        const effectiveCurrent = is3Phase ? current / 1.732 : current;

        const options: CableRecommendation['options'] = [];
        let recommended = '';
        let minSize = '';

        for (const [size, rating] of Object.entries(CABLE_RATINGS)) {
            if (rating >= effectiveCurrent) {
                if (!minSize) minSize = size;

                let suitability = 'Suitable';
                if (rating >= effectiveCurrent * 1.25) {
                    suitability = 'Recommended (25% headroom)';
                    if (!recommended) recommended = size;
                }
                if (rating >= effectiveCurrent * 1.5) {
                    suitability = 'Oversized (50%+ headroom)';
                }

                options.push({
                    size: `${size} sq.mm`,
                    rating: `${rating}A`,
                    suitability
                });

                // Only show 4 options
                if (options.length >= 4) break;
            }
        }

        if (!recommended) recommended = minSize;

        return {
            minSize: `${minSize} sq.mm`,
            recommended: `${recommended} sq.mm`,
            current: Math.round(effectiveCurrent * 100) / 100,
            options
        };
    }

    /**
     * Get comprehensive diagram summary
     */
    static getDiagramSummary(sheets: CanvasSheet[], sheetName?: string): DiagramSummary {
        const filteredSheets = sheetName
            ? sheets.filter(s => s.name.toLowerCase().includes(sheetName.toLowerCase()))
            : sheets;

        const itemTypes: Record<string, number> = {};
        let totalItems = 0;
        let totalConnectors = 0;
        let cableCount = 0;
        let wiringCount = 0;

        const sheetSummaries = filteredSheets.map(sheet => {
            totalItems += sheet.canvasItems.length;
            totalConnectors += sheet.storedConnectors.length;

            sheet.storedConnectors.forEach(c => {
                if (c.materialType === 'Cable') cableCount++;
                else wiringCount++;
            });

            const items = sheet.canvasItems.map(item => {
                itemTypes[item.name] = (itemTypes[item.name] || 0) + 1;
                return {
                    name: item.name,
                    id: item.uniqueID.substring(0, 8),
                    properties: item.properties?.[0] || {}
                };
            });

            return {
                name: sheet.name,
                itemCount: sheet.canvasItems.length,
                connectorCount: sheet.storedConnectors.length,
                items
            };
        });

        return {
            totalItems,
            totalConnectors,
            sheets: sheetSummaries,
            itemTypes,
            connectionTypes: { Cable: cableCount, Wiring: wiringCount }
        };
    }

    /**
     * Find items by name (partial match)
     */
    static findItems(sheets: CanvasSheet[], query: string): CanvasItem[] {
        const results: CanvasItem[] = [];
        const lowerQuery = query.toLowerCase();

        sheets.forEach(sheet => {
            sheet.canvasItems.forEach(item => {
                if (item.name.toLowerCase().includes(lowerQuery)) {
                    results.push(item);
                }
            });
        });

        return results;
    }

    /**
     * Get connectors for a specific item
     */
    static getConnectorsForItem(sheets: CanvasSheet[], itemId: string): Connector[] {
        const results: Connector[] = [];

        sheets.forEach(sheet => {
            sheet.storedConnectors.forEach(conn => {
                if (conn.sourceItem?.uniqueID === itemId || conn.targetItem?.uniqueID === itemId) {
                    results.push(conn);
                }
            });
        });

        return results;
    }
}
