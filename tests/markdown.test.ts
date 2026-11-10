// @vitest-environment jsdom
// A flowchart inside a Markdown file: the block is found, an edited block is put back,
// and every line outside the block stays exactly as it was.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { BlockError, findBlocks, isFlowchartText, isMarkdownPath, putBlock, replaceBlock } from '../src/core/markdown';
import { applyChecked, type Op } from '../src/verify';
import { snapshot } from '../src/semantics';
import { fixtures } from './fixtures';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const indentBy = (text: string, indent: string) =>
  text.replace(/\n$/, '').split('\n').map((l) => (l === '' ? '' : indent + l)).join('\n');

/** A document with every kind of block: plain, in a list, tilde fence, not a flowchart, a quoted example. */
const DOC = [
  '# Pipeline',
  '',
  'Some text with `inline code` and a line that ends in two spaces.  ',
  '',
  '````markdown',
  'An example inside another block, which is not a chart:',
  '```mermaid',
  'flowchart TD',
  '    fake --> block',
  '```',
  '````',
  '',
  '## First chart',
  '',
  '```mermaid',
  fixtures.sample.replace(/\n$/, ''),
  '```',
  '',
  '## A sequence',
  '',
  '```mermaid',
  'sequenceDiagram',
  '    A->>B: hello',
  '```',
  '',
  '## In a list',
  '',
  '1. A step, with its chart:',
  '',
  '   ```mermaid',
  indentBy(fixtures.groups, '   '),
  '   ```',
  '',
  '2. Another step.',
  '',
  '## Tildes',
  '',
  '~~~mermaid',
  fixtures.plain.replace(/\n$/, ''),
  '~~~',
  '',
  'Last line, with no newline after it.',
].join('\n');

describe('finding Mermaid blocks in a Markdown file', () => {
  test('finds each block, skips other fences, and tells flowcharts from other diagrams', () => {
    const blocks = findBlocks(DOC);
    expect(blocks.map((b) => [b.heading, b.flowchart, b.indent, b.locked])).toEqual([
      ['First chart', true, '', null],
      ['A sequence', false, '', null],
      ['In a list', true, '   ', null],
      ['Tildes', true, '', null],
    ]);
    expect(blocks[0].text).toBe(fixtures.sample);
    expect(blocks[2].text).toBe(fixtures.groups);
    expect(blocks[3].text).toBe(fixtures.plain);
    expect(DOC.split('\n')[blocks[0].open]).toBe('```mermaid');
    expect(DOC.split('\n')[blocks[2].close]).toBe('   ```');
  });

  test('putting a block back unchanged gives the same file, byte for byte', () => {
    for (const file of [DOC, DOC + '\n', '```mermaid\nflowchart TD\n  a\n```', '```mermaid\n```\n']) {
      findBlocks(file).forEach((b, i) => {
        expect(replaceBlock(file, b, b.text)).toBe(file);
        expect(putBlock(file, i, b.text)).toBe(file);
      });
    }
  });

  test('tells a flowchart from other text', () => {
    expect(isFlowchartText('flowchart TD\n a --> b\n')).toBe(true);
    expect(isFlowchartText('---\ntitle: x\n---\n\n%% a comment\ngraph LR\n')).toBe(true);
    expect(isFlowchartText('---\ntitle: x\n---\npie\n')).toBe(false);
    expect(isFlowchartText('sequenceDiagram\n')).toBe(false);
    expect(isFlowchartText('')).toBe(false);
    expect(isMarkdownPath('C:\\notes\\Plan.MD')).toBe(true);
    expect(isMarkdownPath('flow.mmd')).toBe(false);
  });

  test('locks a block it could not put back exactly', () => {
    const uneven = '- item\n\n  ```mermaid\n  flowchart TD\n a --> b\n  ```\n';
    expect(findBlocks(uneven)[0].locked).toMatch(/indented evenly/);
    const open = 'text\n\n```mermaid\nflowchart TD\n  a --> b\n';
    expect(findBlocks(open)[0].locked).toMatch(/no closing fence/);
    const mixedBlank = '  ```mermaid\n  flowchart TD\n  \n  a\n\n  b\n  ```\n';
    expect(findBlocks(mixedBlank)[0].locked).toMatch(/indented evenly/);
    for (const file of [uneven, open, mixedBlank]) {
      expect(() => putBlock(file, 0, 'flowchart TD\n  x\n')).toThrow(BlockError);
    }
  });

  test('keeps the way empty lines are written inside an indented block', () => {
    const file = '  ```mermaid\n  flowchart TD\n  \n  a\n  ```\n';
    const [b] = findBlocks(file);
    expect(b.locked).toBeNull();
    expect(b.text).toBe('flowchart TD\n\na\n');
    expect(putBlock(file, 0, 'flowchart TD\n\na\n\nb\n')).toBe('  ```mermaid\n  flowchart TD\n  \n  a\n  \n  b\n  ```\n');
  });

  test('refuses a text that would end the block early', () => {
    const before = DOC;
    for (const bad of ['flowchart TD\n  a\n```\n  b\n', 'flowchart TD\n````\n']) {
      expect(() => putBlock(DOC, 0, bad)).toThrow(BlockError);
    }
    // A tilde line cannot end a backtick block, so it is only text (Mermaid will reject it, not the file).
    expect(findBlocks(putBlock(DOC, 0, 'flowchart TD\n~~~\n'))[0].text).toBe('flowchart TD\n~~~\n');
    expect(DOC).toBe(before);
  });

  test('a text with no final newline gets one, since the closing fence follows', () => {
    const next = putBlock(DOC, 3, 'graph LR\nA-->B');
    expect(findBlocks(next)[3].text).toBe('graph LR\nA-->B\n');
    expect(next.endsWith('~~~\n\nLast line, with no newline after it.')).toBe(true);
  });
});

describe('editing a flowchart inside a Markdown file', () => {
  const ops: Op[] = [
    { kind: 'addNode', title: 'New node', parent: null },
    { kind: 'setDirection', dir: 'LR' },
    { kind: 'setDescription', id: '', description: 'A new description.\n\nWith two paragraphs.' },
    { kind: 'setTitle', id: '', title: 'Say "hi" (now) [x]' },
    { kind: 'deleteNode', id: '' },
  ];

  test.each([0, 2, 3])('block %i: only the block\'s own lines change', async (index) => {
    let file = DOC;
    const lines = DOC.split('\n');
    const first = findBlocks(DOC)[index];
    const above = lines.slice(0, first.open + 1);
    const below = lines.slice(first.close);
    const others = findBlocks(DOC).map((b) => b.text);
    for (const op of ops) {
      const block = findBlocks(file)[index];
      const id = Object.keys((await snapshot(block.text)).nodes)[0];
      const res = await applyChecked(block.text, 'id' in op ? { ...op, id } as Op : op);
      file = putBlock(file, index, res.text);
      const now = file.split('\n');
      const after = findBlocks(file);
      expect(after[index].text, JSON.stringify(op)).toBe(res.text);
      expect(now.slice(0, first.open + 1), 'lines above the block').toEqual(above);
      expect(now.slice(after[index].close), 'lines below the block').toEqual(below);
      after.forEach((b, i) => { if (i !== index) expect(b.text).toBe(others[i]); });
      // Every line of the block still carries the block's indent.
      for (const line of now.slice(after[index].open + 1, after[index].close)) {
        expect(line === '' || line.startsWith(first.indent), line).toBe(true);
      }
    }
  });
});
