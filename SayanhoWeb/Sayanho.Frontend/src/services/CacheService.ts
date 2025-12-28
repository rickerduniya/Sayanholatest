/**
 * CacheService
 * 
 * Provides a simple caching mechanism using sessionStorage.
 * "Cache First" strategy: always return from cache if available.
 * Cache clears automatically on browser reload/tab close.
 */

const STORAGE_PREFIX = 'sayanho_cache_';
const DEBUG = true;

interface CacheEntry<T> {
    data: T;
    timestamp: number;
    version: string;
}

// Current version of the cache structure - incrementing this invalidates all old cache
const CACHE_VERSION = 'v1';

export class CacheService {

    /**
     * Generate a unique key for the cache
     */
    static generateKey(base: string, params?: any): string {
        if (!params) return `${STORAGE_PREFIX}${base}`;

        // Sort keys to ensure consistent order
        const paramStr = Object.keys(params)
            .sort()
            .map(key => `${key}:${params[key]}`)
            .join('|');

        return `${STORAGE_PREFIX}${base}_${paramStr}`;
    }

    /**
     * Get item from cache
     */
    static get<T>(key: string): T | null {
        try {
            const item = sessionStorage.getItem(key);
            if (!item) return null;

            const parsed: CacheEntry<T> = JSON.parse(item);

            // Version check
            if (parsed.version !== CACHE_VERSION) {
                if (DEBUG) console.log(`[Cache] Version mismatch for ${key}. Invalidating.`);
                sessionStorage.removeItem(key);
                return null;
            }

            if (DEBUG) console.log(`[Cache] Hit for ${key}`);
            return parsed.data;
        } catch (e) {
            console.warn(`[Cache] Failed to read/parse key ${key}`, e);
            return null;
        }
    }

    /**
     * Set item in cache
     */
    static set<T>(key: string, data: T): void {
        try {
            const entry: CacheEntry<T> = {
                data,
                timestamp: Date.now(),
                version: CACHE_VERSION
            };
            sessionStorage.setItem(key, JSON.stringify(entry));
            if (DEBUG) console.log(`[Cache] Saved ${key}`);
        } catch (e) {
            console.warn(`[Cache] Failed to save key ${key}`, e);
            // Handle quota exceeded?
            if (e instanceof DOMException && e.name === 'QuotaExceededError') {
                console.error('[Cache] Storage quota exceeded. Clearing old cache might be needed.');
                // Optional: Clear strict prefix matches or older items
            }
        }
    }

    /**
     * Clear all application specific cache
     */
    static clear(): void {
        Object.keys(sessionStorage).forEach(key => {
            if (key.startsWith(STORAGE_PREFIX)) {
                sessionStorage.removeItem(key);
            }
        });
        console.log('[Cache] Cleared all entries.');
    }
}
