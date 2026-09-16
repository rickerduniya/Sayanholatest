import { CanvasItem } from '../types';

export const updateItemVisuals = (item: CanvasItem): string => {
    if (!item.svgContent) return "";

    const parser = new DOMParser();
    const doc = parser.parseFromString(item.svgContent, "image/svg+xml");
    let modified = false;

    switch (item.name) {
        case "Bulb":
        case "Tube Light":
        case "Ceiling Fan":
        case "Exhaust Fan":
        case "Split AC":
        case "Geyser":
        case "Call Bell":
            modified = updateSimpleItemVisuals(doc, item);
            break;
        case "Point Switch Board":
        case "Avg. 5A Switch Board":
            modified = updateSwitchBoardVisuals(doc, item);
            break;
        case "Change Over Switch":
        case "Main Switch":
            modified = updateSwitchVisuals(doc, item);
            break;
        case "VTPN":
        case "SPN DB":
        case "HTPN":
            modified = updateDistributionBoardVisuals(doc, item);
            break;
        case "LT Cubical Panel":
            modified = updateCubiclePanelVisuals(doc, item);
            break;
        case "Source":
            modified = updateSourceVisuals(doc, item);
            break;
        case "Busbar Chamber":
            modified = updateBusbarChamberVisuals(doc, item);
            break;
    }

    if (modified) {
        return new XMLSerializer().serializeToString(doc);
    }
    return item.svgContent;
};

const updateSimpleItemVisuals = (doc: Document, item: CanvasItem): boolean => {
    const power = item.properties[0]?.["Power"];
    if (power) {
        // Try finding common IDs for power text
        const ids = ["text1", "powerText", "Rating"];
        for (const id of ids) {
            const el = doc.getElementById(id);
            if (el) {
                el.textContent = power;
                return true;
            }
        }
    }
    return false;
};

const updateSwitchBoardVisuals = (doc: Document, item: CanvasItem): boolean => {
    let modified = false;
    const avgRun = item.properties[0]?.["Avg. Run"];
    const type = item.properties[0]?.["Type"];

    if (avgRun) {
        const el = doc.getElementById("avgRunText");
        if (el) {
            // Match C# format: "Avg.Run: 10M"
            const numericPart = avgRun.match(/(\d+\.?\d*)/)?.[0] || "0";
            el.textContent = `Avg.Run: ${numericPart}M`;
            modified = true;
        }
    }

    if (type) {
        const el = doc.getElementById("Type");
        if (el) {
            el.textContent = type;
            modified = true;
        }
    }

    // Update Orboard text
    const accessories = item.accessories?.[0];
    if (accessories) {
        let numberOfOnboard = "0";
        const orboardRequired = accessories["orboard_required"];

        if (orboardRequired && orboardRequired.toLowerCase() === "true") {
            numberOfOnboard = accessories["number_of_onboard"] || "1";
        }

        const el = doc.getElementById("orboard");
        if (el) {
            el.textContent = `OB = ${numberOfOnboard}`;
            modified = true;
        }
    }

    return modified;
};

const updateSwitchVisuals = (doc: Document, item: CanvasItem): boolean => {
    let modified = false;
    const rating = item.properties[0]?.["Current Rating"];
    const voltage = item.properties[0]?.["Voltage"];

    if (rating) {
        const el = doc.getElementById("Rating");
        if (el) {
            el.textContent = rating;
            modified = true;
        }
    }

    if (voltage) {
        const el = doc.getElementById("text1");
        if (el) {
            // C# logic: $"C/O {VoltageText.Replace(" ", "")}" or $"MS ..."
            const prefix = item.name === "Main Switch" ? "MS" : "C/O";
            el.textContent = `${prefix} ${voltage.replace(/\s/g, "")}`;
            modified = true;
        }
    }

    return modified;
};

const updateDistributionBoardVisuals = (doc: Document, item: CanvasItem): boolean => {
    let modified = false;
    const wayText = item.properties[0]?.["Way"];
    const incomerRating = item.incomer?.["Current Rating"];

    console.log(`[SvgUpdater] Updating DB: ${item.name}, Way: ${wayText}, Incomer: ${incomerRating}`);

    if (!wayText) {
        console.warn(`[SvgUpdater] Missing Way property.`);
        return false;
    }

    let way = 0;
    if (item.name === "SPN DB") {
        // Use capturing group instead of lookbehind for better compatibility
        const match = wayText.match(/2\+(\d+)/);
        way = match ? parseInt(match[1]) : 4;
        console.log(`[SvgUpdater] SPN DB Way parsed: ${way} from ${wayText}`);
    } else {
        const match = wayText.match(/\d+/);
        way = match ? parseInt(match[0]) : 4;
    }

    const svg = doc.documentElement;
    let width = 0;

    // Calculate Width based on type (compact pitch mirrors GeometryCalculator:
    // HTPN/SPN 44px, VTPN 52px per outgoing way. All three hug the board:
    // lastSlot + 22, so the leaning diagonal tip keeps 4-6px to the border
    // and ~10px to the edge on every Way size — no per-way dead space).
    // SPN outgoing symbols sit SYM_SHIFT right of their slot with a 10px
    // diagonal lean (HTPN/VTPN: no shift, 12px lean); labels stay.
    const SPN_SYM_SHIFT = 5;
    const SPN_LEAN = 10;
    if (item.name === "HTPN") width = 40 + (way * 3 - 1) * 44 + 22;
    else if (item.name === "VTPN") width = 40 + (way - 1) * 52 + 22;
    else if (item.name === "SPN DB") width = 44 * way + 23;

    // Compact vertical layout (SVG units): viewport 112, geometry height 136 —
    // the same 170/140 vertical scale as before, so rendered text size is
    // unchanged. Busbar 68->58, incoming block 38->30, outgoing origin
    // 118->104. Top lead shortened (-37->-29) so it starts just inside the
    // viewport top; incomer-to-busbar baseline gap 10->8px. Label font sizes
    // are untouched; outgoing labels shift right (x -28) to clear the
    // neighbouring tick/diagonal at the tighter pitch. Nameplate is two
    // lines: "<Way>" over "<Device> DB" (VTPN: three lines, "DB" on its own).
    const COMPACT_H = 112;
    const BUSBAR_Y = 58;
    const INCOMING_Y = 30;
    const OUTGOING_Y = 104;
    const NAMEPLATE_Y1 = 14;
    const NAMEPLATE_Y2 = 28;
    const NAMEPLATE_Y3 = 42;
    // VTPN outgoing labels sit 4px left (-32): "OG10+" is wide enough to
    // touch its own tick at -28 (HTPN/SPN labels stay at -28).
    const VTPN_LABEL_X = -32;

    if (width > 0) {
        svg.setAttribute("width", width.toString());
        svg.setAttribute("height", COMPACT_H.toString());
        modified = true;
    }

    // Update Nameplate (two lines: Way on line 1, device name on line 2;
    // VTPN uses three lines: "<Way>" / "VTPN" / "DB").
    // Idempotent: fixes old single-line SVGs (y=20, full text) on re-run.
    const nameplate = doc.querySelector("#nameplate");
    if (nameplate) {
        let line1 = wayText.trim();
        let line2 = item.name;
        let line3: string | null = null;
        if (item.name === "VTPN") {
            line1 = `${way} Way`;
            line2 = "VTPN";
            line3 = "DB";
        } else if (item.name === "HTPN") {
            line1 = `${way} Way`;
            line2 = "HTPN DB";
        } else if (item.name === "SPN DB") {
            const m = wayText.match(/2\s*\+\s*(\d+)/);
            line1 = m ? `2+${m[1]} Way` : (/way/i.test(wayText) ? wayText.trim() : `${wayText.trim()} Way`);
            line2 = "SPN DB";
        }
        nameplate.setAttribute("x", "8");
        nameplate.setAttribute("y", NAMEPLATE_Y1.toString());
        nameplate.textContent = line1;

        const ns = "http://www.w3.org/2000/svg";
        let nameplate2 = doc.querySelector("#nameplate2");
        if (!nameplate2) {
            nameplate2 = doc.createElementNS(ns, "text");
            nameplate2.setAttribute("id", "nameplate2");
            // Mirror line-1 styling so font sizes stay untouched.
            for (const attr of ["font-family", "font-size", "fill", "font-weight"]) {
                const v = nameplate.getAttribute(attr);
                if (v) nameplate2.setAttribute(attr, v);
            }
            if (!nameplate2.getAttribute("font-family")) nameplate2.setAttribute("font-family", "Arial");
            if (!nameplate2.getAttribute("font-size")) nameplate2.setAttribute("font-size", "13");
            if (!nameplate2.getAttribute("fill")) nameplate2.setAttribute("fill", "black");
            if (!nameplate2.getAttribute("font-weight")) nameplate2.setAttribute("font-weight", "bold");
            nameplate.parentNode?.insertBefore(nameplate2, nameplate.nextSibling);
        }
        nameplate2.setAttribute("x", "8");
        nameplate2.setAttribute("y", NAMEPLATE_Y2.toString());
        nameplate2.textContent = line2;

        // Optional third line (VTPN "DB"); removed again on other board types
        // so re-runs stay idempotent.
        let nameplate3 = doc.querySelector("#nameplate3");
        if (line3) {
            if (!nameplate3) {
                nameplate3 = doc.createElementNS(ns, "text");
                nameplate3.setAttribute("id", "nameplate3");
                for (const attr of ["font-family", "font-size", "fill", "font-weight"]) {
                    const v = nameplate.getAttribute(attr);
                    if (v) nameplate3.setAttribute(attr, v);
                }
                if (!nameplate3.getAttribute("font-family")) nameplate3.setAttribute("font-family", "Arial");
                if (!nameplate3.getAttribute("font-size")) nameplate3.setAttribute("font-size", "13");
                if (!nameplate3.getAttribute("fill")) nameplate3.setAttribute("fill", "black");
                if (!nameplate3.getAttribute("font-weight")) nameplate3.setAttribute("font-weight", "bold");
                nameplate2.parentNode?.insertBefore(nameplate3, nameplate2.nextSibling);
            }
            nameplate3.setAttribute("x", "8");
            nameplate3.setAttribute("y", NAMEPLATE_Y3.toString());
            nameplate3.textContent = line3;
        } else if (nameplate3) {
            nameplate3.parentNode?.removeChild(nameplate3);
        }
        modified = true;
    } else {
        console.warn(`[SvgUpdater] Element '#nameplate' not found.`);
    }

    // Update Incomer Text
    if (incomerRating) {
        const incomingtext1 = doc.querySelector("#incomingtext1");
        if (incomingtext1) {
            incomingtext1.textContent = incomerRating;
            modified = true;
        }
    }

    // Update Border Width (all DBs hug the board with a constant margin —
    // border right edge lands 4px past the last diagonal tip on every Way)
    const border = doc.querySelector("#border");
    if (border) {
        const borderWidth = width - 8;

        border.setAttribute("width", borderWidth.toString());
        border.setAttribute("height", (COMPACT_H - 3).toString());
        modified = true;
    }

    // Update Incoming Group Position (top-to-busbar gap tightened 38->30;
    // shorten the top lead so it starts just inside the viewport top, and
    // shorten the tail below the busbar to keep a 2px overlap)
    const incoming = doc.querySelector("#incoming");
    if (incoming) {
        incoming.setAttribute("transform", `translate(${width / 2}, ${INCOMING_Y})`);
        modified = true;
    }
    const incomingLead = doc.querySelector("#line1");
    if (incomingLead) {
        incomingLead.setAttribute("y1", "-29");
        modified = true;
    }
    const incomingTail = doc.querySelector("#line3");
    if (incomingTail) {
        incomingTail.setAttribute("y2", "30");
        modified = true;
    }

    // Update Busbar Length + Height (busbar lifted 68->58 with the incomer;
    // SPN end covers the right-shifted last symbol + 4)
    const busbar = doc.querySelector("#Busbar");
    if (busbar) {
        let endX = 0;
        if (item.name === "HTPN") endX = 40 + (way * 3 - 1) * 44 + 4;
        else if (item.name === "VTPN") endX = 40 + ((way - 1) * 52) + 4;
        else if (item.name === "SPN DB") endX = 40 + ((way - 1) * 44) + SPN_SYM_SHIFT + 4;

        busbar.setAttribute("x1", "36");
        busbar.setAttribute("x2", endX.toString());
        busbar.setAttribute("y1", BUSBAR_Y.toString());
        busbar.setAttribute("y2", BUSBAR_Y.toString());
        modified = true;
    }

    // Update Outgoing Circuits
    const outgoingGroup = doc.querySelector("#outgoing-group");
    if (outgoingGroup) {
        // Clear existing children
        while (outgoingGroup.firstChild) {
            outgoingGroup.removeChild(outgoingGroup.firstChild);
        }

        if (item.name === "HTPN") {
            let j = 0;
            ["R", "Y", "B"].forEach(phase => {
                for (let i = 1; i <= way; i++) {
                    const rating = item.outgoing[j]?.["Current Rating"] || "";
                    const newGroup = createOutgoingGroup(doc, `${phase}${i}`, rating);
                    newGroup.setAttribute("transform", `translate(${40 + j * 44}, ${OUTGOING_Y})`);
                    outgoingGroup.appendChild(newGroup);
                    j++;
                }
            });
        } else if (item.name === "VTPN") {
            for (let i = 1; i <= way; i++) {
                const rating = item.outgoing[i - 1]?.["Current Rating"] || "";
                const newGroup = createOutgoingGroup(doc, `OG${i}`, rating, "TP", 0, 12, VTPN_LABEL_X);
                newGroup.setAttribute("transform", `translate(${40 + (i - 1) * 52}, ${OUTGOING_Y})`);
                outgoingGroup.appendChild(newGroup);
            }
        } else if (item.name === "SPN DB") {
            for (let i = 1; i <= way; i++) {
                const rating = item.outgoing[i - 1]?.["Current Rating"] || "";
                const newGroup = createOutgoingGroup(doc, `OG${i}`, rating, "SP", SPN_SYM_SHIFT, SPN_LEAN);
                newGroup.setAttribute("transform", `translate(${40 + (i - 1) * 44}, ${OUTGOING_Y})`);
                outgoingGroup.appendChild(newGroup);
            }
        }
        modified = true;
    } else {
        console.warn(`[SvgUpdater] Element '#outgoing-group' not found.`);
    }

    return modified;
};

const createOutgoingGroup = (doc: Document, id: string, rating: string, pole: string = "SP", shiftX: number = 0, lean: number = 12, labelX: number = -28): SVGElement => {
    const ns = "http://www.w3.org/2000/svg";
    const group = doc.createElementNS(ns, "g");
    group.setAttribute("id", id);

    // Lines (top lead -45 keeps a 1px gap: OUTGOING_Y - 45 = BUSBAR_Y + 1.
    // shiftX moves the symbol right; labels below stay put)
    const line1 = doc.createElementNS(ns, "line");
    line1.setAttribute("x1", shiftX.toString()); line1.setAttribute("y1", "-45");
    line1.setAttribute("x2", shiftX.toString()); line1.setAttribute("y2", "-20");
    line1.setAttribute("stroke", "black"); line1.setAttribute("stroke-width", "3");
    group.appendChild(line1);

    const line2 = doc.createElementNS(ns, "line");
    line2.setAttribute("x1", (lean + shiftX).toString()); line2.setAttribute("y1", "-18");
    line2.setAttribute("x2", shiftX.toString()); line2.setAttribute("y2", "0");
    line2.setAttribute("stroke", "black"); line2.setAttribute("stroke-width", "3");
    group.appendChild(line2);

    const line3 = doc.createElementNS(ns, "line");
    line3.setAttribute("x1", shiftX.toString()); line3.setAttribute("y1", "-2");
    line3.setAttribute("x2", shiftX.toString()); line3.setAttribute("y2", "32");
    line3.setAttribute("stroke", "black"); line3.setAttribute("stroke-width", "3");
    group.appendChild(line3);

    // Texts (font sizes unchanged; labelX clears the previous tick/diagonal
    // at the compact 44/52px pitch without touching its own tick)
    const createText = (text: string, y: string) => {
        const t = doc.createElementNS(ns, "text");
        t.textContent = text;
        t.setAttribute("x", labelX.toString());
        t.setAttribute("y", y);
        t.setAttribute("font-size", "11"); // Or 12 based on C#
        t.setAttribute("font-family", "Arial");
        t.setAttribute("fill", "black");
        return t;
    };

    group.appendChild(createText(id, "-34"));
    group.appendChild(createText(rating, "-22"));
    group.appendChild(createText(pole, "-9"));
    group.appendChild(createText("MCB", "4"));

    return group;
};

import { PanelRenderer } from './PanelRenderer';

// ...

const updateCubiclePanelVisuals = (doc: Document, item: CanvasItem): boolean => {
    const newSvgString = PanelRenderer.generateSvg(item);
    // Parse the new SVG and replace the document content
    const parser = new DOMParser();
    const newDoc = parser.parseFromString(newSvgString, "image/svg+xml");

    // Replace the root element attributes and content
    const oldRoot = doc.documentElement;
    const newRoot = newDoc.documentElement;

    // Copy attributes
    for (let i = 0; i < newRoot.attributes.length; i++) {
        const attr = newRoot.attributes[i];
        oldRoot.setAttribute(attr.name, attr.value);
    }

    // Replace content
    while (oldRoot.firstChild) {
        oldRoot.removeChild(oldRoot.firstChild);
    }
    while (newRoot.firstChild) {
        oldRoot.appendChild(newRoot.firstChild);
    }

    return true;
};

const updateSourceVisuals = (doc: Document, item: CanvasItem): boolean => {
    let modified = false;

    // Update Type (3-phase or 1-phase text)
    const type = item.properties[0]?.["Type"];
    if (type) {
        // The Source SVG has a text element with id="Rating" that shows "3-phase" or "1-phase"
        const phaseTexts = doc.querySelectorAll('text');
        phaseTexts.forEach(el => {
            if (el.textContent === "3-phase" || el.textContent === "1-phase") {
                el.textContent = type;
                modified = true;
            }
        });
    }

    // Update Capacity if provided
    const capacity = item.properties[0]?.["Capacity"];
    if (capacity) {
        const el = doc.getElementById("text1");
        if (el) {
            el.textContent = capacity;
            modified = true;
        }
    }

    return modified;
};

const updateBusbarChamberVisuals = (doc: Document, item: CanvasItem): boolean => {
    // We will generate a fresh SVG string based on geometry
    const properties = item.properties[0] || {};
    const lengthStr = properties["Length"] || "1";
    const length = parseFloat(lengthStr);
    const validLength = isNaN(length) ? 1 : length;
    const count = Math.max(1, Math.floor(validLength * 6));
    const spacing = 60;
    const margin = 30;
    const width = margin * 2 + (count - 1) * spacing;
    const height = 150;

    // Create new SVG structure
    const ns = "http://www.w3.org/2000/svg";
    const newDoc = document.implementation.createDocument(ns, "svg", null);
    const svg = newDoc.documentElement;
    svg.setAttribute("width", width.toString());
    svg.setAttribute("height", height.toString());
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("xmlns", ns);

    // Chamber Box
    const rect = newDoc.createElementNS(ns, "rect");
    rect.setAttribute("x", "5"); rect.setAttribute("y", "5");
    rect.setAttribute("width", (width - 10).toString());
    rect.setAttribute("height", (height - 10).toString());
    rect.setAttribute("rx", "5");
    rect.setAttribute("fill", "transparent");
    rect.setAttribute("stroke", "#333");
    rect.setAttribute("stroke-width", "2");
    svg.appendChild(rect);

    const bars = properties["Bars"] || "4"; // Default 4
    const isSinglePhase = bars === "2";

    // Busbars (R, Y, B, N) or (P, N)
    const phases = isSinglePhase
        ? ["black", "blue"] // P, N
        : ["red", "yellow", "blue", "black"]; // R, Y, B, N

    // For single phase we might want fewer bars visually?
    // Let's stick to 4 lines for 3-phase, 2 lines for 1-phase
    const barSpacing = isSinglePhase ? 40 : 20;

    const startY = 40;

    phases.forEach((color, idx) => {
        const line = newDoc.createElementNS(ns, "line");
        line.setAttribute("x1", "15");
        line.setAttribute("y1", (startY + idx * barSpacing).toString());
        line.setAttribute("x2", (width - 15).toString());
        line.setAttribute("y2", (startY + idx * barSpacing).toString());
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "4");
        svg.appendChild(line);
    });

    // Label
    const text = newDoc.createElementNS(ns, "text");
    text.textContent = `Busbar Chamber (${validLength}m) - ${bars} Bars`;
    text.setAttribute("x", (width / 2).toString());
    text.setAttribute("y", "25");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "12");
    text.setAttribute("font-family", "Arial");
    text.setAttribute("font-weight", "bold");
    svg.appendChild(text);

    // Connection Points Indicators
    // In (Top)
    const inCircle = newDoc.createElementNS(ns, "circle");
    inCircle.setAttribute("cx", (width / 2).toString());
    inCircle.setAttribute("cy", "5");
    inCircle.setAttribute("r", "4");
    inCircle.setAttribute("fill", "blue");
    svg.appendChild(inCircle);

    // Out (Bottom)
    const outgoing = item.outgoing || [];
    const defaultPhases = ["R", "Y", "B"];

    for (let i = 0; i < count; i++) {
        const x = margin + i * spacing;
        let pColor = "green"; // Default

        if (!isSinglePhase) {
            const phase = outgoing[i]?.["Phase"] || defaultPhases[i % 3];
            if (phase === "R") pColor = "red";
            else if (phase === "Y") pColor = "gold"; // Match standard yellow
            else if (phase === "B") pColor = "blue";
            else if (phase === "ALL") pColor = "purple"; // Multi phase
        } else {
            pColor = "black"; // Single phase
        }

        const outCircle = newDoc.createElementNS(ns, "circle");
        outCircle.setAttribute("cx", x.toString());
        outCircle.setAttribute("cy", (height - 5).toString());
        outCircle.setAttribute("r", "4");
        outCircle.setAttribute("fill", pColor);
        svg.appendChild(outCircle);

        const outLabel = newDoc.createElementNS(ns, "text");
        outLabel.textContent = `O${i + 1}`;
        outLabel.setAttribute("x", x.toString());
        outLabel.setAttribute("y", (height - 15).toString());
        outLabel.setAttribute("text-anchor", "middle");
        outLabel.setAttribute("font-size", "10");
        svg.appendChild(outLabel);

        // Add Phase Label for 4-bar
        if (!isSinglePhase) {
            const phase = outgoing[i]?.["Phase"] || defaultPhases[i % 3];
            const pLabel = newDoc.createElementNS(ns, "text");
            pLabel.textContent = phase;
            pLabel.setAttribute("x", x.toString());
            pLabel.setAttribute("y", (height - 25).toString()); // Above O1 label
            pLabel.setAttribute("text-anchor", "middle");
            pLabel.setAttribute("font-size", "9");
            pLabel.setAttribute("font-weight", "bold");
            pLabel.setAttribute("fill", pColor);
            svg.appendChild(pLabel);
        }
    }

    // Serialize
    const newSvgString = new XMLSerializer().serializeToString(newDoc);

    // Replace old content logic
    // SvgUpdater expects 'doc' to be modified.

    const oldRoot = doc.documentElement;
    const parser = new DOMParser();
    const finalDoc = parser.parseFromString(newSvgString, "image/svg+xml");
    const finalRoot = finalDoc.documentElement;

    while (oldRoot.firstChild) oldRoot.removeChild(oldRoot.firstChild);
    // Copy attributes
    for (let i = 0; i < finalRoot.attributes.length; i++) {
        oldRoot.setAttribute(finalRoot.attributes[i].name, finalRoot.attributes[i].value);
    }
    // Copy children
    while (finalRoot.firstChild) oldRoot.appendChild(finalRoot.firstChild);

    return true;
};
