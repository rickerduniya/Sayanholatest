import { CanvasItem } from '../types';

export class PanelRenderer {

    static generateSvg(item: CanvasItem): string {
        const properties = item.properties?.[0] || {};
        const outgoings = item.outgoing || [];

        // --- 1. CONFIGURATION & DIMENSIONS ---

        const rawCount = parseInt(properties["Incomer Count"] || "1", 10);
        const incomerCount = isNaN(rawCount) ? 1 : Math.max(rawCount, 1);

        // Layout Constants
        const margin = 5;
        const topSpace = 180; // Increased height for complex routing
        const busbarY = margin + topSpace;
        const busbarHeight = 10;
        const outgoingLength = 90; // Increased from 60
        const bottomLabelSpace = 45; // Increased from 35
        const outgoingSpacing = 65;
        const minSectionWidth = 140;
        const couplerWidth = 80;

        // --- 2. CALCULATE SECTION WIDTHS ---
        const sectionWidths: number[] = [];
        for (let i = 1; i <= incomerCount; i++) {
            sectionWidths.push(minSectionWidth);
        }

        for (let i = 1; i <= incomerCount; i++) {
            const isChangeOverNext = i < incomerCount && (properties[`BusCoupler${i}_Type`] === "Change Over Switch Open" || properties[`BusCoupler${i}_Type`] === "Change Over Switch");
            if (isChangeOverNext) {
                const combinedOutgoings = outgoings.filter((o: any) => o["Section"] === i.toString() || o["Section"] === (i + 1).toString());
                const combinedCount = Math.max(combinedOutgoings.length, 1);

                // Shared bus segment spans both sections, so size the pair using the combined outgoing count.
                const requiredSectionsWidth = Math.max(minSectionWidth * 2, combinedCount * outgoingSpacing);
                const perSectionWidth = Math.max(minSectionWidth, requiredSectionsWidth / 2);

                sectionWidths[i - 1] = perSectionWidth;
                sectionWidths[i] = perSectionWidth;
                i++; // skip next section (part of the pair)
                continue;
            }

            const sectionOutgoings = outgoings.filter((o: any) => o["Section"] === i.toString());
            const outCount = Math.max(sectionOutgoings.length, 1);
            let width = outCount * outgoingSpacing;
            if (width < minSectionWidth) width = minSectionWidth;
            sectionWidths[i - 1] = width;
        }

        // Total Dimensions
        let totalWidth = margin * 2;
        sectionWidths.forEach((w, i) => {
            totalWidth += w;
            if (i < sectionWidths.length - 1) totalWidth += couplerWidth;
        });

        const totalHeight = margin + topSpace + busbarHeight + outgoingLength + bottomLabelSpace + margin;

        // --- 3. START SVG GENERATION ---
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">`;

        // Define Styles/Defs
        const redDot = `<circle r="4" fill="#FF0000" stroke="none"/>`;
        const greenDot = `<circle r="4" fill="#00FF00" stroke="none"/>`;

        // Outer Border
        svg += `<rect id="border" x="${margin}" y="${margin}" width="${totalWidth - margin * 2}" height="${totalHeight - margin * 2}" fill="none" stroke="#000" stroke-width="2"/>`;

        // --- 4. RENDER SECTIONS ---
        let currentX = margin;

        for (let sec = 1; sec <= incomerCount; sec++) {
            const isChangeOverNext = sec < incomerCount && (properties[`BusCoupler${sec}_Type`] === "Change Over Switch Open" || properties[`BusCoupler${sec}_Type`] === "Change Over Switch");

            if (isChangeOverNext) {
                // --- RENDER CHANGE OVER SWITCH (Stepped Paths) ---
                const sec1Width = sectionWidths[sec - 1];
                const sec2Width = sectionWidths[sec];
                const totalBlockWidth = sec1Width + couplerWidth + sec2Width;
                const blockCenterX = currentX + totalBlockWidth / 2;

                const sec1Center = currentX + sec1Width / 2;
                const sec2Center = currentX + sec1Width + couplerWidth + sec2Width / 2;

                const incomerYStart = margin + 15;
                const switchBoxTopY = busbarY - 80;
                const switchBoxHeight = 70;
                const switchBoxY = switchBoxTopY;

                // Route Calculation
                // Drop down, switch, drop more, horizontal In, drop into box
                const switchSymbolTop = incomerYStart + 25;
                const switchSymbolBottom = switchSymbolTop + 20;
                const horizontalLegY = switchBoxTopY - 20; // The horizontal merging line height

                // Helper to draw Incomer Leg
                const drawIncomerLeg = (centerX: number, secIndex: number, isRight: boolean) => {
                    // 1. Connection Dot
                    svg += redDot.replace('cx="0" cy="0"', `cx="${centerX}" cy="${incomerYStart}"`).replace('r="4"', 'r="3"').replace('cx=""', `cx="${centerX}" cy="${incomerYStart}"`);

                    // 2. Vertical Line to Switch
                    svg += `<line x1="${centerX}" y1="${incomerYStart}" x2="${centerX}" y2="${switchSymbolTop}" stroke="#000" stroke-width="2.5"/>`;

                    // 3. Switch Symbol (Standard Open Switch)
                    // Left vertical stub
                    svg += `<line x1="${centerX}" y1="${switchSymbolTop}" x2="${centerX}" y2="${switchSymbolTop + 5}" stroke="#000" stroke-width="2.5"/>`;
                    // Blade (Angled open)
                    svg += `<line x1="${centerX}" y1="${switchSymbolTop + 5}" x2="${centerX + 8}" y2="${switchSymbolBottom - 5}" stroke="#000" stroke-width="2"/>`;
                    // Right vertical stub (continuation)
                    svg += `<line x1="${centerX}" y1="${switchSymbolBottom - 5}" x2="${centerX}" y2="${switchSymbolBottom}" stroke="#000" stroke-width="2.5"/>`;

                    // 4. Vertical Line to Horizontal Turn
                    svg += `<line x1="${centerX}" y1="${switchSymbolBottom}" x2="${centerX}" y2="${horizontalLegY}" stroke="#000" stroke-width="2.5"/>`;

                    // 5. Horizontal Line to Center Inputs
                    // Target X for box entry. Box width ~50, so entry points at +/- 15 from center.
                    const entryX = isRight ? blockCenterX + 15 : blockCenterX - 15;
                    svg += `<line x1="${centerX}" y1="${horizontalLegY}" x2="${entryX}" y2="${horizontalLegY}" stroke="#000" stroke-width="2.5"/>`;

                    // 6. Vertical Drop into Box
                    svg += `<line x1="${entryX}" y1="${horizontalLegY}" x2="${entryX}" y2="${switchBoxTopY}" stroke="#000" stroke-width="2.5"/>`;

                    // Labels - Standardized to match Normal Mode
                    // Always on the right side
                    const labelX = centerX + 16;
                    const rate = properties[`Incomer${secIndex}_Rating`];
                    const type = properties[`Incomer${secIndex}_Type`];

                    if (rate) {
                        svg += `<text x="${labelX}" y="${incomerYStart + 18}" font-family="Arial" font-size="12" fill="#000" font-weight="bold">${rate}</text>`;
                        if (type) {
                            // Fix: Add default for SFU
                            const pole = properties[`Incomer${secIndex}_Pole`] || (type === "Main Switch Open" ? "TPN" : "");
                            if (pole) svg += `<text x="${labelX}" y="${incomerYStart + 30}" font-family="Arial" font-size="11" fill="#000">${pole}</text>`;

                            const displayType = type === "Main Switch Open" ? "SFU" : (type === "MCCB" ? "MCCB" : type);
                            svg += `<text x="${labelX}" y="${incomerYStart + 42}" font-family="Arial" font-size="11" fill="#000">${displayType}</text>`;
                        }
                    }
                    svg += `<text x="${centerX + 28}" y="${incomerYStart + 5}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#000">I/C ${secIndex}</text>`;
                };

                // Draw Legs
                drawIncomerLeg(sec1Center, sec, false);
                drawIncomerLeg(sec2Center, sec + 1, true);

                // --- CHANGE OVER SWITCH BOX ---
                // Box Definition
                const boxWidth = 50;
                const boxX = blockCenterX - boxWidth / 2;
                svg += `<rect x="${boxX}" y="${switchBoxY}" width="${boxWidth}" height="${switchBoxHeight}" fill="none" stroke="#000" stroke-width="1.5"/>`;

                // Box Terminals
                const termY = switchBoxY + 10;
                svg += `<circle cx="${blockCenterX - 15}" cy="${termY}" r="2" fill="#000"/>`;
                svg += `<circle cx="${blockCenterX + 15}" cy="${termY}" r="2" fill="#000"/>`;
                const commonY = switchBoxY + switchBoxHeight - 10;
                svg += `<circle cx="${blockCenterX}" cy="${commonY}" r="2" fill="#000"/>`;

                // Internal Switch Blade
                svg += `<line x1="${blockCenterX}" y1="${commonY}" x2="${blockCenterX - 12}" y2="${termY + 5}" stroke="#000" stroke-width="2"/>`;

                // Vertical Text Labels (Rotated -90deg)
                // Adjust positions inside box to be clearer. Width is 50. Center is blockCenterX. Left edge is blockCenterX - 25.
                // Move text to blockCenterX - 15 and blockCenterX + 15
                svg += `<text x="${blockCenterX - 12}" y="${switchBoxY + 45}" text-anchor="middle" font-family="Arial" font-size="10" font-weight="bold" fill="#000" transform="rotate(-90 ${blockCenterX - 12},${switchBoxY + 50})">C/O 415V</text>`;
                

                const coRating = properties[`BusCoupler${sec}_Rating`] || "";
                if (coRating)
                    svg += `<text x="${blockCenterX + 12}" y="${switchBoxY + 45}" text-anchor="middle" font-family="Arial" font-size="10" fill="#000" transform="rotate(-90 ${blockCenterX + 12},${switchBoxY + 60})">${coRating}</text>`;


                // Connection to Busbar
                svg += `<line x1="${blockCenterX}" y1="${switchBoxY + switchBoxHeight}" x2="${blockCenterX}" y2="${busbarY}" stroke="#000" stroke-width="2.5"/>`;

                // --- BUSBAR ---
                const busbarStartX = currentX + 5;
                const busbarEndX = currentX + totalBlockWidth - 5;
                svg += `<rect x="${busbarStartX}" y="${busbarY}" width="${busbarEndX - busbarStartX}" height="${busbarHeight}" fill="#fff" stroke="#000" stroke-width="2"/>`;

                const busbarMaterial = properties["Busbar Material"] || "Aluminium";
                svg += `<text x="${margin + 6}" y="${incomerYStart}" text-anchor="left" font-family="Arial" font-size="14" fill="#000" font-weight="bold">Cubicle Panel</text>`;
                svg += `<text x="${margin + 6}" y="${busbarY - 22}" text-anchor="left" font-family="Arial" font-size="14" fill="#000" font-weight="bold">${busbarMaterial}</text>`;
                svg += `<text x="${margin + 6}" y="${busbarY - 7}" text-anchor="left" font-family="Arial" font-size="14" fill="#000" font-weight="bold">Busbar</text>`;


                // --- OUTGOINGS (shared bus for both sections) ---
                const sec1Outgoings = outgoings.filter((o: any) => o["Section"] === sec.toString());
                const sec2Outgoings = outgoings.filter((o: any) => o["Section"] === (sec + 1).toString());
                const combinedOutgoings = [...sec1Outgoings, ...sec2Outgoings];

                const renderOutgoingsInline = (outgoingList: any[], startOutX: number) => {
                    outgoingList.forEach((out: any, idx: number) => {
                        const ox = startOutX + idx * outgoingSpacing;
                        svg += `<line x1="${ox}" y1="${busbarY + busbarHeight}" x2="${ox}" y2="${busbarY + busbarHeight + 20}" stroke="#000" stroke-width="2.5"/>`;
                        svg += `<line x1="${ox}" y1="${busbarY + busbarHeight + 40}" x2="${ox + 10}" y2="${busbarY + busbarHeight + 20}" stroke="#000" stroke-width="2.5"/>`;
                        svg += `<line x1="${ox}" y1="${busbarY + busbarHeight + 40}" x2="${ox}" y2="${totalHeight - margin}" stroke="#000" stroke-width="2.5"/>`;

                        const rating = out["Current Rating"] || "";
                        const type = out["Type"] || "";
                        const displayType = type === "Main Switch Open" ? "SFU" : type;
                        // Fix SFU Pole
                        const pole = out["Pole"] || (displayType === "SFU" ? "TPN" : "");
                        const globalIdx = outgoings.findIndex((o: any) => o === out) + 1;

                        svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 20}" text-anchor="end" font-family="Arial" font-size="11" fill="#000" font-weight="bold">OG${globalIdx}</text>`;
                        if (rating) svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 32}" text-anchor="end" font-family="Arial" font-size="10" fill="#000">${rating}</text>`;
                        if (pole) svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 44}" text-anchor="end" font-family="Arial" font-size="10" fill="#000">${pole}</text>`;
                        if (displayType) svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 56}" text-anchor="end" font-family="Arial" font-size="10" fill="#000">${displayType}</text>`;

                        svg += greenDot.replace('cx="0" cy="0"', `cx="${ox}" cy="${totalHeight - margin}"`).replace('r="4"', 'r="3"').replace('cx=""', `cx="${ox}" cy="${totalHeight - margin}"`);
                    });
                };

                const outCount = Math.max(combinedOutgoings.length, 1);
                const totalOutWidth = (outCount - 1) * outgoingSpacing;
                const startOutX = blockCenterX - (totalOutWidth / 2);
                renderOutgoingsInline(combinedOutgoings, startOutX);

                currentX += totalBlockWidth + (sec + 1 < incomerCount ? couplerWidth : 0);
                sec++;

            } else {
                // NORMAL SECTION RENDER (Existing Logic)
                const sectionWidth = sectionWidths[sec - 1];
                const sectionCenter = currentX + sectionWidth / 2;
                const sectionOutgoings = outgoings.filter((o: any) => o["Section"] === sec.toString());

                // A. INCOMER (Top)
                const incomerYStart = margin + 15;
                const incomerType = properties[`Incomer${sec}_Type`];
                const incomerRating = properties[`Incomer${sec}_Rating`];

                const switchTop = incomerYStart + 25;
                const switchBottom = switchTop + 20;

                // 1. Top Line from Margin to Switch
                svg += `<line x1="${sectionCenter}" y1="${margin}" x2="${sectionCenter}" y2="${switchTop}" stroke="#000" stroke-width="2.5"/>`;

                // 2. Switch Symbol (At Top)
                svg += `<line x1="${sectionCenter}" y1="${switchTop}" x2="${sectionCenter}" y2="${switchTop + 5}" stroke="#000" stroke-width="2.5"/>`;
                svg += `<line x1="${sectionCenter}" y1="${switchTop + 5}" x2="${sectionCenter + 8}" y2="${switchBottom - 5}" stroke="#000" stroke-width="2"/>`;
                svg += `<line x1="${sectionCenter}" y1="${switchBottom - 5}" x2="${sectionCenter}" y2="${switchBottom}" stroke="#000" stroke-width="2.5"/>`;

                // 3. Line from Switch to Busbar
                svg += `<line x1="${sectionCenter}" y1="${switchBottom}" x2="${sectionCenter}" y2="${busbarY}" stroke="#000" stroke-width="2.5"/>`;

                if (incomerRating) {
                    // Position Normal Incomer Text
                    // Move slightly right
                    const labelX = sectionCenter + 16;
                    svg += `<text x="${labelX}" y="${incomerYStart + 18}" font-family="Arial" font-size="12" fill="#000" font-weight="bold">${incomerRating}</text>`;
                    if (incomerType) {
                        const pole = properties[`Incomer${sec}_Pole`] || (incomerType === "Main Switch Open" ? "TPN" : "");
                        if (pole) svg += `<text x="${labelX}" y="${incomerYStart + 30}" font-family="Arial" font-size="11" fill="#000">${pole}</text>`;
                        const displayType = incomerType === "Main Switch Open" ? "SFU" : incomerType;
                        svg += `<text x="${labelX}" y="${incomerYStart + 42}" font-family="Arial" font-size="11" fill="#000">${displayType}</text>`;
                    }
                }
                svg += `<text x="${sectionCenter + 28}" y="${incomerYStart + 5}" text-anchor="middle" font-family="Arial" font-size="12" font-weight="bold" fill="#000">I/C ${sec}</text>`;
                svg += redDot.replace('cx="0" cy="0"', `cx="${sectionCenter}" cy="${incomerYStart}"`).replace('r="4"', 'r="3"').replace('cx=""', `cx="${sectionCenter}" cy="${incomerYStart}"`);


                // B. BUSBAR
                const busbarStartX = currentX + 5;
                const busbarEndX = currentX + sectionWidth - 5;
                svg += `<rect x="${busbarStartX}" y="${busbarY}" width="${busbarEndX - busbarStartX}" height="${busbarHeight}" fill="#fff" stroke="#000" stroke-width="2"/>`;

                const busbarMaterial = properties["Busbar Material"] || "Aluminium";
                svg += `<text x="${margin + 6}" y="${incomerYStart + 15}" text-anchor="left" font-family="Arial" font-size="14" fill="#000" font-weight="bold">Cubicle Panel</text>`;
                svg += `<text x="${margin + 6}" y="${busbarY - 22}" text-anchor="left" font-family="Arial" font-size="14" fill="#000" font-weight="bold">${busbarMaterial}</text>`;
                svg += `<text x="${margin + 6}" y="${busbarY - 7}" text-anchor="left" font-family="Arial" font-size="14" fill="#000" font-weight="bold">Busbar</text>`;

                // C. OUTGOINGS
                const outCount = Math.max(sectionOutgoings.length, 1);
                const totalOutWidth = (outCount - 1) * outgoingSpacing;
                const startOutX = sectionCenter - (totalOutWidth / 2);

                sectionOutgoings.forEach((out: any, idx: number) => {
                    const ox = startOutX + idx * outgoingSpacing;

                    // Vertical Line from busbar
                    svg += `<line x1="${ox}" y1="${busbarY + busbarHeight}" x2="${ox}" y2="${busbarY + busbarHeight + 20}" stroke="#000" stroke-width="2.5"/>`;

                    // Switch Symbol (diagonal)
                    svg += `<line x1="${ox}" y1="${busbarY + busbarHeight + 40}" x2="${ox + 10}" y2="${busbarY + busbarHeight + 20}" stroke="#000" stroke-width="2.5"/>`;

                    // Continue line down to connection point
                    svg += `<line x1="${ox}" y1="${busbarY + busbarHeight + 40}" x2="${ox}" y2="${totalHeight - margin}" stroke="#000" stroke-width="2.5"/>`;

                    // Text Labels (to the left)
                    const rating = out["Current Rating"] || "";
                    const type = out["Type"] || "";
                    const displayType = type === "Main Switch Open" ? "SFU" : type;
                    // Fix: Add default for SFU
                    const pole = out["Pole"] || (displayType === "SFU" ? "TPN" : "");

                    const globalIdx = outgoings.findIndex((o: any) => o === out) + 1;
                    svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 20}" text-anchor="end" font-family="Arial" font-size="11" fill="#000" font-weight="bold">OG${globalIdx}</text>`;
                    if (rating) svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 32}" text-anchor="end" font-family="Arial" font-size="10" fill="#000">${rating}</text>`;
                    if (pole) svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 44}" text-anchor="end" font-family="Arial" font-size="10" fill="#000">${pole}</text>`;
                    if (displayType) svg += `<text x="${ox - 6}" y="${busbarY + busbarHeight + 56}" text-anchor="end" font-family="Arial" font-size="10" fill="#000">${displayType}</text>`;

                    // Green Dot for outgoing
                    svg += greenDot.replace('cx="0" cy="0"', `cx="${ox}" cy="${totalHeight - margin}"`).replace('r="4"', 'r="3"').replace('cx=""', `cx="${ox}" cy="${totalHeight - margin}"`);
                });

                // D. NORMAL BUS COUPLER
                if (sec < incomerCount) {
                    const couplerCenterX = currentX + sectionWidth + couplerWidth / 2;
                    const couplerType = properties[`BusCoupler${sec}_Type`] || "";

                    svg += `<text x="${couplerCenterX}" y="${busbarY - 10}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#000">Bus Coupler ${sec}</text>`;

                    const leftBusEnd = currentX + sectionWidth - 5;
                    const rightBusStart = currentX + sectionWidth + couplerWidth + 5;

                    if (couplerType === "None" || couplerType === "Direct") {
                        svg += `<rect x="${leftBusEnd}" y="${busbarY}" width="${rightBusStart - leftBusEnd}" height="10" fill="#fff" stroke="#000" stroke-width="2"/>`;
                        if (couplerType === "Direct") {
                            svg += `<text x="${couplerCenterX}" y="${busbarY + 20}" text-anchor="middle" font-family="Arial" font-size="10" fill="#000">(Direct)</text>`;
                        }
                    } else {
                        const switchGap = 12;
                        const rating = properties[`BusCoupler${sec}_Rating`] || "";
                        const pole = properties[`BusCoupler${sec}_Pole`] || "";

                        svg += `<rect x="${leftBusEnd}" y="${busbarY}" width="15" height="10" fill="#fff" stroke="#000" stroke-width="2"/>`;
                        svg += `<line x1="${leftBusEnd + 15}" y1="${busbarY + 5}" x2="${leftBusEnd + 25}" y2="${busbarY - 5}" stroke="#000" stroke-width="2.5"/>`;
                        svg += `<rect x="${leftBusEnd + 25 + switchGap}" y="${busbarY}" width="${rightBusStart - (leftBusEnd + 25 + switchGap)}" height="10" fill="#fff" stroke="#000" stroke-width="2"/>`;

                        if (rating) svg += `<text x="${couplerCenterX}" y="${busbarY + 22}" text-anchor="middle" font-family="Arial" font-size="10" fill="#000">${rating}</text>`;
                        if (pole) svg += `<text x="${couplerCenterX}" y="${busbarY + 34}" text-anchor="middle" font-family="Arial" font-size="10" fill="#000">${pole}</text>`;
                        const displayType = couplerType === "Main Switch Open" ? "SFU" : couplerType;
                        svg += `<text x="${couplerCenterX}" y="${busbarY + 46}" text-anchor="middle" font-family="Arial" font-size="10" fill="#000">${displayType}</text>`;
                    }
                }

                currentX += sectionWidth + (sec < incomerCount ? couplerWidth : 0);
            }
        }

        svg += '</svg>';
        return svg;
    }
}
