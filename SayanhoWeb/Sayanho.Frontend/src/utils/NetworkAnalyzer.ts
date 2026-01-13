import { CanvasItem, Connector, CanvasSheet } from '../types';
import { ApplicationSettings } from './ApplicationSettings';

export class NetworkAnalyzer {
    private allItems: CanvasItem[] = [];
    private allConnectors: Connector[] = [];
    private allSheets: CanvasSheet[];

    constructor(sheets: CanvasSheet[]) {
        this.allSheets = sheets;

        // Collect items and connectors from all sheets
        this.allSheets.forEach(sheet => {
            this.allItems.push(...sheet.canvasItems);
            this.allConnectors.push(...sheet.storedConnectors);
        });

        // After computing currents, update portal labels
        this.updatePortalLabels();
    }

    public analyzeNetwork(): void {
        // Reset all current values
        this.allConnectors.forEach(connector => {
            if (!connector.currentValues) {
                connector.currentValues = {};
            }
            connector.currentValues["Current"] = "0 A";
            connector.currentValues["R_Current"] = "0 A";
            connector.currentValues["Y_Current"] = "0 A";
            connector.currentValues["B_Current"] = "0 A";
            connector.currentValues["Phase"] = "";
        });

        // Find all sources (only "Source" items)
        const sources = this.allItems.filter(item => item.name === "Source");

        // Process each source
        sources.forEach(source => {
            let voltageStr = "230 V";
            let phaseType = "1-phase";

            if (source.properties && source.properties.length > 0) {
                const props = source.properties[0];
                if (props["Voltage"]) voltageStr = props["Voltage"];
                if (props["Type"]) phaseType = props["Type"];
            }

            let voltage = 230;
            if (voltageStr.includes("415")) voltage = 415;
            else if (voltageStr.includes("440")) voltage = 440;

            const sourceConnectors = this.allConnectors.filter(c => c.sourceItem.uniqueID === source.uniqueID);

            sourceConnectors.forEach(connector => {
                this.traceAndCalculateCurrent(connector, voltage, phaseType, "", new Set<string>(), new Set<string>());
            });
        });
    }

    private traceAndCalculateCurrent(
        connector: Connector,
        voltage: number,
        phaseType: string,
        inheritedPhase: string = "",
        visited: Set<string>,
        visitedNets: Set<string>
    ): void {
        const edgeKey = this.getConnectorKey(connector);
        if (visited.has(edgeKey)) return;
        visited.add(edgeKey);

        // Use IDs to look up fresh items from allItems, as connector.targetItem might be stale
        const targetItemId = connector.targetItem.uniqueID;
        const sourceItemId = connector.sourceItem.uniqueID;

        const targetItem = this.allItems.find(i => i.uniqueID === targetItemId);
        const sourceItem = this.allItems.find(i => i.uniqueID === sourceItemId);

        if (!targetItem) return;

        let currentVoltage = voltage;
        let phase = inheritedPhase;

        // Determine phase based on source connection if not inherited
        if (!phase) {
            if (sourceItem?.name === "SPN DB") {
                currentVoltage = 230;
                // Try to find phase feeding this SPN DB
                const incoming = this.allConnectors.find(c => c.targetItem.uniqueID === sourceItem.uniqueID);
                phase = incoming?.currentValues?.["Phase"] || "R";
            } else if (sourceItem?.name?.includes("HTPN")) {
                currentVoltage = 230;
                const sourcePointKey = connector.sourcePointKey || "";
                if (sourcePointKey.includes("R") || sourcePointKey.startsWith("R")) phase = "R";
                else if (sourcePointKey.includes("Y") || sourcePointKey.startsWith("Y")) phase = "Y";
                else if (sourcePointKey.includes("B") || sourcePointKey.startsWith("B")) phase = "B";
                else phase = "R";
            } else if (sourceItem?.name === "Main Switch" || sourceItem?.name === "Change Over Switch") {
                if (sourceItem.name === "Change Over Switch") {
                    // Change Over Switch Handler Logic
                    currentVoltage = 415;
                    phase = "ALL";
                    if (sourceItem.properties?.[0]?.["Voltage"]?.includes("DP") || sourceItem.properties?.[0]?.["Voltage"]?.includes("230V")) {
                        currentVoltage = 230;
                        // Try to find phase feeding this switch
                        const incoming = this.allConnectors.find(c => c.targetItem.uniqueID === sourceItem.uniqueID);
                        phase = incoming?.currentValues?.["Phase"] || "R";
                    }
                } else {
                    // Main Switch
                    currentVoltage = 415;
                    phase = "ALL";
                    if (sourceItem.properties?.[0]?.["Voltage"]?.includes("DP")) {
                        currentVoltage = 230;
                        const incoming = this.allConnectors.find(c => c.targetItem.uniqueID === sourceItem.uniqueID);
                        phase = incoming?.currentValues?.["Phase"] || "R";
                    }
                }
            } else if (sourceItem?.name?.includes("VTPN") || sourceItem?.name === "LT Cubical Panel") {
                phase = "ALL";
            } else if (sourceItem?.name === "Source") {
                if (sourceItem.properties?.[0]?.["Type"]?.includes("3-phase")) {
                    phase = "ALL";
                } else {
                    phase = "R";
                }
            } else if (sourceItem) {
                // Inherit from incoming
                const incoming = this.allConnectors.find(c => c.targetItem.uniqueID === sourceItem.uniqueID);
                phase = incoming?.currentValues?.["Phase"] || "R";
            }
        }

        if (!connector.currentValues) connector.currentValues = {};
        connector.currentValues["Phase"] = phase;

        // Check if target is a load
        if (targetItem.properties?.[0]?.["Power"]) {
            const powerStr = targetItem.properties[0]["Power"];
            const power = parseFloat(powerStr.split(' ')[0]);

            if (!isNaN(power)) {
                const diversificationFactor = ApplicationSettings.getDiversificationFactor(targetItem.name);
                const current = (power * diversificationFactor) / currentVoltage;

                connector.currentValues["Current"] = `${current.toFixed(2)} A`;

                if (!targetItem.properties[0]) targetItem.properties[0] = {};
                targetItem.properties[0]["Phase"] = phase;

                if (phase === "R") {
                    connector.currentValues["R_Current"] = `${current.toFixed(2)} A`;
                    connector.currentValues["Y_Current"] = "0 A";
                    connector.currentValues["B_Current"] = "0 A";
                } else if (phase === "Y") {
                    connector.currentValues["R_Current"] = "0 A";
                    connector.currentValues["Y_Current"] = `${current.toFixed(2)} A`;
                    connector.currentValues["B_Current"] = "0 A";
                } else if (phase === "B") {
                    connector.currentValues["R_Current"] = "0 A";
                    connector.currentValues["Y_Current"] = "0 A";
                    connector.currentValues["B_Current"] = `${current.toFixed(2)} A`;
                } else if (phase === "ALL") {
                    const phaseCurrent = current / 3;
                    connector.currentValues["R_Current"] = `${phaseCurrent.toFixed(2)} A`;
                    connector.currentValues["Y_Current"] = `${phaseCurrent.toFixed(2)} A`;
                    connector.currentValues["B_Current"] = `${phaseCurrent.toFixed(2)} A`;
                }
            }
        } else {
            // Special handling: Portal bridging across sheets
            if (targetItem.name === 'Portal') {
                const metaP = (targetItem.properties?.[0] || {}) as Record<string, string>;
                const netId = (metaP["NetId"] || metaP["netId"] || '').trim();
                if (!netId) return;

                // Prevent cycling through same net repeatedly
                if (visitedNets.has(netId)) return;
                visitedNets.add(netId);

                // Find counterpart portal (pair-only)
                const portals = this.allItems.filter(it => it.name === 'Portal') as CanvasItem[];
                const sameNet = portals.filter(p => {
                    const mp = (p.properties?.[0] || {}) as Record<string, string>;
                    const nid = (mp['NetId'] || mp['netId'] || '').trim();
                    return nid === netId;
                });

                // Allow bridging if exactly 2 portals exist with this ID
                if (sameNet.length !== 2) return;

                const counterpart = sameNet.find(p => p.uniqueID !== targetItem.uniqueID);
                if (!counterpart) return;

                // Trace from counterpart's outgoing connectors
                // We ignore 'Direction' property and rely on connectivity.
                const outFromCounterpart = this.allConnectors.filter(c => c.sourceItem.uniqueID === counterpart.uniqueID);

                if (outFromCounterpart.length > 0) {
                    let totalCurrent = 0;
                    let rPhaseCurrent = 0;
                    let yPhaseCurrent = 0;
                    let bPhaseCurrent = 0;

                    outFromCounterpart.forEach(outC => {
                        this.traceAndCalculateCurrent(outC, voltage, phaseType, phase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outC.currentValues?.["Current"]);
                        rPhaseCurrent += this.parseCurrent(outC.currentValues?.["R_Current"]);
                        yPhaseCurrent += this.parseCurrent(outC.currentValues?.["Y_Current"]);
                        bPhaseCurrent += this.parseCurrent(outC.currentValues?.["B_Current"]);
                    });

                    connector.currentValues["Current"] = `${totalCurrent.toFixed(2)} A`;
                    connector.currentValues["R_Current"] = `${rPhaseCurrent.toFixed(2)} A`;
                    connector.currentValues["Y_Current"] = `${yPhaseCurrent.toFixed(2)} A`;
                    connector.currentValues["B_Current"] = `${bPhaseCurrent.toFixed(2)} A`;
                }
                return;
            }

            // Trace outgoing connectors
            const outgoingConnectors = this.allConnectors.filter(c => c.sourceItem.uniqueID === targetItem.uniqueID);

            if (outgoingConnectors.length > 0) {
                let totalCurrent = 0;
                let rPhaseCurrent = 0;
                let yPhaseCurrent = 0;
                let bPhaseCurrent = 0;

                if (targetItem.name?.includes("VTPN")) {
                    outgoingConnectors.forEach(outConnector => {
                        this.traceAndCalculateCurrent(outConnector, 415, phaseType, phase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);
                        rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                        yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                        bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                    });
                } else if (targetItem.name === "LT Cubical Panel") {
                    // Section-Aware Tracing for LT Cubical Panel
                    const targetPointKey = connector.targetPointKey || "";
                    let targetSectionId = "1";

                    if (targetPointKey.startsWith("in")) {
                        targetSectionId = targetPointKey.substring(2);
                    }

                    const panelProps = (targetItem.properties?.[0] || {}) as Record<string, string>;
                    const rawCount = parseInt(panelProps["Incomer Count"] || "1", 10);
                    const incomerCount = isNaN(rawCount) ? 1 : Math.max(rawCount, 1);

                    const sectionNum = parseInt(targetSectionId, 10);
                    const allowedSections = new Set<string>();
                    if (Number.isFinite(sectionNum) && sectionNum >= 1) {
                        allowedSections.add(sectionNum.toString());
                        const isChangeOverType = (t?: string) => {
                            if (!t) return false;
                            return t === "Change Over Switch Open" || t === "Change Over Switch" || t.includes("Change Over Switch");
                        };

                        if (sectionNum > 1 && isChangeOverType(panelProps[`BusCoupler${sectionNum - 1}_Type`])) {
                            allowedSections.add((sectionNum - 1).toString());
                        }
                        if (sectionNum < incomerCount && isChangeOverType(panelProps[`BusCoupler${sectionNum}_Type`])) {
                            allowedSections.add((sectionNum + 1).toString());
                        }
                    } else {
                        allowedSections.add(targetSectionId);
                    }

                    const outgoings = targetItem.outgoing || [];

                    outgoingConnectors.forEach(outConnector => {
                        // Check if this outgoing connector belongs to the same section
                        const sourcePointKey = outConnector.sourcePointKey || ""; // e.g. "out1"
                        let outgoingIndex = -1;

                        if (sourcePointKey.startsWith("out")) {
                            const indexPart = sourcePointKey.substring(3).split('_')[0]; // Handle out1 or out1_R
                            outgoingIndex = parseInt(indexPart) - 1; // 0-based index
                        }

                        if (outgoingIndex >= 0 && outgoingIndex < outgoings.length) {
                            const outItem = outgoings[outgoingIndex];
                            const section = outItem["Section"];

                            // Only trace if sections match
                            if (allowedSections.has(section)) {
                                // Determine Phase/Voltage based on Pole/Phase config
                                let linkVoltage = 415;
                                let linkPhase = "ALL"; // Default 3-phase

                                const pole = outItem["Pole"];
                                const selectedPhase = outItem["Phase"]; // R, Y, or B

                                // Check for Single Phase types logic
                                if (pole && (pole.startsWith("DP") || pole.startsWith("SP") || pole.startsWith("1P"))) {
                                    linkVoltage = 230;
                                    // If a specific phase is selected, use it. Otherwise default to R or inherited?
                                    // For panel outgoings, they must tap from a phase. Defaulting to R if missing.
                                    linkPhase = selectedPhase || "R";
                                }

                                this.traceAndCalculateCurrent(outConnector, linkVoltage, phaseType, linkPhase, visited, visitedNets);
                                totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);
                                if (linkPhase === "R" || linkPhase === "ALL") rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                                if (linkPhase === "Y" || linkPhase === "ALL") yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                                if (linkPhase === "B" || linkPhase === "ALL") bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                            }
                        }
                    });
                } else if (targetItem.name === "SPN DB") {
                    const spnPhase = phase;
                    outgoingConnectors.forEach(outConnector => {
                        this.traceAndCalculateCurrent(outConnector, 230, phaseType, spnPhase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);

                        if (spnPhase === "R") rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                        else if (spnPhase === "Y") yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                        else if (spnPhase === "B") bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                    });
                } else if (targetItem.name === "Busbar Chamber") {
                    const busbarProps = (targetItem.properties?.[0] || {}) as Record<string, string>;
                    const bars = (busbarProps["Bars"] || "4").toString();
                    const outgoings = targetItem.outgoing || [];

                    outgoingConnectors.forEach(outConnector => {
                        const sourcePointKey = outConnector.sourcePointKey || "";
                        let outgoingIndex = -1;
                        if (sourcePointKey.startsWith("out")) {
                            const indexPart = sourcePointKey.substring(3).split('_')[0];
                            outgoingIndex = parseInt(indexPart, 10) - 1;
                        }

                        let linkVoltage = 415;
                        let linkPhase = "ALL";

                        if (bars === "2") {
                            // 2-bar busbar: single-phase system. All outgoing taps inherit incomer phase.
                            linkVoltage = 230;
                            linkPhase = phase;
                            if (linkPhase !== "R" && linkPhase !== "Y" && linkPhase !== "B") {
                                linkPhase = "R";
                            }
                        } else {
                            // 4-bar busbar: per-outgoing phase configuration (R/Y/B or ALL)
                            let configuredPhase: string | undefined;
                            if (outgoingIndex >= 0 && outgoingIndex < outgoings.length) {
                                configuredPhase = outgoings[outgoingIndex]?.["Phase"];
                            }

                            const defaultPhases = ["R", "Y", "B"];
                            const normalized = (configuredPhase || defaultPhases[Math.max(outgoingIndex, 0) % 3]).toString();

                            if (normalized === "ALL") {
                                linkVoltage = 415;
                                linkPhase = "ALL";
                            } else {
                                linkVoltage = 230;
                                linkPhase = (normalized === "Y" || normalized === "B") ? normalized : "R";
                            }
                        }

                        this.traceAndCalculateCurrent(outConnector, linkVoltage, phaseType, linkPhase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);

                        if (linkPhase === "R" || linkPhase === "ALL") rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                        if (linkPhase === "Y" || linkPhase === "ALL") yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                        if (linkPhase === "B" || linkPhase === "ALL") bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                    });
                } else if (targetItem.name?.includes("HTPN")) {
                    outgoingConnectors.forEach(outConnector => {
                        const outPointKey = outConnector.sourcePointKey || "";
                        let outPhase = "R";
                        if (outPointKey.includes("R") || outPointKey.startsWith("R")) outPhase = "R";
                        else if (outPointKey.includes("Y") || outPointKey.startsWith("Y")) outPhase = "Y";
                        else if (outPointKey.includes("B") || outPointKey.startsWith("B")) outPhase = "B";

                        this.traceAndCalculateCurrent(outConnector, 230, phaseType, outPhase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);
                        rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                        yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                        bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                    });
                } else if (targetItem.name === "Main Switch" || targetItem.name === "Change Over Switch") {
                    let switchVoltage = currentVoltage;
                    let switchPhase = phase;

                    if (targetItem.name === "Change Over Switch") {
                        switchVoltage = 415;
                        switchPhase = "ALL";
                        if (targetItem.properties?.[0]?.["Voltage"]?.includes("DP") || targetItem.properties?.[0]?.["Voltage"]?.includes("230V")) {
                            switchVoltage = 230;
                            // Inherit phase from incoming
                            switchPhase = phase;
                        }
                    } else {
                        // Main Switch
                        switchVoltage = 415;
                        switchPhase = "ALL";
                        if (targetItem.properties?.[0]?.["Voltage"]?.includes("DP")) {
                            switchVoltage = 230;
                            switchPhase = phase;
                        }
                    }

                    outgoingConnectors.forEach(outConnector => {
                        this.traceAndCalculateCurrent(outConnector, switchVoltage, phaseType, switchPhase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);
                        rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                        yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                        bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                    });
                } else {
                    // Generic component
                    outgoingConnectors.forEach(outConnector => {
                        this.traceAndCalculateCurrent(outConnector, currentVoltage, phaseType, phase, visited, visitedNets);
                        totalCurrent += this.parseCurrent(outConnector.currentValues?.["Current"]);
                        rPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["R_Current"]);
                        yPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["Y_Current"]);
                        bPhaseCurrent += this.parseCurrent(outConnector.currentValues?.["B_Current"]);
                    });
                }

                connector.currentValues["Current"] = `${totalCurrent.toFixed(2)} A`;
                connector.currentValues["R_Current"] = `${rPhaseCurrent.toFixed(2)} A`;
                connector.currentValues["Y_Current"] = `${yPhaseCurrent.toFixed(2)} A`;
                connector.currentValues["B_Current"] = `${bPhaseCurrent.toFixed(2)} A`;
            }
        }
    }

    private parseCurrent(currentStr?: string): number {
        if (!currentStr) return 0;
        const val = parseFloat(currentStr.split(' ')[0]);
        return isNaN(val) ? 0 : val;
    }

    private getConnectorKey(c: Connector): string {
        const sId = c.sourceItem?.uniqueID || "null";
        const tId = c.targetItem?.uniqueID || "null";
        const sKey = c.sourcePointKey || "";
        const tKey = c.targetPointKey || "";
        return `${sId}:${sKey}->${tId}:${tKey}`;
    }

    private updatePortalLabels(): void {
        // Map item id to its sheet name
        const itemToSheet = new Map<string, string>();
        this.allSheets.forEach(sh => {
            sh.canvasItems.forEach(it => itemToSheet.set(it.uniqueID, sh.name));
        });

        // Group portals by NetId
        const byNet = new Map<string, CanvasItem[]>();
        this.allItems.forEach(it => {
            if (it.name === 'Portal') {
                const p = (it.properties?.[0] || {}) as Record<string, string>;
                const netId = (p['NetId'] || p['netId'] || '').trim();
                if (netId) {
                    if (!byNet.has(netId)) byNet.set(netId, []);
                    byNet.get(netId)!.push(it);
                }
            }
        });

        const getLocalLink = (portal: CanvasItem): { remoteItem: CanvasItem | null, remotePoint: string | null } => {
            const meta = (portal.properties?.[0] || {}) as Record<string, string>;
            const dir = (meta['Direction'] || meta['direction'] || '').toLowerCase();

            // Primary: match expected orientation
            if (dir === 'in') {
                const inc = this.allConnectors.find(c => c.targetItem.uniqueID === portal.uniqueID);
                if (inc) {
                    const remote = this.allItems.find(i => i.uniqueID === inc.sourceItem.uniqueID) || inc.sourceItem;
                    return { remoteItem: remote, remotePoint: inc.sourcePointKey };
                }
            } else if (dir === 'out') {
                const out = this.allConnectors.find(c => c.sourceItem.uniqueID === portal.uniqueID);
                if (out) {
                    const remote = this.allItems.find(i => i.uniqueID === out.targetItem.uniqueID) || out.targetItem;
                    return { remoteItem: remote, remotePoint: out.targetPointKey };
                }
            }

            // Fallback: handle connections created with inverted CP keys (portal appears on unexpected end)
            const asSource = this.allConnectors.find(c => c.sourceItem.uniqueID === portal.uniqueID);
            if (asSource) {
                const remote = this.allItems.find(i => i.uniqueID === asSource.targetItem.uniqueID) || asSource.targetItem;
                return { remoteItem: remote, remotePoint: asSource.targetPointKey };
            }
            const asTarget = this.allConnectors.find(c => c.targetItem.uniqueID === portal.uniqueID);
            if (asTarget) {
                const remote = this.allItems.find(i => i.uniqueID === asTarget.sourceItem.uniqueID) || asTarget.sourceItem;
                return { remoteItem: remote, remotePoint: asTarget.sourcePointKey };
            }

            return { remoteItem: null, remotePoint: null };
        };

        byNet.forEach((portals, netId) => {
            if (portals.length !== 2) {
                portals.forEach(p => {
                    if (!p.properties[0]) p.properties[0] = {} as any;
                    p.properties[0]['Label'] = netId;
                });
                return;
            }

            const [p1, p2] = portals;
            const l1 = getLocalLink(p1);
            const l2 = getLocalLink(p2);

            // Incomplete until both sides are connected
            if (!l1.remoteItem || !l2.remoteItem) {
                [p1, p2].forEach(p => {
                    if (!p.properties[0]) p.properties[0] = {} as any;
                    p.properties[0]['Label'] = netId;
                });
                return;
            }

            const r1Sheet = itemToSheet.get(l2.remoteItem.uniqueID) || '';
            const r2Sheet = itemToSheet.get(l1.remoteItem.uniqueID) || '';

            if (!p1.properties[0]) p1.properties[0] = {} as any;
            if (!p2.properties[0]) p2.properties[0] = {} as any;

            p1.properties[0]['Label'] = `${r1Sheet} - ${l2.remoteItem.name} - ${l2.remotePoint || ''}`.trim();
            p2.properties[0]['Label'] = `${r2Sheet} - ${l1.remoteItem.name} - ${l1.remotePoint || ''}`.trim();
        });
    }
}
