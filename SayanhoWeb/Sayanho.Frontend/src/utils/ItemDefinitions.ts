import { Point, Size } from '../types';

export const STATIC_ITEM_DEFINITIONS: Record<string, { size: Size, connectionPoints: Record<string, Point> }> = {
    "Portal": {
        size: { width: 60, height: 40 },
        connectionPoints: {
            "port": { x: 60, y: 20 }
        }
    },
    "Source": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "out": { x: 30, y: 60 }
        }
    },
    "Main Switch": {
        size: { width: 100, height: 100 },
        connectionPoints: {
            "in": { x: 50, y: 0 },
            "out": { x: 50, y: 100 }
        }
    },
    "Change Over Switch": {
        size: { width: 100, height: 100 },
        connectionPoints: {
            "in1": { x: 31, y: 0 },
            "in2": { x: 85, y: 0 },
            "out": { x: 58, y: 100 }
        }
    },
    "Bulb": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    },
    "Tube Light": {
        size: { width: 80, height: 48 },
        connectionPoints: {
            "in": { x: 40, y: 0 }
        }
    },
    "Ceiling Fan": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    },
    "Exhaust Fan": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    },
    "Split AC": {
        size: { width: 80, height: 60 },
        connectionPoints: {
            "in": { x: 40, y: 0 }
        }
    },
    "AC Point": {
        size: { width: 80, height: 60 },
        connectionPoints: {
            "in": { x: 40, y: 0 }
        }
    },
    "Geyser": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    },
    "Geyser Point": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    },
    "Call Bell": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    },
    "Point Switch Board": {
        size: { width: 200, height: 120 },
        connectionPoints: {
            "in": { x: 100, y: 0 },
            "out1": { x: 4, y: 120 },
            "out2": { x: 28, y: 120 },
            "out3": { x: 52, y: 120 },
            "out4": { x: 76, y: 120 },
            "out5": { x: 100, y: 120 },
            "out6": { x: 124, y: 120 },
            "out7": { x: 148, y: 120 },
            "out8": { x: 172, y: 120 },
            "out9": { x: 196, y: 120 }
        }
    },
    "Avg. 5A Switch Board": {
        size: { width: 100, height: 100 },
        connectionPoints: {
            "in": { x: 50, y: 0 }
        }
    },
    "LT Cubical Panel": {
        size: { width: 300, height: 200 },
        connectionPoints: {}
    },
    // Default fallback for others
    "default": {
        size: { width: 60, height: 60 },
        connectionPoints: {
            "in": { x: 30, y: 0 }
        }
    }
};

export const getItemDefinition = (name: string) => {
    return STATIC_ITEM_DEFINITIONS[name] || STATIC_ITEM_DEFINITIONS["default"];
};
