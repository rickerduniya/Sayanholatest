// IndexedDB-based image storage for floor plan backgrounds
// Stores images client-side to reduce server bandwidth usage

const DB_NAME = 'SayanhoLayoutDB';
const DB_VERSION = 1;
const STORE_NAME = 'planImages';

export class LayoutImageStore {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    /**
     * Initialize the IndexedDB database
     */
    async init(): Promise<void> {
        if (this.db) return;

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error('[LayoutImageStore] Failed to open IndexedDB:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('[LayoutImageStore] IndexedDB initialized successfully');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;

                // Create object store for images
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    console.log('[LayoutImageStore] Created object store:', STORE_NAME);
                }
            };
        });

        return this.initPromise;
    }

    /**
     * Store an image blob with the given ID
     */
    async saveImage(id: string, blob: Blob, metadata?: Record<string, any>): Promise<void> {
        await this.init();

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const record = {
                id,
                blob,
                type: blob.type,
                size: blob.size,
                savedAt: new Date().toISOString(),
                ...metadata
            };

            const request = store.put(record);

            request.onsuccess = () => {
                console.log(`[LayoutImageStore] Saved image: ${id} (${(blob.size / 1024).toFixed(1)}KB)`);
                resolve();
            };

            request.onerror = () => {
                console.error('[LayoutImageStore] Failed to save image:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Retrieve an image blob by ID
     */
    async getImage(id: string): Promise<Blob | null> {
        await this.init();

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);

            request.onsuccess = () => {
                const record = request.result;
                if (record && record.blob) {
                    resolve(record.blob);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => {
                console.error('[LayoutImageStore] Failed to get image:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Get an image as a data URL for display
     */
    async getImageAsDataUrl(id: string): Promise<string | null> {
        const blob = await this.getImage(id);
        if (!blob) return null;

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Delete an image by ID
     */
    async deleteImage(id: string): Promise<void> {
        await this.init();

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);

            request.onsuccess = () => {
                console.log(`[LayoutImageStore] Deleted image: ${id}`);
                resolve();
            };

            request.onerror = () => {
                console.error('[LayoutImageStore] Failed to delete image:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * List all stored image IDs
     */
    async listImages(): Promise<string[]> {
        await this.init();

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAllKeys();

            request.onsuccess = () => {
                resolve(request.result as string[]);
            };

            request.onerror = () => {
                console.error('[LayoutImageStore] Failed to list images:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Get total storage usage
     */
    async getStorageUsage(): Promise<{ count: number; totalBytes: number }> {
        await this.init();

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const records = request.result;
                const totalBytes = records.reduce((sum, r) => sum + (r.size || 0), 0);
                resolve({
                    count: records.length,
                    totalBytes
                });
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    /**
     * Clear all stored images
     */
    async clearAll(): Promise<void> {
        await this.init();

        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onsuccess = () => {
                console.log('[LayoutImageStore] Cleared all images');
                resolve();
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }
}

// Singleton instance
export const layoutImageStore = new LayoutImageStore();
