export interface Point {
    x: number;
    y: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface ItemData {
    name: string;
    quantity: number;
    rate: number;
    power: number;
    size: Size;
    iconPath?: string;
    connectionPoints: Record<string, Point>;
    incomingPriorityList?: string[];
}

export interface CanvasItem {
    uniqueID: string;
    name: string;
    position: Point;
    size: Size;
    connectionPoints: Record<string, Point>;
    properties: Record<string, string>[];
    alternativeCompany1: string;
    alternativeCompany2: string;
    svgContent?: string;
    iconPath?: string;
    locked: boolean;
    idPoints: Record<string, Point>;
    incomer: Record<string, string>;
    outgoing: Record<string, string>[];
    accessories: Record<string, string>[];
    rotation?: number;
}

export interface Connector {
    sourceItem: CanvasItem;
    sourcePointKey: string;
    targetItem: CanvasItem;
    targetPointKey: string;

    // New Properties matching C#
    materialType: "Cable" | "Wiring";
    properties?: Record<string, string>;
    currentValues?: Record<string, string>;
    alternativeCompany1?: string;
    alternativeCompany2?: string;
    laying?: Record<string, string>;
    accessories?: Record<string, string>[];
    length?: number;
    isVirtual?: boolean;
}

export interface CanvasSheetState {
    canvasItems: CanvasItem[];
    storedConnectors: Connector[];
    existingLinePoints: Point[][];
    existingConnections: string[];
    scale: number;
    stagingItems?: CanvasItem[];
    placedStagingIds?: string[];
}

export interface CanvasSheet {
    sheetId: string;
    name: string;
    canvasItems: CanvasItem[];
    storedConnectors: Connector[];
    existingLinePoints: Point[][];
    existingConnections: string[];
    scale: number;
    viewportX: number;
    viewportY: number;
    undoStack: CanvasSheetState[];
    redoStack: CanvasSheetState[];
}
