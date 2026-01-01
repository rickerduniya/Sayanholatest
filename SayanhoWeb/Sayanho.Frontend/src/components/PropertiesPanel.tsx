import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/useStore';
import { shallow } from 'zustand/shallow';
import { CanvasItem, Connector } from '../types';
import { X, Plus, Save, ChevronDown } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { fetchProperties } from '../utils/api';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { sortOptionStringsAsc } from '../utils/sortUtils';

import { LOAD_ITEM_DEFAULTS, DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { PanelDesignerDialog } from './PanelDesignerDialog.tsx';

// Property Options Constants
const OPTIONS = {
    INCOMING_DEVICE: ["ACB", "SFU", "MCCB"],
    OUTGOING_DEVICE: ["SFU", "MCCB"],
    METERING_TYPE: ["Analog", "Digital"],
    METER_MAKE: ["L&T", "ABB", "AE"],
    METER_PROTECTION: ["Fuse", "MCB"],
    BUSBAR_POSITION: ["Vertical", "Horizontal"],
    SOURCE_TYPE: ["1-phase", "3-phase"],
    SOURCE_VOLTAGE: ["230 V", "415 V", "440 V"],
    SOURCE_FREQUENCY: ["50 Hz", "60 Hz"],
    RATINGS: ["32A", "63A", "100A", "125A", "160A", "200A", "250A", "400A", "630A", "800A", "1000A", "1250A", "1600A", "2000A", "2500A", "3200A", "4000A"],
    TYPE: ["Lighting", "Appliance", "Other"],
    SWITCH_VOLTAGE: ["230V DP", "415V TPN", "415V FP"],
    FINISHING_METHOD: ["Crimping", "Soldering"]
};

export const PropertiesPanel: React.FC = React.memo(() => {
    const { sheets, activeSheetId, selectedItemIds, selectedConnectorIndices, updateSheet, updateConnector, editMode, setEditMode, isPropertiesPanelOpen } = useStore(
        state => ({
            sheets: state.sheets,
            activeSheetId: state.activeSheetId,
            selectedItemIds: state.selectedItemIds,
            selectedConnectorIndices: state.selectedConnectorIndices,
            updateSheet: state.updateSheet,
            updateConnector: state.updateConnector,
            editMode: state.editMode,
            setEditMode: state.setEditMode,
            isPropertiesPanelOpen: state.isPropertiesPanelOpen
        }),
        shallow
    );
    const currentSheet = sheets.find(s => s.sheetId === activeSheetId);
    const { colors } = useTheme();
    const [editedProperties, setEditedProperties] = useState<Record<string, string>>({});
    const [editedAccessories, setEditedAccessories] = useState<Record<string, string>>({});
    const [editedIncomer, setEditedIncomer] = useState<Record<string, string>>({});
    const [editedOutgoing, setEditedOutgoing] = useState<Record<string, string>[]>([]);
    const [editedLaying, setEditedLaying] = useState<Record<string, string>>({});
    const [editedAltComp1, setEditedAltComp1] = useState<string>("");
    const [editedAltComp2, setEditedAltComp2] = useState<string>("");

    // Dynamic Property State
    const [availableProperties, setAvailableProperties] = useState<Record<string, string>[]>([]);
    const [dbIncomerOptions, setDbIncomerOptions] = useState<string[]>([]);
    const [dbOutgoingOptions, setDbOutgoingOptions] = useState<string[]>([]);
    const [layingOptions, setLayingOptions] = useState<Record<string, string>[]>([]);

    // Helper to select default rating >= threshold
    const selectDefaultRating = (options: string[], threshold: number): string => {
        if (!options || options.length === 0 || threshold <= 0) return "";

        // Options are like "6 A", "10 A", etc.
        // We want the first option where value >= threshold
        // Assuming options are already sorted ascendingly by value

        for (const opt of options) {
            const val = parseFloat(opt.replace(" A", ""));
            if (val >= threshold) {
                return opt;
            }
        }

        // If no option meets the threshold (e.g. all are smaller), return the largest (last)
        // OR return the first available?
        // Logic: ">= threshold". If none exist >= threshold, fallback to first/default behavior
        return options[0];
    };

    const parseWayCount = (itemName: string, wayText: string): number => {
        const txt = (wayText || '').toString();
        if (!txt) return 0;

        if (itemName === "SPN DB") {
            const match = txt.match(/2\s*\+\s*(\d+)/);
            return match ? (parseInt(match[1], 10) || 0) : 0;
        }

        const match = txt.match(/(\d+)/);
        return match ? (parseInt(match[1], 10) || 0) : 0;
    };

    const resizeDbOutgoing = (
        itemName: string,
        prev: Record<string, string>[],
        oldWayCount: number,
        newWayCount: number,
        defaultRating: string
    ): Record<string, string>[] => {
        if (newWayCount <= 0) return [];

        if (itemName === "HTPN") {
            let effectiveOldWayCount = oldWayCount;
            if (effectiveOldWayCount <= 0 && prev.length > 0) {
                effectiveOldWayCount = Math.floor(prev.length / 3);
            }

            const next: Record<string, string>[] = [];
            for (let phaseIndex = 0; phaseIndex < 3; phaseIndex++) {
                for (let i = 0; i < newWayCount; i++) {
                    if (effectiveOldWayCount > 0 && i < effectiveOldWayCount) {
                        const oldIndex = (phaseIndex * effectiveOldWayCount) + i;
                        const existing = prev[oldIndex];
                        next.push(existing ? { ...existing } : { "Current Rating": defaultRating });
                    } else {
                        next.push({ "Current Rating": defaultRating });
                    }
                }
            }
            return next;
        }

        const totalSlots = newWayCount;
        const base = prev.slice(0, totalSlots).map(v => ({ ...v }));
        if (base.length < totalSlots) {
            const missing = totalSlots - base.length;
            for (let i = 0; i < missing; i++) {
                base.push({ "Current Rating": defaultRating });
            }
        }
        return base;
    };
    const [isLoadingProperties, setIsLoadingProperties] = useState(false);
    const [panelDevices, setPanelDevices] = useState<{ mccb: Record<string, string>[], acb: Record<string, string>[], sfu: Record<string, string>[], mcb: Record<string, string>[], changeOver?: Record<string, string>[] }>({ mccb: [], acb: [], sfu: [], mcb: [] });

    // State for 2-page wizard
    const [currentPage, setCurrentPage] = useState(1);

    // Reset page when item changes
    useEffect(() => {
        setCurrentPage(1);
    }, [selectedItemIds, selectedConnectorIndices]);

    // Only show properties if exactly one item is selected
    const selectedItemId = selectedItemIds.length === 1 ? selectedItemIds[0] : null;
    const selectedItem = selectedItemId ? currentSheet?.canvasItems.find(item => item.uniqueID === selectedItemId) : null;
    // Only show connector properties if exactly one connector is selected
    const selectedConnectorIndex = selectedConnectorIndices.length === 1 ? selectedConnectorIndices[0] : null;
    const selectedConnector = selectedConnectorIndex !== null && currentSheet ? currentSheet.storedConnectors[selectedConnectorIndex] : null;
    const isConnectorVirtual = !!(selectedConnector && (selectedConnector.isVirtual || (selectedConnector.properties && (selectedConnector.properties as any)["IsVirtual"] === 'True')));

    // Effect 1: Fetch dynamic properties from API (only when item/connector TYPE changes)
    useEffect(() => {
        // Force read-only mode if virtual connector is selected
        if (selectedConnector && isConnectorVirtual && editMode) {
            setEditMode(false);
        }
        const loadDynamicProperties = async () => {
            if (!selectedItem) return;

            setIsLoadingProperties(true);
            try {
                // 1. Load main properties for the item
                const data = await fetchProperties(selectedItem.name);
                setAvailableProperties(data.properties);

                // 2. Load DB specific options
                if (selectedItem.name === "VTPN") {
                    const incomerData = await fetchProperties("MCCB");
                    const outgoingData = await fetchProperties("MCB");

                    // Filter outgoing for TP (Triple Pole)
                    const tpOutgoing = sortOptionStringsAsc(
                        outgoingData.properties
                            .filter(p => p["Pole"] === "TP")
                            .map(p => p["Current Rating"])
                            .filter((v, i, a) => a.indexOf(v) === i) // Unique
                    );

                    const mccbIncomer = sortOptionStringsAsc(
                        incomerData.properties
                            .map(p => p["Current Rating"])
                            .filter((v, i, a) => a.indexOf(v) === i)
                    );

                    setDbIncomerOptions(mccbIncomer);
                    setDbOutgoingOptions(tpOutgoing);
                } else if (selectedItem.name === "SPN DB") {
                    const incomerData = await fetchProperties("MCB Isolator");
                    const outgoingData = await fetchProperties("MCB");

                    // Incomer DP
                    const dpIncomer = sortOptionStringsAsc(
                        incomerData.properties
                            .filter(p => p["Pole"] === "DP")
                            .map(p => p["Current Rating"])
                            .filter((v, i, a) => a.indexOf(v) === i)
                    );

                    // Outgoing SP
                    const spOutgoing = sortOptionStringsAsc(
                        outgoingData.properties
                            .filter(p => p["Pole"] === "SP")
                            .map(p => p["Current Rating"])
                            .filter((v, i, a) => a.indexOf(v) === i)
                    );

                    setDbIncomerOptions(dpIncomer);
                    setDbOutgoingOptions(spOutgoing);
                } else if (selectedItem.name === "HTPN") {
                    const incomerData = await fetchProperties("MCB"); // FP
                    const outgoingData = await fetchProperties("MCB"); // SP

                    const fpIncomer = sortOptionStringsAsc(
                        incomerData.properties
                            .filter(p => p["Pole"] === "FP")
                            .map(p => p["Current Rating"])
                            .filter((v, i, a) => a.indexOf(v) === i)
                    );

                    const spOutgoing = sortOptionStringsAsc(
                        outgoingData.properties
                            .filter(p => p["Pole"] === "SP")
                            .map(p => p["Current Rating"])
                            .filter((v, i, a) => a.indexOf(v) === i)
                    );

                    setDbIncomerOptions(fpIncomer);
                    setDbOutgoingOptions(spOutgoing);
                    setDbIncomerOptions(fpIncomer);
                    setDbOutgoingOptions(spOutgoing);
                } else if (selectedItem.name === "LT Cubical Panel") {
                    // Fetch all device types for Panel Configuration
                    const mccbData = await fetchProperties("MCCB");
                    const acbData = await fetchProperties("ACB");
                    const sfuData = await fetchProperties("Main Switch Open"); // Represents SFU
                    const mcbData = await fetchProperties("MCB");
                    const changeOverData = await fetchProperties("Change Over Switch Open");

                    setPanelDevices({
                        mccb: mccbData.properties,
                        acb: acbData.properties,
                        sfu: sfuData.properties,
                        mcb: mcbData.properties,
                        changeOver: changeOverData.properties
                    });
                } else {
                    setDbIncomerOptions([]);
                    setDbOutgoingOptions([]);
                }

            } catch (error) {
                console.error("Failed to load dynamic properties", error);
            } finally {
                setIsLoadingProperties(false);
            }
        };

        const loadConnectorProperties = async () => {
            if (!selectedConnector) return;

            setIsLoadingProperties(true);
            try {
                const materialName = selectedConnector.materialType === "Wiring" ? "Wiring" : "Cable";
                const data = await fetchProperties(materialName);
                setAvailableProperties(data.properties);

                if (selectedConnector.materialType === "Cable") {
                    const layingData = await fetchProperties("Laying");
                    setLayingOptions(layingData.properties);
                } else {
                    setLayingOptions([]);
                }

            } catch (error) {
                console.error("Failed to load connector properties", error);
            } finally {
                setIsLoadingProperties(false);
            }
        };

        if (selectedItem) {
            loadDynamicProperties();
        } else if (selectedConnector) {
            loadConnectorProperties();
        } else {
            // Clear all when nothing is selected
            setAvailableProperties([]);
            setDbIncomerOptions([]);
            setDbOutgoingOptions([]);
            setLayingOptions([]);
        }
    }, [selectedItem?.name, selectedConnector?.materialType]); // Only re-fetch when TYPE changes

    // Effect 2: Sync form state with store data (when selection or properties change)
    useEffect(() => {
        if (selectedItem) {
            if (selectedItem.properties && selectedItem.properties[0]) {
                setEditedProperties({ ...selectedItem.properties[0] });
            } else {
                // Check if it's a load item with defaults
                if (LOAD_ITEM_DEFAULTS[selectedItem.name]) {
                    setEditedProperties({ ...LOAD_ITEM_DEFAULTS[selectedItem.name] });
                } else if (selectedItem.name === "Source") {
                    setEditedProperties({
                        "Type": "1-phase",
                        "Voltage": "230 V",
                        "Frequency": "50 Hz"
                    });
                } else {
                    setEditedProperties({});
                }
            }

            if (selectedItem.accessories && selectedItem.accessories[0]) {
                setEditedAccessories({ ...selectedItem.accessories[0] });
            } else {
                setEditedAccessories({});
            }

            if (selectedItem.incomer) {
                setEditedIncomer({ ...selectedItem.incomer });
            } else {
                setEditedIncomer({});
            }

            if (selectedItem.outgoing && selectedItem.outgoing.length > 0) {
                setEditedOutgoing([...selectedItem.outgoing]);
            } else if (selectedItem.name === "SPN DB" || selectedItem.name === "VTPN" || selectedItem.name === "HTPN") {
                // Initialize with logical defaults if empty
                // We depend on dbOutgoingOptions being populated. 
                // Since data fetching is async in Effect 1, and this is Effect 2, we might not have options yet.
                // However, Effect 2 runs when selectedItem changes. Effect 1 also runs then.
                // We need to wait for dbOutgoingOptions to be populated.
                // Actually, let's just use the threshold logic if options are available. 
                // If not available yet, we might need another effect or dependency.
                // Simpler approach: Re-run this logic when dbOutgoingOptions changes IF outgoing is empty.

                const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(selectedItem.name);
                const defaultRating = selectDefaultRating(dbOutgoingOptions, threshold);

                if (defaultRating) {
                    // Calculate expected slots based on Way property
                    const wayStr = selectedItem.properties?.[0]?.["Way"] || DefaultRulesEngine.getDefaultWay(selectedItem.name) || "0";
                    const waysCount = parseWayCount(selectedItem.name, wayStr);
                    setEditedOutgoing(resizeDbOutgoing(selectedItem.name, [], 0, waysCount, defaultRating));
                } else {
                    setEditedOutgoing([]);
                }
            }

            setEditedAltComp1(selectedItem.alternativeCompany1 || "");
            setEditedAltComp2(selectedItem.alternativeCompany2 || "");

        } else if (selectedConnector) {
            // Connector Logic
            setEditedProperties(selectedConnector.properties || {});
            setEditedProperties(selectedConnector.properties || {});

            // Auto-set accessories defaults for Cable if not present
            const acc = selectedConnector.accessories && selectedConnector.accessories[0] ? { ...selectedConnector.accessories[0] } : {};
            if (selectedConnector.materialType === "Cable") {
                if (!Object.prototype.hasOwnProperty.call(acc, "glands_required")) {
                    acc["glands_required"] = "true";
                    acc["number_of_glands"] = "2";
                }
                if (!Object.prototype.hasOwnProperty.call(acc, "finishing_required")) {
                    acc["finishing_required"] = "true";
                    acc["number_of_finishing"] = "2";
                    acc["finishing_method"] = "Crimping";
                }
            }
            setEditedAccessories(acc);
            setEditedLaying(selectedConnector.laying || {});
            setEditedIncomer({});
            setEditedOutgoing([]);

            setEditedAltComp1(selectedConnector.alternativeCompany1 || "");
            setEditedAltComp2(selectedConnector.alternativeCompany2 || "");

        } else {
            setEditedProperties({});
            setEditedAccessories({});
            setEditedIncomer({});
            setEditedOutgoing([]);
            setEditedLaying({});
            setEditedAltComp1("");
            setEditedAltComp2("");
        }
    }, [
        selectedItemId,
        selectedConnectorIndex,
        selectedItem?.properties,
        selectedItem?.accessories,
        selectedItem?.incomer,
        selectedItem?.outgoing,
        selectedItem?.alternativeCompany1,
        selectedItem?.alternativeCompany2,
        selectedConnector?.properties,
        selectedConnector?.accessories,
        selectedConnector?.laying,
        selectedConnector?.alternativeCompany1,
        selectedConnector?.alternativeCompany2,
        dbOutgoingOptions // Important dependency for default rating logic
    ]); // React to selection changes and property updates, but NOT position changes


    // Helper to filter options based on preceding selections
    const getFilteredOptions = (key: string, currentValues: Record<string, string>) => {
        if (availableProperties.length === 0) return [];
        // Exclude non-dropdown keys
        const allKeys = Object.keys(availableProperties[0]).filter(k => k !== "Item" && k !== "Rate" && k !== "Description" && k !== "GS");

        const keyIndex = allKeys.indexOf(key);
        if (keyIndex === -1) return []; // Should not happen for dropdown keys

        // Filter rows based on all preceding keys
        const precedingKeys = allKeys.slice(0, keyIndex);
        const filteredRows = availableProperties.filter(row => {
            return precedingKeys.every(prevKey => {
                const selectedValue = currentValues[prevKey];
                return !selectedValue || row[prevKey] === selectedValue;
            });
        });

        const options = Array.from(new Set(filteredRows.map(r => r[key]).filter(Boolean)));
        return sortOptionStringsAsc(options);
    };

    const handlePropertyChange = (key: string, value: string) => {
        const newProperties = { ...editedProperties, [key]: value };

        // Auto-clear downstream properties if they become invalid
        if (availableProperties.length > 0) {
            const allKeys = Object.keys(availableProperties[0]).filter(k => k !== "Item" && k !== "Rate" && k !== "Description" && k !== "GS");
            const keyIndex = allKeys.indexOf(key);

            // If the changed key is part of the cascading sequence
            if (keyIndex !== -1 && keyIndex < allKeys.length - 1) {
                const subsequentKeys = allKeys.slice(keyIndex + 1);

                subsequentKeys.forEach(subKey => {
                    const currentVal = newProperties[subKey];
                    if (currentVal) {
                        // Check if this value is still valid given the new upstream selection
                        const validOptions = getFilteredOptions(subKey, newProperties);
                        if (!validOptions.includes(currentVal)) {
                            newProperties[subKey] = ""; // Clear invalid selection
                        }
                    }
                });
            }
        }

        // Auto-uncheck End Box for Main Switch if Type changes to non-TPN SFU
        if (selectedItem?.name === "Main Switch" && key === "Type" && value !== "TPN SFU") {
            setEditedAccessories(prev => ({ ...prev, endbox_required: "false" }));
        }

        // Handle "Way" changes for DBs to auto-populate outgoing slots
        if (key === "Way" && selectedItem && (selectedItem.name === "SPN DB" || selectedItem.name === "VTPN" || selectedItem.name === "HTPN")) {
            const oldWaysCount = parseWayCount(selectedItem.name, editedProperties["Way"] || "");
            const newWaysCount = parseWayCount(selectedItem.name, value);
            const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(selectedItem.name);
            const defaultRating = selectDefaultRating(dbOutgoingOptions, threshold);

            setEditedOutgoing(prev => resizeDbOutgoing(selectedItem.name, prev, oldWaysCount, newWaysCount, defaultRating));
        }

        setEditedProperties(newProperties);
    };

    const handleAccessoryChange = (key: string, value: string) => {
        const newAcc = { ...editedAccessories, [key]: value };

        // Auto-set count to 2 if checked and count is missing
        if (key === "finishing_required" && value === "true" && !newAcc["number_of_finishing"]) {
            newAcc["number_of_finishing"] = "2";
        }
        // Auto-set default method if checked and method is missing
        if (key === "finishing_required" && value === "true" && !newAcc["finishing_method"]) {
            newAcc["finishing_method"] = "Crimping";
        }

        setEditedAccessories(newAcc);
    };

    const handleIncomerChange = (key: string, value: string) => {
        setEditedIncomer(prev => ({ ...prev, [key]: value }));
    };

    const handleOutgoingChange = (index: number, key: string, value: string) => {
        const newOutgoing = [...editedOutgoing];
        if (!newOutgoing[index]) {
            newOutgoing[index] = {};
        }
        newOutgoing[index][key] = value;
        setEditedOutgoing(newOutgoing);
    };

    const handleAddProperty = () => {
        const key = prompt('Enter property name:');
        if (key && key.trim()) {
            setEditedProperties(prev => ({ ...prev, [key.trim()]: '' }));
        }
    };

    const handleRemoveProperty = (key: string) => {
        const newProps = { ...editedProperties };
        delete newProps[key];
        setEditedProperties(newProps);
    };

    const handleAlternativeCompanyChange = (key: 'alternativeCompany1' | 'alternativeCompany2', value: string) => {
        if (key === 'alternativeCompany1') {
            setEditedAltComp1(value);
        } else {
            setEditedAltComp2(value);
        }
    };

    const handleSave = () => {
        if (selectedItem && currentSheet && updateSheet) {
            const updatedItems = currentSheet.canvasItems.map(item => {
                if (item.uniqueID === selectedItemId) {
                    let finalAccessories = [editedAccessories];

                    // Validation for Main Switch End Box
                    if (item.name === "Main Switch" && editedAccessories["endbox_required"] === "true") {
                        const ratingStr = editedProperties["Current Rating"] || "";
                        const ratingMatch = ratingStr.match(/(\d+)/);
                        if (ratingMatch) {
                            const rating = parseInt(ratingMatch[1], 10);
                            // End box only available for 63A and above
                            if (rating < 63) {
                                alert(`No end box available for this rating (${ratingStr}). End box requirement will be unchecked.`);
                                finalAccessories = [{ ...editedAccessories, endbox_required: "false" }];
                            }
                        }
                    }

                    let updatedItem = {
                        ...item,
                        properties: [editedProperties],
                        accessories: finalAccessories,
                        incomer: editedIncomer,
                        outgoing: editedOutgoing,
                        alternativeCompany1: editedAltComp1,
                        alternativeCompany2: editedAltComp2
                    };

                    // Update Geometry (Size, Connection Points)
                    const geometry = calculateGeometry(updatedItem);
                    if (geometry) {
                        updatedItem = {
                            ...updatedItem,
                            size: geometry.size,
                            connectionPoints: geometry.connectionPoints
                        };
                    }

                    // Update visuals (SVG Content)
                    updatedItem.svgContent = updateItemVisuals(updatedItem);
                    return updatedItem;
                }
                return item;
            });
            updateSheet({ canvasItems: updatedItems });
            setEditMode(false);
        } else if (selectedConnector && updateConnector && selectedConnectorIndex !== null) {
            if (isConnectorVirtual) {
                alert('This connector mirrors properties across portals and cannot be edited.');
                setEditMode(false);
                return;
            }
            // Connector Save Logic
            updateConnector(selectedConnectorIndex, {
                properties: editedProperties,
                accessories: [editedAccessories],
                laying: editedLaying,
                alternativeCompany1: editedAltComp1,
                alternativeCompany2: editedAltComp2
                // Length is handled separately or within properties if mapped
            });
            setEditMode(false);
        }
    };

    const handleCancel = () => {
        setEditMode(false);
        // Reset changes
        if (selectedItem && selectedItem.properties && selectedItem.properties[0]) {
            setEditedProperties({ ...selectedItem.properties[0] });
        } else if (selectedConnector) {
            setEditedProperties(selectedConnector.properties || {});
        } else {
            setEditedProperties({});
        }
    };

    // Helper to render a dropdown field
    const renderDropdown = (
        label: string,
        key: string,
        options: string[],
        values: Record<string, string> = editedProperties,
        onChange: (key: string, value: string) => void = handlePropertyChange
    ) => (
        <div className="mb-3">
            <label className="text-xs block mb-1 font-medium" style={{ color: colors.text, opacity: 0.8 }}>{label}</label>
            {editMode ? (
                <div className="relative">
                    <select
                        value={values[key] || ""}
                        onChange={(e) => onChange(key, e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10"
                        style={{
                            color: colors.text,
                        }}
                    >
                        <option value="" className="bg-white dark:bg-slate-800">Select...</option>
                        {options.map(opt => (
                            <option key={opt} value={opt} className="bg-white dark:bg-slate-800">{opt}</option>
                        ))}
                    </select>
                    <div className="absolute right-2 top-1/2 transform -translate-y-1/2 pointer-events-none">
                        <ChevronDown size={12} style={{ color: colors.text }} />
                    </div>
                </div>
            ) : (
                <div
                    className="text-xs font-medium px-3 py-2 rounded-lg border bg-white/30 dark:bg-white/5 border-white/20 dark:border-white/10"
                    style={{
                        color: colors.text,
                    }}
                >
                    {values[key] || "—"}
                </div>
            )}
        </div>
    );

    // Helper to render a checkbox field
    const renderCheckbox = (
        label: string,
        key: string,
        values: Record<string, string> = editedProperties,
        onChange: (key: string, value: string) => void = handlePropertyChange
    ) => (
        <div className="mb-3 flex items-center gap-2">
            {editMode ? (
                <input
                    type="checkbox"
                    checked={values[key] === 'true'}
                    onChange={(e) => onChange(key, e.target.checked.toString())}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 bg-white/50 dark:bg-black/20 border-white/20 dark:border-white/10"
                />
            ) : (
                <div className={`w-4 h-4 rounded border flex items-center justify-center ${values[key] === 'true' ? 'bg-blue-600 border-blue-600' : 'border-gray-400 bg-white/30 dark:bg-white/5'}`}>
                    {values[key] === 'true' && <div className="w-2 h-2 bg-white rounded-sm" />}
                </div>
            )}
            <label className="text-xs font-medium" style={{ color: colors.text }}>{label}</label>
        </div>
    );

    // Helper to render a numeric input
    const renderNumberInput = (
        label: string,
        key: string,
        min: number = 0,
        max: number = 100,
        values: Record<string, string> = editedProperties,
        onChange: (key: string, value: string) => void = handlePropertyChange,
        defaultValue: number = 0
    ) => (
        <div className="mb-3">
            <label className="text-xs block mb-1 font-medium" style={{ color: colors.text, opacity: 0.8 }}>{label}</label>
            {editMode ? (
                <input
                    type="number"
                    min={min}
                    max={max}
                    value={values[key] || defaultValue.toString()}
                    onChange={(e) => onChange(key, e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10"
                    style={{
                        color: colors.text,
                    }}
                />
            ) : (
                <div
                    className="text-xs font-medium px-3 py-2 rounded-lg border bg-white/30 dark:bg-white/5 border-white/20 dark:border-white/10"
                    style={{
                        color: colors.text,
                    }}
                >
                    {values[key] || defaultValue.toString()}
                </div>
            )}
        </div>
    );

    // Generic Editor for other items
    const renderGenericProperties = () => (
        <div className="space-y-2">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold" style={{ color: colors.text }}>Custom Properties</h3>
                {editMode && (
                    <button
                        onClick={handleAddProperty}
                        className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                        title="Add Property"
                    >
                        <Plus size={16} />
                    </button>
                )}
            </div>
            {Object.entries(editedProperties).length === 0 ? (
                <p className="text-xs italic" style={{ color: colors.text, opacity: 0.6 }}>No properties set</p>
            ) : (
                Object.entries(editedProperties).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 mb-2">
                        <div className="flex-1">
                            <label className="text-xs block mb-1 font-medium" style={{ color: colors.text, opacity: 0.8 }}>{key}</label>
                            {editMode ? (
                                <input
                                    type="text"
                                    value={value}
                                    onChange={(e) => handlePropertyChange(key, e.target.value)}
                                    className="w-full px-3 py-2 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                />
                            ) : (
                                <div
                                    className="text-xs font-medium px-3 py-2 rounded-lg border bg-white/30 dark:bg-white/5 border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                >
                                    {value || '—'}
                                </div>
                            )}
                        </div>
                        {editMode && (
                            <button
                                onClick={() => handleRemoveProperty(key)}
                                className="text-red-600 hover:text-red-700 mt-5"
                                title="Remove Property"
                            >
                                <X size={14} />
                            </button>
                        )}
                    </div>
                ))
            )}
        </div>
    );

    // Helper to render LT Cubical Panel properties
    const [isDesignerOpen, setIsDesignerOpen] = useState(false);

    // Lazy import would be better but simple import for now
    // We need to move this import to top level, but for this tool call we can't.
    // Assuming we do a multi-replace to add import at top + change here.

    const renderLTCubicalPanel = () => {
        return (
            <div className="space-y-4">
                <div className="p-4 bg-white/40 dark:bg-black/20 rounded-lg border border-white/20 text-center">
                    <p className="text-sm opacity-70 mb-3">LT Cubical Panel requires complex configuration.</p>
                    <button
                        onClick={() => setIsDesignerOpen(true)}
                        className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        Open Visual Designer
                    </button>
                </div>

                {/* Show basic summary */}
                <div className="text-xs opacity-60">
                    Incomers: {editedProperties["Incomer Count"] || 0}<br />
                    Outgoings: {editedOutgoing.length}
                </div>

                {/* Dialog Component - Rendered via Portal to break out of sidebar container */}
                {isDesignerOpen && selectedItem &&
                    createPortal(
                        <PanelDesignerDialog
                            isOpen={isDesignerOpen}
                            onClose={() => setIsDesignerOpen(false)}
                            item={{
                                ...selectedItem,
                                properties: [editedProperties],
                                outgoing: editedOutgoing,
                                incomer: editedIncomer
                            }}
                            onSave={(updatedItem) => {
                                setEditedProperties(updatedItem.properties[0]);
                                setEditedOutgoing(updatedItem.outgoing);
                                if (currentSheet) {
                                    // Recalculate Geometry (Size & Connection Points)
                                    const geometry = calculateGeometry(updatedItem);
                                    if (geometry) {
                                        updatedItem.size = geometry.size;
                                        updatedItem.connectionPoints = geometry.connectionPoints;
                                    }

                                    const newItems = currentSheet.canvasItems.map(i =>
                                        i.uniqueID === updatedItem.uniqueID ? updatedItem : i
                                    );
                                    updateSheet({ canvasItems: newItems });
                                }
                                setIsDesignerOpen(false);
                            }}
                            availableDevices={panelDevices}
                        />,
                        document.body
                    )
                }
            </div>
        );
    };



    // Helper to render dynamic properties
    const renderDynamicProperties = (children?: React.ReactNode) => {
        if (isLoadingProperties) {
            return <div className="text-xs p-2">Loading options...</div>;
        }

        if (selectedItem?.name === "LT Cubical Panel") {
            return renderLTCubicalPanel();
        }

        if (availableProperties.length === 0) {
            // Check if it's a load item
            if (selectedItem && LOAD_ITEM_DEFAULTS[selectedItem.name]) {
                return (
                    <div className="space-y-2">
                        {renderDropdown("Type", "Type", OPTIONS.TYPE)}

                        {/* Custom render for Power to handle " W" suffix stripping/adding */}
                        <div className="mb-3">
                            <label className="text-xs block mb-1 font-medium" style={{ color: colors.text, opacity: 0.8 }}>Power (W)</label>
                            {editMode ? (
                                <input
                                    type="number"
                                    min={0}
                                    max={10000}
                                    value={editedProperties["Power"] ? parseInt(editedProperties["Power"].replace(" W", "")) : 0}
                                    onChange={(e) => handlePropertyChange("Power", e.target.value + " W")}
                                    className="w-full px-3 py-2 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                />
                            ) : (
                                <div
                                    className="text-xs font-medium px-3 py-2 rounded-lg border bg-white/30 dark:bg-white/5 border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                >
                                    {editedProperties["Power"] || "—"}
                                </div>
                            )}
                        </div>

                        <div className="mb-3">
                            <label className="text-xs block mb-1 font-medium" style={{ color: colors.text, opacity: 0.8 }}>Description</label>
                            {editMode ? (
                                <input
                                    type="text"
                                    value={editedProperties["Description"] || ""}
                                    onChange={(e) => handlePropertyChange("Description", e.target.value)}
                                    className="w-full px-3 py-2 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                />
                            ) : (
                                <div
                                    className="text-xs font-medium px-3 py-2 rounded-lg border bg-white/30 dark:bg-white/5 border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                >
                                    {editedProperties["Description"] || "—"}
                                </div>
                            )}
                        </div>
                    </div>
                );
            }

            // Check if it's a Source item
            if (selectedItem && selectedItem.name === "Source") {
                return (
                    <div className="space-y-2">
                        {renderDropdown("Type", "Type", OPTIONS.SOURCE_TYPE)}
                        {renderDropdown("Voltage", "Voltage", OPTIONS.SOURCE_VOLTAGE)}
                        {renderDropdown("Frequency", "Frequency", OPTIONS.SOURCE_FREQUENCY)}
                    </div>
                );
            }

            // Check if it's a Text item
            if (selectedItem && selectedItem.name === "Text") {
                return (
                    <div className="space-y-3">
                        <div className="mb-3">
                            <label className="text-xs block mb-1 font-medium" style={{ color: colors.text, opacity: 0.8 }}>Content</label>
                            {editMode ? (
                                <textarea
                                    value={editedProperties["Text"] || ""}
                                    onChange={(e) => handlePropertyChange("Text", e.target.value)}
                                    className="w-full px-3 py-2 text-xs rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[60px] bg-white/50 dark:bg-black/20 border border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                    }}
                                />
                            ) : (
                                <div
                                    className="text-xs font-medium px-3 py-2 rounded-lg border whitespace-pre-wrap bg-white/30 dark:bg-white/5 border-white/20 dark:border-white/10"
                                    style={{
                                        color: colors.text,
                                        minHeight: '24px'
                                    }}
                                >
                                    {editedProperties["Text"] || "—"}
                                </div>
                            )}
                        </div>

                        {renderNumberInput("Font Size", "FontSize", 8, 72, editedProperties, handlePropertyChange, 10)}

                        {renderDropdown("Font Family", "FontFamily", ["Arial", "Verdana", "Times New Roman", "Courier New", "Georgia", "Tahoma", "Trebuchet MS"], editedProperties, handlePropertyChange)}

                        <div className="mb-3">
                            <label className="text-xs block mb-1" style={{ color: colors.text, opacity: 0.8 }}>Color</label>
                            {editMode ? (
                                <div className="flex gap-2">
                                    <input
                                        type="color"
                                        value={editedProperties["Color"] || "#000000"}
                                        onChange={(e) => handlePropertyChange("Color", e.target.value)}
                                        className="h-8 w-8 p-0 border-0 rounded cursor-pointer"
                                    />
                                    <input
                                        type="text"
                                        value={editedProperties["Color"] || "#000000"}
                                        onChange={(e) => handlePropertyChange("Color", e.target.value)}
                                        className="flex-1 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        style={{
                                            backgroundColor: colors.panelBackground,
                                            color: colors.text,
                                            borderColor: colors.border
                                        }}
                                    />
                                </div>
                            ) : (
                                <div className="flex items-center gap-2">
                                    <div
                                        className="w-4 h-4 rounded border border-gray-300"
                                        style={{ backgroundColor: editedProperties["Color"] || "#000000" }}
                                    />
                                    <span className="text-xs" style={{ color: colors.text }}>
                                        {editedProperties["Color"] || "#000000"}
                                    </span>
                                </div>
                            )}
                        </div>

                        {renderDropdown("Alignment", "Align", ["left", "center", "right"], editedProperties, handlePropertyChange)}

                        {/* Text Styling Toggles */}
                        <div className="mb-3">
                            <label className="text-xs block mb-2" style={{ color: colors.text, opacity: 0.8 }}>Text Style</label>
                            <div className="flex gap-2 flex-wrap">
                                {editMode ? (
                                    <>
                                        <button
                                            onClick={() => {
                                                const isBold = editedProperties["Bold"] === "true";
                                                handlePropertyChange("Bold", (!isBold).toString());
                                            }}
                                            className={`px-3 py-1 text-xs font-bold border rounded transition-colors ${editedProperties["Bold"] === "true"
                                                ? 'bg-blue-500 text-white border-blue-600'
                                                : 'border-gray-300'
                                                }`}
                                            style={{
                                                backgroundColor: editedProperties["Bold"] === "true" ? '#3b82f6' : colors.panelBackground,
                                                color: editedProperties["Bold"] === "true" ? '#ffffff' : colors.text,
                                                borderColor: editedProperties["Bold"] === "true" ? '#2563eb' : colors.border
                                            }}
                                        >
                                            B
                                        </button>
                                        <button
                                            onClick={() => {
                                                const isItalic = editedProperties["Italic"] === "true";
                                                handlePropertyChange("Italic", (!isItalic).toString());
                                            }}
                                            className={`px-3 py-1 text-xs italic border rounded transition-colors ${editedProperties["Italic"] === "true"
                                                ? 'bg-blue-500 text-white border-blue-600'
                                                : 'border-gray-300'
                                                }`}
                                            style={{
                                                backgroundColor: editedProperties["Italic"] === "true" ? '#3b82f6' : colors.panelBackground,
                                                color: editedProperties["Italic"] === "true" ? '#ffffff' : colors.text,
                                                borderColor: editedProperties["Italic"] === "true" ? '#2563eb' : colors.border
                                            }}
                                        >
                                            I
                                        </button>
                                        <button
                                            onClick={() => {
                                                const isUnderline = editedProperties["Underline"] === "true";
                                                handlePropertyChange("Underline", (!isUnderline).toString());
                                            }}
                                            className={`px-3 py-1 text-xs underline border rounded transition-colors ${editedProperties["Underline"] === "true"
                                                ? 'bg-blue-500 text-white border-blue-600'
                                                : 'border-gray-300'
                                                }`}
                                            style={{
                                                backgroundColor: editedProperties["Underline"] === "true" ? '#3b82f6' : colors.panelBackground,
                                                color: editedProperties["Underline"] === "true" ? '#ffffff' : colors.text,
                                                borderColor: editedProperties["Underline"] === "true" ? '#2563eb' : colors.border
                                            }}
                                        >
                                            U
                                        </button>
                                        <button
                                            onClick={() => {
                                                const isStrikethrough = editedProperties["Strikethrough"] === "true";
                                                handlePropertyChange("Strikethrough", (!isStrikethrough).toString());
                                            }}
                                            className={`px-3 py-1 text-xs line-through border rounded transition-colors ${editedProperties["Strikethrough"] === "true"
                                                ? 'bg-blue-500 text-white border-blue-600'
                                                : 'border-gray-300'
                                                }`}
                                            style={{
                                                backgroundColor: editedProperties["Strikethrough"] === "true" ? '#3b82f6' : colors.panelBackground,
                                                color: editedProperties["Strikethrough"] === "true" ? '#ffffff' : colors.text,
                                                borderColor: editedProperties["Strikethrough"] === "true" ? '#2563eb' : colors.border
                                            }}
                                        >
                                            S
                                        </button>
                                    </>
                                ) : (
                                    <div className="flex gap-2 text-xs" style={{ color: colors.text }}>
                                        {editedProperties["Bold"] === "true" && <span className="font-bold">Bold</span>}
                                        {editedProperties["Italic"] === "true" && <span className="italic">Italic</span>}
                                        {editedProperties["Underline"] === "true" && <span className="underline">Underline</span>}
                                        {editedProperties["Strikethrough"] === "true" && <span className="line-through">Strikethrough</span>}
                                        {!editedProperties["Bold"] && !editedProperties["Italic"] && !editedProperties["Underline"] && !editedProperties["Strikethrough"] && "None"}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            }

            // Fallback to generic if no dynamic properties found
            return renderGenericProperties();
        }

        const keys = Object.keys(availableProperties[0]).filter(k => k !== "Item" && k !== "Rate" && k !== "Description" && k !== "GS");

        return (
            <div className="space-y-2">
                {keys.map(key => {
                    const options = getFilteredOptions(key, editedProperties);

                    const dropdown = renderDropdown(
                        key,
                        key,
                        options.length > 0 ? options : ["Select..."],
                        editedProperties,
                        (k, v) => {
                            handlePropertyChange(k, v);
                        }
                    );

                    // Inject Alternative Companies after "Company"
                    if (key === "Company") {
                        // Get all unique companies for alternatives
                        const allCompanies = sortOptionStringsAsc(Array.from(new Set(availableProperties.map(r => r["Company"]).filter(Boolean))));

                        return (
                            <React.Fragment key={key}>
                                {dropdown}
                                <div className="mb-3">
                                    <label className="text-xs block mb-1" style={{ color: colors.text, opacity: 0.8 }}>Alternative Company - 1</label>
                                    {editMode ? (
                                        <div className="relative">
                                            <select
                                                value={editedAltComp1}
                                                onChange={(e) => handleAlternativeCompanyChange('alternativeCompany1', e.target.value)}
                                                className="w-full px-2 py-1 text-xs border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                style={{
                                                    backgroundColor: colors.panelBackground,
                                                    color: colors.text,
                                                    borderColor: colors.border
                                                }}
                                            >
                                                <option value="">Select...</option>
                                                {allCompanies.map(opt => (
                                                    <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                            </select>
                                            <div className="absolute right-2 top-1/2 transform -translate-y-1/2 pointer-events-none">
                                                <ChevronDown size={12} style={{ color: colors.text }} />
                                            </div>
                                        </div>
                                    ) : (
                                        <div
                                            className="text-xs font-medium px-2 py-1 rounded border"
                                            style={{
                                                backgroundColor: colors.panelBackground,
                                                color: colors.text,
                                                borderColor: colors.border
                                            }}
                                        >
                                            {editedAltComp1 || "—"}
                                        </div>
                                    )}
                                </div>
                                <div className="mb-3">
                                    <label className="text-xs block mb-1" style={{ color: colors.text, opacity: 0.8 }}>Alternative Company - 2</label>
                                    {editMode ? (
                                        <div className="relative">
                                            <select
                                                value={editedAltComp2}
                                                onChange={(e) => handleAlternativeCompanyChange('alternativeCompany2', e.target.value)}
                                                className="w-full px-2 py-1 text-xs border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                style={{
                                                    backgroundColor: colors.panelBackground,
                                                    color: colors.text,
                                                    borderColor: colors.border
                                                }}
                                            >
                                                <option value="">Select...</option>
                                                {allCompanies.map(opt => (
                                                    <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                            </select>
                                            <div className="absolute right-2 top-1/2 transform -translate-y-1/2 pointer-events-none">
                                                <ChevronDown size={12} style={{ color: colors.text }} />
                                            </div>
                                        </div>
                                    ) : (
                                        <div
                                            className="text-xs font-medium px-2 py-1 rounded border"
                                            style={{
                                                backgroundColor: colors.panelBackground,
                                                color: colors.text,
                                                borderColor: colors.border
                                            }}
                                        >
                                            {editedAltComp2 || "—"}
                                        </div>
                                    )}
                                </div>
                            </React.Fragment>
                        );
                    }

                    return <React.Fragment key={key}>{dropdown}</React.Fragment>;
                })}

                {/* Point Switch Board Accessories */}
                {selectedItem && selectedItem.name === "Point Switch Board" && (
                    <div className="border-t pt-2 mt-2">
                        <label className="text-xs font-semibold block mb-2" style={{ color: colors.text }}>Accessories</label>

                        <div className="grid grid-cols-2 gap-2 mb-2 items-center">
                            <label className="text-xs" style={{ color: colors.text }}>Orboard Required:</label>
                            {renderCheckbox("", "orboard_required", editedAccessories, handleAccessoryChange)}
                        </div>

                        <div className="grid grid-cols-2 gap-2 mb-2 items-center">
                            <label className="text-xs" style={{ color: colors.text }}>Number of Onboard:</label>
                            {renderNumberInput("", "number_of_onboard", 1, 4, editedAccessories, handleAccessoryChange, 1)}
                        </div>
                    </div>
                )}

                {/* Main Switch / VTPN / HTPN Accessories */}
                {selectedItem && (
                    (selectedItem.name === "Main Switch" && editedProperties["Type"] === "TPN SFU") ||
                    selectedItem.name.includes("VTPN") ||
                    selectedItem.name.includes("HTPN")
                ) && (
                        <div className="border-t pt-2 mt-2">
                            <label className="text-xs font-semibold block mb-2" style={{ color: colors.text }}>Accessories</label>

                            <div className="grid grid-cols-2 gap-2 mb-2 items-center">
                                <label className="text-xs" style={{ color: colors.text }}>Endbox Required:</label>
                                {renderCheckbox("", "endbox_required", editedAccessories, handleAccessoryChange)}
                            </div>

                            <div className="grid grid-cols-2 gap-2 mb-2 items-center">
                                <label className="text-xs" style={{ color: colors.text }}>Number of Endbox:</label>
                                {renderNumberInput("", "number_of_endbox", 1, 2, editedAccessories, handleAccessoryChange, 2)}
                            </div>
                        </div>
                    )}

                {children}

                {/* Always render generic inputs for Rate, Description if they exist in the data or are standard */}
                <div className="mb-3">
                    <label className="text-xs block mb-1" style={{ color: colors.text, opacity: 0.8 }}>Rate</label>
                    <div
                        className="text-xs font-medium px-2 py-1 rounded border"
                        style={{
                            backgroundColor: colors.panelBackground,
                            color: colors.text,
                            borderColor: colors.border
                        }}
                    >
                        {/* Rate is usually determined by the combination of properties */}
                        {(() => {
                            // Find the row that matches all current selections
                            const match = availableProperties.find(row =>
                                keys.every(k => row[k] === editedProperties[k])
                            );
                            return match ? match["Rate"] : "—";
                        })()}
                    </div>
                </div>
            </div>
        );
    };

    // New Render Helper for Laying
    const renderLayingProperties = () => {
        if (layingOptions.length === 0) return null;

        const keys = Object.keys(layingOptions[0]).filter(k => k !== "Item" && k !== "Rate" && k !== "Description" && k !== "GS");

        // Helper to filter laying options
        const getFilteredLayingOptions = (key: string, currentValues: Record<string, string>) => {
            const keyIndex = keys.indexOf(key);
            if (keyIndex === -1) return [];

            const precedingKeys = keys.slice(0, keyIndex);
            const filteredRows = layingOptions.filter(row => {
                return precedingKeys.every(prevKey => {
                    const selectedValue = currentValues[prevKey];
                    return !selectedValue || row[prevKey] === selectedValue;
                });
            });

            return sortOptionStringsAsc(Array.from(new Set(filteredRows.map(r => r[key]).filter(Boolean))));
        };

        const handleLayingChange = (key: string, value: string) => {
            const newLaying = { ...editedLaying, [key]: value };
            // Auto-clear downstream
            const keyIndex = keys.indexOf(key);
            if (keyIndex !== -1 && keyIndex < keys.length - 1) {
                const subsequentKeys = keys.slice(keyIndex + 1);
                subsequentKeys.forEach(subKey => {
                    const currentVal = newLaying[subKey];
                    if (currentVal) {
                        const validOptions = getFilteredLayingOptions(subKey, newLaying);
                        if (!validOptions.includes(currentVal)) {
                            newLaying[subKey] = "";
                        }
                    }
                });
            }
            setEditedLaying(newLaying);
        };

        return (
            <div className="mt-4 pt-4 border-t border-gray-200">
                <h4 className="text-xs font-bold mb-2" style={{ color: colors.text }}>Laying Details</h4>
                {keys.map(key => (
                    renderDropdown(
                        key,
                        key,
                        getFilteredLayingOptions(key, editedLaying).length > 0 ? getFilteredLayingOptions(key, editedLaying) : ["Select..."],
                        editedLaying,
                        handleLayingChange
                    )
                ))}
            </div>
        );
    };

    // Helper to render DB specific properties (Page 2 equivalent)
    const renderDBProperties = () => {
        if (!selectedItem || !currentSheet) return null;

        const isSPN = selectedItem.name === "SPN DB";
        const isHTPN = selectedItem.name.includes("HTPN");
        const isVTPN = selectedItem.name.includes("VTPN") || selectedItem.name.includes("Cubicle Panel");

        if (!isSPN && !isHTPN && !isVTPN) return null;

        // Parse Way
        let ways = 0;
        const wayStr = editedProperties["Way"] || "0";
        if (isSPN) {
            const match = wayStr.match(/(?<=2\+)\d+/);
            ways = match ? parseInt(match[0]) : 0;
        } else {
            const match = wayStr.match(/\d+/);
            ways = match ? parseInt(match[0]) : 0;
        }

        if (ways === 0) return <div className="text-xs text-red-500">Invalid Way selection</div>;

        // Get Connected Connectors
        const incomingConnectors = currentSheet.storedConnectors.filter(c => c.targetItem.uniqueID === selectedItem.uniqueID);
        const outgoingConnectors = currentSheet.storedConnectors.filter(c => c.sourceItem.uniqueID === selectedItem.uniqueID);

        // Calculate Max Incoming Load
        let maxIncomingLoad = "0 A";
        if (incomingConnectors.length > 0) {
            const c = incomingConnectors[0];
            if (c.currentValues) {
                const r = parseFloat(c.currentValues["R_Current"]?.replace(" A", "") || "0");
                const y = parseFloat(c.currentValues["Y_Current"]?.replace(" A", "") || "0");
                const b = parseFloat(c.currentValues["B_Current"]?.replace(" A", "") || "0");
                maxIncomingLoad = Math.max(r, y, b).toFixed(2) + " A";
            }
        }

        return (
            <div className="space-y-4">
                {/* Incomer Section */}
                <div className="border-b pb-2">
                    <h4 className="text-xs font-bold mb-2" style={{ color: colors.text }}>Incomer</h4>
                    <div className="mb-2">
                        <label className="text-xs block mb-1" style={{ color: colors.text, opacity: 0.8 }}>
                            Select I/C (Max load: {maxIncomingLoad})
                        </label>
                        {editMode ? (
                            <div className="relative">
                                <select
                                    value={editedIncomer["Current Rating"] || ""}
                                    onChange={(e) => handleIncomerChange("Current Rating", e.target.value)}
                                    className="w-full px-2 py-1 text-xs border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    style={{
                                        backgroundColor: colors.panelBackground,
                                        color: colors.text,
                                        borderColor: colors.border
                                    }}
                                >
                                    <option value="">Select...</option>
                                    {dbIncomerOptions.map(opt => (
                                        <option key={opt} value={opt}>{opt}</option>
                                    ))}
                                </select>
                                <div className="absolute right-2 top-1/2 transform -translate-y-1/2 pointer-events-none">
                                    <ChevronDown size={12} style={{ color: colors.text }} />
                                </div>
                            </div>
                        ) : (
                            <div
                                className="text-xs font-medium px-2 py-1 rounded border"
                                style={{
                                    backgroundColor: colors.panelBackground,
                                    color: colors.text,
                                    borderColor: colors.border
                                }}
                            >
                                {editedIncomer["Current Rating"] || "—"}
                            </div>
                        )}
                    </div>
                </div>

                {/* Outgoing Section */}
                <div>
                    <h4 className="text-xs font-bold mb-2" style={{ color: colors.text }}>Outgoing Ways</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                        {Array.from({ length: ways }).map((_, i) => {
                            const index = i + 1;
                            let label = `O/G-${index}`;
                            let maxLoad = "0 A";
                            let phaseColor = colors.text;
                            let bgColor = "transparent";
                            let textColor = colors.text;

                            // HTPN Phase Logic
                            if (isHTPN) {
                                const phases = ["R", "Y", "B"];
                                const phase = phases[i % 3]; // Simplified distribution, ideally matches connector point
                                label = `O/G ${phase}-${Math.ceil((i + 1) / 3)}`;

                                if (phase === "R") { bgColor = "#DB7093"; textColor = "white"; } // PaleVioletRed
                                else if (phase === "Y") { bgColor = "#FFD700"; textColor = "black"; } // Gold
                                else if (phase === "B") { bgColor = "#00008B"; textColor = "white"; } // DarkBlue
                            }

                            // Find outgoing connector for this way
                            // Note: This relies on sourcePointKey convention "out{i}" or "out{i}_{phase}"
                            // We need to match the logic in NetworkAnalyzer/C# to find the specific connector
                            let connector: Connector | undefined;

                            if (isHTPN) {
                                // HTPN logic: check for phase specific keys
                                // In C#: out{i}_{phase} where i resets per phase? No, i is 1..way
                                // Let's look at HTPNHandler.cs: key = $"out{i}_{phase}"
                                // But wait, the loop in HTPNHandler is:
                                // foreach phase { for i=1 to way } -> so there are way * 3 outputs?
                                // Re-reading HTPNHandler.cs:
                                // svgDocument.Width = 56 * way * 3;
                                // It seems HTPN has 'way' number of TPN sets? Or 'way' per phase?
                                // C# HTPNHandler line 74: for (int i = 1; i <= way; i++) inside foreach phase.
                                // So yes, 3 * way outgoing circuits.
                                // But here 'ways' parsed from property usually means "Total Ways" or "Ways per phase"?
                                // In C# PropertyEditor line 611: for (int i = 0; i < wayValue; i++) inside foreach phase.
                                // So it renders wayValue * 3 dropdowns.

                                // For now, let's stick to the simple loop. If HTPN, we might need a nested loop or adjust 'ways'.
                                // If 'Way' property says "4 Way TPN", does it mean 4 TP ways or 12 SP ways?
                                // Usually TPN DB means 4 TP ways.
                                // But HTPNHandler seems to generate SP outputs for each phase.
                            } else {
                                // SPN/VTPN logic
                                const key = `out${index}`;
                                connector = outgoingConnectors.find(c => c.sourcePointKey?.startsWith(key));
                            }

                            // HTPN Special Handling for Loop
                            // If HTPN, we shouldn't use the simple map. We should probably render by phase.
                            // But to keep it simple in this first pass, let's just try to find *any* connector.

                            if (connector && connector.currentValues) {
                                // For SP outgoing, we just want the total current (which is single phase)
                                const cur = parseFloat(connector.currentValues["Current"]?.replace(" A", "") || "0");
                                maxLoad = cur.toFixed(2) + " A";
                            }

                            return (
                                <div key={i} className="mb-2">
                                    <label
                                        className="text-[10px] block mb-1 px-1 rounded"
                                        style={{
                                            color: textColor,
                                            backgroundColor: bgColor,
                                            opacity: bgColor === "transparent" ? 0.8 : 1
                                        }}
                                    >
                                        {label} (Max: {maxLoad})
                                    </label>
                                    {editMode ? (
                                        <select
                                            value={editedOutgoing[i]?.["Current Rating"] || ""}
                                            onChange={(e) => handleOutgoingChange(i, "Current Rating", e.target.value)}
                                            className="w-full px-1 py-1 text-xs border rounded appearance-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                                            style={{
                                                backgroundColor: colors.panelBackground,
                                                color: colors.text,
                                                borderColor: colors.border
                                            }}
                                        >
                                            <option value="">Select...</option>
                                            {dbOutgoingOptions.map(opt => (
                                                <option key={opt} value={opt}>{opt}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <div
                                            className="text-xs font-medium px-2 py-1 rounded border"
                                            style={{
                                                backgroundColor: colors.panelBackground,
                                                color: colors.text,
                                                borderColor: colors.border
                                            }}
                                        >
                                            {editedOutgoing[i]?.["Current Rating"] || "—"}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    };

    // HTPN Specific Render (Override if HTPN)
    const renderHTPNProperties = () => {
        if (!selectedItem || !currentSheet || !selectedItem.name.includes("HTPN")) return null;

        const wayStr = editedProperties["Way"] || "0";
        const match = wayStr.match(/\d+/);
        const ways = match ? parseInt(match[0]) : 0;

        if (ways === 0) return <div className="text-xs text-red-500">Invalid Way selection</div>;

        const outgoingConnectors = currentSheet.storedConnectors.filter(c => c.sourceItem.uniqueID === selectedItem.uniqueID);

        // Calculate Max Incoming Load (Same as generic)
        const incomingConnectors = currentSheet.storedConnectors.filter(c => c.targetItem.uniqueID === selectedItem.uniqueID);
        let maxIncomingLoad = "0 A";
        if (incomingConnectors.length > 0) {
            const c = incomingConnectors[0];
            if (c.currentValues) {
                const r = parseFloat(c.currentValues["R_Current"]?.replace(" A", "") || "0");
                const y = parseFloat(c.currentValues["Y_Current"]?.replace(" A", "") || "0");
                const b = parseFloat(c.currentValues["B_Current"]?.replace(" A", "") || "0");
                maxIncomingLoad = Math.max(r, y, b).toFixed(2) + " A";
            }
        }

        const phases = [
            { name: "Red Phase", code: "R", color: "#DB7093", text: "white" },
            { name: "Yellow Phase", code: "Y", color: "#FFD700", text: "black" },
            { name: "Blue Phase", code: "B", color: "#00008B", text: "white" }
        ];

        return (
            <div className="space-y-4">
                {/* Incomer Section */}
                <div className="border-b pb-2">
                    <h4 className="text-xs font-bold mb-2" style={{ color: colors.text }}>Incomer</h4>
                    <div className="mb-2">
                        <label className="text-xs block mb-1" style={{ color: colors.text, opacity: 0.8 }}>
                            Select I/C (Max load: {maxIncomingLoad})
                        </label>
                        {editMode ? (
                            <div className="relative">
                                <select
                                    value={editedIncomer["Current Rating"] || ""}
                                    onChange={(e) => handleIncomerChange("Current Rating", e.target.value)}
                                    className="w-full px-2 py-1 text-xs border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    style={{
                                        backgroundColor: colors.panelBackground,
                                        color: colors.text,
                                        borderColor: colors.border
                                    }}
                                >
                                    <option value="">Select...</option>
                                    {dbIncomerOptions.map(opt => (
                                        <option key={opt} value={opt}>{opt}</option>
                                    ))}
                                </select>
                                <div className="absolute right-2 top-1/2 transform -translate-y-1/2 pointer-events-none">
                                    <ChevronDown size={12} style={{ color: colors.text }} />
                                </div>
                            </div>
                        ) : (
                            <div
                                className="text-xs font-medium px-2 py-1 rounded border"
                                style={{
                                    backgroundColor: colors.panelBackground,
                                    color: colors.text,
                                    borderColor: colors.border
                                }}
                            >
                                {editedIncomer["Current Rating"] || "—"}
                            </div>
                        )}
                    </div>
                </div>

                {phases.map((phase, phaseIndex) => (
                    <div key={phase.name} className="border-b pb-2 last:border-0">
                        <h4 className="text-xs font-bold mb-2" style={{ color: phase.color }}>{phase.name}</h4>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                            {Array.from({ length: ways }).map((_, i) => {
                                const index = i + 1;
                                // Calculate global index for editedOutgoing array
                                // HTPNHandler.cs fills outgoing group sequentially: R1..Rn, Y1..Yn, B1..Bn
                                // So R is 0..ways-1, Y is ways..2*ways-1, B is 2*ways..3*ways-1
                                const globalIndex = (phaseIndex * ways) + i;

                                const label = `O/G ${phase.code}-${index}`;

                                // Find connector
                                // HTPNHandler.cs key: $"out{i}_{phase.name}"
                                const key = `out${index}_${phase.name}`;
                                const connector = outgoingConnectors.find(c => c.sourcePointKey === key);

                                let maxLoad = "0 A";
                                if (connector && connector.currentValues) {
                                    const cur = parseFloat(connector.currentValues["Current"]?.replace(" A", "") || "0");
                                    maxLoad = cur.toFixed(2) + " A";
                                }

                                return (
                                    <div key={globalIndex} className="mb-2">
                                        <label
                                            className="text-[10px] block mb-1 px-1 rounded"
                                            style={{
                                                color: phase.text,
                                                backgroundColor: phase.color,
                                            }}
                                        >
                                            {label} (Max: {maxLoad})
                                        </label>
                                        {editMode ? (
                                            <select
                                                value={editedOutgoing[globalIndex]?.["Current Rating"] || ""}
                                                onChange={(e) => handleOutgoingChange(globalIndex, "Current Rating", e.target.value)}
                                                className="w-full px-1 py-1 text-xs border rounded appearance-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                style={{
                                                    backgroundColor: colors.panelBackground,
                                                    color: colors.text,
                                                    borderColor: colors.border
                                                }}
                                            >
                                                <option value="">Select...</option>
                                                {dbOutgoingOptions.map(opt => (
                                                    <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <div
                                                className="text-xs font-medium px-2 py-1 rounded border"
                                                style={{
                                                    backgroundColor: colors.panelBackground,
                                                    color: colors.text,
                                                    borderColor: colors.border
                                                }}
                                            >
                                                {editedOutgoing[globalIndex]?.["Current Rating"] || "—"}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    if ((!selectedItem && !selectedConnector) || !isPropertiesPanelOpen) {
        return null;
    }

    // Check for fixed spec connectors (Point Switch Board / Avg 5A Switch Board)
    const isFixedSpecConnector = selectedConnector && (
        selectedConnector.sourceItem.name === "Point Switch Board" ||
        selectedConnector.targetItem.name === "Point Switch Board" ||
        selectedConnector.sourceItem.name === "Avg. 5A Switch Board" ||
        selectedConnector.targetItem.name === "Avg. 5A Switch Board"
    );

    if (isFixedSpecConnector) {
        return (
            <div className="h-full flex flex-col" style={{ backgroundColor: colors.panelBackground }}>
                <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: colors.border }}>
                    <h2 className="font-semibold text-sm" style={{ color: colors.text }}>Connection Properties</h2>
                </div>
                <div className="p-4 text-xs italic opacity-60" style={{ color: colors.text }}>
                    Properties for this connection are fixed and cannot be modified.
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col" style={{ backgroundColor: colors.panelBackground }}>
            <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: colors.border }}>
                <h2 className="font-semibold text-sm" style={{ color: colors.text }}>
                    {selectedItem ? selectedItem.name : (selectedConnector?.materialType === "Wiring" ? "Wire Properties" : "Cable Properties")}
                </h2>
                {editMode ? (
                    <div className="flex gap-2">
                        <button onClick={handleSave} className="text-green-600 hover:text-green-700" title="Save">
                            <Save size={16} />
                        </button>
                        <button onClick={handleCancel} className="text-red-600 hover:text-red-700" title="Cancel">
                            <X size={16} />
                        </button>
                    </div>
                ) : (
                    <button
                        onClick={() => setEditMode(true)}
                        className="text-blue-600 hover:text-blue-700 text-xs font-medium"
                    >
                        Edit
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-y-auto p-3">
                {selectedItem && (
                    <>
                        {/* Page 1: Main Properties */}
                        {renderDynamicProperties()}

                        {/* Page 2: DB Specifics */}
                        {selectedItem.name.includes("HTPN") ? renderHTPNProperties() : renderDBProperties()}

                        {/* Add other item specific renders here if needed */}
                    </>
                )}

                {selectedConnector && (
                    <div className="space-y-2">
                        {renderDynamicProperties()}

                        {/* Length Input */}
                        {renderNumberInput("Length (m)", "Length", 0, 1000, editedProperties, handlePropertyChange, 0)}

                        {/* Cable Specifics */}
                        {selectedConnector.materialType === "Cable" && (
                            <>
                                <div className="mt-4 pt-4 border-t border-gray-200">
                                    <h4 className="text-xs font-bold mb-2" style={{ color: colors.text }}>Accessories</h4>
                                    {renderCheckbox("Glands Required", "glands_required", editedAccessories, handleAccessoryChange)}
                                    {editedAccessories["glands_required"] === "true" &&
                                        renderNumberInput("Number of Glands", "number_of_glands", 1, 2, editedAccessories, handleAccessoryChange, 2)
                                    }

                                    {/* Finishing Cable Ends */}
                                    {renderCheckbox("Finishing Required", "finishing_required", editedAccessories, handleAccessoryChange)}
                                    {editedAccessories["finishing_required"] === "true" && (
                                        <>
                                            {renderNumberInput("Number of Ends", "number_of_finishing", 1, 2, editedAccessories, handleAccessoryChange, 2)}
                                            {renderDropdown("Method", "finishing_method", OPTIONS.FINISHING_METHOD, editedAccessories, handleAccessoryChange)}
                                        </>
                                    )}
                                </div>
                                {renderLayingProperties()}
                            </>
                        )}


                    </div>
                )}
            </div>
        </div>
    );
});
