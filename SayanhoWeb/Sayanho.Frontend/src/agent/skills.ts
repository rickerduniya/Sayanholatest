// Skill registry.
//
// Skills are markdown documents holding the domain knowledge the agent needs:
// the design workflow, per-room load quantities, board sizing arithmetic, and
// the wiring rules. Keeping them as files rather than string literals inside the
// system prompt has two practical benefits:
//
//  1. They can be edited by an electrical engineer without touching TypeScript.
//  2. They are loaded on demand. Injecting all four into every request would
//     add ~6k tokens to each turn of a 20-turn agent run for no benefit, and
//     would break Gemini's static-prompt caching.
//
// The agent is told which skills exist and asks for the ones it needs via the
// `load_skill` tool.

import workflowSkill from './skills/electrical-design-workflow.md?raw';
import loadPlacementSkill from './skills/load-placement.md?raw';
import boardSizingSkill from './skills/board-sizing.md?raw';
import connectionRulesSkill from './skills/connection-rules.md?raw';

export interface Skill {
    name: string;
    description: string;
    /** Which half of the app the skill is about, for the agent's benefit. */
    appliesTo: 'layout' | 'sld' | 'layout+sld';
    content: string;
}

/** Strip the YAML front matter so it does not confuse the model. */
const stripFrontMatter = (raw: string): string =>
    raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();

export const SKILLS: Skill[] = [
    {
        name: 'electrical-design-workflow',
        description: 'Master phase-by-phase workflow: floor plan → loads → switch boards → distribution boards → SLD → verification. Load this first for any full design request.',
        appliesTo: 'layout+sld',
        content: stripFrontMatter(workflowSkill)
    },
    {
        name: 'load-placement',
        description: 'Comprehensive Indian residential placement guide — quantities, positions, mounting surfaces (all lights are wall mounted; AC points and exhaust fans go on boundary walls only), door-side switch logic, furniture-aware socket placement, and contextual reasoning for every component type.',
        appliesTo: 'layout',
        content: stripFrontMatter(loadPlacementSkill)
    },
    {
        name: 'board-sizing',
        description: 'Counting and sizing SPN DB / HTPN / VTPN boards from the placed loads, valid Way values, spare capacity, and phase balancing.',
        appliesTo: 'layout+sld',
        content: stripFrontMatter(boardSizingSkill)
    },
    {
        name: 'connection-rules',
        description: 'Exact SLD wiring map and connection point keys: loads → Point Switch Board → SPN DB → HTPN → VTPN → Source, with AC/geyser on dedicated HTPN ways.',
        appliesTo: 'sld',
        content: stripFrontMatter(connectionRulesSkill)
    }
];

export function getSkill(name: string): Skill | undefined {
    const q = (name || '').trim().toLowerCase();
    return SKILLS.find(s => s.name.toLowerCase() === q);
}

/** Compact index for the system prompt: names + descriptions, no bodies. */
export function getSkillIndex(): string {
    return SKILLS
        .map(s => `- ${s.name} (${s.appliesTo}): ${s.description}`)
        .join('\n');
}

export function listSkillNames(): string[] {
    return SKILLS.map(s => s.name);
}
