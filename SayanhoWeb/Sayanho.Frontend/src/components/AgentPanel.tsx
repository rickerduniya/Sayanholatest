// AgentPanel — the control surface for the design agent.
//
// Priorities, in order:
//   1. Stop must always be reachable and must always work. It is the promise that
//      makes an autonomous agent acceptable on someone's drawing.
//   2. The user must be able to see what the agent is doing to their plan, in
//      plain language, as it happens.
//   3. Milestone reviews must be obvious and quick to answer.
//
// The panel does not own any agent logic. It renders AgentController state and
// calls back into it.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Bot,
    Play,
    Square,
    Pause,
    X,
    Check,
    AlertTriangle,
    Loader2,
    Wrench,
    MessageSquare,
    Flag,
    Hand,
    ChevronDown,
    ChevronRight,
    Image as ImageIcon,
    ImageOff,
    Share2,
    Copy
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useStore } from '../store/useStore';
import { useLayoutStore } from '../store/useLayoutStore';
import { chatService } from '../services/ChatService';
import { agentController, AgentSnapshot, AgentEvent } from '../agent/AgentController';
import { useDiagramCallbacks } from '../hooks/useDiagramCallbacks';
import { ApplicationSettings } from '../utils/ApplicationSettings';
import { collectPlanImages, describePlanImages } from '../agent/planImages';
import {
    buildMarkdownReport,
    buildJsonReport,
    copyText,
    downloadReport,
    ReportContext
} from '../agent/agentReport';

interface AgentPanelProps {
    isOpen: boolean;
    onClose: () => void;
    showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * Ready-made goals.
 *
 * These are full-design requests phrased the way the workflow skill expects, so
 * the common case is one click rather than the user having to learn the phrasing.
 */
const PRESET_GOALS = [
    {
        label: 'Design the complete electrical system',
        goal: 'Design the complete electrical installation for the loaded floor plan(s): place all light points, fans, exhaust fans, 5A socket boards, AC points and geyser points; add point switch boards; size and place the SPN DB, HTPN and (only if needed) VTPN; then generate the matching SLD and wire it fully. Follow the electrical-design-workflow skill and pause for my review at each milestone.'
    },
    {
        label: 'Place loads only (no boards)',
        goal: 'Place only the electrical loads on the floor plan: light points, ceiling fans, exhaust fans, 5A socket boards, AC points, geyser points and the call bell. Do not place any distribution boards or point switch boards, and do not generate the SLD yet.'
    },
    {
        label: 'Add boards and wire the existing layout',
        goal: 'The loads are already placed on the floor plan. Add the point switch boards, size and place the distribution boards (SPN DB, HTPN, VTPN if needed) and the source, then generate the SLD and wire everything up. Verify at the end.'
    },
    {
        label: 'Review and fix the current design',
        goal: 'Review the current layout and SLD. Run layout_validate and validate_diagram, explain every problem you find in plain language, and fix the errors. Do not add new loads unless a validation error requires it.'
    }
];

const STATUS_LABEL: Record<AgentSnapshot['status'], string> = {
    idle: 'Idle',
    running: 'Working',
    paused: 'Paused',
    awaiting_review: 'Waiting for your review',
    stopping: 'Stopping…',
    stopped: 'Stopped',
    completed: 'Finished',
    error: 'Error'
};

const EVENT_ICON: Record<AgentEvent['kind'], React.ReactNode> = {
    status: <Bot size={12} />,
    thought: <MessageSquare size={12} />,
    tool: <Wrench size={12} />,
    milestone: <Flag size={12} />,
    error: <AlertTriangle size={12} />,
    info: <Bot size={12} />
};

export const AgentPanel: React.FC<AgentPanelProps> = ({ isOpen, onClose, showToast }) => {
    const { colors } = useTheme();
    const { buildCallbacks } = useDiagramCallbacks(showToast);

    const [snapshot, setSnapshot] = useState<AgentSnapshot>(() => agentController.getSnapshot());
    const [goal, setGoal] = useState('');
    const [showThoughts, setShowThoughts] = useState(true);
    const logScrollRef = useRef<HTMLDivElement>(null);

    // Share/export state
    const [shareMenuOpen, setShareMenuOpen] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const [includeReasoning, setIncludeReasoning] = useState(true);
    const [includePayloads, setIncludePayloads] = useState(true);
    const shareMenuRef = useRef<HTMLDivElement>(null);

    /** Reasoning entries the user has expanded in the log. */
    const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());

    /** Optional user comment typed at a milestone review. Sent back to the agent. */
    const [reviewFeedback, setReviewFeedback] = useState('');
    const activeMilestoneName = snapshot.milestone?.name || null;
    // Clear the draft whenever a new milestone arrives so a stale comment
    // is never sent to the wrong checkpoint.
    useEffect(() => {
        setReviewFeedback('');
    }, [activeMilestoneName]);

    const floorPlans = useLayoutStore(state => state.floorPlans);
    const activeFloorPlanId = useLayoutStore(state => state.activeFloorPlanId);
    const activeView = useLayoutStore(state => state.activeView);
    const setActiveView = useLayoutStore(state => state.setActiveView);
    const sheets = useStore(state => state.sheets);

    useEffect(() => agentController.subscribe(setSnapshot), []);

    // Dismiss the share menu on outside click or Escape.
    useEffect(() => {
        if (!shareMenuOpen) return;

        const onPointerDown = (e: MouseEvent) => {
            if (shareMenuRef.current?.contains(e.target as Node)) return;
            setShareMenuOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setShareMenuOpen(false);
        };

        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [shareMenuOpen]);

    // Reset the copy confirmation after a moment.
    useEffect(() => {
        if (copyState === 'idle') return;
        const timer = setTimeout(() => setCopyState('idle'), 2200);
        return () => clearTimeout(timer);
    }, [copyState]);

    // Follow the log while the agent works, but do not fight the user if they
    // have scrolled back to read something.
    //
    // Scrolls the log container itself rather than calling scrollIntoView on a
    // sentinel. scrollIntoView walks up to the nearest scrollable ancestor and
    // can scroll the whole panel, which pushed the milestone review buttons out
    // of view every time a new event arrived.
    useEffect(() => {
        if (snapshot.status !== 'running' && snapshot.status !== 'awaiting_review') return;

        const el = logScrollRef.current;
        if (!el) return;

        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom > 120) return;   // user scrolled up: leave them alone

        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, [snapshot.events.length, snapshot.status]);

    const isBusy = agentController.isBusy();

    const apiKeyMissing = useMemo(() => {
        try {
            return !ApplicationSettings.getAiSettings().apiKey;
        } catch {
            return true;
        }
    }, [isOpen]);

    /**
     * Pre-flight checks.
     *
     * Better to refuse clearly than to let the agent start and discover halfway
     * through that there is no floor plan, or that the plan is uncalibrated and
     * every area-derived count is wrong.
     */
    const preflight = useMemo(() => {
        const blockers: string[] = [];
        const warnings: string[] = [];

        if (apiKeyMissing) {
            blockers.push('No LLM API key configured. Open Settings → AI and add one.');
        }
        if (floorPlans.length === 0) {
            blockers.push('No floor plan loaded. Upload a floor plan in Layout mode first.');
        } else {
            const plansWithoutRooms = floorPlans.filter(p => p.rooms.length === 0);
            if (plansWithoutRooms.length === floorPlans.length) {
                blockers.push('No rooms detected on any floor plan. Run Detect Rooms in the Layout toolbar.');
            } else if (plansWithoutRooms.length > 0) {
                warnings.push(`${plansWithoutRooms.length} floor plan(s) have no detected rooms and will be skipped.`);
            }

            const uncalibrated = floorPlans.filter(p => !p.isScaleCalibrated);
            if (uncalibrated.length > 0) {
                warnings.push(
                    `${uncalibrated.length} floor plan(s) are not scale-calibrated. Room areas will be estimated from a default 50 px/m, so fitting counts may be wrong. Calibrate first for accurate results.`
                );
            }

            // The agent reads room labels and spots detection errors from the
            // drawing. Without it, it can only trust the detected vectors.
            const withoutImage = floorPlans.filter(p => !p.backgroundImageId);
            if (withoutImage.length === floorPlans.length) {
                warnings.push(
                    'No floor plan image to show the agent — these plans were drawn by hand. It will work from detected geometry only and cannot read room labels or verify the walls.'
                );
            } else if (withoutImage.length > 0) {
                warnings.push(
                    `${withoutImage.length} floor plan(s) have no source image; the agent cannot visually verify those.`
                );
            }
        }

        return { blockers, warnings };
    }, [apiKeyMissing, floorPlans]);

    /**
     * Whether the agent will be able to see the drawing on this run.
     *
     * Surfaced in the panel because it materially changes what the agent can do,
     * and because it depends on the model actually supporting vision — something
     * we cannot detect, so the user has to know it matters.
     */
    const imageInfo = useMemo(() => {
        const withImage = floorPlans.filter(p => Boolean(p.backgroundImageId));
        return { count: withImage.length, total: floorPlans.length };
    }, [floorPlans]);

    const runAgent = async (goalText: string) => {
        const trimmed = goalText.trim();
        if (!trimmed || isBusy) return;
        if (preflight.blockers.length > 0) {
            showToast(preflight.blockers[0], 'error');
            return;
        }

        // The user should watch the plan being populated, not a schematic they
        // are not looking at yet.
        if (activeView !== 'layout') setActiveView('layout');

        agentController.beginRun(`Goal: ${trimmed}`);

        // Start each run from a clean conversation.
        //
        // ChatService keeps one history for the whole session, so without this a
        // second run replayed the previous run's goal *and* its attached image as
        // if the user had just sent them. The network log for a correction run
        // showed the opening message twice, each with its own copy of the plan —
        // roughly 2.2k wasted vision tokens on every request, and a model being
        // told to place loads while also being told to reposition them.
        chatService.reset();
        chatService.setAgentHooks(agentController.createHooks());
        chatService.setDiagramCallbacks(buildCallbacks());

        try {
            await chatService.initializeContext(useStore.getState().sheets);

            // Attach the floor plan drawing, with the agent's own placements on
            // it when the plan is not empty.
            //
            // Without an image the agent's only view of the building is the
            // detected vector geometry, so a detection error (a missed wall
            // merging two rooms, a label OCR could not read) is invisible to it.
            // Without the overlay, a request like "reposition these" is equally
            // blind: it sees a coordinate list and cannot tell that a fan landed
            // in a doorway. Drawing the components closes that gap.
            //
            // Image preparation is guarded separately from sendMessage. Wrapping
            // both together meant any mid-run LLM failure was reported as
            // "could not attach the image" and then silently retried the whole
            // conversation without it — losing the real error and doubling the
            // token spend.
            let message = trimmed;
            let images: string[] | undefined;

            try {
                const planImages = await collectPlanImages(floorPlans, activeFloorPlanId, { annotate: true });
                message = `${trimmed}\n\n---\n${describePlanImages(planImages)}`;

                if (planImages.images.length > 0) {
                    const totalKb = planImages.images.reduce((sum, i) => sum + i.approxKb, 0);
                    const overlaid = planImages.images.reduce((sum, i) => sum + i.annotatedComponents, 0);
                    images = planImages.images.map(i => i.dataUri);
                    agentController.note(
                        overlaid > 0
                            ? `Attached ${planImages.images.length} floor plan image${planImages.images.length === 1 ? '' : 's'} (~${totalKb} KB) with ${overlaid} already-placed component${overlaid === 1 ? '' : 's'} drawn on, so the agent can see and judge its own placements.`
                            : `Attached ${planImages.images.length} floor plan image${planImages.images.length === 1 ? '' : 's'} (~${totalKb} KB) so the agent can read labels and verify the detected walls.`
                    );
                } else {
                    agentController.note('No floor plan image available — the agent will work from detected geometry only.');
                }
            } catch (imageError: any) {
                // A missing image degrades the run; it must not abort it.
                console.warn('[AgentPanel] Plan image capture failed', imageError);
                agentController.note('Could not prepare the floor plan image; continuing with detected geometry only.');
                message = trimmed;
                images = undefined;
            }

            await chatService.sendMessage(message, false, images);

            const finalSnapshot = agentController.getSnapshot();
            if (finalSnapshot.status === 'stopping' || finalSnapshot.status === 'stopped') {
                agentController.finishRun('stopped', 'Handed control back to you. Everything placed so far is editable.');
            } else {
                agentController.finishRun('completed', 'Run finished. Review the drawing and the summary in the chat panel.');
            }
        } catch (error: any) {
            agentController.finishRun('error', error?.message || 'The agent run failed.');
        } finally {
            // Detach hooks so ordinary chat is never gated by a stale controller.
            chatService.setAgentHooks(null);
        }
    };

    const statusTone =
        snapshot.status === 'error' ? 'bg-red-500'
            : snapshot.status === 'completed' ? 'bg-green-500'
                : snapshot.status === 'awaiting_review' ? 'bg-amber-500'
                    : snapshot.status === 'paused' ? 'bg-amber-500'
                        : snapshot.status === 'running' ? 'bg-blue-500'
                            : 'bg-gray-400';

    const visibleEvents = showThoughts
        ? snapshot.events
        : snapshot.events.filter(e => e.kind !== 'thought');

    /**
     * Environment context for the report.
     *
     * A run that went wrong is usually explained by something outside the log —
     * an uncalibrated plan, no rooms detected, or a model that cannot see images.
     * Including it means a shared report is self-contained.
     */
    const buildContext = (): ReportContext => {
        let provider: string | undefined;
        let model: string | undefined;
        try {
            const ai = ApplicationSettings.getAiSettings();
            provider = ai.provider;
            model = ai.modelName;
        } catch {
            // Settings unreadable is not a reason to refuse the report.
        }

        return {
            provider,
            model,
            sldSheetCount: sheets.length,
            imagesAttached: floorPlans.filter(p => Boolean(p.backgroundImageId)).length,
            floorPlans: floorPlans.map(p => ({
                name: p.name,
                rooms: p.rooms.length,
                walls: p.walls.length,
                components: p.components.length,
                calibrated: Boolean(p.isScaleCalibrated),
                hasImage: Boolean(p.backgroundImageId)
            }))
        };
    };

    const buildReport = (format: 'md' | 'json'): string => {
        const options = {
            includeReasoning,
            includeToolPayloads: includePayloads,
            context: buildContext()
        };
        return format === 'json'
            ? buildJsonReport(snapshot, options)
            : buildMarkdownReport(snapshot, options);
    };

    const handleShare = async (mode: 'copy' | 'download', format: 'md' | 'json') => {
        setShareMenuOpen(false);
        const text = buildReport(format);

        if (mode === 'download') {
            downloadReport(text, format);
            showToast(`Activity report downloaded (${format.toUpperCase()}).`, 'success');
            return;
        }

        const ok = await copyText(text);
        setCopyState(ok ? 'copied' : 'failed');
        showToast(
            ok
                ? `Activity report copied (${Math.round(text.length / 1024)} KB). Paste it anywhere.`
                : 'Could not access the clipboard. Use Download instead.',
            ok ? 'success' : 'error'
        );
    };

    /** Approximate size, shown so the user knows before pasting into a chat. */
    const reportSizeKb = useMemo(() => {
        if (!shareMenuOpen || snapshot.events.length === 0) return null;
        try {
            return Math.max(1, Math.round(buildReport('md').length / 1024));
        } catch {
            return null;
        }
    }, [shareMenuOpen, snapshot.events, includeReasoning, includePayloads]);

    // Early return sits below every hook. It used to be above the report helpers,
    // which put a useMemo after a conditional return — React then saw a different
    // hook count on the render where the panel opened and threw
    // "Rendered more hooks than during the previous render", blanking the panel.
    if (!isOpen) return null;

    return (
        <div
            className="fixed left-3 top-3 bottom-3 z-[60] flex w-[420px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border shadow-2xl"
            style={{ backgroundColor: colors.panelBackground, borderColor: colors.border }}
        >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between rounded-t-xl bg-gradient-to-r from-indigo-600 to-blue-700 px-4 py-3 text-white">
                <div className="flex items-center gap-2">
                    <Bot size={18} />
                    <h2 className="font-semibold">Design Agent</h2>
                    <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-0.5 text-[10px]">
                        <span className={`h-1.5 w-1.5 rounded-full ${statusTone} ${snapshot.status === 'running' ? 'animate-pulse' : ''}`} />
                        {STATUS_LABEL[snapshot.status]}
                    </span>
                </div>
                <button
                    onClick={onClose}
                    className="rounded p-1.5 transition-colors hover:bg-white/20"
                    title="Close"
                >
                    <X size={18} />
                </button>
            </div>

            {/* Pre-flight */}
            {(preflight.blockers.length > 0 || preflight.warnings.length > 0) && !isBusy && (
                <div className="max-h-[28vh] shrink-0 space-y-1.5 overflow-y-auto border-b px-4 py-3" style={{ borderColor: colors.border }}>
                    {preflight.blockers.map((b, i) => (
                        <div key={`b${i}`} className="flex items-start gap-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-[11px] text-red-600 dark:text-red-400">
                            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                            <span>{b}</span>
                        </div>
                    ))}
                    {preflight.warnings.map((w, i) => (
                        <div key={`w${i}`} className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                            <span>{w}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Milestone review.
                Layout notes, because this block failing is a dead end for the
                user rather than a cosmetic problem:
                  - The summary scrolls inside its own bounded box, and the
                    Approve / Stop buttons sit outside that box with shrink-0.
                    Previously the whole block grew with the text and pushed the
                    buttons past the bottom of a panel that does not scroll, so a
                    long summary made the only useful controls unreachable.
                  - The block itself stays shrinkable (no shrink-0) so that on a
                    short viewport the summary gives up height instead of the
                    buttons being clipped. */}
            {snapshot.status === 'awaiting_review' && (
                <div className="flex min-h-0 flex-col border-b px-4 py-3" style={{ borderColor: colors.border }}>
                    <div className="flex min-h-0 flex-col rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                        <div className="mb-1 flex shrink-0 items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                            <Flag size={13} className="shrink-0" />
                            <span className="min-w-0 break-words">{snapshot.milestone?.name || 'Checkpoint'}</span>
                        </div>

                        <div className="custom-scrollbar min-h-0 max-h-[32vh] overflow-y-auto pr-1">
                            <p className="whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: colors.text }}>
                                {snapshot.milestone?.summary || 'The agent asked for a review. See the activity log below for what it just did.'}
                            </p>
                        </div>

                        <p className="mt-2 shrink-0 text-[10px] opacity-60" style={{ color: colors.text }}>
                            The agent is paused. You can inspect or edit the drawing now, then choose.
                        </p>
                        <textarea
                            value={reviewFeedback}
                            onChange={e => setReviewFeedback(e.target.value)}
                            onKeyDown={e => {
                                e.stopPropagation();
                            }}
                            placeholder="Add a comment for the agent (optional) — e.g. “go with option B, I fixed the rooms”…"
                            rows={2}
                            maxLength={2000}
                            className="custom-scrollbar mt-2 w-full shrink-0 resize-none rounded-lg border bg-transparent px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-500"
                            style={{ borderColor: colors.border, color: colors.text }}
                        />
                        <div className="mt-2.5 flex shrink-0 gap-2">
                            <button
                                onClick={() => agentController.resolveReview(true, reviewFeedback)}
                                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700"
                            >
                                <Check size={13} /> Approve &amp; continue
                            </button>
                            <button
                                onClick={() => agentController.resolveReview(false, reviewFeedback)}
                                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                                style={{ borderColor: colors.border, color: colors.text }}
                            >
                                <Hand size={13} /> Stop here
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Goal / presets — only before a run starts */}
            {!isBusy && (
                <div className="custom-scrollbar max-h-[45vh] shrink-0 space-y-2 overflow-y-auto border-b px-4 py-3" style={{ borderColor: colors.border }}>
                    {/* Vision status. The agent reads room labels and checks the
                        detected walls from the drawing, so whether it can see one
                        is worth stating up front — as is the fact that it needs a
                        vision-capable model to use it. */}
                    {imageInfo.total > 0 && (
                        <div
                            className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-[11px]"
                            style={{
                                backgroundColor: imageInfo.count > 0 ? 'rgba(59,130,246,0.10)' : 'rgba(148,163,184,0.12)',
                                color: colors.text
                            }}
                        >
                            {imageInfo.count > 0
                                ? <ImageIcon size={13} className="mt-0.5 shrink-0 text-blue-500" />
                                : <ImageOff size={13} className="mt-0.5 shrink-0 opacity-50" />}
                            <span className="opacity-80">
                                {imageInfo.count > 0 ? (
                                    <>
                                        The agent will see {imageInfo.count === imageInfo.total
                                            ? (imageInfo.total === 1 ? 'your floor plan drawing' : `all ${imageInfo.total} floor plan drawings`)
                                            : `${imageInfo.count} of ${imageInfo.total} floor plan drawings`}
                                        {' '}to read room labels and check the detected walls. Requires a vision-capable model.
                                    </>
                                ) : (
                                    <>No source drawing to show the agent — it will work from detected geometry only.</>
                                )}
                            </span>
                        </div>
                    )}

                    <p className="text-[10px] font-semibold uppercase tracking-wide opacity-50" style={{ color: colors.text }}>
                        What should the agent do?
                    </p>

                    <div className="space-y-1">
                        {PRESET_GOALS.map(preset => (
                            <button
                                key={preset.label}
                                onClick={() => runAgent(preset.goal)}
                                disabled={preflight.blockers.length > 0}
                                className="flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/5"
                                style={{ borderColor: colors.border, color: colors.text }}
                            >
                                <Play size={12} className="shrink-0 text-blue-500" />
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    <div className="flex items-end gap-2 pt-1">
                        <textarea
                            value={goal}
                            onChange={e => setGoal(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    runAgent(goal);
                                }
                                e.stopPropagation();
                            }}
                            placeholder="Or describe your own goal…"
                            rows={2}
                            className="flex-1 resize-none rounded-lg border bg-transparent px-2 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                            style={{ borderColor: colors.border, color: colors.text }}
                        />
                        <button
                            onClick={() => runAgent(goal)}
                            disabled={!goal.trim() || preflight.blockers.length > 0}
                            className="rounded-lg bg-blue-600 p-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                            title="Run"
                        >
                            <Play size={15} />
                        </button>
                    </div>
                </div>
            )}

            {/* Live controls */}
            {isBusy && (
                <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: colors.border }}>
                    <button
                        onClick={() => agentController.requestStop()}
                        disabled={snapshot.status === 'stopping'}
                        className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                    >
                        <Square size={12} /> Stop
                    </button>

                    {snapshot.status === 'paused' ? (
                        <button
                            onClick={() => agentController.resume()}
                            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                        >
                            <Play size={12} /> Resume
                        </button>
                    ) : (
                        <button
                            onClick={() => agentController.requestPause()}
                            disabled={snapshot.status !== 'running'}
                            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
                            style={{ borderColor: colors.border, color: colors.text }}
                        >
                            <Pause size={12} /> Pause
                        </button>
                    )}

                    <span className="ml-auto text-[10px] opacity-60" style={{ color: colors.text }}>
                        {snapshot.toolCallCount} action{snapshot.toolCallCount === 1 ? '' : 's'}
                    </span>
                </div>
            )}

            {/* Action log */}
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide opacity-50" style={{ color: colors.text }}>
                        Activity
                    </p>

                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setShowThoughts(v => !v)}
                            className="flex items-center gap-1 text-[10px] opacity-60 transition-opacity hover:opacity-100"
                            style={{ color: colors.text }}
                            title={showThoughts ? 'Hide the model\'s reasoning' : 'Show the model\'s reasoning'}
                        >
                            {showThoughts ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            reasoning
                        </button>

                        {/* Share menu. Exists because the panel deliberately hides
                            what matters most when reporting a bad run: the tool
                            arguments, the full results, and the untruncated
                            reasoning. */}
                        <div className="relative" ref={shareMenuRef}>
                            <button
                                onClick={() => setShareMenuOpen(v => !v)}
                                disabled={snapshot.events.length === 0}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/10"
                                style={{ color: colors.text }}
                                title="Copy or download this activity log"
                                aria-haspopup="menu"
                                aria-expanded={shareMenuOpen}
                            >
                                {copyState === 'copied'
                                    ? <Check size={11} className="text-green-500" />
                                    : copyState === 'failed'
                                        ? <AlertTriangle size={11} className="text-red-500" />
                                        : <Share2 size={11} />}
                                {copyState === 'copied' ? 'copied' : copyState === 'failed' ? 'failed' : 'share'}
                            </button>

                            {shareMenuOpen && (
                                <div
                                    role="menu"
                                    className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border shadow-xl"
                                    style={{ backgroundColor: colors.panelBackground, borderColor: colors.border }}
                                >
                                    <div className="border-b px-2.5 py-1.5" style={{ borderColor: colors.border }}>
                                        <label className="flex cursor-pointer items-center gap-2 text-[10px]" style={{ color: colors.text }}>
                                            <input
                                                type="checkbox"
                                                checked={includeReasoning}
                                                onChange={e => setIncludeReasoning(e.target.checked)}
                                            />
                                            Include reasoning
                                        </label>
                                        <label className="mt-1 flex cursor-pointer items-center gap-2 text-[10px]" style={{ color: colors.text }}>
                                            <input
                                                type="checkbox"
                                                checked={includePayloads}
                                                onChange={e => setIncludePayloads(e.target.checked)}
                                            />
                                            Include tool data
                                        </label>
                                    </div>

                                    {([
                                        { label: 'Copy as Markdown', hint: 'Best for pasting into chat', action: () => handleShare('copy', 'md') },
                                        { label: 'Copy as JSON', hint: 'Best for bug reports', action: () => handleShare('copy', 'json') },
                                        { label: 'Download .md', hint: 'For long runs', action: () => handleShare('download', 'md') },
                                        { label: 'Download .json', hint: '', action: () => handleShare('download', 'json') }
                                    ]).map(item => (
                                        <button
                                            key={item.label}
                                            role="menuitem"
                                            onClick={item.action}
                                            className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                                            style={{ color: colors.text }}
                                        >
                                            <span>{item.label}</span>
                                            {item.hint && <span className="text-[9px] opacity-40">{item.hint}</span>}
                                        </button>
                                    ))}

                                    <div className="border-t px-2.5 py-1.5 text-[9px] opacity-45" style={{ borderColor: colors.border, color: colors.text }}>
                                        {reportSizeKb === null ? 'Includes model, floor plan summary and every action.' : `≈ ${reportSizeKb} KB`}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div ref={logScrollRef} className="custom-scrollbar min-h-[5rem] flex-1 space-y-1 overflow-y-auto px-4 py-2">
                    {visibleEvents.length === 0 && (
                        <div className="py-10 text-center text-[11px] opacity-50" style={{ color: colors.text }}>
                            <Bot size={28} className="mx-auto mb-2 opacity-40" />
                            <p>The agent places loads, sizes boards and wires the schematic for you.</p>
                            <p className="mt-1">You can stop it at any moment and carry on by hand.</p>
                        </div>
                    )}

                    {visibleEvents.map(event => {
                        const tone =
                            event.kind === 'error' || event.ok === false ? 'text-red-500'
                                : event.kind === 'milestone' ? 'text-amber-600 dark:text-amber-400'
                                    : event.kind === 'thought' ? 'opacity-70'
                                        : event.ok ? 'text-green-600 dark:text-green-400'
                                            : 'opacity-80';

                        // Reasoning is stored in full for the report but shortened
                        // here — an unabridged chain of thought pushes the actions
                        // the user is trying to watch off the screen.
                        const isLongThought = event.kind === 'thought' && event.message.length > 400;
                        const expanded = expandedEvents.has(event.id);
                        const shown = isLongThought && !expanded
                            ? `${event.message.slice(0, 400)}…`
                            : event.message;

                        return (
                            <div key={event.id} className="flex items-start gap-2 text-[11px]" style={{ color: colors.text }}>
                                <span className={`mt-0.5 shrink-0 ${tone}`}>
                                    {event.kind === 'tool' && event.ok === undefined
                                        ? <Loader2 size={12} className="animate-spin" />
                                        : EVENT_ICON[event.kind]}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className={event.kind === 'thought' ? 'whitespace-pre-wrap opacity-70' : ''}>
                                        {shown}
                                    </p>
                                    {isLongThought && (
                                        <button
                                            onClick={() => setExpandedEvents(prev => {
                                                const next = new Set(prev);
                                                if (next.has(event.id)) next.delete(event.id);
                                                else next.add(event.id);
                                                return next;
                                            })}
                                            className="mt-0.5 text-[10px] text-blue-500 transition-opacity hover:opacity-80"
                                        >
                                            {expanded ? 'show less' : 'show more'}
                                        </button>
                                    )}
                                    {event.detail && (
                                        <p className={`text-[10px] ${event.ok === false ? 'text-red-500' : 'opacity-50'}`}>
                                            {event.detail}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t px-4 py-2" style={{ borderColor: colors.border }}>
                {snapshot.lastError ? (
                    <p className="text-[10px] text-red-500">{snapshot.lastError}</p>
                ) : (
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] opacity-45" style={{ color: colors.text }}>
                            {floorPlans.length} floor plan(s) · {sheets.length} SLD sheet(s) · undoable (Ctrl+Z)
                        </p>
                        {/* A second, always-visible copy affordance. After a run
                            finishes the controls above disappear, and this is the
                            moment the user most wants to share what happened. */}
                        {snapshot.events.length > 0 && (
                            <button
                                onClick={() => handleShare('copy', 'md')}
                                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                                style={{ color: colors.text }}
                                title="Copy the full activity log, including reasoning, as Markdown"
                            >
                                {copyState === 'copied'
                                    ? <><Check size={10} className="text-green-500" /> copied</>
                                    : <><Copy size={10} /> copy log</>}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
