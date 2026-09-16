// Server Wake Service
// ---------------------------------------------------------------------------
// The backend is hosted on a platform that suspends idle instances, so the
// first request after a period of inactivity can take 20-30 seconds while the
// container is restarted. Two things are needed to keep that from looking like
// a broken app:
//
//  1. Wake the server as EARLY as possible. The wake-up is started when the
//     user first lands on any page (landing page included), not when they log
//     in, so the cold start overlaps with the time they spend reading the page
//     instead of blocking their first real action.
//
//  2. Keep it awake while they work. After every backend response we note the
//     time; if the app goes quiet for IDLE_PING_INTERVAL_MS we send a cheap
//     health ping so the instance is never suspended mid-session.
//
// Status changes are pushed to subscribers so the UI can show an honest
// "Waking up server..." message with elapsed time instead of a generic spinner.

import axios from 'axios';
import { API_URL } from '../config/api';

export type ServerStatus =
    | 'unknown'      // nothing attempted yet
    | 'checking'     // a probe is in flight and has been fast so far
    | 'waking'       // probe is taking long enough that this is a cold start
    | 'ready'        // backend answered successfully
    | 'unreachable'; // gave up after exhausting retries

export interface ServerStatusSnapshot {
    status: ServerStatus;
    /** ms spent on the current wake attempt (0 when not waking). */
    elapsedMs: number;
    /** Timestamp of the last successful backend response, or null. */
    lastSuccessAt: number | null;
    /** How many probe attempts the current wake cycle has made. */
    attempt: number;
}

type Listener = (snapshot: ServerStatusSnapshot) => void;

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Show "waking up" only after the probe has been slow enough to mean a cold start. */
const COLD_START_NOTICE_DELAY_MS = 1_500;

/** Per-probe timeout. Cold boots are slow, so this is generous. */
const PROBE_TIMEOUT_MS = 15_000;

/** Total budget for one wake cycle before we report the server unreachable. */
const WAKE_BUDGET_MS = 90_000;

/** Delay between failed probes. */
const RETRY_DELAY_MS = 2_500;

/** Send a keep-alive ping once backend traffic has been idle this long. */
const IDLE_PING_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

/** How often we check whether the idle threshold has been crossed. */
const IDLE_CHECK_INTERVAL_MS = 30_000;

/** Elapsed-time refresh rate while waking, so the UI can count up. */
const TICK_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

// A dedicated axios instance. Interceptors registered on the global `axios`
// default are NOT inherited here, which is deliberate: health pings must not
// appear in the network trace and must not count as user activity, otherwise
// the keep-alive would keep resetting its own idle timer forever.
const probeClient = axios.create({ timeout: PROBE_TIMEOUT_MS });

const listeners = new Set<Listener>();

let status: ServerStatus = 'unknown';
let attempt = 0;
let wakeStartedAt: number | null = null;
let lastSuccessAt: number | null = null;
let lastActivityAt = 0;

let wakePromise: Promise<boolean> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

const snapshot = (): ServerStatusSnapshot => ({
    status,
    elapsedMs: wakeStartedAt ? Date.now() - wakeStartedAt : 0,
    lastSuccessAt,
    attempt
});

const emit = () => {
    const current = snapshot();
    listeners.forEach(listener => {
        try {
            listener(current);
        } catch (error) {
            console.error('[ServerWake] listener failed', error);
        }
    });
};

const setStatus = (next: ServerStatus) => {
    if (status === next) return;
    status = next;
    emit();
};

const startTicking = () => {
    if (tickTimer) return;
    // Only needed while a wake is in progress; drives the elapsed-time display.
    tickTimer = setInterval(emit, TICK_INTERVAL_MS);
};

const stopTicking = () => {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Single cheap health probe. Resolves true when the backend answered.
 *
 * A non-2xx response still counts as "awake": the container is running and
 * routing requests, which is all the wake-up cares about. Only transport
 * failures and timeouts count as still-asleep.
 */
const probeOnce = async (): Promise<boolean> => {
    try {
        await probeClient.get(`${API_URL}/health`, {
            // Defeat any intermediate caching so we always hit the origin.
            params: { _: Date.now() }
        });
        return true;
    } catch (error) {
        if (axios.isAxiosError(error) && error.response) {
            return true;
        }
        return false;
    }
};

const markSuccess = () => {
    lastSuccessAt = Date.now();
    lastActivityAt = lastSuccessAt;
    attempt = 0;
    wakeStartedAt = null;
    stopTicking();
    setStatus('ready');
    // setStatus is a no-op if we were already 'ready', but the timestamps above
    // changed, so make sure subscribers still see the fresh snapshot.
    emit();
};

const runWakeCycle = async (): Promise<boolean> => {
    wakeStartedAt = Date.now();
    attempt = 0;
    setStatus('checking');
    startTicking();

    const noticeTimer = setTimeout(() => {
        if (status === 'checking') setStatus('waking');
    }, COLD_START_NOTICE_DELAY_MS);

    try {
        while (Date.now() - wakeStartedAt < WAKE_BUDGET_MS) {
            attempt += 1;
            emit();

            const awake = await probeOnce();
            if (awake) {
                clearTimeout(noticeTimer);
                markSuccess();
                return true;
            }

            // Transport failure. On a cold start this is expected for the first
            // few tries, so keep going until the budget is spent.
            setStatus('waking');
            await sleep(RETRY_DELAY_MS);
        }

        clearTimeout(noticeTimer);
        stopTicking();
        setStatus('unreachable');
        return false;
    } finally {
        clearTimeout(noticeTimer);
        stopTicking();
        wakePromise = null;
        if (status !== 'ready' && status !== 'unreachable') {
            // Defensive: never leave the UI stuck on a transient status.
            setStatus('unreachable');
        }
    }
};

// ---------------------------------------------------------------------------
// Keep-alive
// ---------------------------------------------------------------------------

const keepAliveTick = () => {
    // Nothing to keep alive if we never reached the backend, or if the browser
    // knows it is offline. Also skip while a wake cycle is already running.
    if (wakePromise) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // Background tabs get throttled and pinging from them mostly wastes
        // the free tier's request budget. We ping again on becoming visible.
        return;
    }

    const idleFor = Date.now() - lastActivityAt;
    if (idleFor < IDLE_PING_INTERVAL_MS) return;

    void (async () => {
        const awake = await probeOnce();
        if (awake) {
            // Note the ping itself as the new activity marker so the next ping
            // is a full interval away.
            lastSuccessAt = Date.now();
            lastActivityAt = lastSuccessAt;
            setStatus('ready');
        } else {
            // The instance went to sleep despite the keep-alive (or the network
            // dropped). Start a full wake cycle so the UI reports it honestly.
            void serverWake.ensureAwake({ force: true });
        }
    })();
};

const handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    // Coming back to the tab is the moment the user is most likely to act, so
    // verify the backend is still up if we have been away a while.
    if (Date.now() - lastActivityAt >= IDLE_PING_INTERVAL_MS) {
        void serverWake.ensureAwake({ force: true });
    }
};

const handleOnline = () => {
    void serverWake.ensureAwake({ force: true });
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const serverWake = {
    /**
     * Begin waking the backend and start the keep-alive loop. Safe to call
     * repeatedly; only the first call does the setup work.
     *
     * Call this as early as possible in the app lifecycle (landing page mount).
     */
    start(): Promise<boolean> {
        if (!started) {
            started = true;

            idleTimer = setInterval(keepAliveTick, IDLE_CHECK_INTERVAL_MS);

            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', handleVisibilityChange);
            }
            if (typeof window !== 'undefined') {
                window.addEventListener('online', handleOnline);
            }
        }

        return this.ensureAwake();
    },

    /**
     * Ensure a wake cycle is running. Concurrent callers share one cycle.
     *
     * @param force Re-probe even if the backend previously answered.
     */
    ensureAwake({ force = false }: { force?: boolean } = {}): Promise<boolean> {
        if (wakePromise) return wakePromise;
        if (!force && status === 'ready') return Promise.resolve(true);

        wakePromise = runWakeCycle();
        return wakePromise;
    },

    /**
     * Record that real backend traffic just succeeded. Called from the axios
     * response interceptor so the keep-alive only fires during genuine idle
     * periods rather than on a fixed schedule.
     */
    noteActivity(): void {
        lastActivityAt = Date.now();
        lastSuccessAt = lastActivityAt;
        if (status !== 'ready') {
            setStatus('ready');
        }
    },

    /**
     * Record that a backend request failed at the transport level (no HTTP
     * response). That usually means the instance was suspended again, so we
     * surface the wake-up UI rather than letting the user stare at a failure.
     */
    noteTransportFailure(): void {
        if (wakePromise) return;
        void this.ensureAwake({ force: true });
    },

    getSnapshot(): ServerStatusSnapshot {
        return snapshot();
    },

    subscribe(listener: Listener): () => void {
        listeners.add(listener);
        listener(snapshot());
        return () => {
            listeners.delete(listener);
        };
    },

    /** Test/teardown helper. Not used in normal app flow. */
    stop(): void {
        if (idleTimer) {
            clearInterval(idleTimer);
            idleTimer = null;
        }
        stopTicking();
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', handleOnline);
        }
        started = false;
    }
};

export const IDLE_KEEP_ALIVE_INTERVAL_MS = IDLE_PING_INTERVAL_MS;
