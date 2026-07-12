/**
 * LocalProjectService — Save/Load entire Sayanho projects as .sayanho files
 * 
 * Exports: SLD sheets + Layout floor plans + floor plan images (from IndexedDB)
 * Imports: Restores all state from a .sayanho file, including images back into IndexedDB
 * 
 * File format is versioned JSON with base64-encoded images embedded.
 */

import { CanvasSheet, CanvasItem } from '../types';
import { FloorPlan, LayoutComponent } from '../types/layout';
import { stripSheetsForApi, LightCanvasSheet, LightConnector } from './payloadUtils';
import { layoutImageStore } from './LayoutImageStore';
import { api } from '../services/api';

// ============================================================================
// File Format Types
// ============================================================================

const CURRENT_VERSION = 1;
const FORMAT_IDENTIFIER = 'sayanho-project';

interface SayanhoProjectFile {
    version: number;
    format: typeof FORMAT_IDENTIFIER;
    savedAt: string;
    projectName: string;
    sld: {
        sheets: LightCanvasSheet[];
    };
    layout: {
        floorPlans: FloorPlan[];
        activeFloorPlanId: string | null;
        stagingComponents: LayoutComponent[];
        placedStagingComponentIds: string[];
    };
    images: Record<string, string>; // id → data URL
}

export interface ImportResult {
    success: boolean;
    projectName: string;
    sheets: CanvasSheet[];
    error?: string;
}

// ============================================================================
// EXPORT — Save project to a local .sayanho file
// ============================================================================

export async function exportProjectToFile(
    sheets: CanvasSheet[],
    floorPlans: FloorPlan[],
    activeFloorPlanId: string | null,
    stagingComponents: LayoutComponent[],
    placedStagingComponentIds: string[],
    projectName: string
): Promise<void> {
    console.log('[LocalProject] Starting export...');

    // 1. Strip SLD sheets (remove undo/redo, svgContent — same as backend save)
    const strippedSheets = stripSheetsForApi(sheets, true); // include viewport

    // 2. Clean floor plans (remove transient data that shouldn't be persisted)
    const cleanedFloorPlans = floorPlans.map(fp => ({
        ...fp,
        // Keep all architectural + component data, just ensure no circular refs
    }));

    // 3. Collect and embed floor plan images from IndexedDB
    const images: Record<string, string> = {};
    const imageIds = new Set<string>();

    for (const fp of floorPlans) {
        if (fp.backgroundImageId) {
            imageIds.add(fp.backgroundImageId);
        }
    }

    for (const imageId of imageIds) {
        try {
            const dataUrl = await layoutImageStore.getImageAsDataUrl(imageId);
            if (dataUrl) {
                images[imageId] = dataUrl;
                console.log(`[LocalProject] Embedded image: ${imageId}`);
            }
        } catch (err) {
            console.warn(`[LocalProject] Failed to read image ${imageId}:`, err);
        }
    }

    // 4. Assemble the project file
    const projectFile: SayanhoProjectFile = {
        version: CURRENT_VERSION,
        format: FORMAT_IDENTIFIER,
        savedAt: new Date().toISOString(),
        projectName,
        sld: {
            sheets: strippedSheets,
        },
        layout: {
            floorPlans: cleanedFloorPlans,
            activeFloorPlanId,
            stagingComponents,
            placedStagingComponentIds,
        },
        images,
    };

    // 5. Serialize to blob
    const jsonString = JSON.stringify(projectFile);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const sizeKB = (blob.size / 1024).toFixed(1);
    const suggestedName = `${sanitizeFilename(projectName)}.sayanho`;

    // 6. Show native Save As dialog using File System Access API (Chrome/Edge)
    //    Fallback to direct download for Firefox/Safari/other browsers
    if ('showSaveFilePicker' in window) {
        try {
            const fileHandle = await (window as any).showSaveFilePicker({
                suggestedName,
                types: [
                    {
                        description: 'Sayanho Project File',
                        accept: { 'application/json': ['.sayanho'] },
                    },
                ],
            });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            console.log(`[LocalProject] Saved "${projectName}" via File System Access API (${sizeKB} KB, ${Object.keys(images).length} images)`);
            return;
        } catch (err: any) {
            // User cancelled the dialog — not an error
            if (err.name === 'AbortError') {
                console.log('[LocalProject] Save cancelled by user.');
                throw new Error('CANCELLED');
            }
            // For any other error, fall through to the legacy download below
            console.warn('[LocalProject] File System Access API failed, falling back to download:', err);
        }
    }

    // Fallback: trigger browser download (Firefox, Safari, older browsers)
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    console.log(`[LocalProject] Exported "${projectName}" via download (${sizeKB} KB, ${Object.keys(images).length} images)`);
}

// ============================================================================
// IMPORT — Load project from a local .sayanho file
// ============================================================================

export function importProjectFromFile(): Promise<ImportResult> {
    return new Promise((resolve) => {
        // Create a hidden file input
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.sayanho';
        input.style.display = 'none';

        input.onchange = async (event) => {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (!file) {
                resolve({ success: false, projectName: '', sheets: [], error: 'No file selected' });
                document.body.removeChild(input);
                return;
            }

            try {
                console.log(`[LocalProject] Importing file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
                const text = await file.text();
                const projectFile = JSON.parse(text) as SayanhoProjectFile;

                // Validate format
                if (projectFile.format !== FORMAT_IDENTIFIER) {
                    throw new Error(`Invalid file format. Expected "${FORMAT_IDENTIFIER}", got "${projectFile.format}"`);
                }
                if (!projectFile.version || projectFile.version > CURRENT_VERSION) {
                    throw new Error(`Unsupported file version: ${projectFile.version}. Max supported: ${CURRENT_VERSION}`);
                }
                if (!projectFile.sld?.sheets) {
                    throw new Error('File is missing SLD sheet data');
                }

                // 1. Reconstruct full CanvasSheets from lightweight format
                const reconstructedSheets = reconstructSheets(projectFile.sld.sheets);

                // 2. Restore SVG content from API (same as loadDiagram)
                const restoredSheets = await restoreSvgContent(reconstructedSheets);

                // 3. Restore images to IndexedDB
                if (projectFile.images) {
                    await restoreImages(projectFile.images);
                }

                // 4. Restore layout state (handled by caller via returned data + store action)
                const result: ImportResult & { layoutData?: SayanhoProjectFile['layout'] } = {
                    success: true,
                    projectName: projectFile.projectName || file.name.replace('.sayanho', ''),
                    sheets: restoredSheets,
                };

                // Attach layout data for the caller to apply
                (result as any).layoutData = projectFile.layout;

                resolve(result);
            } catch (err: any) {
                console.error('[LocalProject] Import failed:', err);
                resolve({
                    success: false,
                    projectName: '',
                    sheets: [],
                    error: err.message || 'Failed to parse project file',
                });
            } finally {
                document.body.removeChild(input);
            }
        };

        // Handle cancel (user closes file picker without selecting)
        input.oncancel = () => {
            resolve({ success: false, projectName: '', sheets: [], error: 'Cancelled' });
            document.body.removeChild(input);
        };

        document.body.appendChild(input);
        input.click();
    });
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Reconstruct full CanvasSheet objects from lightweight API format.
 * Re-links connector sourceItem/targetItem references and adds empty undo/redo stacks.
 */
function reconstructSheets(lightSheets: LightCanvasSheet[]): CanvasSheet[] {
    return lightSheets.map((light) => {
        // Build a lookup map: uniqueID → CanvasItem
        const itemMap = new Map<string, CanvasItem>();
        const canvasItems: CanvasItem[] = light.canvasItems.map((li) => {
            const item: CanvasItem = {
                uniqueID: li.uniqueID,
                name: li.name,
                position: li.position,
                size: li.size,
                connectionPoints: li.connectionPoints,
                properties: li.properties,
                alternativeCompany1: li.alternativeCompany1,
                alternativeCompany2: li.alternativeCompany2,
                iconPath: li.iconPath,
                locked: li.locked,
                idPoints: li.idPoints,
                incomer: li.incomer,
                outgoing: li.outgoing,
                accessories: li.accessories,
                rotation: li.rotation,
                // svgContent will be restored later
            };
            itemMap.set(item.uniqueID, item);
            return item;
        });

        // Reconstruct connectors with full item references
        const storedConnectors = (light.storedConnectors as LightConnector[]).map((lc) => ({
            sourceItem: itemMap.get(lc.sourceItemId) || ({} as CanvasItem),
            sourcePointKey: lc.sourcePointKey,
            targetItem: itemMap.get(lc.targetItemId) || ({} as CanvasItem),
            targetPointKey: lc.targetPointKey,
            materialType: lc.materialType,
            properties: lc.properties,
            alternativeCompany1: lc.alternativeCompany1,
            alternativeCompany2: lc.alternativeCompany2,
            laying: lc.laying,
            accessories: lc.accessories,
            length: lc.length,
            isVirtual: lc.isVirtual,
        }));

        return {
            sheetId: light.sheetId,
            name: light.name,
            canvasItems,
            storedConnectors,
            existingLinePoints: light.existingLinePoints,
            existingConnections: light.existingConnections,
            scale: light.scale,
            viewportX: light.viewportX || 0,
            viewportY: light.viewportY || 0,
            undoStack: [],
            redoStack: [],
        } as CanvasSheet;
    });
}

/**
 * Restore SVG content for all items (same logic as loadDiagram in App.tsx).
 * Fetches SVG icons from backend API and regenerates Portal SVGs.
 */
async function restoreSvgContent(sheets: CanvasSheet[]): Promise<CanvasSheet[]> {
    return Promise.all(
        sheets.map(async (sheet) => {
            const restoredItems = await Promise.all(
                sheet.canvasItems.map(async (item) => {
                    // Portal — regenerate SVG from properties
                    if (item.name === 'Portal' && !item.svgContent) {
                        return { ...item, svgContent: generatePortalSvg(item) };
                    }

                    // Regular items — fetch SVG from API via iconPath
                    if (!item.svgContent && item.iconPath) {
                        try {
                            const iconName = item.iconPath.split('/').pop();
                            if (iconName) {
                                const url = encodeURI(api.getIconUrl(iconName));
                                const response = await fetch(url);
                                if (response.ok) {
                                    let svg = await response.text();
                                    // Apply visual updates if properties exist
                                    if (item.properties && item.properties[0]) {
                                        const { updateItemVisuals } = await import('./SvgUpdater');
                                        const updatedSvg = updateItemVisuals({ ...item, svgContent: svg });
                                        if (updatedSvg) svg = updatedSvg;
                                    }
                                    return { ...item, svgContent: svg };
                                }
                            }
                        } catch (error) {
                            console.error('[LocalProject] Failed to fetch SVG for', item.name, error);
                        }
                    }
                    return item;
                })
            );

            return { ...sheet, canvasItems: restoredItems };
        })
    );
}

/**
 * Generate Portal SVG based on direction property (same as App.tsx logic).
 */
function generatePortalSvg(item: CanvasItem): string {
    const meta = (item.properties?.[0] || {}) as Record<string, string>;
    const dir = (meta['Direction'] || meta['direction'] || 'out').toLowerCase();
    const w = item.size?.width || 60;
    const h = item.size?.height || 40;

    const arrow =
        dir === 'in'
            ? `<path d="M ${w / 2} ${h * 0.7} L ${w / 2} ${h * 0.3} M ${w / 2} ${h * 0.3} L ${w / 2 - 6} ${h * 0.3 + 6} M ${w / 2} ${h * 0.3} L ${w / 2 + 6} ${h * 0.3 + 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
            : `<path d="M ${w / 2} ${h * 0.3} L ${w / 2} ${h * 0.7} M ${w / 2} ${h * 0.7} L ${w / 2 - 6} ${h * 0.7 - 6} M ${w / 2} ${h * 0.7} L ${w / 2 + 6} ${h * 0.7 - 6}" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="6" ry="6" fill="#fff" stroke="#111" stroke-width="2"/>
  ${arrow}
</svg>`;
}

/**
 * Restore images from the project file back into IndexedDB.
 */
async function restoreImages(images: Record<string, string>): Promise<void> {
    for (const [id, dataUrl] of Object.entries(images)) {
        try {
            // Convert data URL to Blob
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            await layoutImageStore.saveImage(id, blob);
            console.log(`[LocalProject] Restored image to IndexedDB: ${id}`);
        } catch (err) {
            console.warn(`[LocalProject] Failed to restore image ${id}:`, err);
        }
    }
}

/**
 * Sanitize a project name for use as a filename.
 */
function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'Untitled';
}
