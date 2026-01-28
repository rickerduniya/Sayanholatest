import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useStore } from '../store/useStore';
import { useTheme } from '../context/ThemeContext';
import { chatService, ChatMessage, DiagramCallbacks } from '../services/ChatService';
import { api } from '../services/api';
import { CanvasItem, Connector, ItemData } from '../types';
import { getItemDefinition, LOAD_ITEM_DEFAULTS, DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { Send, X, Bot, User, Loader2, PlusCircle, Database, Cpu, Zap, ChevronDown, ChevronRight, Wrench, Paperclip, Camera, Trash2, Eye } from 'lucide-react';
import { sortOptionStringsAsc } from '../utils/sortUtils';
import { fetchProperties } from '../utils/api';
import { createConnectorWithDefaults } from '../utils/ConnectorFactory';
import { applyAutoArrange } from '../utils/AutoArrange';


export const ChatPanel = () => {
    const {
        isChatOpen,
        toggleChat,
        sheets,
        addItem,
        addConnector,
        deleteItem,
        calculateNetwork,
        activeSheetId,
        setActiveSheet,
        addSheet,
        removeSheet,
        renameSheet,
        moveItems,
        updateItemProperties,
        updateItemTransform,
        updateItemLock,
        duplicateItem,
        updateConnector,
        takeSnapshot,
        updateSheet,
        undo,
        redo,
        getCurrentSheet,
        selectedItemIds,
        selectedConnectorIndices,
        canvasSnapshotCallback
    } = useStore();
    const { colors } = useTheme();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isDbMode, setIsDbMode] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
    const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [availableItems, setAvailableItems] = useState<ItemData[]>([]);

    const [pendingImages, setPendingImages] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);


    // Show toast notification
    const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            if (!file.type.startsWith('image/')) {
                showToast('Please select an image file', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = (evt) => {
                const dataUrl = evt.target?.result as string;
                if (dataUrl) {
                    setPendingImages(prev => [...prev, dataUrl]);
                }
            };
            reader.readAsDataURL(file);
        }
        // Reset input
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleCaptureView = async () => {
        if (!canvasSnapshotCallback) {
            showToast('Canvas capture not available yet', 'error');
            return;
        }

        showToast('Capturing view...', 'info');
        try {
            const dataUrl = await canvasSnapshotCallback();
            if (dataUrl) {
                setPendingImages(prev => [...prev, dataUrl]);
                showToast('View captured!', 'success');
            } else {
                showToast('Failed to capture view', 'error');
            }
        } catch (e) {
            console.error(e);
            showToast('Error capturing view', 'error');
        }
    };

    const removePendingImage = (index: number) => {
        setPendingImages(prev => prev.filter((_, i) => i !== index));
    };

    // Calculate selected context
    const selectedCount = (selectedItemIds?.length || 0) + (selectedConnectorIndices?.length || 0);

    const insertSelectionContext = useCallback(() => {
        const currentSheet = getCurrentSheet();
        if (!currentSheet) return;

        let contextStr = "";

        // Add items
        if (selectedItemIds && selectedItemIds.length > 0) {
            selectedItemIds.forEach(id => {
                const item = currentSheet.canvasItems.find(i => i.uniqueID === id);
                if (item) {
                    const props = item.properties?.[0] || {};
                    const propStr = Object.entries(props)
                        .filter(([k, v]) => v && !['Label', 'NetId', 'Direction'].includes(k))
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ');
                    contextStr += `[Context: ${item.name} (ID: ${item.uniqueID.substring(0, 8)})${propStr ? ` - ${propStr}` : ''}] `;
                }
            });
        }

        // Add connectors
        if (selectedConnectorIndices && selectedConnectorIndices.length > 0) {
            selectedConnectorIndices.forEach(idx => {
                if (idx >= 0) {
                    const conn = currentSheet.storedConnectors[idx];
                    if (conn) {
                        const source = conn.sourceItem?.name || 'Unknown';
                        const target = conn.targetItem?.name || 'Unknown';
                        contextStr += `[Context: Connection ${source}->${target}] `;
                    }
                }
            });
        }

        if (contextStr) {
            setInput(prev => prev + (prev ? " " : "") + contextStr);
            if (textareaRef.current) textareaRef.current.focus();
        }
    }, [selectedItemIds, selectedConnectorIndices, getCurrentSheet]);

    // Fetch available items on mount
    useEffect(() => {
        const fetchItems = async () => {
            try {
                const items = await api.getItems();
                setAvailableItems(items);
            } catch (e) {
                console.error('Failed to fetch items for AI assistant', e);
            }
        };
        fetchItems();
    }, []);



    // Add item helper for AI
    const addItemHelper = useCallback(async (itemName: string, position?: { x: number; y: number }, properties?: Record<string, any>): Promise<CanvasItem | null> => {
        if (itemName === "Text") {
            const newItem: CanvasItem = {
                uniqueID: crypto.randomUUID(),
                name: "Text",
                position: position || { x: 300, y: 300 },
                size: { width: 150, height: 50 },
                connectionPoints: {},
                properties: [{
                    "Text": "New Text",
                    "FontSize": "16",
                    "FontFamily": "Arial",
                    "Color": "default",
                    "Align": "left",
                    ...(properties || {})
                }],
                alternativeCompany1: '',
                alternativeCompany2: '',
                locked: false,
                idPoints: {},
                incomer: {},
                outgoing: [],
                accessories: []
            };
            addItem(newItem);
            return newItem;
        }

        const itemData = availableItems.find(i =>
            i.name.toLowerCase() === itemName.toLowerCase() ||
            i.name.toLowerCase().includes(itemName.toLowerCase())
        );

        if (!itemData) {
            console.error(`Item "${itemName}" not found in available items`);
            return null;
        }

        const currentSheet = getCurrentSheet();
        const scale = currentSheet?.scale || 1;

        // Create new item
        const newItem: CanvasItem = {
            uniqueID: crypto.randomUUID(),
            name: itemData.name,
            position: position || { x: 300, y: 300 },
            size: itemData.size,
            connectionPoints: itemData.connectionPoints,
            properties: [],
            alternativeCompany1: '',
            alternativeCompany2: '',
            svgContent: undefined,
            iconPath: itemData.iconPath,
            locked: false,
            idPoints: {},
            incomer: {},
            outgoing: [],
            accessories: []
        };

        try {
            // Fetch properties
            const props = await api.getItemProperties(itemData.name, 1);
            if (props?.properties && props.properties.length > 0) {
                newItem.properties = [props.properties[0]];
            } else if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }
            newItem.alternativeCompany1 = props?.alternativeCompany1 || '';
            newItem.alternativeCompany2 = props?.alternativeCompany2 || '';
        } catch (err) {
            console.error('Failed to load properties', err);
            if (LOAD_ITEM_DEFAULTS[newItem.name]) {
                newItem.properties = [{ ...LOAD_ITEM_DEFAULTS[newItem.name] }];
            }
        }

        // Fetch SVG Content
        if (itemData.iconPath) {
            try {
                const iconName = itemData.iconPath.split('/').pop();
                const url = api.getIconUrl(iconName!);
                const encodedUrl = encodeURI(url);
                const response = await fetch(encodedUrl);
                if (response.ok) {
                    newItem.svgContent = await response.text();
                }
            } catch (e) {
                console.error("Failed to fetch SVG content", e);
            }
        }

        // Apply local definitions for static items
        const staticDef = getItemDefinition(newItem.name);
        if (staticDef && !["HTPN", "VTPN", "SPN DB"].includes(newItem.name)) {
            newItem.size = staticDef.size;
            newItem.connectionPoints = staticDef.connectionPoints;
        }

        // Initialize Distribution Boards and Switches
        if (["HTPN", "VTPN", "SPN DB", "Main Switch", "Change Over Switch", "Point Switch Board"].includes(newItem.name)) {
            if (!newItem.properties[0]) newItem.properties[0] = {};
            let wayVal = newItem.properties[0]["Way"];
            if (!wayVal || wayVal.includes(',')) {
                if (newItem.name === "SPN DB") wayVal = "2+4";
                else wayVal = "4";
            }
            newItem.properties[0]["Way"] = wayVal;

            try {
                const initData = await api.initializeItem(newItem.name, newItem.properties);
                if (initData) {
                    if (initData.incomer) newItem.incomer = initData.incomer;
                    if (initData.outgoing) newItem.outgoing = initData.outgoing;
                    if (initData.accessories) newItem.accessories = initData.accessories;
                }
            } catch (err) {
                console.error(`[ChatPanel] Failed to initialize item accessories:`, err);
            }

            if (["HTPN", "VTPN", "SPN DB"].includes(newItem.name)) {
                const threshold = DefaultRulesEngine.getDefaultOutgoingThreshold(newItem.name);
                if (threshold > 0 && newItem.outgoing && newItem.outgoing.length > 0) {
                    const parseRating = (s: string) => {
                        const m = (s || '').toString().match(/(\d+(?:\.\d+)?)/);
                        return m ? parseFloat(m[1]) : NaN;
                    };

                    let defaultRating = "";
                    try {
                        const pole = newItem.name === "VTPN" ? "TP" : "SP";
                        const mcb = await fetchProperties("MCB");

                        const allRatings = sortOptionStringsAsc(
                            Array.from(new Set(
                                (mcb.properties || [])
                                    .map(p => p["Current Rating"])
                                    .filter(Boolean)
                            ))
                        );

                        const poleRatingsRaw = (mcb.properties || [])
                            .filter(p => {
                                const pPole = (p["Pole"] || "").toString();
                                if (!pPole) return false;
                                return pPole === pole || pPole.includes(pole);
                            })
                            .map(p => p["Current Rating"])
                            .filter(Boolean);
                        const poleRatings = sortOptionStringsAsc(Array.from(new Set(poleRatingsRaw)));
                        const ratings = poleRatings.length > 0 ? poleRatings : allRatings;

                        defaultRating = ratings.find(r => {
                            const v = parseRating(r);
                            return Number.isFinite(v) && v >= threshold;
                        }) || ratings[0] || "";
                    } catch (e) {
                        console.error('[ChatPanel] Failed to fetch outgoing rating options for defaults', e);
                    }

                    if (defaultRating) {
                        newItem.outgoing = newItem.outgoing.map(o => ({ ...(o || {}), "Current Rating": defaultRating }));
                    }
                }
            }

            const result = calculateGeometry(newItem);
            if (result) {
                newItem.size = result.size;
                newItem.connectionPoints = result.connectionPoints;
            }
        }

        // Update visuals if needed
        if (newItem.svgContent && newItem.properties[0]) {
            const updatedSvg = updateItemVisuals(newItem);
            if (updatedSvg) {
                newItem.svgContent = updatedSvg;
            }
        }

        // Add item to canvas
        addItem(newItem);
        return newItem;
    }, [availableItems, addItem, getCurrentSheet]);

    const connectItemsHelper = useCallback(async (args: {
        sourceItemId: string;
        sourcePointKey: string;
        targetItemId: string;
        targetPointKey: string;
        materialType?: 'Cable' | 'Wiring';
    }): Promise<{ connector: Connector; connectorIndex: number } | { error: string }> => {
        const currentSheet = getCurrentSheet();
        if (!currentSheet) return { error: 'No active sheet.' };
        if (!addConnector) return { error: 'Connector action not available.' };

        const sourceItem = currentSheet.canvasItems.find(i => i.uniqueID === args.sourceItemId);
        const targetItem = currentSheet.canvasItems.find(i => i.uniqueID === args.targetItemId);
        if (!sourceItem || !targetItem) return { error: 'Source or target item not found on the active sheet.' };

        if (!sourceItem.connectionPoints?.[args.sourcePointKey]) {
            return { error: `Invalid sourcePointKey: ${args.sourcePointKey}` };
        }
        if (!targetItem.connectionPoints?.[args.targetPointKey]) {
            return { error: `Invalid targetPointKey: ${args.targetPointKey}` };
        }

        const beforeCount = currentSheet.storedConnectors.length;
        const result = await createConnectorWithDefaults({
            activeSheet: currentSheet,
            allSheets: sheets,
            sourceItem,
            sourcePointKey: args.sourcePointKey,
            targetItem,
            targetPointKey: args.targetPointKey,
            materialType: args.materialType || 'Cable'
        });

        if (result.error) return { error: result.error };
        if (!result.connector) return { error: 'Failed to create connector.' };

        if (result.warnings && result.warnings.length > 0) {
            showToast(result.warnings.join('\n'), 'info');
        }

        addConnector(result.connector);
        const updated = useStore.getState().getCurrentSheet();
        const created = updated?.storedConnectors[beforeCount];
        if (!created) return { error: 'Connector was not added.' };
        return { connector: created, connectorIndex: beforeCount };
    }, [getCurrentSheet, addConnector, sheets, showToast]);

    const autoLayoutActiveSheet = useCallback(() => {
        const sheet = getCurrentSheet();
        if (!sheet) return;
        takeSnapshot();
        const newItems = applyAutoArrange(sheet.canvasItems, sheet.storedConnectors);
        updateSheet({ canvasItems: newItems });
        calculateNetwork();
    }, [getCurrentSheet, takeSnapshot, updateSheet, calculateNetwork]);

    // Setup diagram callbacks for ChatService
    useEffect(() => {
        if (isChatOpen) {
            const callbacks: DiagramCallbacks = {
                addItem: addItemHelper,
                deleteItem: (itemId: string) => deleteItem(itemId),
                calculateNetwork: () => calculateNetwork(),
                getSheets: () => sheets,
                getCurrentSheet: () => getCurrentSheet(),
                getActiveSheetId: () => activeSheetId,
                setActiveSheet: (id: string) => setActiveSheet(id),
                addSheet: (name?: string) => addSheet(name),
                renameSheet: (id: string, name: string) => renameSheet(id, name),
                removeSheet: (id: string) => removeSheet(id),
                moveItems: (moves) => {
                    if (!moves || moves.length === 0) return;
                    takeSnapshot();
                    moveItems(moves.map(m => ({ id: m.itemId, x: m.x, y: m.y })));
                    calculateNetwork();
                },
                updateItemProperties: (id: string, props: Record<string, string>) => updateItemProperties(id, props),
                updateItemTransform: (id: string, x: number, y: number, w: number, h: number, r: number) => updateItemTransform(id, x, y, w, h, r),
                updateItemLock: (id: string, locked: boolean) => updateItemLock(id, locked),
                updateItemFields: (id: string, updates: Partial<Pick<CanvasItem, 'incomer' | 'outgoing' | 'accessories' | 'alternativeCompany1' | 'alternativeCompany2'>>) => {
                    const sheet = useStore.getState().getCurrentSheet();
                    if (!sheet) return;
                    takeSnapshot();
                    const newItems = sheet.canvasItems.map(it => it.uniqueID === id ? { ...it, ...updates } : it);
                    updateSheet({ canvasItems: newItems }, { recalcNetwork: false });
                },
                updateItemRaw: (id: string, updates: Partial<CanvasItem>, options?: { recalcNetwork?: boolean }) => {
                    const sheet = useStore.getState().getCurrentSheet();
                    if (!sheet) return;
                    takeSnapshot();
                    const newItems = sheet.canvasItems.map(it => it.uniqueID === id ? { ...it, ...updates } : it);
                    updateSheet({ canvasItems: newItems }, { recalcNetwork: options?.recalcNetwork });
                },
                duplicateItem: (id: string) => duplicateItem(id),
                connectItems: connectItemsHelper,
                updateConnector: (index: number, updates: Partial<Connector>) => updateConnector(index, updates),
                deleteConnector: (index: number) => {
                    const sheet = useStore.getState().getCurrentSheet();
                    if (!sheet) return;
                    if (index < 0 || index >= sheet.storedConnectors.length) return;
                    takeSnapshot();
                    const filtered = sheet.storedConnectors.filter((_, i) => i !== index);
                    updateSheet({ storedConnectors: filtered });
                    calculateNetwork();
                },
                autoLayoutActiveSheet: autoLayoutActiveSheet,
                listAvailableItems: () => availableItems.map(i => ({ name: i.name, connectionPointKeys: Object.keys(i.connectionPoints || {}) })),
                undo: () => undo(),
                redo: () => redo(),
                showToast: showToast
            };
            chatService.setDiagramCallbacks(callbacks);
            chatService.initializeContext(sheets);
            // Load existing history (filtering out system messages)
            const history = chatService.getHistory();
            setMessages(history.filter((m: ChatMessage) => m.role !== 'system'));
        }
    }, [isChatOpen, sheets, addItemHelper, deleteItem, calculateNetwork, showToast, getCurrentSheet, activeSheetId, setActiveSheet, addSheet, renameSheet, removeSheet, moveItems, takeSnapshot, updateSheet, updateItemProperties, updateItemTransform, updateItemLock, duplicateItem, connectItemsHelper, updateConnector, autoLayoutActiveSheet, availableItems]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isLoading]);

    const toolByCallId = React.useMemo(() => {
        const m = new Map<string, ChatMessage>();
        messages.forEach(msg => {
            if (msg.role === 'tool' && msg.tool_call_id) m.set(msg.tool_call_id, msg);
        });
        return m;
    }, [messages]);

    const formatToolLabel = (name: string) => (name || '').replace(/_/g, ' ');

    const tryPrettyJson = (raw: string) => {
        try {
            const obj = JSON.parse(raw);
            return JSON.stringify(obj, null, 2);
        } catch {
            return raw;
        }
    };

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
        }
    }, [input]);

    const handleSend = async () => {
        if ((!input.trim() && pendingImages.length === 0) || isLoading) return;

        const userMsg = input;
        const currentImages = [...pendingImages];
        const dbMode = isDbMode;

        setInput('');
        setPendingImages([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setIsLoading(true);

        setMessages(prev => [...prev, {
            role: 'user',
            content: userMsg,
            images: currentImages.length > 0 ? currentImages : undefined
        }]);

        try {
            const newHistory = await chatService.sendMessage(userMsg, dbMode, currentImages);
            setMessages(newHistory.filter(m => m.role !== 'system'));
        } catch (error: any) {
            setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${error.message}` }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleNewChat = () => {
        chatService.reset();
        // Re-setup callbacks after reset
        const callbacks: DiagramCallbacks = {
            addItem: addItemHelper,
            deleteItem: (itemId: string) => deleteItem(itemId),
            calculateNetwork: () => calculateNetwork(),
            getSheets: () => sheets,
            getCurrentSheet: () => getCurrentSheet(),
            getActiveSheetId: () => activeSheetId,
            setActiveSheet: (id: string) => setActiveSheet(id),
            addSheet: (name?: string) => addSheet(name),
            renameSheet: (id: string, name: string) => renameSheet(id, name),
            removeSheet: (id: string) => removeSheet(id),
            moveItems: (moves) => {
                if (!moves || moves.length === 0) return;
                takeSnapshot();
                moveItems(moves.map(m => ({ id: m.itemId, x: m.x, y: m.y })));
                calculateNetwork();
            },
            updateItemProperties: (id: string, props: Record<string, string>) => updateItemProperties(id, props),
            updateItemTransform: (id: string, x: number, y: number, w: number, h: number, r: number) => updateItemTransform(id, x, y, w, h, r),
            updateItemLock: (id: string, locked: boolean) => updateItemLock(id, locked),
            updateItemFields: (id: string, updates: Partial<Pick<CanvasItem, 'incomer' | 'outgoing' | 'accessories' | 'alternativeCompany1' | 'alternativeCompany2'>>) => {
                const sheet = useStore.getState().getCurrentSheet();
                if (!sheet) return;
                takeSnapshot();
                const newItems = sheet.canvasItems.map(it => it.uniqueID === id ? { ...it, ...updates } : it);
                updateSheet({ canvasItems: newItems }, { recalcNetwork: false });
            },
            updateItemRaw: (id: string, updates: Partial<CanvasItem>, options?: { recalcNetwork?: boolean }) => {
                const sheet = useStore.getState().getCurrentSheet();
                if (!sheet) return;
                takeSnapshot();
                const newItems = sheet.canvasItems.map(it => it.uniqueID === id ? { ...it, ...updates } : it);
                updateSheet({ canvasItems: newItems }, { recalcNetwork: options?.recalcNetwork });
            },
            duplicateItem: (id: string) => duplicateItem(id),
            connectItems: connectItemsHelper,
            updateConnector: (index: number, updates: Partial<Connector>) => updateConnector(index, updates),
            deleteConnector: (index: number) => {
                const sheet = useStore.getState().getCurrentSheet();
                if (!sheet) return;
                if (index < 0 || index >= sheet.storedConnectors.length) return;
                takeSnapshot();
                const filtered = sheet.storedConnectors.filter((_, i) => i !== index);
                updateSheet({ storedConnectors: filtered });
                calculateNetwork();
            },
            autoLayoutActiveSheet: autoLayoutActiveSheet,
            listAvailableItems: () => availableItems.map(i => ({ name: i.name, connectionPointKeys: Object.keys(i.connectionPoints || {}) })),
            undo: () => undo(),
            redo: () => redo(),
            showToast: showToast
        };
        chatService.setDiagramCallbacks(callbacks);
        chatService.initializeContext(sheets);
        setMessages([]);
        setIsDbMode(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!isChatOpen) return null;

    return (
        <div
            className="fixed right-0 top-12 bottom-0 w-[450px] shadow-2xl flex flex-col z-40 border-l transition-all duration-300 ease-in-out"
            style={{ backgroundColor: colors.panelBackground, borderColor: colors.border }}
        >
            {/* Toast Notification */}
            {toast && (
                <div
                    className={`absolute top-16 left-4 right-4 p-3 rounded-lg shadow-lg z-50 flex items-center gap-2 animate-slide-down ${toast.type === 'success' ? 'bg-green-500 text-white' :
                        toast.type === 'error' ? 'bg-red-500 text-white' :
                            'bg-blue-500 text-white'
                        }`}
                >
                    <Zap size={16} />
                    <span className="text-sm font-medium">{toast.message}</span>
                </div>
            )}

            {/* Header */}
            <div className="p-4 border-b flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                <div className="flex items-center gap-2">
                    <Bot size={20} />
                    <h2 className="font-semibold">AI Diagram Assistant</h2>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleNewChat}
                        className="p-1.5 rounded hover:bg-white/20 transition-colors"
                        title="New Conversation"
                    >
                        <PlusCircle size={18} />
                    </button>
                    <button
                        onClick={toggleChat}
                        className="p-1.5 rounded hover:bg-white/20 transition-colors"
                        title="Close"
                    >
                        <X size={20} />
                    </button>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center opacity-60 space-y-4" style={{ color: colors.text }}>
                        <div className="p-4 rounded-full bg-blue-100 dark:bg-blue-900/30">
                            <Bot size={40} className="text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                            <p className="font-medium text-lg">AI Diagram Assistant</p>
                            <p className="text-sm mt-1">Ask about your diagram, analyze loads, or add components.</p>
                        </div>
                        <div className="grid grid-cols-1 gap-2 text-xs w-full max-w-xs">
                            <button onClick={() => setInput("What's the total load on my diagram?")} className="p-2 rounded border hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" style={{ borderColor: colors.border }}>
                                "What's the total load on my diagram?"
                            </button>
                            <button onClick={() => setInput("Is my diagram phase balanced?")} className="p-2 rounded border hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" style={{ borderColor: colors.border }}>
                                "Is my diagram phase balanced?"
                            </button>
                            <button onClick={() => setInput("Add a ceiling fan to my diagram")} className="p-2 rounded border hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" style={{ borderColor: colors.border }}>
                                "Add a ceiling fan to my diagram"
                            </button>
                            <button onClick={() => setInput("What cable size do I need for 25A?")} className="p-2 rounded border hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" style={{ borderColor: colors.border }}>
                                "What cable size do I need for 25A?"
                            </button>
                        </div>
                    </div>
                )}

                {messages.map((msg, idx) => {
                    if (msg.role === 'tool' || msg.role === 'system') return null;
                    const isUser = msg.role === 'user';
                    const displayContent = isUser ? msg.content.replace('[USER EXPLICITLY MARKED THIS AS A DATABASE QUERY. YOU MUST USE DATABASE TOOLS]\n', '') : msg.content;
                    const toolCalls = !isUser ? ((msg as any).tool_calls as any[] | undefined) : undefined;
                    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
                    const hasContent = !!displayContent && displayContent.trim().length > 0;

                    if (!isUser && !hasContent && !hasToolCalls) return null;

                    return (
                        <div key={idx} className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isUser ? 'bg-blue-600 text-white' : 'bg-green-600 text-white'}`}>
                                {isUser ? <User size={16} /> : <Bot size={16} />}
                            </div>

                            <div
                                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm select-text ${isUser
                                    ? 'bg-blue-600 text-white rounded-tr-none'
                                    : 'bg-white dark:bg-gray-800 border rounded-tl-none'
                                    }`}
                                style={{
                                    borderColor: isUser ? 'transparent' : colors.border,
                                    color: isUser ? 'white' : colors.text
                                }}
                            >
                                {isUser ? (
                                    <div className="whitespace-pre-wrap">{displayContent}</div>
                                ) : (
                                    <div className="space-y-3">
                                        {hasContent && (
                                            <div className="prose prose-sm dark:prose-invert max-w-none select-text">
                                                <ReactMarkdown>{displayContent}</ReactMarkdown>
                                            </div>
                                        )}
                                        {hasToolCalls && (
                                            <div className="pt-2 border-t" style={{ borderColor: colors.border }}>
                                                <button
                                                    onClick={() => setExpandedTools(prev => ({ ...prev, [idx]: !prev[idx] }))}
                                                    className="flex items-center gap-2 text-xs opacity-80 hover:opacity-100 transition-opacity"
                                                    style={{ color: colors.text }}
                                                >
                                                    {expandedTools[idx] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                    <Wrench size={14} />
                                                    <span>{expandedTools[idx] ? 'Hide actions' : 'Show actions'}</span>
                                                    <span className="opacity-60">({toolCalls!.length})</span>
                                                </button>
                                                {expandedTools[idx] && (
                                                    <div className="mt-2 space-y-2">
                                                        {toolCalls!.map((tc: any) => {
                                                            const tmsg = tc?.id ? toolByCallId.get(tc.id) : undefined;
                                                            const toolName = tc?.function?.name || '';
                                                            const toolResult = tmsg?.content ? tryPrettyJson(tmsg.content) : '';
                                                            const preview = toolResult ? toolResult.split('\n').slice(0, 6).join('\n') : '';
                                                            return (
                                                                <div key={tc.id} className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: colors.border }}>
                                                                    <div className="font-medium opacity-90">{formatToolLabel(toolName)}</div>
                                                                    {preview && (
                                                                        <pre className="mt-1 whitespace-pre-wrap opacity-80" style={{ color: colors.text }}>
                                                                            {preview}
                                                                        </pre>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}

                {isLoading && (
                    <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center flex-shrink-0">
                            <Bot size={16} />
                        </div>
                        <div className="bg-white dark:bg-gray-800 border rounded-2xl rounded-tl-none px-4 py-3 shadow-sm flex items-center gap-2" style={{ borderColor: colors.border }}>
                            <Loader2 size={16} className="animate-spin text-blue-600" />
                            <span className="text-sm opacity-70" style={{ color: colors.text }}>Analyzing...</span>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t bg-gray-50 dark:bg-gray-900/50" style={{ borderColor: colors.border }}>
                <div className="flex flex-col gap-2">
                    {/* Toolbar */}
                    <div className="flex items-center gap-2 px-1">
                        <button
                            onClick={() => setIsDbMode(!isDbMode)}
                            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-colors border ${isDbMode
                                ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
                                : 'bg-transparent text-gray-500 border-transparent hover:bg-gray-100 dark:hover:bg-gray-800'
                                }`}
                            title="Toggle to focus on database queries (prices, specs)"
                        >
                            <Database size={12} />
                            <span>Database</span>
                            {isDbMode && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse ml-0.5" />}
                        </button>

                        {/* Insert Selection Button */}
                        {selectedCount > 0 && (
                            <button
                                onClick={insertSelectionContext}
                                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-colors border bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800 animate-fade-in"
                                title="Insert selected items into chat"
                            >
                                <PlusCircle size={12} />
                                <span>Add Selection ({selectedCount})</span>
                            </button>
                        )}
                        <div className="flex items-center gap-1.5 text-xs px-2 py-1 text-green-600 dark:text-green-400">
                            <Cpu size={12} />
                            <span>Diagram-Aware</span>
                        </div>
                    </div>


                    {/* Image Previews in Input Area */}
                    {pendingImages.length > 0 && (
                        <div className="flex gap-2 p-2 overflow-x-auto">
                            {pendingImages.map((img, idx) => (
                                <div key={idx} className="relative group flex-shrink-0">
                                    <img src={img} alt="attachment" className="h-16 w-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700" />
                                    <button
                                        onClick={() => removePendingImage(idx)}
                                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex gap-2 items-end bg-white dark:bg-gray-800 border rounded-xl p-2 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/50 transition-all" style={{ borderColor: colors.border }}>

                        {/* Attachment Buttons */}
                        <div className="flex flex-col gap-1 pb-1">
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                                title="Attach Image"
                            >
                                <Paperclip size={18} />
                            </button>
                            <button
                                onClick={handleCaptureView}
                                className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                                title="Capture Canvas View"
                            >
                                <Eye size={18} />
                            </button>
                            <input
                                type="file"
                                ref={fileInputRef}
                                className="hidden"
                                accept="image/*"
                                onChange={handleFileSelect}
                            />
                        </div>

                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={isDbMode ? "Ask a database question..." : "Ask about your diagram, use Capture View to show..."}
                            className="flex-1 bg-transparent resize-none text-sm focus:outline-none max-h-32 py-2 px-1"
                            style={{ color: colors.text }}
                            rows={1}
                        />
                        <button
                            onClick={handleSend}
                            disabled={isLoading || (!input.trim() && pendingImages.length === 0)}
                            className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-[1px]"
                        >
                            <Send size={18} />
                        </button>
                    </div>
                </div>
                <div className="text-xs text-center mt-2 opacity-40" style={{ color: colors.text }}>
                    AI can see items you attach or capture from the canvas
                </div>
            </div>

            {/* CSS for toast animation */}
            <style>{`
                @keyframes slide-down {
                    from {
                        transform: translateY(-100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateY(0);
                        opacity: 1;
                    }
                }
                .animate-slide-down {
                    animation: slide-down 0.3s ease-out;
                }
            `}</style>
        </div>
    );
};
