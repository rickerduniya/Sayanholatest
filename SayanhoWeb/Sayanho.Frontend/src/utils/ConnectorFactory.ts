import type { CanvasItem, CanvasSheet, Connector } from '../types';
import { api } from '../services/api';
import { DefaultRulesEngine } from './DefaultRulesEngine';
import { sortOptionStringsAsc } from './sortUtils';

type MaterialType = 'Cable' | 'Wiring';

const getPortalMeta = (it: CanvasItem) => (it.properties?.[0] || {}) as Record<string, string>;

const isPortal = (it: CanvasItem) => it.name === 'Portal';

const getPortalDir = (it: CanvasItem) => (getPortalMeta(it)['Direction'] || getPortalMeta(it)['direction'] || '').toLowerCase();

const getPortalNetId = (it: CanvasItem) => (getPortalMeta(it)['NetId'] || getPortalMeta(it)['netId'] || '').trim();

const countConnectorsForItem = (sheet: CanvasSheet, itemId: string) =>
    sheet.storedConnectors.filter(c => c.sourceItem.uniqueID === itemId || c.targetItem.uniqueID === itemId).length;

export async function createConnectorWithDefaults(args: {
    activeSheet: CanvasSheet;
    allSheets: CanvasSheet[];
    sourceItem: CanvasItem;
    sourcePointKey: string;
    targetItem: CanvasItem;
    targetPointKey: string;
    materialType: MaterialType;
}): Promise<{ connector?: Connector; warnings?: string[]; error?: string }> {
    const warnings: string[] = [];
    const { activeSheet, allSheets } = args;
    let { sourceItem, targetItem } = args;
    let sourcePointKey = args.sourcePointKey;
    let targetPointKey = args.targetPointKey;

    if (sourceItem.uniqueID === targetItem.uniqueID) {
        return { error: 'Cannot connect an item to itself.' };
    }

    const classify = (item: CanvasItem, pointKey: string): 'in' | 'out' | 'other' => {
        const k = (pointKey || '').toLowerCase();
        if (k === 'in' || k.startsWith('in')) return 'in';
        if (k === 'out' || k.startsWith('out')) return 'out';
        if (isPortal(item) && k === 'port') {
            const dir = getPortalDir(item);
            if (dir === 'in') return 'in';
            if (dir === 'out') return 'out';
        }
        return 'other';
    };

    const sType = classify(sourceItem, sourcePointKey);
    const tType = classify(targetItem, targetPointKey);

    if (sType === 'in' && tType === 'out') {
        const tmpItem = sourceItem;
        sourceItem = targetItem;
        targetItem = tmpItem;

        const tmpKey = sourcePointKey;
        sourcePointKey = targetPointKey;
        targetPointKey = tmpKey;
    } else if (!(sType === 'out' && tType === 'in')) {
        return { error: 'Invalid connection. Source must be an OUT point and target must be an IN point.' };
    }

    if (!sourceItem.connectionPoints?.[sourcePointKey]) {
        return { error: `Invalid sourcePointKey: ${sourcePointKey}` };
    }
    if (!targetItem.connectionPoints?.[targetPointKey]) {
        return { error: `Invalid targetPointKey: ${targetPointKey}` };
    }

    const pointAlreadyUsed = (itemId: string, pointKey: string) => {
        return activeSheet.storedConnectors.some(c => {
            const sid = c.sourceItem?.uniqueID;
            const tid = c.targetItem?.uniqueID;
            return (sid === itemId && c.sourcePointKey === pointKey) || (tid === itemId && c.targetPointKey === pointKey);
        });
    };

    if (pointAlreadyUsed(sourceItem.uniqueID, sourcePointKey)) {
        return { error: `Connection point already used: ${sourceItem.name} ${sourceItem.uniqueID.substring(0, 8)}:${sourcePointKey}` };
    }
    if (pointAlreadyUsed(targetItem.uniqueID, targetPointKey)) {
        return { error: `Connection point already used: ${targetItem.name} ${targetItem.uniqueID.substring(0, 8)}:${targetPointKey}` };
    }

    if (isPortal(sourceItem) && isPortal(targetItem)) {
        return { error: 'Connecting a portal to another portal is not allowed.' };
    }

    if (isPortal(sourceItem)) {
        const cnt = countConnectorsForItem(activeSheet, sourceItem.uniqueID);
        if (cnt >= 1) return { error: 'This portal already has a connection.' };
    }
    if (isPortal(targetItem)) {
        const cnt = countConnectorsForItem(activeSheet, targetItem.uniqueID);
        if (cnt >= 1) return { error: 'This portal already has a connection.' };
    }

    let properties: Record<string, string> = {};
    let alternativeCompany1 = '';
    let alternativeCompany2 = '';
    let laying: Record<string, string> = {};
    let materialOverride: MaterialType | null = null;
    let forceVirtual = false;
    let forceLengthZero = false;

    const maybeMirrorFromCounterpart = () => {
        const portalSide = isPortal(sourceItem) ? sourceItem : (isPortal(targetItem) ? targetItem : null);
        if (!portalSide) return;
        const dir = getPortalDir(portalSide);
        if (dir !== 'in') return;

        forceVirtual = true;
        forceLengthZero = true;
        const netId = getPortalNetId(portalSide);
        if (!netId) return;

        const portals: CanvasItem[] = [];
        allSheets.forEach(sh => sh.canvasItems.forEach(ci => { if (ci.name === 'Portal') portals.push(ci); }));
        const pair = portals.filter(p => getPortalNetId(p) === netId);
        if (pair.length !== 2) return;
        const counterpart = pair.find(p => p.uniqueID !== portalSide.uniqueID);
        if (!counterpart) return;

        const counterpartSheet = allSheets.find(sh => sh.canvasItems.some(ci => ci.uniqueID === counterpart.uniqueID));
        const attached = counterpartSheet?.storedConnectors.find(c =>
            c.sourceItem.uniqueID === counterpart.uniqueID || c.targetItem.uniqueID === counterpart.uniqueID
        );
        if (!attached) return;

        properties = { ...(attached.properties || {}) };
        materialOverride = attached.materialType;
        alternativeCompany1 = attached.alternativeCompany1 || '';
        alternativeCompany2 = attached.alternativeCompany2 || '';
        laying = { ...(attached.laying || {}) };
        properties['IsVirtual'] = 'True';
    };

    maybeMirrorFromCounterpart();

    let apiData: Awaited<ReturnType<typeof api.getMaterialProperties>> | null = null;
    if (!forceVirtual) {
        try {
            apiData = await api.getMaterialProperties(args.materialType);
            if (apiData.properties && apiData.properties.length > 0) {
                properties = apiData.properties[0];
                alternativeCompany1 = apiData.alternativeCompany1 || '';
                alternativeCompany2 = apiData.alternativeCompany2 || '';
                laying = (apiData.laying || {}) as Record<string, string>;
            }
        } catch (e: any) {
            warnings.push(e?.message ? `Failed to load ${args.materialType} defaults: ${e.message}` : `Failed to load ${args.materialType} defaults`);
        }
    }

    try {
        const downstreamItem = targetItem;
        const downstreamProps = downstreamItem.properties?.[0] || {};

        const usedMaterial: MaterialType = materialOverride || args.materialType;

        if (!forceVirtual && usedMaterial === 'Cable') {
            const dynamicDefaults = DefaultRulesEngine.getConnectorDefaultsForTarget(
                usedMaterial,
                downstreamItem.name,
                downstreamProps
            );
            if (dynamicDefaults.properties['Core']) {
                properties['Core'] = dynamicDefaults.properties['Core'];
            }
        }

        if (!forceVirtual && usedMaterial === 'Wiring' && apiData?.properties) {
            const phaseType = DefaultRulesEngine.getItemPhaseType(downstreamItem.name, downstreamProps);
            const isExcluded = DefaultRulesEngine.isExcludedFromPhaseLogic(downstreamItem.name);

            if (!isExcluded) {
                const availableSizes: string[] = (apiData.properties || [])
                    .map((p: any) => p['Conductor Size'])
                    .filter((s: any) => s && typeof s === 'string');

                let targetConductorSize: string | null = null;

                if (phaseType === 'three-phase') {
                    const threePhasePattern = /^3 x \d+(\.\d+)? \+ 2 x \d+(\.\d+)? sq\.mm$/;
                    const matchingSizes = availableSizes.filter(s => threePhasePattern.test(s));
                    if (matchingSizes.length > 0) {
                        const sorted = sortOptionStringsAsc(Array.from(new Set(matchingSizes)));
                        targetConductorSize = sorted[0] || null;
                    }
                } else {
                    const singlePhasePattern = /^2 x \d+(\.\d+)? \+ 1 x \d+(\.\d+)? sq\.mm$/;
                    const matchingSizes = availableSizes.filter(s => singlePhasePattern.test(s));
                    if (matchingSizes.length > 0) {
                        const sorted = sortOptionStringsAsc(Array.from(new Set(matchingSizes)));
                        targetConductorSize = sorted[0] || null;
                    }
                }

                if (targetConductorSize) {
                    properties['Conductor Size'] = targetConductorSize;
                }
            }
        }
    } catch (e: any) {
        warnings.push(e?.message ? `Failed to apply dynamic defaults: ${e.message}` : 'Failed to apply dynamic defaults');
    }

    const connector: Connector = {
        sourceItem,
        sourcePointKey,
        targetItem,
        targetPointKey,
        properties,
        currentValues: {
            Current: '0 A',
            R_Current: '0 A',
            Y_Current: '0 A',
            B_Current: '0 A',
            Phase: ''
        },
        alternativeCompany1,
        alternativeCompany2,
        laying,
        accessories: [],
        length: forceLengthZero ? 0 : 0,
        materialType: materialOverride || args.materialType,
        isVirtual: forceVirtual
    };

    return { connector, warnings };
}
