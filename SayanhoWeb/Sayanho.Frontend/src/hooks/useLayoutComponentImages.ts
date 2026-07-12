import { useState, useEffect } from 'react';
import { LAYOUT_COMPONENT_DEFINITIONS } from '../utils/LayoutComponentDefinitions';
import { api } from '../services/api';

/**
 * Hook to preload all layout component SVG icons
 * Returns a map of component type -> HTMLImageElement
 */
export function useLayoutComponentImages() {
    const [images, setImages] = useState<Record<string, HTMLImageElement>>({});

    useEffect(() => {
        const loadImages = async () => {
            const loadedImages: Record<string, HTMLImageElement> = {};
            const promises: Promise<void>[] = [];
            // Cache-bust so browsers always load fresh SVGs after updates
            const v = '2';

            Object.values(LAYOUT_COMPONENT_DEFINITIONS).forEach(def => {
                if (!def.svgIcon) return;

                const promise = new Promise<void>((resolve) => {
                    const img = new Image();
                    const iconName = def.svgIcon;

                    if (iconName) {
                        img.src = `${api.getIconUrl(iconName)}?v=${v}`;
                        img.crossOrigin = 'Anonymous';

                        img.onload = () => {
                            loadedImages[def.type] = img;
                            resolve();
                        };

                        img.onerror = () => {
                            console.warn(`[LayoutImages] Failed to load icon for ${def.type}: ${def.svgIcon}`);
                            resolve();
                        };
                    } else {
                        resolve();
                    }
                });

                promises.push(promise);
            });

            await Promise.all(promises);
            setImages(loadedImages);
        };

        loadImages();
    }, []);

    return images;
}
