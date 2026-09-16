import React, { useState, useEffect } from 'react';
import { X, Save, Copy, Clipboard, Plus } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { PanelRenderer } from '../utils/PanelRenderer';
import { CanvasItem } from '../types';
import { sortOptionStringsAsc } from '../utils/sortUtils';
import { useStore } from '../store/useStore';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { findIncompatibleConnectorsForItem } from '../utils/PhaseCompatibility';

interface PanelDesignerProps {
    isOpen: boolean;
    onClose: () => void;
    item: CanvasItem;
    onSave: (updatedItem: CanvasItem) => void;
    availableDevices: { mccb: any[], acb: any[], sfu: any[], mcb: any[], changeOver?: any[] };
}

export const PanelDesignerDialog: React.FC<PanelDesignerProps> = ({
    isOpen, onClose, item, onSave, availableDevices
}) => {
    const { colors, theme } = useTheme();
    const [localItem, setLocalItem] = useState<CanvasItem>(JSON.parse(JSON.stringify(item)));
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [clipboard, setClipboard] = useState<any[]>([]);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, section: number, index: number | null, type: 'Incomer' | 'Coupler' | 'Outgoing' | 'Background' } | null>(null);

    useEffect(() => {
        if (isOpen) {
            setLocalItem(JSON.parse(JSON.stringify(item)));
            setSelectedIds([]);
        }
    }, [isOpen, item]);

    const properties = localItem.properties[0] || {};
    const incomerCount = Math.max(parseInt(properties["Incomer Count"] || "1", 10), 1);
    const outgoings = localItem.outgoing || [];

    useEffect(() => {
        if (selectedIds.length === 0) return;
        const first = selectedIds[0];
        if (first.startsWith("Incomer:")) {
            const sec = parseInt(first.split(":")[1], 10);
            if (!Number.isFinite(sec) || sec < 1 || sec > incomerCount) setSelectedIds([]);
            return;
        }
        if (first.startsWith("Coupler:")) {
            const sec = parseInt(first.split(":")[1], 10);
            if (!Number.isFinite(sec) || sec < 1 || sec >= incomerCount) setSelectedIds([]);
            return;
        }
        const idx = parseInt(first, 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= outgoings.length) setSelectedIds([]);
    }, [incomerCount, outgoings.length, selectedIds]);

    if (!isOpen) return null;

    // Helper to determine current coupling mode
    // If ANY coupler is "Change Over Switch...", we assume Change Over Mode
    let isChangeOverMode = false;
    for (let i = 1; i < incomerCount; i++) {
        const type = properties[`BusCoupler${i}_Type`];
        if (type && type.includes("Change Over Switch")) {
            isChangeOverMode = true;
            break;
        }
    }

    // Helper to find specific rows in the loaded database data
    const findDeviceRow = (type: string, pole: string, rating: string, company: string) => {
        let dataset: any[] = [];
        const normType = type.toLowerCase().replace(/\s+/g, "");

        if (normType.includes("mccb")) dataset = availableDevices.mccb;
        else if (normType.includes("mcb")) dataset = availableDevices.mcb;
        else if (normType.includes("mainswitch") || normType.includes("sfu")) dataset = availableDevices.sfu;
        else if (normType.includes("changeover")) dataset = availableDevices.changeOver || [];

        return dataset.find((d: any) => {
            let matchesType = true;
            if (d["Item"] === "Main Switch Open") matchesType = d["Type"] === "TPN SFU";
            // For Change Over, explicitly ignore Type column check as it might be 'open execution type'
            else if (d["Item"] === "Change Over Switch Open") matchesType = true;

            const matchesPole = d["Pole"] ? d["Pole"] === pole : true;
            const matchesRating = d["Current Rating"] === rating;
            const matchesCompany = d["Company"] === company;
            return matchesType && matchesPole && matchesRating && matchesCompany;
        });
    };

    // Generic helper to get options based on filters
    const getOptions = (datasetKey: 'mccb' | 'mcb' | 'sfu' | 'changeOver', filters: { pole?: string, rating?: string } = {}) => {
        let data = (availableDevices as any)[datasetKey] || [];

        // Filter for Main Switch Open specific type
        if (datasetKey === 'sfu') {
            data = data.filter((d: any) => d["Type"] === "TPN SFU");
        }

        if (filters.pole) {
            data = data.filter((d: any) => d["Pole"] === filters.pole);
        }
        if (filters.rating) {
            data = data.filter((d: any) => d["Current Rating"] === filters.rating);
        }
        return data;
    };

    // Get unique values for dropdowns
    const getUniqueValues = (data: any[], key: string) => {
        const values = data
            .map(d => d?.[key])
            .filter(v => v !== undefined && v !== null && `${v}` !== '')
            .map(v => `${v}`);
        return sortOptionStringsAsc(Array.from(new Set(values)));
    };

    const getDatasetKeyFromType = (type: string): 'mccb' | 'mcb' | 'sfu' | 'changeOver' | null => {
        const normType = (type || '').toLowerCase().replace(/\s+/g, "");
        if (normType.includes("mccb")) return 'mccb';
        if (normType.includes("mcb")) return 'mcb';
        if (normType.includes("mainswitch") || normType.includes("sfu")) return 'sfu';
        if (normType.includes("changeover")) return 'changeOver';
        return null;
    };

    const getEffectiveType = (type: string, isCoupler: boolean) => {
        if (isCoupler && isChangeOverMode) return "Change Over Switch Open";
        return type || "";
    };

    const getEffectivePole = (type: string, pole: string) => {
        if (type === "Change Over Switch Open") return pole || "FP";
        if (type === "Main Switch Open") return pole || "TPN";
        return pole || "";
    };

    const getValidPoles = (type: string, opts: { isOutgoing: boolean } = { isOutgoing: false }) => {
        const datasetKey = getDatasetKeyFromType(type);
        if (!datasetKey) return [] as string[];

        let poles = getUniqueValues(getOptions(datasetKey), "Pole");
        if (type === "Main Switch Open" && poles.length === 0) poles.push("TPN");
        if (type === "Change Over Switch Open") poles = ["FP"];
        if (opts.isOutgoing && type === "MCB") {
            poles = poles.filter(p => p !== "SP");
        }
        return poles;
    };

    const getValidRatings = (type: string, pole: string) => {
        const datasetKey = getDatasetKeyFromType(type);
        if (!datasetKey) return [] as string[];
        const effectivePole = getEffectivePole(type, pole);
        const filterPole = (type === "Main Switch Open" || type === "Change Over Switch Open") ? undefined : effectivePole || undefined;
        return getUniqueValues(getOptions(datasetKey, { pole: filterPole }), "Current Rating");
    };

    const getValidCompanies = (type: string, pole: string, rating: string) => {
        const datasetKey = getDatasetKeyFromType(type);
        if (!datasetKey) return [] as string[];
        const effectivePole = getEffectivePole(type, pole);
        const filterPole = (type === "Main Switch Open" || type === "Change Over Switch Open") ? undefined : effectivePole || undefined;
        return getUniqueValues(getOptions(datasetKey, { pole: filterPole, rating: rating || undefined }), "Company");
    };

    const handleUpdateProperty = (key: string, value: string) => {
        const newProps = { ...properties, [key]: value };
        if (key === "Incomer Count") {
            const prevCountRaw = parseInt(properties["Incomer Count"] || "1", 10);
            const prevCount = Number.isFinite(prevCountRaw) ? Math.max(prevCountRaw, 1) : 1;
            const nextCountRaw = parseInt(value || "1", 10);
            const nextCount = Number.isFinite(nextCountRaw) ? Math.max(nextCountRaw, 1) : 1;

            if (nextCount < prevCount) {
                const nextOutgoings = (localItem.outgoing || []).filter((o: any) => {
                    const secRaw = parseInt((o?.["Section"] || "").toString(), 10);
                    if (!Number.isFinite(secRaw)) return true;
                    return secRaw >= 1 && secRaw <= nextCount;
                });
                setLocalItem({ ...localItem, properties: [newProps], outgoing: nextOutgoings });
                return;
            }
        }

        setLocalItem({ ...localItem, properties: [newProps] });
    };

    const handleSystemModeChange = (mode: "BusCoupler" | "ChangeOver") => {
        const newProps = { ...properties };

        // Loop through all potential couplers and set type appropriately
        // Max incomers is usually 3, so couplers at 1 and 2
        for (let i = 1; i < incomerCount; i++) {
            if (mode === "ChangeOver") {
                newProps[`BusCoupler${i}_Type`] = "Change Over Switch Open";
                newProps[`BusCoupler${i}_Pole`] = "FP"; // Default to FP
                newProps[`BusCoupler${i}_Rating`] = "";
                newProps[`BusCoupler${i}_Company`] = "";
            } else {
                newProps[`BusCoupler${i}_Type`] = ""; // Reset to empty/select
                newProps[`BusCoupler${i}_Pole`] = "";
                newProps[`BusCoupler${i}_Rating`] = "";
                newProps[`BusCoupler${i}_Company`] = "";
            }
        }
        setLocalItem({ ...localItem, properties: [newProps] });
    }

    const handleUpdateIncomer = (section: string, field: string, value: string) => {
        const prefix = `Incomer${section}_`;
        let newProps = { ...properties, [prefix + field]: value };

        const type = getEffectiveType(newProps[prefix + 'Type'], false);
        const datasetKey = getDatasetKeyFromType(type);

        if (!datasetKey || !type) {
            newProps[prefix + 'Pole'] = "";
            newProps[prefix + 'Rating'] = "";
            newProps[prefix + 'Company'] = "";
            newProps[prefix + 'Rate'] = "";
            newProps[prefix + 'Description'] = "";
            newProps[prefix + 'GS'] = "";
            setLocalItem({ ...localItem, properties: [newProps] });
            return;
        }

        const poles = getValidPoles(type);
        const currentPole = newProps[prefix + 'Pole'] || "";
        let nextPole = currentPole;
        if (type === "Main Switch Open") nextPole = currentPole || "TPN";
        if (type === "Change Over Switch Open") nextPole = currentPole || "FP";
        if (poles.length > 0 && nextPole && !poles.includes(nextPole)) nextPole = "";
        if (type === "Main Switch Open" && poles.length > 0 && !nextPole && poles.includes("TPN")) nextPole = "TPN";
        if (type === "Change Over Switch Open") nextPole = "FP";
        newProps[prefix + 'Pole'] = nextPole;

        const currentRating = newProps[prefix + 'Rating'] || "";
        const validRatings = getValidRatings(type, nextPole);
        let nextRating = currentRating;
        if (nextRating && validRatings.length > 0 && !validRatings.includes(nextRating)) nextRating = "";
        newProps[prefix + 'Rating'] = nextRating;

        const currentCompany = newProps[prefix + 'Company'] || "";
        const validCompanies = getValidCompanies(type, nextPole, nextRating);
        let nextCompany = currentCompany;
        if (nextCompany && validCompanies.length > 0 && !validCompanies.includes(nextCompany)) nextCompany = "";
        newProps[prefix + 'Company'] = nextCompany;

        const hasFullSelection = !!type && !!nextRating && !!nextCompany && ((type === "Main Switch Open" || type === "Change Over Switch Open") ? true : !!getEffectivePole(type, nextPole));
        if (hasFullSelection) {
            const row = findDeviceRow(type, getEffectivePole(type, nextPole), nextRating, nextCompany);
            if (row) {
                newProps[prefix + 'Rate'] = row['Rate'];
                newProps[prefix + 'Description'] = row['Description'];
                newProps[prefix + 'GS'] = row['GS'];
            } else {
                newProps[prefix + 'Rate'] = "";
                newProps[prefix + 'Description'] = "";
                newProps[prefix + 'GS'] = "";
            }
        } else {
            newProps[prefix + 'Rate'] = "";
            newProps[prefix + 'Description'] = "";
            newProps[prefix + 'GS'] = "";
        }

        setLocalItem({ ...localItem, properties: [newProps] });
    };

    const handleUpdateCoupler = (section: string, field: string, value: string) => {
        // If in C/O mode, disallow Type change? Or allow rating change?
        // Requirement implies type is fixed for C/O mode.

        const prefix = `BusCoupler${section}_`;
        let newProps = { ...properties, [prefix + field]: value };

        if (field === 'Current Rating') {
            newProps[prefix + 'Rating'] = value;
        }

        const type = getEffectiveType(newProps[prefix + 'Type'], true);
        const datasetKey = getDatasetKeyFromType(type);

        if (!datasetKey || !type) {
            newProps[prefix + 'Pole'] = "";
            newProps[prefix + 'Rating'] = "";
            newProps[prefix + 'Company'] = "";
            newProps[prefix + 'Rate'] = "";
            newProps[prefix + 'Description'] = "";
            newProps[prefix + 'GS'] = "";
            newProps[prefix + 'Type'] = type;
            setLocalItem({ ...localItem, properties: [newProps] });
            return;
        }

        newProps[prefix + 'Type'] = type;

        const poles = getValidPoles(type);
        const currentPole = newProps[prefix + 'Pole'] || "";
        let nextPole = currentPole;
        if (type === "Main Switch Open") nextPole = currentPole || "TPN";
        if (type === "Change Over Switch Open") nextPole = currentPole || "FP";
        if (poles.length > 0 && nextPole && !poles.includes(nextPole)) nextPole = "";
        if (type === "Main Switch Open" && poles.length > 0 && !nextPole && poles.includes("TPN")) nextPole = "TPN";
        if (type === "Change Over Switch Open") nextPole = "FP";
        newProps[prefix + 'Pole'] = nextPole;

        const currentRating = newProps[prefix + 'Rating'] || "";
        const validRatings = getValidRatings(type, nextPole);
        let nextRating = currentRating;
        if (nextRating && validRatings.length > 0 && !validRatings.includes(nextRating)) nextRating = "";
        newProps[prefix + 'Rating'] = nextRating;

        const currentCompany = newProps[prefix + 'Company'] || "";
        const validCompanies = getValidCompanies(type, nextPole, nextRating);
        let nextCompany = currentCompany;
        if (nextCompany && validCompanies.length > 0 && !validCompanies.includes(nextCompany)) nextCompany = "";
        newProps[prefix + 'Company'] = nextCompany;

        const hasFullSelection = !!type && !!nextRating && !!nextCompany && ((type === "Main Switch Open" || type === "Change Over Switch Open") ? true : !!getEffectivePole(type, nextPole));
        if (hasFullSelection) {
            const row = findDeviceRow(type, getEffectivePole(type, nextPole), nextRating, nextCompany);
            if (row) {
                newProps[prefix + 'Rate'] = row['Rate'];
                newProps[prefix + 'Description'] = row['Description'];
                newProps[prefix + 'GS'] = row['GS'];
            } else {
                newProps[prefix + 'Rate'] = "";
                newProps[prefix + 'Description'] = "";
                newProps[prefix + 'GS'] = "";
            }
        } else {
            newProps[prefix + 'Rate'] = "";
            newProps[prefix + 'Description'] = "";
            newProps[prefix + 'GS'] = "";
        }

        setLocalItem({ ...localItem, properties: [newProps] });
    };

    const handleUpdateOutgoing = (index: number, field: string, value: string) => {
        const newOut = [...outgoings];
        const item = { ...newOut[index] };
        item[field] = value;

        const type = getEffectiveType(item['Type'], false);
        const datasetKey = getDatasetKeyFromType(type);

        if (!datasetKey || !type) {
            item['Pole'] = "";
            item['Current Rating'] = "";
            item['Company'] = "";
            item['Rate'] = "";
            item['Description'] = "";
            item['GS'] = "";
        } else {
            const poles = getValidPoles(type, { isOutgoing: true });
            const currentPole = item['Pole'] || "";
            let nextPole = currentPole;
            if (type === "Main Switch Open") nextPole = currentPole || "TPN";
            if (type === "Change Over Switch Open") nextPole = currentPole || "FP";
            if (poles.length > 0 && nextPole && !poles.includes(nextPole)) nextPole = "";
            if (type === "Main Switch Open" && poles.length > 0 && !nextPole && poles.includes("TPN")) nextPole = "TPN";
            if (type === "Change Over Switch Open") nextPole = "FP";
            item['Pole'] = nextPole;

            const currentRating = item['Current Rating'] || "";
            const validRatings = getValidRatings(type, nextPole);
            let nextRating = currentRating;
            if (nextRating && validRatings.length > 0 && !validRatings.includes(nextRating)) nextRating = "";
            item['Current Rating'] = nextRating;

            const currentCompany = item['Company'] || "";
            const validCompanies = getValidCompanies(type, nextPole, nextRating);
            let nextCompany = currentCompany;
            if (nextCompany && validCompanies.length > 0 && !validCompanies.includes(nextCompany)) nextCompany = "";
            item['Company'] = nextCompany;

            const hasFullSelection = !!type && !!nextRating && !!nextCompany && ((type === "Main Switch Open" || type === "Change Over Switch Open") ? true : !!getEffectivePole(type, nextPole));
            if (hasFullSelection) {
                const row = findDeviceRow(type, getEffectivePole(type, nextPole), nextRating, nextCompany);
                if (row) {
                    item['Rate'] = row['Rate'];
                    item['Description'] = row['Description'];
                    item['GS'] = row['GS'];
                } else {
                    item['Rate'] = "";
                    item['Description'] = "";
                    item['GS'] = "";
                }
            } else {
                item['Rate'] = "";
                item['Description'] = "";
                item['GS'] = "";
            }
        }

        newOut[index] = item;
        setLocalItem({ ...localItem, outgoing: newOut });
    };


    const handleAddOutgoing = (section: string) => {
        const newOut = [...outgoings, {
            "Section": section,
            "Type": "", // Default
            "Pole": "",
            "Current Rating": "",
            "Company": "",
            "Rate": "",
            "Description": "",
            "GS": "",
            "Phase": ""
        }];
        setLocalItem({ ...localItem, outgoing: newOut });
    };

    const handleDeleteSelected = () => {
        if (selectedIds[0]?.startsWith("Incomer")) {
            const section = parseInt(selectedIds[0].split(":")[1]);
            if (incomerCount <= 1) {
                alert("Cannot delete the last incomer. At least one is required.");
                return;
            }
            handleUpdateProperty("Incomer Count", (incomerCount - 1).toString());
            // Remove incomer properties for this section to clean up
            const newProps = { ...properties };
            Object.keys(newProps).forEach(k => {
                if (k.startsWith(`Incomer${section}_`)) delete newProps[k];
            });

            const newOut = outgoings.filter((o: any) => o["Section"] !== section.toString());
            setLocalItem({ ...localItem, properties: [newProps], outgoing: newOut });
            setSelectedIds([]);
        } else {
            const newOut = outgoings.filter((_, idx) => !selectedIds.includes(idx.toString()));
            setLocalItem({ ...localItem, outgoing: newOut });
            setSelectedIds([]);
        }
    };

    const handleAddIncomer = () => {
        if (incomerCount >= 3) {
            alert("Maximum 3 incomers allowed.");
            return;
        }
        handleUpdateProperty("Incomer Count", (incomerCount + 1).toString());
    };
    const handleCopy = () => {
        if (selectedIds.length === 0) return;
        const firstId = selectedIds[0];

        if (firstId.startsWith("Incomer")) {
            const section = firstId.split(":")[1];
            const data = {
                _metaType: "Incomer",
                Type: properties[`Incomer${section}_Type`],
                Pole: properties[`Incomer${section}_Pole`],
                Rating: properties[`Incomer${section}_Rating`],
                Company: properties[`Incomer${section}_Company`],
                Rate: properties[`Incomer${section}_Rate`],
                Description: properties[`Incomer${section}_Description`],
                GS: properties[`Incomer${section}_GS`]
            };
            setClipboard([data]);
        } else if (firstId.startsWith("Coupler")) {
            const section = firstId.split(":")[1];
            const data = {
                _metaType: "Coupler",
                Type: properties[`BusCoupler${section}_Type`],
                Pole: properties[`BusCoupler${section}_Pole`],
                Rating: properties[`BusCoupler${section}_Rating`],
                Company: properties[`BusCoupler${section}_Company`],
                Rate: properties[`BusCoupler${section}_Rate`],
                Description: properties[`BusCoupler${section}_Description`],
                GS: properties[`BusCoupler${section}_GS`]
            };
            setClipboard([data]);
        } else {
            const selectedItems = outgoings.filter((_, idx) => selectedIds.includes(idx.toString()));
            setClipboard(selectedItems.map(item => ({ ...item, _metaType: "Outgoing" })));
        }
        setContextMenu(null);
    };

    const handlePaste = (section: number, targetIndex: number | null, targetType: string = "Outgoing") => {
        if (clipboard.length === 0) return;
        const firstClip = clipboard[0];

        // 1. Paste into Incomer Slot
        if (targetType === "Incomer") {
            const prefix = `Incomer${section}_`;
            let newProps = { ...properties };

            // Explicitly overwrite properties (use clipboard value OR empty string to clear previous value)
            newProps[prefix + "Type"] = firstClip.Type || "";
            newProps[prefix + "Pole"] = firstClip.Pole || "";
            newProps[prefix + "Rating"] = firstClip.Rating || firstClip["Current Rating"] || "";
            newProps[prefix + "Company"] = firstClip.Company || "";
            newProps[prefix + "Rate"] = firstClip.Rate || "";
            newProps[prefix + "Description"] = firstClip.Description || "";
            newProps[prefix + "GS"] = firstClip.GS || "";

            setLocalItem({ ...localItem, properties: [newProps] });
        }
        // 2. Paste into Coupler Slot
        else if (targetType === "Coupler") {
            const prefix = `BusCoupler${section}_`;
            let newProps = { ...properties };

            newProps[prefix + "Type"] = firstClip.Type || "";
            newProps[prefix + "Pole"] = firstClip.Pole || "";
            newProps[prefix + "Rating"] = firstClip.Rating || firstClip["Current Rating"] || "";
            newProps[prefix + "Company"] = firstClip.Company || "";
            newProps[prefix + "Rate"] = firstClip.Rate || "";
            newProps[prefix + "Description"] = firstClip.Description || "";
            newProps[prefix + "GS"] = firstClip.GS || "";

            setLocalItem({ ...localItem, properties: [newProps] });
        }
        // 3. Paste into Outgoing List
        else {
            // If pasting non-outgoing item (Incomer props) into outgoing list -> convert to new outgoing item
            let newItemsToAdd: any[] = [];

            if (firstClip._metaType === "Incomer" || firstClip._metaType === "Coupler") {
                // Convert Incomer/Coupler prop object to Outgoing item
                newItemsToAdd = [{
                    "Section": section.toString(),
                    "Type": firstClip.Type || "MCB",
                    "Pole": firstClip.Pole || "",
                    "Current Rating": firstClip.Rating || "",
                    "Company": firstClip.Company || "",
                    "Description": firstClip.Description || "",
                    "GS": firstClip.GS || "",
                    "Phase": firstClip.Phase || ""
                }];
            } else {
                // Standard outgoing paste
                newItemsToAdd = clipboard.map(item => {
                    const { _metaType, ...rest } = item;
                    return { ...rest, "Section": section.toString() };
                });
            }

            let newOutgoings = [...outgoings];
            if (targetIndex !== null) {
                // Insert at index
                // Note: Logic for multi-paste at index
                newItemsToAdd.forEach((newItem, i) => {
                    const destIdx = targetIndex + i;
                    if (destIdx < newOutgoings.length) {
                        // User requested "Paste Properties" behavior (Overwrite)
                        newOutgoings[destIdx] = { ...newOutgoings[destIdx], ...newItem };
                    } else {
                        // If overflowing or appending, push new item
                        newOutgoings.push(newItem);
                    }
                });
            } else {
                newOutgoings = [...newOutgoings, ...newItemsToAdd];
            }
            setLocalItem({ ...localItem, outgoing: newOutgoings });
        }

        setContextMenu(null);
    };

    const handleSlotClick = (e: React.MouseEvent, section: number, index: number | null, globalIndex: number = -1) => {
        e.stopPropagation();
        if (index === null) return;

        if (e.ctrlKey || e.shiftKey) {
            if (selectedIds.includes(globalIndex.toString())) {
                setSelectedIds(selectedIds.filter(id => id !== globalIndex.toString()));
            } else {
                setSelectedIds([...selectedIds, globalIndex.toString()]);
            }
        } else {
            setSelectedIds([globalIndex.toString()]);
        }
    };

    // Rendering Logic
    const margin = 5;
    const topSpace = 180;
    const busbarY = margin + topSpace;
    const busbarHeight = 10;
    const outgoingTopY = busbarY + busbarHeight;
    const outgoingLength = 60;
    const outgoingSpacing = 65;
    const minSectionWidth = 140;
    const couplerWidth = 80;

    const sectionWidths: number[] = [];
    for (let i = 1; i <= incomerCount; i++) {
        sectionWidths.push(minSectionWidth);
    }

    for (let i = 1; i <= incomerCount; i++) {
        const isChangeOverNext = i < incomerCount && (properties[`BusCoupler${i}_Type`] === "Change Over Switch Open" || properties[`BusCoupler${i}_Type`] === "Change Over Switch");
        if (isChangeOverNext) {
            const combinedOutgoings = (outgoings || []).filter((o: any) => o["Section"] === i.toString() || o["Section"] === (i + 1).toString());
            const combinedCount = Math.max(combinedOutgoings.length, 1);

            const requiredSectionsWidth = Math.max(minSectionWidth * 2, combinedCount * outgoingSpacing);
            const perSectionWidth = Math.max(minSectionWidth, requiredSectionsWidth / 2);

            sectionWidths[i - 1] = perSectionWidth;
            sectionWidths[i] = perSectionWidth;
            i++;
            continue;
        }

        const sectionOutgoings = (outgoings || []).filter((o: any) => o["Section"] === i.toString());
        const count = Math.max(sectionOutgoings.length, 1);
        let width = count * outgoingSpacing;
        if (width < minSectionWidth) width = minSectionWidth;
        sectionWidths[i - 1] = width;
    }

    // --- Render Dropdowns Components ---

    const RenderDeviceConfig = ({ type, pole, rating, company, rate, phase, onChange, canDelete, onDelete, title }: any) => {
        const isCoupler = title.includes("Coupler");
        const forcedType = isChangeOverMode && isCoupler ? "Change Over Switch Open" : type;
        const disableType = isChangeOverMode && isCoupler;

        const effectiveType = forcedType || "";
        const isSfu = effectiveType === "Main Switch Open";
        const isMccb = effectiveType === "MCCB";
        const isMcb = effectiveType === "MCB";
        const isChangeOver = effectiveType === "Change Over Switch Open";

        let datasetKey: 'mccb' | 'mcb' | 'sfu' | 'changeOver' | null = null;
        if (isSfu) datasetKey = 'sfu';
        if (isMccb) datasetKey = 'mccb';
        if (isMcb) datasetKey = 'mcb';
        if (isChangeOver) datasetKey = 'changeOver';

        let poles = datasetKey ? getUniqueValues(getOptions(datasetKey), "Pole") : [];
        if (isSfu && poles.length === 0) poles.push("TPN");
        if (isChangeOver) poles = ["FP"];

        // Filter "SP" for MCB if requested
        if (isMcb) {
            poles = poles.filter(p => p !== "SP");
        }

        const effectivePole = isChangeOver ? (pole || "FP") : pole;

        const ratings = datasetKey ? getUniqueValues(getOptions(datasetKey, { pole: (isSfu || isChangeOver) ? undefined : effectivePole }), "Current Rating") : [];

        const companies = datasetKey ? getUniqueValues(getOptions(datasetKey, { pole: (isSfu || isChangeOver) ? undefined : effectivePole, rating }), "Company") : [];

        const showPhase = effectivePole && (effectivePole.startsWith("DP") || effectivePole.startsWith("SP") || effectivePole.startsWith("1P"));

        const showRate = rate && effectiveType && ((isSfu || isChangeOver) ? true : !!effectivePole) && rating && company;

        const inputStyle = {
            backgroundColor: theme === 'dark' ? '#1e293b' : '#ffffff',
            borderColor: colors.border,
            color: colors.text
        };

        const optionStyle = {
            backgroundColor: theme === 'dark' ? '#1e293b' : '#ffffff',
            color: colors.text
        };

        return (
            <div className="space-y-2">
                <div className="text-xs opacity-70">{title}</div>
                <select
                    value={effectiveType || ""}
                    onChange={(e) => onChange("Type", e.target.value)}
                    className="w-full text-xs p-1 rounded border"
                    style={inputStyle}
                    disabled={disableType}
                >
                    <option value="" disabled style={optionStyle}>Select Type...</option>
                    <option value="MCCB" style={optionStyle}>MCCB</option>
                    <option value="Main Switch Open" style={optionStyle}>Main Switch (SFU)</option>
                    {(!title.includes("Incomer") && !title.includes("Coupler")) && <option value="MCB" style={optionStyle}>MCB</option>}
                    {/* Extra options for Coupler etc */}
                    {(title.includes("Coupler") ? (
                        <>
                            <option value="Direct" style={optionStyle}>Direct Link (Solid)</option>
                            {isChangeOverMode && <option value="Change Over Switch Open" style={optionStyle}>Change Over Switch (Open Execution)</option>}
                        </>
                    ) : null)}
                </select>

                <select
                    value={effectivePole || ""}
                    onChange={(e) => onChange("Pole", e.target.value)}
                    className="w-full text-xs p-1 rounded border"
                    style={inputStyle}
                    disabled={!effectiveType || isChangeOver || (isSfu && poles.length <= 1)}
                >
                    <option value="" style={optionStyle}>Select Pole...</option>
                    {poles.map((p: string) => <option key={p} value={p} style={optionStyle}>{p}</option>)}
                </select>

                <select
                    value={rating || ""}
                    onChange={(e) => onChange("Current Rating", e.target.value)}
                    className="w-full text-xs p-1 rounded border"
                    style={inputStyle}
                    disabled={!effectiveType || (!isSfu && !isChangeOver && !effectivePole)}
                >
                    <option value="" style={optionStyle}>Select Rating...</option>
                    {ratings.map((r: string) => <option key={r} value={r} style={optionStyle}>{r}</option>)}
                </select>

                <select
                    value={company || ""}
                    onChange={(e) => onChange("Company", e.target.value)}
                    className="w-full text-xs p-1 rounded border"
                    style={inputStyle}
                    disabled={!rating}
                >
                    <option value="" style={optionStyle}>Select Company...</option>
                    {companies.map((c: string) => <option key={c} value={c} style={optionStyle}>{c}</option>)}
                </select>

                {showPhase && (
                    <select
                        value={phase || ""}
                        onChange={(e) => onChange("Phase", e.target.value)}
                        className="w-full text-xs p-1 rounded border"
                        style={inputStyle}
                    >
                        <option value="" style={optionStyle}>Select Phase...</option>
                        <option value="R" style={optionStyle}>R Phase</option>
                        <option value="Y" style={optionStyle}>Y Phase</option>
                        <option value="B" style={optionStyle}>B Phase</option>
                    </select>
                )}

                {showRate && (
                    <div className="text-[10px] text-green-600 dark:text-green-400 font-medium px-1">
                        Rate: ₹{rate}
                    </div>
                )}

                {canDelete && (
                    <button onClick={onDelete} className="w-full py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">
                        Delete
                    </button>
                )}
            </div>
        );
    };

    const containerStyle = {
        backgroundColor: colors.panelBackground,
        color: colors.text,
        borderColor: colors.border
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-[95vw] h-[90vh] rounded-xl shadow-2xl flex flex-col border border-white/10 overflow-hidden"
                style={containerStyle}>
                <div className="flex justify-between items-center p-4 border-b bg-gray-50/50"
                    style={{ borderColor: colors.border, backgroundColor: 'rgba(0,0,0,0.02)' }}>
                    <h2 className="text-xl font-bold flex items-center gap-2" style={{ color: colors.text }}>
                        <span>Visual Panel Designer</span>
                        <span className="text-sm font-normal opacity-50 px-2 py-0.5 border rounded-full" style={{ borderColor: colors.border }}>LT Cubical Panel</span>
                    </h2>
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                let finalItem = { ...localItem, svgContent: PanelRenderer.generateSvg(localItem) };
                                // Recompute connection points for the edited incomer/outgoing layout
                                // so phase validation sees the same out{ N }/in{ N } mapping as the canvas.
                                try {
                                    const geometry = calculateGeometry(finalItem);
                                    if (geometry) {
                                        finalItem = { ...finalItem, size: geometry.size, connectionPoints: geometry.connectionPoints };
                                    }
                                } catch { /* keep local geometry on failure */ }
                                // Block a panel reconfig (incomer Pole/Type or outgoing
                                // Pole) that would invalidate existing wiring.
                                try {
                                    const st = useStore.getState();
                                    const sheet = st.getCurrentSheet();
                                    if (sheet) {
                                        const items = sheet.canvasItems.map(ci => ci.uniqueID === finalItem.uniqueID ? finalItem : ci);
                                        const issues = findIncompatibleConnectorsForItem(
                                            finalItem,
                                            sheet.storedConnectors,
                                            items
                                        );
                                        if (issues.length > 0) {
                                            const details = issues.slice(0, 3).map(i => `• ${i.error}`).join('\n');
                                            const more = issues.length > 3 ? `\n...and ${issues.length - 3} more.` : '';
                                            alert(`Cannot save. This panel change would make ${issues.length} existing connection(s) phase-incompatible (single-phase vs 3-phase).\n\n${details}${more}\n\nDelete or rewire those connections first, or choose a compatible Pole configuration.`);
                                            return;
                                        }
                                    }
                                } catch { /* validation must never block save on internal error */ }
                                onSave(finalItem);
                            }}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 text-sm font-medium transition-colors"
                        >
                            <Save size={16} /> Save Changes
                        </button>
                        <button onClick={onClose} className="p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors">
                            <X size={20} style={{ color: colors.text }} />
                        </button>
                    </div>
                </div>

                <div className="flex-1 flex overflow-hidden">
                    <div className="w-64 border-r p-4 space-y-6 overflow-y-auto"
                        style={{ borderColor: colors.border, backgroundColor: 'rgba(0,0,0,0.02)' }}>
                        {/* Global Settings */}
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-bold uppercase opacity-60 mb-1 block">Incomers</label>
                                <select
                                    value={properties["Incomer Count"]}
                                    onChange={(e) => handleUpdateProperty("Incomer Count", e.target.value)}
                                    className="w-full p-2 text-sm rounded border bg-transparent"
                                    style={{ borderColor: colors.border, color: colors.text }}
                                >
                                    <option value="1" className="bg-white dark:bg-slate-800">1 Incomer</option>
                                    <option value="2" className="bg-white dark:bg-slate-800">2 Incomers</option>
                                    <option value="3" className="bg-white dark:bg-slate-800">3 Incomers</option>
                                </select>
                            </div>

                            {/* System Linking Selection (Only if > 1 Incomer) */}
                            {incomerCount > 1 && (
                                <div>
                                    <label className="text-xs font-bold uppercase opacity-60 mb-1 block">System Configuration</label>
                                    <div className="flex flex-col gap-2">
                                        <label
                                            className={`flex items-center gap-2 p-2 rounded border cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-800`}
                                            style={{
                                                borderColor: !isChangeOverMode ? (theme === 'dark' ? '#3b82f6' : '#3b82f6') : 'transparent',
                                                backgroundColor: !isChangeOverMode ? (theme === 'dark' ? 'rgba(30, 58, 138, 0.5)' : '#dbeafe') : 'transparent'
                                            }}
                                        >
                                            <input
                                                type="radio"
                                                name="systemLink"
                                                checked={!isChangeOverMode}
                                                onChange={() => handleSystemModeChange("BusCoupler")}
                                                className="accent-blue-600"
                                            />
                                            <span className="text-sm">Bus Coupler System</span>
                                        </label>
                                        <label
                                            className={`flex items-center gap-2 p-2 rounded border cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-800`}
                                            style={{
                                                borderColor: isChangeOverMode ? (theme === 'dark' ? '#3b82f6' : '#3b82f6') : 'transparent',
                                                backgroundColor: isChangeOverMode ? (theme === 'dark' ? 'rgba(30, 58, 138, 0.5)' : '#dbeafe') : 'transparent'
                                            }}
                                        >
                                            <input
                                                type="radio"
                                                name="systemLink"
                                                checked={isChangeOverMode}
                                                onChange={() => handleSystemModeChange("ChangeOver")}
                                                className="accent-blue-600"
                                            />
                                            <span className="text-sm">Change Over System</span>
                                        </label>
                                    </div>
                                    <div className="text-[10px] opacity-60 mt-1 pl-1">
                                        {isChangeOverMode
                                            ? "Incomers will be interlocked via a central Change Over Switch."
                                            : "Incomers will be linked via Bus Couplers (Direct, MCCB, SFU)."
                                        }
                                    </div>
                                </div>
                            )}

                            {/* Busbar Details */}
                            <div>
                                <label className="text-xs font-bold uppercase opacity-60 mb-1 block">Busbar Details</label>
                                <div className="space-y-2">
                                    <label className="text-xs opacity-70 block">Busbar Material</label>
                                    <select
                                        value={properties["Busbar Material"] || "Aluminium"}
                                        onChange={(e) => handleUpdateProperty("Busbar Material", e.target.value)}
                                        className="w-full p-2 text-sm rounded border bg-transparent"
                                        style={{ borderColor: colors.border, color: colors.text }}
                                    >
                                        <option value="Aluminium" className="bg-white dark:bg-slate-800">Aluminium</option>
                                        <option value="Copper" className="bg-white dark:bg-slate-800">Copper</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        {/* Selection Logic */}
                        {selectedIds.length > 0 && selectedIds[0].startsWith("Incomer") ? (
                            <div className="p-3 rounded border" style={{
                                backgroundColor: theme === 'dark' ? 'rgba(20, 83, 45, 0.4)' : '#f0fdf4',
                                borderColor: theme === 'dark' ? '#166534' : '#dcfce7'
                            }}>
                                <h3 className="text-sm font-bold mb-2" style={{ color: theme === 'dark' ? '#86efac' : '#15803d' }}>Incomer Config</h3>
                                {(() => {
                                    const section = selectedIds[0].split(":")[1];
                                    return (
                                        <RenderDeviceConfig
                                            type={properties[`Incomer${section}_Type`]}
                                            pole={properties[`Incomer${section}_Pole`] || (properties[`Incomer${section}_Type`] === "Main Switch Open" ? "TPN" : "")}
                                            rating={properties[`Incomer${section}_Rating`]}
                                            company={properties[`Incomer${section}_Company`]}
                                            rate={properties[`Incomer${section}_Rate`]}
                                            onChange={(field: string, val: string) => {
                                                if (field === "Current Rating") handleUpdateIncomer(section, "Rating", val); // Remap
                                                else handleUpdateIncomer(section, field, val);
                                            }}
                                            canDelete={incomerCount > 1}
                                            onDelete={handleDeleteSelected}
                                            title={`Incomer for Section ${section}`}
                                        />
                                    );
                                })()}
                            </div>
                        ) : selectedIds.length > 0 && selectedIds[0].startsWith("Coupler") ? (
                            <div className="p-3 rounded border" style={{
                                backgroundColor: theme === 'dark' ? 'rgba(88, 28, 135, 0.4)' : '#faf5ff',
                                borderColor: theme === 'dark' ? '#6b21a8' : '#f3e8ff'
                            }}>
                                <h3 className="text-sm font-bold mb-2" style={{ color: theme === 'dark' ? '#d8b4fe' : '#7e22ce' }}>Coupler Config</h3>
                                {(() => {
                                    const section = selectedIds[0].split(":")[1];
                                    return (
                                        <RenderDeviceConfig
                                            type={properties[`BusCoupler${section}_Type`] || ""}
                                            pole={properties[`BusCoupler${section}_Pole`] || (properties[`BusCoupler${section}_Type`] === "Main Switch Open" ? "TPN" : "")}
                                            rating={properties[`BusCoupler${section}_Rating`]}
                                            company={properties[`BusCoupler${section}_Company`]}
                                            rate={properties[`BusCoupler${section}_Rate`]}
                                            onChange={(field: string, val: string) => {
                                                if (field === "Current Rating") handleUpdateCoupler(section, "Current Rating", val);
                                                else handleUpdateCoupler(section, field, val);
                                            }}
                                            canDelete={false}
                                            title={`Bus Coupler for Sec ${section}`}
                                        />
                                    );
                                })()}
                            </div>
                        ) : selectedIds.length > 0 && (
                            <div className="p-3 rounded border" style={{
                                backgroundColor: theme === 'dark' ? 'rgba(30, 58, 138, 0.4)' : '#eff6ff',
                                borderColor: theme === 'dark' ? '#1e40af' : '#dbeafe'
                            }}>
                                <h3 className="text-sm font-bold mb-2" style={{ color: theme === 'dark' ? '#93c5fd' : '#1d4ed8' }}>{selectedIds.length} Items Selected</h3>
                                {selectedIds.length === 1 ? (
                                    (() => {
                                        const idx = parseInt(selectedIds[0]);
                                        const item = outgoings[idx];
                                        if (!item) return null;
                                        return (
                                            <RenderDeviceConfig
                                                type={item["Type"]}
                                                pole={item["Pole"] || (item["Type"] === "Main Switch Open" ? "TPN" : "")}
                                                rating={item["Current Rating"]}
                                                company={item["Company"]}
                                                rate={item["Rate"]}
                                                phase={item["Phase"]}
                                                onChange={(field: string, val: string) => handleUpdateOutgoing(idx, field, val)}
                                                canDelete={true}
                                                onDelete={handleDeleteSelected}
                                                title={`Circuit ${idx + 1}`}
                                            />
                                        );
                                    })()
                                ) : (
                                    <div className="space-y-2">
                                        <div className="text-xs opacity-70">Bulk edit not supported yet.</div>
                                        <button onClick={handleDeleteSelected} className="w-full py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200">
                                            Delete Selected
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="text-xs text-gray-500">
                            Hold Shift to select multiple.<br />
                            Right-click for options.
                        </div>
                    </div>

                    {/* Visualizer Area */}
                    <div className="flex-1 overflow-auto p-8 flex justify-center items-start relative"
                        style={{ backgroundColor: theme === 'dark' ? '#0f172a' : '#f1f5f9' }}
                        onClick={() => { setSelectedIds([]); setContextMenu(null); }}
                        onContextMenu={(e) => { e.preventDefault(); }}
                    >
                        <div dangerouslySetInnerHTML={{ __html: PanelRenderer.generateSvg(localItem) }} className="pointer-events-none" style={{ filter: theme === 'dark' ? 'invert(1) hue-rotate(180deg)' : 'none' }} />

                        <div
                            className="absolute"
                            style={{
                                width: PanelRenderer.generateSvg(localItem).match(/width="(\d+)"/)?.[1] + "px" || "auto",
                                height: PanelRenderer.generateSvg(localItem).match(/height="(\d+)"/)?.[1] + "px" || "auto",
                            }}
                        >
                            {(() => {
                                const elements = [];
                                let currentX = margin;
                                // Must match PanelRenderer constants exactly
                                const rendererTopSpace = 180;
                                const rendererBusbarY = margin + rendererTopSpace;

                                // Functions to generate elements to avoid duplication
                                const pushIncomerOverlay = (centerX: number, secNum: number) => {
                                    elements.push(
                                        <div
                                            key={`ic-${secNum}`}
                                            className={`absolute cursor-pointer border-2 hover:border-blue-400 rounded ${selectedIds.includes(`Incomer:${secNum}`) ? "border-blue-600 bg-blue-500/20" : "border-transparent"}`}
                                            style={{ left: centerX - 25, top: margin + 10, width: 50, height: 60 }}
                                            onClick={(e) => { e.stopPropagation(); setSelectedIds([`Incomer:${secNum}`]); }}
                                            title={`Incomer ${secNum}`}
                                            onContextMenu={(e) => {
                                                e.preventDefault(); e.stopPropagation();
                                                setSelectedIds([`Incomer:${secNum}`]);
                                                setContextMenu({ x: e.clientX, y: e.clientY, section: secNum, index: null, type: 'Incomer' });
                                            }}
                                        />
                                    );
                                };

                                const pushOutgoingOverlays = (secNum: number, startX: number, outList: any[]) => {
                                    outList.forEach((out, idx) => {
                                        const itemX = startX + (idx * outgoingSpacing);
                                        const isSelected = selectedIds.includes(out.globalIdx.toString());
                                        // FIXED: Start overlay higher to cover text labels (approx busbarY + 15)
                                        // SVG text starts at busbarY + 20 to 42. Switch at +20 to +40. 
                                        const overlayTop = rendererBusbarY + busbarHeight + 10;
                                        const overlayHeight = 70; // Covers text + switch + connection

                                        elements.push(
                                            <div
                                                key={`og-${out.globalIdx}`}
                                                className={`absolute cursor-pointer transition-all border-2 ${isSelected ? "border-blue-500 bg-blue-500/10" : "border-transparent hover:border-blue-300/50"}`}
                                                style={{
                                                    left: itemX - 25, // Centered on itemX (width 50)
                                                    top: overlayTop,
                                                    width: 50, // Wider to catch text
                                                    height: overlayHeight,
                                                    borderRadius: '4px'
                                                }}
                                                draggable={true}
                                                onDragStart={(e) => {
                                                    e.stopPropagation();
                                                    e.dataTransfer.effectAllowed = "move";
                                                    e.dataTransfer.setData("text/plain", out.globalIdx.toString());
                                                }}
                                                onDragOver={(e) => {
                                                    e.preventDefault();
                                                    e.dataTransfer.dropEffect = "move";
                                                }}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    const sourceIdx = parseInt(e.dataTransfer.getData("text/plain"));
                                                    const targetIdx = out.globalIdx;

                                                    if (!isNaN(sourceIdx) && sourceIdx !== targetIdx) {
                                                        const newOut = [...outgoings];
                                                        const [movedItem] = newOut.splice(sourceIdx, 1);
                                                        movedItem["Section"] = secNum.toString();
                                                        let adjustedTarget = targetIdx;
                                                        if (sourceIdx < targetIdx) adjustedTarget -= 1;
                                                        newOut.splice(adjustedTarget, 0, movedItem);
                                                        setLocalItem({ ...localItem, outgoing: newOut });
                                                    }
                                                }}
                                                onClick={(e) => handleSlotClick(e, secNum, idx, out.globalIdx)}
                                                onContextMenu={(e) => {
                                                    e.preventDefault(); e.stopPropagation();
                                                    if (!selectedIds.includes(out.globalIdx.toString())) {
                                                        setSelectedIds([out.globalIdx.toString()]);
                                                    }
                                                    setContextMenu({ x: e.clientX, y: e.clientY, section: secNum, index: out.globalIdx, type: 'Outgoing' });
                                                }}
                                            />
                                        );
                                    });
                                };

                                const pushAddButton = (secNum: number, startX: number, count: number) => {
                                    // FIXED: Position purely based on busbar line to avoid dependency on overlayTop
                                    // Overlay ends at busbarY + 10 + 70 = +80. So +85 gives 5px gap.
                                    const addButtonTop = rendererBusbarY + busbarHeight + 85;

                                    elements.push(
                                        <div
                                            key={`add-${secNum}`}
                                            className="absolute cursor-pointer hover:bg-green-500/20 flex items-center justify-center group rounded-full border border-dashed border-gray-400"
                                            style={{
                                                left: startX + (count * outgoingSpacing) - 15,
                                                top: addButtonTop,
                                                width: 30,
                                                height: 30
                                            }}
                                            onClick={(e) => { e.stopPropagation(); handleAddOutgoing(secNum.toString()); }}
                                            onDragOver={(e) => {
                                                e.preventDefault();
                                                e.dataTransfer.dropEffect = "move";
                                            }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                const sourceIdx = parseInt(e.dataTransfer.getData("text/plain"));
                                                if (!isNaN(sourceIdx)) {
                                                    const newOut = [...outgoings];
                                                    const [movedItem] = newOut.splice(sourceIdx, 1);
                                                    movedItem["Section"] = secNum.toString();

                                                    // Add to end of this section
                                                    let lastSectionIdx = -1;
                                                    newOut.forEach((o, i) => {
                                                        if (o["Section"] === secNum.toString()) lastSectionIdx = i;
                                                    });
                                                    if (lastSectionIdx !== -1) {
                                                        newOut.splice(lastSectionIdx + 1, 0, movedItem);
                                                    } else {
                                                        newOut.push(movedItem);
                                                    }
                                                    setLocalItem({ ...localItem, outgoing: newOut });
                                                }
                                            }}
                                            title="Add New Circuit"
                                        >
                                            <Plus size={16} className="opacity-50 group-hover:opacity-100" />
                                        </div>
                                    );
                                };

                                for (let sec = 1; sec <= incomerCount; sec++) {
                                    const isChangeOverNext = sec < incomerCount && (properties[`BusCoupler${sec}_Type`] === "Change Over Switch Open" || properties[`BusCoupler${sec}_Type`] === "Change Over Switch");

                                    if (isChangeOverNext) {
                                        // --- CHANGE OVER SWITCH LOGIC ---
                                        // IMPORTANT: we mutate `sec` later (sec++) to skip the next section.
                                        // Capture the current coupler section index now so click handlers don't
                                        // end up selecting the mutated value (which breaks selection for 2-incomer mode).
                                        const couplerSection = sec;
                                        const sec1Width = sectionWidths[sec - 1];
                                        const sec2Width = sectionWidths[sec];

                                        // Centers
                                        const sec1Center = currentX + sec1Width / 2;
                                        const sec2Center = currentX + sec1Width + couplerWidth + sec2Width / 2;

                                        // Block Width
                                        const totalBlockWidth = sec1Width + couplerWidth + sec2Width;
                                        const blockCenterX = currentX + totalBlockWidth / 2;

                                        // 1. Incomer 1
                                        pushIncomerOverlay(sec1Center, sec);

                                        // 2. Incomer 2 (sec+1)
                                        pushIncomerOverlay(sec2Center, sec + 1);

                                        // 3. Central Switch Box
                                        const switchBoxTopY = rendererBusbarY - 80;
                                        elements.push(
                                            <div
                                                key={`coupler-${couplerSection}`}
                                                className={`absolute cursor-pointer border-2 hover:border-purple-400 rounded ${selectedIds.includes(`Coupler:${couplerSection}`) ? "border-purple-600 bg-purple-500/20" : "border-transparent"}`}
                                                style={{
                                                    left: blockCenterX - 30, // 60px wide box
                                                    top: switchBoxTopY,
                                                    width: 60,
                                                    height: 70
                                                }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedIds([`Coupler:${couplerSection}`]);
                                                }}
                                                title={`Change Over Switch`}
                                                onContextMenu={(e) => {
                                                    e.preventDefault(); e.stopPropagation();
                                                    setSelectedIds([`Coupler:${couplerSection}`]);
                                                    setContextMenu({ x: e.clientX, y: e.clientY, section: couplerSection, index: null, type: 'Coupler' });
                                                }}
                                            />
                                        );

                                        // 4. Outgoings (shared bus for both sections)
                                        const sec1Outgoings = outgoings.map((o, idx) => ({ ...o, globalIdx: idx } as any)).filter(o => o["Section"] === sec.toString());
                                        const sec2Outgoings = outgoings.map((o, idx) => ({ ...o, globalIdx: idx } as any)).filter(o => o["Section"] === (sec + 1).toString());
                                        const combinedOutgoings = [...sec1Outgoings, ...sec2Outgoings];
                                        const outCount = Math.max(combinedOutgoings.length, 1);
                                        const startOutX = blockCenterX - ((outCount - 1) * outgoingSpacing) / 2;
                                        pushOutgoingOverlays(sec, startOutX, combinedOutgoings);
                                        pushAddButton(sec, startOutX, combinedOutgoings.length);

                                        currentX += totalBlockWidth + (sec + 1 < incomerCount ? couplerWidth : 0);
                                        sec++; // Skip next iterations

                                    } else {
                                        // --- NORMAL LOGIC ---
                                        const width = sectionWidths[sec - 1];
                                        const sectionCenter = currentX + (width / 2);

                                        // Incomer
                                        pushIncomerOverlay(sectionCenter, sec);

                                        // Outgoings
                                        const sectionOutgoings = outgoings.map((o, idx) => ({ ...o, globalIdx: idx } as any)).filter(o => o["Section"] === sec.toString());
                                        const outCount = Math.max(sectionOutgoings.length, 1);
                                        const startOutX = sectionCenter - ((outCount - 1) * outgoingSpacing) / 2;

                                        pushOutgoingOverlays(sec, startOutX, sectionOutgoings);
                                        pushAddButton(sec, startOutX, sectionOutgoings.length);

                                        // Coupler (Normal)
                                        if (sec < incomerCount) {
                                            elements.push(
                                                <div
                                                    key={`coupler-${sec}`}
                                                    className={`absolute cursor-pointer border-2 hover:border-purple-400 rounded ${selectedIds.includes(`Coupler:${sec}`) ? "border-purple-600 bg-purple-500/20" : "border-transparent"}`}
                                                    style={{
                                                        left: currentX + width + 10,
                                                        top: rendererBusbarY - 10,
                                                        width: couplerWidth - 20,
                                                        height: 40
                                                    }}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setSelectedIds([`Coupler:${sec}`]);
                                                    }}
                                                    title={`Bus Coupler ${sec}`}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault(); e.stopPropagation();
                                                        setSelectedIds([`Coupler:${sec}`]);
                                                        setContextMenu({ x: e.clientX, y: e.clientY, section: sec, index: null, type: 'Coupler' });
                                                    }}
                                                />
                                            );
                                        }

                                        currentX += width + (sec < incomerCount ? couplerWidth : 0);
                                    }
                                }
                                return elements;
                            })()}
                        </div>
                    </div>
                </div>
            </div>

            {contextMenu && (
                <div
                    className="fixed z-[60] bg-white dark:bg-slate-800 shadow-xl rounded-lg py-1 border border-gray-200 dark:border-gray-700 min-w-[150px]"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    {contextMenu.type === 'Outgoing' && contextMenu.index !== null ? (
                        <>
                            <button onClick={handleCopy} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <Copy size={14} /> Copy {selectedIds.length > 1 ? `(${selectedIds.length})` : ''}
                            </button>
                            <button onClick={() => handlePaste(contextMenu.section, contextMenu.index)} disabled={clipboard.length === 0} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 border-t border-gray-100 dark:border-gray-800">
                                <Clipboard size={14} /> Paste Properties
                            </button>
                        </>
                    ) : (contextMenu.type === 'Incomer' || contextMenu.type === 'Coupler') ? (
                        <>
                            <button onClick={handleCopy} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <Copy size={14} /> Copy {contextMenu.type}
                            </button>
                            <button onClick={() => handlePaste(contextMenu.section, null, contextMenu.type)} disabled={clipboard.length === 0} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 border-t border-gray-100 dark:border-gray-800">
                                Paste Properties
                            </button>
                        </>
                    ) : (
                        <button onClick={() => handlePaste(contextMenu.section, null)} disabled={clipboard.length === 0} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50">
                            Paste ({clipboard.length})
                        </button>
                    )}
                    <button onClick={() => setContextMenu(null)} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 border-t mt-1">
                        Cancel
                    </button>
                </div>
            )}

            {contextMenu && (
                <div className="fixed inset-0 z-[55] bg-transparent" onClick={() => setContextMenu(null)} />
            )}
        </div>
    );
};
