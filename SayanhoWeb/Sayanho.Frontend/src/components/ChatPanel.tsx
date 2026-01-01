import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useStore } from '../store/useStore';
import { useTheme } from '../context/ThemeContext';
import { chatService, ChatMessage, DiagramCallbacks } from '../services/ChatService';
import { api } from '../services/api';
import { CanvasItem, ItemData } from '../types';
import { getItemDefinition, LOAD_ITEM_DEFAULTS, DefaultRulesEngine } from '../utils/DefaultRulesEngine';
import { calculateGeometry } from '../utils/GeometryCalculator';
import { updateItemVisuals } from '../utils/SvgUpdater';
import { Send, X, Bot, User, Loader2, PlusCircle, Database, Cpu, Zap } from 'lucide-react';
import { sortOptionStringsAsc } from '../utils/sortUtils';
import { fetchProperties } from '../utils/api';

export const ChatPanel = () => {
    const {
        isChatOpen,
        toggleChat,
        sheets,
        addItem,
        deleteItem,
        calculateNetwork,
        activeSheetId,
        getCurrentSheet,
        selectedItemIds,
        selectedConnectorIndices
    } = useStore();
    const { colors } = useTheme();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isDbMode, setIsDbMode] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [availableItems, setAvailableItems] = useState<ItemData[]>([]);

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

    // Show toast notification
    const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    // Add item helper for AI
    const addItemHelper = useCallback(async (itemName: string, position?: { x: number; y: number }): Promise<CanvasItem | null> => {
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

    // Setup diagram callbacks for ChatService
    useEffect(() => {
        if (isChatOpen) {
            const callbacks: DiagramCallbacks = {
                addItem: addItemHelper,
                deleteItem: (itemId: string) => deleteItem(itemId),
                calculateNetwork: () => calculateNetwork(),
                getSheets: () => sheets,
                showToast: showToast
            };
            chatService.setDiagramCallbacks(callbacks);
            chatService.initializeContext(sheets);
            // Load existing history (filtering out system messages)
            const history = chatService.getHistory();
            setMessages(history.filter(m => m.role !== 'system'));
        }
    }, [isChatOpen, sheets, addItemHelper, deleteItem, calculateNetwork, showToast]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isLoading]);

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
        }
    }, [input]);

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        const userMsg = input;
        const dbMode = isDbMode;
        setInput('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setIsLoading(true);

        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);

        try {
            const newHistory = await chatService.sendMessage(userMsg, dbMode);
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
                    // Strip the explicit DB tag from user message for display
                    const displayContent = isUser ? msg.content.replace('[USER EXPLICITLY MARKED THIS AS A DATABASE QUERY. YOU MUST USE DATABASE TOOLS]\n', '') : msg.content;

                    return (
                        <div key={idx} className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                            {/* Avatar */}
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isUser ? 'bg-blue-600 text-white' : 'bg-green-600 text-white'}`}>
                                {isUser ? <User size={16} /> : <Bot size={16} />}
                            </div>

                            {/* Bubble */}
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
                                    <div className="prose prose-sm dark:prose-invert max-w-none select-text">
                                        <ReactMarkdown>{displayContent}</ReactMarkdown>
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

                    <div className="flex gap-2 items-end bg-white dark:bg-gray-800 border rounded-xl p-2 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/50 transition-all" style={{ borderColor: colors.border }}>
                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={isDbMode ? "Ask a database question..." : "Ask about your diagram or request changes..."}
                            className="flex-1 bg-transparent resize-none text-sm focus:outline-none max-h-32 py-2 px-1"
                            style={{ color: colors.text }}
                            rows={1}
                        />
                        <button
                            onClick={handleSend}
                            disabled={isLoading || !input.trim()}
                            className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-[1px]"
                        >
                            <Send size={18} />
                        </button>
                    </div>
                </div>
                <div className="text-xs text-center mt-2 opacity-40" style={{ color: colors.text }}>
                    AI can analyze, modify diagrams & query the database
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
