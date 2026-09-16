export interface ApiTraceEntry {
    id: number;
    timestamp: string;
    method: string;
    url: string;
    requestHeaders?: Record<string, string>;
    requestBody?: any;
    requestParams?: any;
    responseStatus?: number;
    responseStatusText?: string;
    responseHeaders?: Record<string, string>;
    responseBody?: any;
    duration?: number;
    error?: string;
}

/**
 * Strip credentials before a trace is stored.
 *
 * The Network Monitor exists to be copied into a bug report, and it was
 * recording bearer tokens and LLM API keys verbatim in request headers. Anyone
 * pasting a trace log was publishing their session token and their provider key.
 * Redaction happens on the way in, so no secret is ever held in memory by the
 * tracer and "Copy" cannot leak one.
 */
const SENSITIVE_HEADERS = new Set([
    'authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'openai-api-key',
    'cookie',
    'set-cookie',
    'proxy-authorization'
]);

const maskSecret = (value: string): string => {
    const v = (value || '').toString();
    // Keep the scheme and a short tail so a reader can still tell two different
    // tokens apart without being able to use either.
    const bearer = v.match(/^(Bearer|Basic|Token)\s+(.*)$/i);
    if (bearer) {
        const secret = bearer[2] || '';
        return `${bearer[1]} [redacted${secret.length > 4 ? `, …${secret.slice(-4)}` : ''}]`;
    }
    return `[redacted${v.length > 4 ? `, …${v.slice(-4)}` : ''}]`;
};

const redactHeaders = (headers?: Record<string, string>): Record<string, string> | undefined => {
    if (!headers) return headers;

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
            ? maskSecret(value as unknown as string)
            : (value as unknown as string);
    }
    return out;
};

/** Remove a key embedded in a query string, e.g. Gemini's ?key=… */
const redactUrl = (url: string): string => {
    if (!url) return url;
    return url.replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&]+/gi, '$1[redacted]');
};

const redactTrace = (trace: ApiTraceEntry): ApiTraceEntry => ({
    ...trace,
    url: redactUrl(trace.url),
    requestHeaders: redactHeaders(trace.requestHeaders),
    responseHeaders: redactHeaders(trace.responseHeaders)
});

class ApiTracer {
    private traces: ApiTraceEntry[] = [];
    private maxTraces = 100; // Keep last 100 traces
    private listeners: (() => void)[] = [];

    addTrace(trace: ApiTraceEntry) {
        this.traces.push(redactTrace(trace));
        // Keep only the last maxTraces entries
        if (this.traces.length > this.maxTraces) {
            this.traces = this.traces.slice(-this.maxTraces);
        }
        this.notifyListeners();
    }

    getTraces(): ApiTraceEntry[] {
        return [...this.traces];
    }

    clearTraces() {
        this.traces = [];
        this.notifyListeners();
    }

    addListener(callback: () => void) {
        this.listeners.push(callback);
    }

    removeListener(callback: () => void) {
        this.listeners = this.listeners.filter(cb => cb !== callback);
    }

    private notifyListeners() {
        this.listeners.forEach(cb => cb());
    }

    getFormattedTraces(): string {
        if (this.traces.length === 0) {
            return 'No API traces recorded yet.';
        }

        let output = '='.repeat(80) + '\n';
        output += 'API TRACE LOG\n';
        output += `Generated: ${new Date().toISOString()}\n`;
        output += `Total Requests: ${this.traces.length}\n`;
        output += '='.repeat(80) + '\n\n';

        this.traces.forEach((trace, index) => {
            output += `\n${'─'.repeat(80)}\n`;
            output += `[${index + 1}/${this.traces.length}] Request ID: ${trace.id}\n`;
            output += `${'─'.repeat(80)}\n`;
            output += `Timestamp: ${trace.timestamp}\n`;
            output += `Method: ${trace.method}\n`;
            output += `URL: ${trace.url}\n`;

            if (trace.requestParams && Object.keys(trace.requestParams).length > 0) {
                output += `\nQuery Parameters:\n`;
                output += JSON.stringify(trace.requestParams, null, 2) + '\n';
            }

            if (trace.requestHeaders && Object.keys(trace.requestHeaders).length > 0) {
                output += `\nRequest Headers:\n`;
                output += JSON.stringify(trace.requestHeaders, null, 2) + '\n';
            }

            if (trace.requestBody !== undefined && trace.requestBody !== null) {
                output += `\nRequest Body:\n`;
                if (typeof trace.requestBody === 'string') {
                    output += trace.requestBody + '\n';
                } else if (trace.requestBody instanceof Blob) {
                    output += `[Blob: ${trace.requestBody.size} bytes, type: ${trace.requestBody.type}]\n`;
                } else {
                    output += JSON.stringify(trace.requestBody, null, 2) + '\n';
                }
            }

            if (trace.duration !== undefined) {
                output += `\nDuration: ${trace.duration}ms\n`;
            }

            if (trace.error) {
                output += `\n❌ ERROR:\n${trace.error}\n`;
            } else if (trace.responseStatus !== undefined) {
                output += `\nResponse Status: ${trace.responseStatus} ${trace.responseStatusText || ''}\n`;

                if (trace.responseHeaders && Object.keys(trace.responseHeaders).length > 0) {
                    output += `\nResponse Headers:\n`;
                    output += JSON.stringify(trace.responseHeaders, null, 2) + '\n';
                }

                if (trace.responseBody !== undefined && trace.responseBody !== null) {
                    output += `\nResponse Body:\n`;
                    if (typeof trace.responseBody === 'string') {
                        // Truncate very long strings
                        const maxLength = 5000;
                        if (trace.responseBody.length > maxLength) {
                            output += trace.responseBody.substring(0, maxLength) + `\n... [truncated, total length: ${trace.responseBody.length}]\n`;
                        } else {
                            output += trace.responseBody + '\n';
                        }
                    } else if (trace.responseBody instanceof Blob) {
                        output += `[Blob: ${trace.responseBody.size} bytes, type: ${trace.responseBody.type}]\n`;
                    } else {
                        const jsonStr = JSON.stringify(trace.responseBody, null, 2);
                        const maxLength = 5000;
                        if (jsonStr.length > maxLength) {
                            output += jsonStr.substring(0, maxLength) + `\n... [truncated, total length: ${jsonStr.length}]\n`;
                        } else {
                            output += jsonStr + '\n';
                        }
                    }
                }
            }
        });

        output += `\n${'='.repeat(80)}\n`;
        output += 'END OF TRACE LOG\n';
        output += '='.repeat(80) + '\n';

        return output;
    }

    copyToClipboard(): Promise<void> {
        const formatted = this.getFormattedTraces();
        return navigator.clipboard.writeText(formatted);
    }
}

export const apiTracer = new ApiTracer();
