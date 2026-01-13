
// Central definition for item categories and their contents
// Used by both SLD Sidebar and Layout Sidebar for consistency

export interface CategoryDefinition {
    id: string; // Internal ID
    label: string; // Display Name
    icon: string; // Emoji or Icon char
    sldItems: string[]; // List of SLD Item Names
    order: number;
    styleClass?: string; // Optional styling class reference
}

export const UNIFIED_ITEM_CATEGORIES: CategoryDefinition[] = [
    {
        id: 'distribution',
        label: 'Distribution Boards',
        icon: '📦',
        order: 1,
        sldItems: ["VTPN", "HTPN", "SPN DB", "LT Cubical Panel", "Busbar Chamber"],
        styleClass: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200"
    },
    {
        id: 'switchgear',
        label: 'Switchgear',
        icon: '⏻',
        order: 2,
        sldItems: ["Main Switch", "Change Over Switch"],
        styleClass: "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200"
    },
    {
        id: 'appliances',
        label: 'Appliances',
        icon: '🔧',
        order: 3,
        // Moved AC Point here to match SLD
        sldItems: ["AC Point", "Geyser Point", "Computer Point"],
        styleClass: "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200"
    },
    {
        id: 'lighting',
        label: 'Lighting',
        icon: '💡',
        order: 4,
        sldItems: ["Light Point", "Tube Light", "Bulb"],
        styleClass: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
    },
    {
        id: 'fans',
        label: 'Fans',
        icon: '❄️',
        order: 5,
        sldItems: ["Ceiling Fan", "Exhaust Fan", "Ceiling Rose"],
        styleClass: "bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200"
    },
    {
        id: 'switch_boards',
        label: 'Switch Boards',
        icon: '⬚',
        order: 6,
        sldItems: [
            "Point Switch Board",
            "Avg. 5A Switch Board",
            "2 Switch Board", "3 Switch Board", "4 Switch Board",
            "6 Switch Board", "8 Switch Board", "12 Switch Board", "18 Switch Board"
        ],
        styleClass: "bg-slate-200 text-slate-900 dark:bg-slate-800/60 dark:text-slate-300"
    },
    {
        id: 'sockets',
        label: 'Sockets',
        icon: '🔌',
        order: 7,
        sldItems: ["5A Socket", "15A Socket", "5A Socket Board", "15A Socket Board"],
        styleClass: "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200"
    },
    {
        id: 'infrastructure',
        label: 'Infrastructure',
        icon: '⚡',
        order: 8,
        sldItems: ["Source", "Portal", "Generator"],
        styleClass: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200"
    },
    {
        id: 'meters',
        label: 'Meters',
        icon: 'Ⓜ',
        order: 9,
        sldItems: ["1 Phase Meter", "3 Phase Meter"],
        styleClass: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200"
    },
    {
        id: 'others',
        label: 'Others',
        icon: '🔔',
        order: 10,
        // Normalized "Bell" and "Call Bell Point" to "Call Bell"
        sldItems: ["Call Bell", "Bell Push"],
        styleClass: "bg-pink-100 text-pink-900 dark:bg-pink-900/40 dark:text-pink-200"
    },
    // Layout only categories (mapped for consistency, though SLD might not populate them yet)
    {
        id: 'safety',
        label: 'Safety',
        icon: '🚨',
        order: 11,
        sldItems: [], // No SLD equivalents yet
        styleClass: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200"
    }
];
