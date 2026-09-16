import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useStore } from '../store/useStore';
import { useLayoutStore } from '../store/useLayoutStore';
import { useTheme } from '../context/ThemeContext';
import { chatService, ChatMessage } from '../services/ChatService';
import { useDiagramCallbacks } from '../hooks/useDiagramCallbacks';
import { Send, X, Bot, User, Loader2, PlusCircle, Database, Cpu, Zap, ChevronDown, ChevronRight, Wrench, Paperclip, Eye } from 'lucide-react';


export const ChatPanel = () => {
    const {
        isChatOpen,
        toggleChat,
        sheets,
        getCurrentSheet,
        selectedItemIds,
        selectedConnectorIndices,
        canvasSnapshotCallback
    } = useStore();
    const activeView = useLayoutStore(state => state.activeView);
    const isLayoutMode = activeView === 'layout';
    const { colors } = useTheme();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isDbMode, setIsDbMode] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
    const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const [pendingImages, setPendingImages] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);


    // Show toast notification
    const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    }, []);

    const { buildCallbacks } = useDiagramCallbacks(showToast);

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

    // Setup diagram callbacks for ChatService.
    //
    // The callback bundle is built by useDiagramCallbacks, shared with AgentPanel.
    // It used to be defined inline here *and* duplicated in handleNewChat, so the
    // two copies could drift and the agent could end up with a different tool
    // surface from chat.
    useEffect(() => {
        if (!isChatOpen) return;

        chatService.setDiagramCallbacks(buildCallbacks());
        chatService.initializeContext(sheets);
        setMessages(chatService.getHistory().filter((m: ChatMessage) => m.role !== 'system'));
    }, [isChatOpen, sheets, buildCallbacks]);

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
        chatService.setDiagramCallbacks(buildCallbacks());
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
            className="fixed right-3 top-3 bottom-3 w-[400px] max-w-[calc(100vw-1.5rem)] rounded-xl shadow-2xl flex flex-col z-40 border transition-all duration-300 ease-in-out"
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
                    <h2 className="font-semibold">AI {isLayoutMode ? 'Layout' : 'Diagram'} Assistant</h2>
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
                            <p className="font-medium text-lg">AI {isLayoutMode ? 'Layout' : 'Diagram'} Assistant</p>
                            <p className="text-sm mt-1">{isLayoutMode ? 'Ask about floor-plan wiring, point switch boards, or load placement.' : 'Ask about your diagram, analyze loads, or add components.'}</p>
                        </div>
                        <div className="grid grid-cols-1 gap-2 text-xs w-full max-w-xs">
                            <button onClick={() => setInput(isLayoutMode ? "How should I connect these loads to point switch boards?" : "What's the total load on my diagram?")} className="p-2 rounded border hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" style={{ borderColor: colors.border }}>
                                {isLayoutMode ? 'How should I connect these loads to point switch boards?' : "What's the total load on my diagram?"}
                            </button>
                            <button onClick={() => setInput(isLayoutMode ? "What is the best layout for lighting and fan points?" : "Is my diagram phase balanced?")} className="p-2 rounded border hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" style={{ borderColor: colors.border }}>
                                {isLayoutMode ? 'What is the best layout for lighting and fan points?' : 'Is my diagram phase balanced?'}
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
                                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm select-text overflow-hidden ${isUser
                                    ? 'bg-blue-600 text-white rounded-tr-none'
                                    : 'bg-white dark:bg-gray-800 border rounded-tl-none'
                                    }`}
                                style={{
                                    borderColor: isUser ? 'transparent' : colors.border,
                                    color: isUser ? 'white' : colors.text,
                                    overflowWrap: 'anywhere',
                                    wordBreak: 'break-word',
                                }}
                            >
                                {isUser ? (
                                    <div className="whitespace-pre-wrap">{displayContent}</div>
                                ) : (
                                    <div className="space-y-3">
                                        {hasContent && (
                                            <div
                                                className="prose prose-sm dark:prose-invert max-w-none select-text"
                                                style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                                            >
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
