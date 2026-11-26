// A large chart printed over several pages (D6.2; the user, 2026-11-25, Q226 to Q228):
// where the cuts fall, at what size, on which paper and which way up.
import { describe, expect, test } from 'vitest';
import {
  MIN_PT, PX_PER_MM, bestPlan, cuts, defaultSize, fitScale, pageMm, paperOfRegion, planFor, textPt,
} from '../src/print-pages';

/** The user's first document as the print sheet draws it (27 boxes; measured 2026-11-25). */
const TALL = { x: 0, y: 0, w: 1218, h: 4863 };

describe('cuts', () => {
  test('with nothing to cut through, each window starts where the last ended', () => {
    expect(cuts(0, 250, 100, 10, [])).toEqual([[0, 100], [100, 200], [200, 250]]);
  });

  test('a cut that would go through a box moves back to just before it, so the box is whole on the next page', () => {
    // A box from 90 to 120 lies across the cut at 100: the cut moves to 86 (4 clear of it).
    expect(cuts(0, 250, 100, 10, [[90, 120]])[0]).toEqual([0, 86]);
    expect(cuts(0, 250, 100, 10, [[90, 120]])[1][0]).toBe(86);
  });

  test('it moves back at most 40% of a page; past that the cut goes through, and the next page starts the overlap before it', () => {
    // A box from 20 to 130 covers every place from 60 to 100.
    const w = cuts(0, 250, 100, 10, [[20, 130]]);
    expect(w[0]).toEqual([0, 100]);
    expect(w[1][0]).toBe(90);
  });

  test('a last strip under 3% of a page with no box in it is left out, not printed on a page of its own', () => {
    // Past 200 is 1 unit of blank edge (D6.2's check: a part 1 px tall).
    expect(cuts(0, 201, 100, 10, [])).toEqual([[0, 100], [100, 200]]);
    // A strip past 3% of a page is printed, blank or not.
    expect(cuts(0, 210, 100, 10, [])).toEqual([[0, 100], [100, 200], [200, 210]]);
    // With a box in it, the strip is printed.
    expect(cuts(0, 201, 100, 10, [[199, 201]]).at(-1)![1]).toBe(201);
  });

  test('a chart that fits is one window', () => {
    expect(cuts(5, 80, 100, 10, [[10, 30]])).toEqual([[5, 85]]);
  });
});

describe('the size and the pages', () => {
  test('a fitted chart is never enlarged; the tall one prints its text at 2 pt on one A4 page', () => {
    expect(fitScale({ x: 0, y: 0, w: 100, h: 100 }, 'A4')).toBe(1);
    expect(textPt(fitScale(TALL, 'A4'))).toBe(2);
  });

  test('over several pages the text is full size where the page is wide enough, shrunk to its width down to 8 pt, never under', () => {
    expect(planFor({ x: 0, y: 0, w: 500, h: 3000 }, [], 'A4', 'portrait').scale).toBe(1);
    const sideways = planFor(TALL, [], 'A4', 'landscape');
    expect(sideways.scale).toBeCloseTo(((297 - 28) * PX_PER_MM) / 1218);
    expect(sideways.textPt).toBe(8.8);
    expect(sideways.cols).toBe(1);
    const upright = planFor(TALL, [], 'A4', 'portrait');
    expect(upright.textPt).toBe(MIN_PT);
    expect(upright.cols).toBe(2);
  });

  test('each part fits its page: the paper less its margins and the part\'s line', () => {
    const plan = planFor(TALL, [], 'Letter', 'landscape');
    const [pw, ph] = pageMm('Letter', 'landscape');
    for (const p of plan.parts) {
      expect(p.w * plan.scale).toBeLessThanOrEqual((pw - 28) * PX_PER_MM + 0.01);
      expect(p.h * plan.scale).toBeLessThanOrEqual((ph - 28 - 8) * PX_PER_MM);
    }
  });

  test('parts are in reading order: across, then down', () => {
    const plan = planFor({ x: 0, y: 0, w: 5387, h: 3366 }, [], 'A4', 'portrait');
    expect(plan.parts.slice(0, 3).map((p) => [p.row, p.col])).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(plan.parts.length).toBe(plan.cols * plan.rows);
  });
});

describe('the choices the print page starts on (Q227, Q228)', () => {
  test('one page while its text stays 8 pt or more, otherwise several', () => {
    expect(defaultSize({ x: 0, y: 0, w: 456, h: 642 }, 'A4')).toBe('fit'); // the sample
    expect(defaultSize(TALL, 'A4')).toBe('pages');
    // Exactly 8 pt on one page: one page.
    const h = (245 * PX_PER_MM) / (8 / 10.5);
    expect(defaultSize({ x: 0, y: 0, w: 100, h }, 'A4')).toBe('fit');
    expect(defaultSize({ x: 0, y: 0, w: 100, h: h + 2 }, 'A4')).toBe('pages');
  });

  test('the way up that needs the fewest pages: the tall chart sideways, 7 on A4 and 6 on Letter', () => {
    expect([bestPlan(TALL, [], 'A4').orientation, bestPlan(TALL, [], 'A4').parts.length]).toEqual(['landscape', 7]);
    expect([bestPlan(TALL, [], 'Letter').orientation, bestPlan(TALL, [], 'Letter').parts.length]).toEqual(['landscape', 6]);
  });

  test('between two that need as many pages, the one with fewer columns, then upright', () => {
    expect(bestPlan({ x: 0, y: 0, w: 300, h: 300 }, [], 'A4').orientation).toBe('portrait');
  });

  test('the paper of a region: Letter in the US and Canada, A4 in Britain and where the region is unknown', () => {
    expect(paperOfRegion('US')).toBe('Letter');
    expect(paperOfRegion('CA')).toBe('Letter');
    expect(paperOfRegion('GB')).toBe('A4');
    expect(paperOfRegion(undefined)).toBe('A4');
  });
});
