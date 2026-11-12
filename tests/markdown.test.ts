// @vitest-environment jsdom
// A flowchart inside a Markdown file: the block is found, an edited block is put back,
// and every line outside the block stays exactly as it was.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { BlockError, findAgain, findBlocks, isFlowchartText, isMarkdownPath, putBlock, replaceBlock } from '../src/core/markdown';
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

describe('finding the shown block again after a change on disk (bug hunt S2)', () => {
  const chart = (name: string) => '```mermaid\nflowchart TD\n  ' + name + '\n```\n';
  const file = (...names: string[]) => names.map(chart).join('\ntext\n\n');
  const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);

  test('the same block, unchanged, moved by a block added or taken away above it', () => {
    expect(again(file('a', 'b'), file('new', 'a', 'b'), 1)).toBe(2);
    expect(again(file('a', 'b', 'c'), file('b', 'c'), 1)).toBe(0);
  });

  test('the shown block changed, and every other block as it was', () => {
    expect(again(file('a', 'b', 'c'), file('a', 'B', 'c'), 1)).toBe(1);
  });

  test('the shown block taken away, another flowchart now in its place: not found', () => {
    expect(again(file('a', 'b', 'c'), file('a', 'c'), 1)).toBe(-1);
    expect(again(file('a', 'b'), file('a'), 1)).toBe(-1);
  });

  test('a block added above and the shown block changed: not found', () => {
    expect(again(file('a', 'b'), file('a', 'new', 'B'), 1)).toBe(-1);
  });

  test('the shown block and another changed at once: not found', () => {
    expect(again(file('a', 'b', 'c'), file('A', 'B', 'c'), 1)).toBe(-1);
  });
});

describe('a copy of the shown block written beside it (bug hunt round 2: B8)', () => {
  const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
  const doc = '# Original\n\n' + chart + '\nend\n';
  const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);

  test('B8: a copy above under its own heading: the shown block is the original, now second', () => {
    expect(again(doc, '# Variant (copy)\n\n' + chart + '\n' + doc, 0)).toBe(1);
  });

  test('a copy below, after other text: the shown block is still the first', () => {
    expect(again(doc, doc + '\n# Copy\n\n' + chart, 0)).toBe(0);
  });

  test('a copy right beside it, nothing around them to tell them apart: not found', () => {
    expect(again(doc, '# Original\n\n' + chart + '\n' + chart + '\nend\n', 0)).toBe(-1);
  });

  test('two alike blocks, and only the text around them changed: the same one', () => {
    const two = '# One\n\n' + chart + '\n# Two\n\n' + chart;
    expect(again(two, two.replace('# Two', '# Two, renamed'), 1)).toBe(1);
    expect(again(two, 'Intro.\n\n' + two, 0)).toBe(0);
  });

  test('two alike blocks, and a third block added after them: the same one', () => {
    const two = '# One\n\n' + chart + '\n# Two\n\n' + chart;
    const more = two + '\n# Three\n\n```mermaid\nflowchart LR\n  c\n```\n';
    expect(again(two, more, 0)).toBe(0);
    expect(again(two, more, 1)).toBe(1);
  });

  // Round 3: the one block left holding the text is not the shown one when the shown one
  // was a copy and changed (B13); a copy written right below the shown block reads like
  // it below, and the shown block like it above: not certain (B14).
  const changed = chart.replace('a --> b', 'a --> b --> c');
  test('B13: two alike blocks, and the shown one changed: still the shown one', () => {
    const two = '# One\n\n' + chart + '\n# Two\n\n' + chart + '\nend\n';
    const after = '# One\n\n' + chart + '\n# Two\n\n' + changed + '\nend\n';
    expect(again(two, after, 1)).toBe(1);
    expect(again(two, after.replace('# One', '# One, renamed'), 1)).toBe(1);
    expect(again(two, after, 0)).toBe(0);
  });

  test('B13: two alike blocks under the same heading, and the shown second one changed', () => {
    const two = '## Example\n\n' + chart + '\n## Example\n\n' + chart;
    expect(again(two, '## Example\n\n' + chart + '\n## Example\n\n' + changed, 1)).toBe(1);
  });

  test('B14: a copy written right below the shown block, under its own heading: not found', () => {
    const details = '## Details\n\n' + Array.from({ length: 8 }, (_, i) => `Detail line ${i}.`).join('\n\n') + '\n';
    const doc1 = '# Pipeline\n\n' + chart + '\n' + details;
    expect(again(doc1, '# Pipeline\n\n' + chart + '\n## Variant\n\n' + chart + '\n' + details, 0)).toBe(-1);
  });

  test('B13: the old text kept as a backup above, and the shown block changed in place: never the backup', () => {
    const backup = '# Backup\n\n' + chart + '\n# Original\n\n' + changed + '\nend\n';
    expect(again(doc, backup, 0)).not.toBe(0);
    const two = '## A\n\n' + chart + '\n## B\n\n```mermaid\nflowchart LR\n  b\n```\n';
    expect(again(two, '## Old A\n\n' + chart + '\n## A\n\n' + changed + '\n## B\n\n```mermaid\nflowchart LR\n  b\n```\n', 0)).not.toBe(0);
  });

  test('a block added right after a shown block that opens the file: still the shown block', () => {
    const first = chart + '\nThe end.\n';
    const added = '```mermaid\nflowchart LR\n  c\n```\n';
    expect(again(first, chart + '\n' + added + '\nThe end.\n', 0)).toBe(0);
    expect(again(first, chart + '\n## Second\n\n' + added + '\nThe end.\n', 0)).toBe(0);
  });
});

describe('what is not a flowchart block (bug hunt S4, S5)', () => {
  test('a fence inside YAML front matter at the top of the file', () => {
    const md = '---\ntitle: x\ndesc: |\n  ```mermaid\n  flowchart TD\n  A\n  ```\n---\n\n```mermaid\nflowchart TD\n  B\n```\n';
    const blocks = findBlocks(md);
    expect(blocks.map((b) => b.open)).toEqual([9]);
    // The same lines further down are not front matter.
    expect(findBlocks('text\n\n' + md).length).toBe(2);
    // Front matter that never closes is not front matter.
    expect(findBlocks('---\n```mermaid\nflowchart TD\n  A\n```\n').length).toBe(1);
  });

  test('a fence indented four columns or more, outside a list: a code sample', () => {
    expect(findBlocks('Example:\n\n    ```mermaid\n    flowchart TD\n    a --> b\n    ```\n\ntext\n')).toEqual([]);
    expect(findBlocks('\t```mermaid\n\tflowchart TD\n\t```\n')).toEqual([]);
    expect(findBlocks('text\n    ```mermaid\n    flowchart TD\n    ```\n')).toEqual([]);
  });

  test('inside a list item, up to three columns past the start of its text', () => {
    const inItem = findBlocks('- item\n\n    ```mermaid\n    flowchart TD\n      a\n    ```\n');
    expect(inItem.map((b) => [b.indent, b.flowchart, b.locked])).toEqual([['    ', true, null]]);
    expect(findBlocks('10. step\n\n     ```mermaid\n     flowchart TD\n     a\n     ```\n').length).toBe(1);
    expect(findBlocks('- a\n  - b\n    text\n\n      ```mermaid\n      flowchart TD\n      ```\n').length).toBe(1);
    // Four columns past the item's text: a code sample inside the item.
    expect(findBlocks('- a\n  - b\n\n        ```mermaid\n        flowchart TD\n        ```\n')).toEqual([]);
  });

  test('a fence line indented four columns does not close a block at the margin', () => {
    expect(findBlocks('```mermaid\nflowchart TD\n    ```\n```\n')[0].close).toBe(3);
  });

  test('B10: a list-like line inside a fenced block, or in a code sample, is no list item (bug hunt round 2)', () => {
    // After a fenced block holding "- sample": the fence below is a code sample.
    expect(findBlocks('```text\n- sample\n   ```\n\n    ```mermaid\n    flowchart TD\n     a-->b\n    ```\n')).toEqual([]);
    // "- an indented code sample" is itself indented four columns at the margin.
    expect(findBlocks('Text:\n\n    - an indented code sample\n\n        ```mermaid\n        flowchart TD\n         a-->b\n        ```\n')).toEqual([]);
  });

  test('a real list item is still one, with a fenced block or a sub-item between', () => {
    // A fenced block inside the item, then the flowchart in the same item.
    const after = findBlocks('- item\n\n  ```text\n  - sample\n  ```\n\n    ```mermaid\n    flowchart TD\n    a\n    ```\n');
    expect(after.map((b) => b.open)).toEqual([6]);
    // A sub-item four columns in (two past its item's text), and a fence in it.
    expect(findBlocks('- a\n\n    - b\n\n      ```mermaid\n      flowchart TD\n      ```\n').length).toBe(1);
  });

  test('B15: a line less indented than an item\'s text ends the item, so a fence below it is a code sample (bug hunt round 3)', () => {
    const sample = (ind: string) => `${ind}\`\`\`mermaid\n${ind}flowchart TD\n${ind}  a --> b\n${ind}\`\`\`\n`;
    // A paragraph indented 2 under "1. ", whose text starts at column 3.
    expect(findBlocks('1. Step one\n\n  A paragraph indented two spaces.\n\n' + sample('    '))).toEqual([]);
    // A quote indented 1 under "- ".
    expect(findBlocks('- item\n\n > a quote\n\n' + sample('    '))).toEqual([]);
    // A fenced block left of the item's text.
    expect(findBlocks('   * item\n   ~~~~js\n   t\n   ~~~~\n' + sample('     '))).toEqual([]);
    // A thematic break indented 1 under "1. ".
    expect(findBlocks('1. item\n ---\n\n' + sample('    '))).toEqual([]);
    // An item further out still holds the fence: the paragraph ended "- b", not "- a".
    const outer = findBlocks('- a\n  - b\n\n  para in a\n\n    ```mermaid\n    flowchart TD\n    ```\n');
    expect(outer.map((b) => b.open)).toEqual([5]);
  });
});
