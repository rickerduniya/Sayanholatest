// The extreme-downstream (tier 0) row spaces adjacent item centres by
// ((w1 + w2) / 2) * factor — touching distance plus a margin — instead of a
// fixed pixel gap, so wide boards get room and narrow loads do not waste space.

import { describe, it, expect } from 'vitest';
import { applyAutoArrange, DEFAULT_DOWNSTREAM_GAP_FACTOR } from '../AutoArrange';

const item = (id: string, w: number, h = 60): any => ({
    uniqueID: id,
    name: 'Load',
    position: { x: 0, y: 0 },
    size: { width: w, height: h },
    connectionPoints: { out: { x: w / 2, y: h }, in: { x: w / 2, y: 0 } },
    locked: false
});

const link = (from: any, to: any): any => ({
    sourceItem: from,
    sourcePointKey: 'out',
    targetItem: to,
    targetPointKey: 'in',
    materialType: 'Wiring'
});

const centerX = (it: any): number => it.position.x + it.size.width / 2;

describe('downstream horizontal gap', () => {
    it('spaces two adjacent tier-0 centres by ((w1+w2)/2)*defaultFactor', () => {
        const s = item('s', 100);
        const a = item('a', 60);
        const b = item('b', 140);
        const out = applyAutoArrange([s, a, b], [link(s, a), link(s, b)]);

        const pa = out.find(i => i.uniqueID === 'a')!;
        const pb = out.find(i => i.uniqueID === 'b')!;
        expect(Math.abs(centerX(pb) - centerX(pa))).toBeCloseTo(((60 + 140) / 2) * DEFAULT_DOWNSTREAM_GAP_FACTOR, 6);
    });

    it('honours an explicit gap factor override', () => {
        const s = item('s', 100);
        const a = item('a', 60);
        const b = item('b', 140);
        const out = applyAutoArrange([s, a, b], [link(s, a), link(s, b)], 1.5);

        const pa = out.find(i => i.uniqueID === 'a')!;
        const pb = out.find(i => i.uniqueID === 'b')!;
        expect(Math.abs(centerX(pb) - centerX(pa))).toBeCloseTo(((60 + 140) / 2) * 1.5, 6);
    });

    it('holds the minimum for every adjacent pair in a wider row', () => {
        const s = item('s', 100);
        const widths = [40, 200, 60, 120];
        const leaves = widths.map((w, i) => item(`l${i}`, w));
        const out = applyAutoArrange(
            [s, ...leaves],
            leaves.map(l => link(s, l))
        );

        const ordered = leaves
            .map(l => out.find(i => i.uniqueID === l.uniqueID)!)
            .sort((p, q) => centerX(p) - centerX(q));

        for (let i = 1; i < ordered.length; i++) {
            const prev = ordered[i - 1];
            const curr = ordered[i];
            const min = ((prev.size.width + curr.size.width) / 2) * DEFAULT_DOWNSTREAM_GAP_FACTOR;
            expect(centerX(curr) - centerX(prev)).toBeGreaterThanOrEqual(min - 1e-6);
            // Left edge must not overlap the previous right edge.
            expect(curr.position.x).toBeGreaterThanOrEqual(prev.position.x + prev.size.width);
        }
    });
});
