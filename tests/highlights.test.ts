import { describe, expect, it } from 'vitest';
import { itemOf, parseHighlights, parseItem, resolveHighlights, toggleHighlight, toggleInFile } from '../src/core/highlights';

const chart = {
  nodes: { collect: {}, clean: {}, review: {} },
  subs: { prep: {} },
  edges: [
    { start: 'collect', end: 'clean' },
    { start: 'clean', end: 'review' },
    { start: 'collect', end: 'clean' }, // a second arrow with the same ends
  ],
};

describe('the highlights file', () => {
  it('reads ids and arrows, and skips blank lines, notes and what is not an item', () => {
    const text = '# the agent: working on these\ncollect\n\n  clean  \ncollect-->clean\nclean --> review\nnot an item\nprep\ncollect\n';
    expect(parseHighlights(text)).toEqual([
      { kind: 'id', id: 'collect' },
      { kind: 'id', id: 'clean' },
      { kind: 'arrow', from: 'collect', to: 'clean' },
      { kind: 'arrow', from: 'clean', to: 'review' },
      { kind: 'id', id: 'prep' },
    ]);
    expect(parseItem('a --> b --> c')).toBeNull();
    expect(parseHighlights('a\r\nb\r\n')).toEqual([{ kind: 'id', id: 'a' }, { kind: 'id', id: 'b' }]);
  });

  it('finds each item on the chart and ignores what is not there', () => {
    const items = parseHighlights('review\nprep\ngone\ncollect --> clean\nreview --> collect\n');
    expect(resolveHighlights(items, chart)).toEqual([
      { kind: 'node', id: 'review' },
      { kind: 'sub', id: 'prep' },
      { kind: 'edge', index: 0 }, // the first arrow with those ends
    ]);
  });

  it('names an arrow by its ends, whichever of two alike was clicked', () => {
    expect(itemOf({ kind: 'edge', index: 2 }, chart)).toEqual({ kind: 'arrow', from: 'collect', to: 'clean' });
    expect(itemOf({ kind: 'node', id: 'clean' }, chart)).toEqual({ kind: 'id', id: 'clean' });
    expect(itemOf({ kind: 'edge', index: 9 }, chart)).toBeNull();
  });

  it('adds an item at the end and keeps every other line as it was', () => {
    const agent = '# from the agent\ncollect\ngone\n';
    expect(toggleHighlight(agent, { kind: 'id', id: 'review' })).toBe('# from the agent\ncollect\ngone\nreview\n');
    expect(toggleHighlight('', { kind: 'arrow', from: 'a', to: 'b' })).toBe('a --> b\n');
    expect(toggleHighlight('collect', { kind: 'id', id: 'clean' })).toBe('collect\nclean\n');
  });

  it('takes an item off wherever and however it is written', () => {
    const text = 'collect\ncollect -->clean\n# note\n  collect  \nreview\n';
    expect(toggleHighlight(text, { kind: 'id', id: 'collect' })).toBe('collect -->clean\n# note\nreview\n');
    expect(toggleHighlight(text, { kind: 'arrow', from: 'collect', to: 'clean' })).toBe('collect\n# note\n  collect  \nreview\n');
  });

  it('gives nothing, so the file is deleted, when the last item is taken off', () => {
    expect(toggleHighlight('collect\n', { kind: 'id', id: 'collect' })).toBe('');
    expect(toggleHighlight('# only a note left\ncollect\n\n', { kind: 'id', id: 'collect' })).toBe('');
  });
});

describe('switching a highlight in the file on disk (bug hunt S8)', () => {
  const collect = { kind: 'id', id: 'collect' } as const;

  it('writes the file with the item switched', async () => {
    const written: string[] = [];
    await toggleInFile(async () => '# a note\nclean\n', async (t) => { written.push(t); }, collect);
    await toggleInFile(async () => null, async (t) => { written.push(t); }, collect);
    expect(written).toEqual(['# a note\nclean\ncollect\n', 'collect\n']);
  });

  it('writes nothing when the file cannot be read', async () => {
    const written: string[] = [];
    const unreadable = async (): Promise<string> => { throw new Error('stream did not contain valid UTF-8'); };
    await expect(toggleInFile(unreadable, async (t) => { written.push(t); }, collect)).rejects.toThrow(/UTF-8/);
    expect(written).toEqual([]);
  });
});
