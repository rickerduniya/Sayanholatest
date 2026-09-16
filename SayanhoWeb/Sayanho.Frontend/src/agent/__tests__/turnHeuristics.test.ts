import { describe, it, expect } from 'vitest';
import { looksUnfinished } from '../turnHeuristics';

describe('looksUnfinished', () => {
    it('flags a turn that announces work with no tool call', () => {
        // Verbatim from the run this was written for: the agent said this, emitted
        // nothing, and the provider returned finish_reason: stop.
        expect(looksUnfinished(
            '**Reasoning**\n\nPlacing the decided loads for the merged living region, the kitchen and BATH-03, and pulling the remaining candidates.'
        )).toBe(true);
    });

    it('flags "Now I will…" and "Let me…" openings', () => {
        expect(looksUnfinished('Positions settled. Now generating the schematic symbols.')).toBe(true);
        expect(looksUnfinished('Let me read the actual diagram state.')).toBe(true);
        expect(looksUnfinished("I'll start with the query layer.")).toBe(true);
    });

    it('flags an empty message', () => {
        expect(looksUnfinished('')).toBe(true);
        expect(looksUnfinished('   ')).toBe(true);
    });

    it('does not flag a wrap-up that names its verification', () => {
        expect(looksUnfinished(
            'All 26 connectors are in. layout_validate reports 0 errors and validate_diagram is clean. Total connected load 8166 W across three phases.'
        )).toBe(false);
    });

    it('does not flag a past-tense summary', () => {
        expect(looksUnfinished(
            'Placed 26 devices across 13 rooms and wired every one. Two warnings remain: the plan is uncalibrated, and BEDROOM-01 borders no detected external wall.'
        )).toBe(false);
    });

    it('does not flag an answer to a question', () => {
        expect(looksUnfinished(
            'The SPN DB needs 7 ways for 4 point switch boards and 3 socket boards, so a 2+10 way board gives you three spare.'
        )).toBe(false);
    });

    it('does not flag a report of a blocker', () => {
        expect(looksUnfinished(
            'The floor plan has no detected rooms, so there is nothing to place. Run Detect Rooms in the Layout toolbar and start me again.'
        )).toBe(false);
    });
});
