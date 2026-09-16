// Server Status Banner
// ---------------------------------------------------------------------------
// Honest, non-blocking feedback about the backend cold start. Mounted once at
// the app root so it is visible on the landing page, the auth page, and the
// designer alike.
//
// Deliberate choices:
//  - Nothing is shown while the backend responds quickly. A banner that always
//    flashes on load trains users to ignore it.
//  - The elapsed seconds are shown while waking. A counter that visibly moves
//    reads as "working" where a static spinner reads as "hung".
//  - "Ready" is only confirmed if we actually told the user we were waking,
//    otherwise the success toast is noise.

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, WifiOff, RefreshCw } from 'lucide-react';
import { useServerStatus } from '../hooks/useServerStatus';
import { serverWake } from '../services/serverWakeService';

const READY_CONFIRMATION_MS = 2500;

export const ServerStatusBanner: React.FC = () => {
    const { status, elapsedMs } = useServerStatus();

    // Only celebrate readiness if the user was told we were waking up.
    const announcedWakingRef = useRef(false);
    const [showReady, setShowReady] = useState(false);

    useEffect(() => {
        if (status === 'waking') {
            announcedWakingRef.current = true;
            setShowReady(false);
            return;
        }

        if (status === 'ready' && announcedWakingRef.current) {
            announcedWakingRef.current = false;
            setShowReady(true);
            const timer = setTimeout(() => setShowReady(false), READY_CONFIRMATION_MS);
            return () => clearTimeout(timer);
        }
    }, [status]);

    const isWaking = status === 'waking';
    const isUnreachable = status === 'unreachable';
    const visible = isWaking || isUnreachable || showReady;

    if (!visible) return null;

    const seconds = Math.floor(elapsedMs / 1000);

    return (
        <div
            className="fixed left-1/2 top-4 z-[10000] -translate-x-1/2 px-4"
            role="status"
            aria-live="polite"
        >
            {isWaking && (
                <div className="flex items-center gap-3 rounded-xl border border-blue-400/40 bg-blue-600/95 px-4 py-2.5 text-white shadow-2xl backdrop-blur">
                    <Loader2 size={18} className="shrink-0 animate-spin" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight">Waking up server…</p>
                        <p className="text-[11px] leading-tight opacity-85">
                            The free server sleeps when idle. First start takes up to 30 seconds
                            {seconds > 0 ? ` · ${seconds}s` : ''}
                        </p>
                    </div>
                </div>
            )}

            {!isWaking && isUnreachable && (
                <div className="flex items-center gap-3 rounded-xl border border-red-400/40 bg-red-600/95 px-4 py-2.5 text-white shadow-2xl backdrop-blur">
                    <WifiOff size={18} className="shrink-0" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight">Can't reach the server</p>
                        <p className="text-[11px] leading-tight opacity-85">
                            Check your connection, then try again.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => serverWake.ensureAwake({ force: true })}
                        className="ml-1 flex shrink-0 items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/25"
                    >
                        <RefreshCw size={13} />
                        Retry
                    </button>
                </div>
            )}

            {!isWaking && !isUnreachable && showReady && (
                <div className="flex items-center gap-2.5 rounded-xl border border-green-400/40 bg-green-600/95 px-4 py-2.5 text-white shadow-2xl backdrop-blur">
                    <CheckCircle2 size={18} className="shrink-0" />
                    <p className="text-sm font-semibold leading-tight">Server ready</p>
                </div>
            )}
        </div>
    );
};
