// @vitest-environment jsdom
// The checked edit refuses an edit that changes whether the file ends with a line break,
// whatever edit function did it (bug hunt round 6, oA42). No edit function does that now,
// so this file plants one: `setStyle` here adds or drops the last line break after
// making its change, and Mermaid reads the result the same either way.
import { beforeAll, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';

vi.mock('../src/core/edits', async (original) => {
  const real = await original<typeof import('../src/core/edits')>();
  return {
    ...real,
    setStyle: (text: string, id: string, changes: Record<string, string | null>): string => {
      const out = real.setStyle(text, id, changes);
      return out.endsWith('\n') ? out.slice(0, -1) : `${out}\n`;
    },
  };
});

const { applyChecked } = await import('../src/verify');
const { EditError, setStyle } = await import('../src/core/edits');

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

test.each([
  ['drops the last line break', 'flowchart TD\n    a --> b\n'],
  ['adds a last line break', 'flowchart TD\n    a --> b'],
])('an edit that %s is refused', async (_, text) => {
  // The planted edit does change it.
  expect(setStyle(text, 'a', { fill: '#abcdef' }).endsWith('\n')).toBe(!text.endsWith('\n'));
  const made = applyChecked(text, { kind: 'setStyle', id: 'a', changes: { fill: '#abcdef' } });
  await expect(made).rejects.toThrow(EditError);
  await expect(made).rejects.toThrow(/last line break/);
});
