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

    // Calculate Width based on type
    if (item.name === "HTPN") width = 56 * way * 3;
    else if (item.name === "VTPN") width = 70 * way;
    else if (item.name === "SPN DB") width = 60 * way;

    if (width > 0) {
        svg.setAttribute("width", width.toString());
        modified = true;
    }

    // Update Nameplate
    const nameplate = doc.querySelector("#nameplate");
    if (nameplate) {
        let suffix = item.name;
        let displayText = `${wayText} ${suffix}`;
        if (item.name === "VTPN") displayText = `${way} Way VTPN DB`;
        if (item.name === "HTPN") displayText = `${wayText} HTPN DB`;
        if (item.name === "SPN DB") displayText = `${wayText} SPN DB`;
        nameplate.textContent = displayText;
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

    // Update Border Width
    const border = doc.querySelector("#border");
    if (border) {
        let borderWidth = 0;
        if (item.name === "HTPN") borderWidth = 56 * way * 0.99 * 3;
        else if (item.name === "VTPN") borderWidth = 70 * way * 0.99;
        else if (item.name === "SPN DB") borderWidth = 60 * way * 0.98;

        border.setAttribute("width", borderWidth.toString());
        modified = true;
    }

    // Update Incoming Group Position
    const incoming = doc.querySelector("#incoming");
    if (incoming) {
        incoming.setAttribute("transform", `translate(${width / 2}, 50)`);
        modified = true;
    }

    // Update Busbar Length
    const busbar = doc.querySelector("#Busbar");
    if (busbar) {
        let endX = 0;
        if (item.name === "HTPN") endX = (51 + (way - 1) * 55) * 3;
        else if (item.name === "VTPN") endX = 52 + ((way - 1) * 65);
        else if (item.name === "SPN DB") endX = 42 + ((way - 1) * 55);

        busbar.setAttribute("x2", endX.toString());
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
                    newGroup.setAttribute("transform", `translate(${40 + j * 55}, 130)`);
                    outgoingGroup.appendChild(newGroup);
                    j++;
                }
            });
        } else if (item.name === "VTPN") {
            for (let i = 1; i <= way; i++) {
                const rating = item.outgoing[i - 1]?.["Current Rating"] || "";
                const newGroup = createOutgoingGroup(doc, `OG${i}`, rating, "TP");
                newGroup.setAttribute("transform", `translate(${50 + (i - 1) * 65}, 130)`);
                outgoingGroup.appendChild(newGroup);
            }
        } else if (item.name === "SPN DB") {
            for (let i = 1; i <= way; i++) {
                const rating = item.outgoing[i - 1]?.["Current Rating"] || "";
                const newGroup = createOutgoingGroup(doc, `OG${i}`, rating, "SP");
                newGroup.setAttribute("transform", `translate(${40 + (i - 1) * 55}, 130)`);
                outgoingGroup.appendChild(newGroup);
            }
        }
        modified = true;
    } else {
        console.warn(`[SvgUpdater] Element '#outgoing-group' not found.`);
    }

    return modified;
};

const createOutgoingGroup = (doc: Document, id: string, rating: string, pole: string = "SP"): SVGElement => {
    const ns = "http://www.w3.org/2000/svg";
    const group = doc.createElementNS(ns, "g");
    group.setAttribute("id", id);

    // Lines
    const line1 = doc.createElementNS(ns, "line");
    line1.setAttribute("x1", "0"); line1.setAttribute("y1", "-49");
    line1.setAttribute("x2", "0"); line1.setAttribute("y2", "-20");
    line1.setAttribute("stroke", "black"); line1.setAttribute("stroke-width", "3");
    group.appendChild(line1);

    const line2 = doc.createElementNS(ns, "line");
    line2.setAttribute("x1", "12"); line2.setAttribute("y1", "-18");
    line2.setAttribute("x2", "0"); line2.setAttribute("y2", "0");
    line2.setAttribute("stroke", "black"); line2.setAttribute("stroke-width", "3");
    group.appendChild(line2);

    const line3 = doc.createElementNS(ns, "line");
    line3.setAttribute("x1", "0"); line3.setAttribute("y1", "-2");
    line3.setAttribute("x2", "0"); line3.setAttribute("y2", "32");
    line3.setAttribute("stroke", "black"); line3.setAttribute("stroke-width", "3");
    group.appendChild(line3);

    // Texts
    const createText = (text: string, y: string) => {
        const t = doc.createElementNS(ns, "text");
        t.textContent = text;
        t.setAttribute("x", "-35");
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
