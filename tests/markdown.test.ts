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
    // An indented `---` in a YAML text ends nothing, as in Mermaid (bug hunt round 4, A36).
    expect(isFlowchartText('---\ntitle: |\n  ---\n  a\n---\nflowchart TD\n')).toBe(true);
    expect(isFlowchartText('---\ntitle: |\n  ---\n  flowchart TD\n---\npie\n')).toBe(false);
    expect(isFlowchartText('sequenceDiagram\n')).toBe(false);
    expect(isFlowchartText('')).toBe(false);
    expect(isMarkdownPath('C:\\notes\\Plan.MD')).toBe(true);
    expect(isMarkdownPath('flow.mmd')).toBe(false);
  });

  test('locks a block it could not put back exactly', () => {
    const uneven = '- item\n\n   ```mermaid\n   flowchart TD\n  a --> b\n   ```\n';
    expect(findBlocks(uneven)[0].locked).toMatch(/indented evenly/);
    // A line indented less than the item's text ends the item, and the block (B23).
    const ended = findBlocks('- item\n\n  ```mermaid\n  flowchart TD\n a --> b\n  ```\n');
    expect(ended.map((b) => [b.text, b.locked])).toEqual([['flowchart TD\n', 'the block has no closing fence line.']]);
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

  test('B22: the old text kept as a backup, and the shown block changed in place to another block\'s text: never the backup', () => {
    const other = '```mermaid\nflowchart TD\n  x --> y\n```\n';
    const before = '# Original\n\n' + chart + '\nOriginal end\n\n# Other\n\n' + other + '\nOther end\n';
    const after = '# Backup\n\n' + chart + '\n# Original\n\n' + other + '\nOriginal end\n\n# Other\n\n' + other + '\nOther end\n';
    expect(again(before, after, 0)).toBe(-1);
  });

  // Round 5: the backup took the text below the block with it, and the original's text
  // below was changed with the block, so the backup read like the place below and the
  // changed original like it above only (B25). A block added directly above the shown
  // one reads so too, and is no rival: it stands between the shown block and its heading.
  test('B25: the old block and the text below it kept as a backup, both changed in place: never the backup', () => {
    const before = '# Original\n\n' + chart + '\nAfter\n';
    const after = '# Backup\n\n' + chart + '\nAfter\n\n# Original\n\n' + changed + '\nChanged end\n';
    expect(again(before, after, 0)).toBe(-1);
    const added = '```mermaid\nflowchart LR\n  n\n```\n';
    expect(again(before, '# Original\n\n' + added + '\n' + chart + '\nAfter\n', 0)).toBe(1);
  });

  // Round 6: the same backup, told apart by the headings only when every heading above
  // the block is compared: a nearest heading repeated under both (B26), a heading
  // underlined with `===` or `---` (B27), and the original's heading renamed at once (B28).
  test('B26 to B28: the old block kept as a backup under headings that differ above the nearest, underlined, or renamed: never the backup', () => {
    const before = '# Original\n\n## Diagram\n\n' + chart + '\nAfter\n';
    expect(again(before, '# Backup\n\n## Diagram\n\n' + chart + '\nAfter\n\n# Original\n\n## Diagram\n\n' + changed + '\nChanged end\n', 0)).toBe(-1);
    const setext = 'Original\n========\n\n' + chart + '\nAfter\n';
    expect(again(setext, 'Backup\n======\n\n' + chart + '\nAfter\n\nOriginal\n========\n\n' + changed + '\nChanged end\n', 0)).toBe(-1);
    expect(again(setext, 'Backup\n------\n\n' + chart + '\nAfter\n\nOriginal\n------\n\n' + changed + '\nChanged end\n', 0)).toBe(-1);
    const one = '# Original\n\n' + chart + '\nAfter\n';
    expect(again(one, '# Backup\n\n' + chart + '\nAfter\n\n# Renamed original\n\n' + changed + '\nChanged end\n', 0)).toBe(-1);
    // The headings read as Markdown reads them: a `---` under a list item or a quote, or
    // after a blank line, underlines nothing; a heading inside a code block is no heading.
    const notUnder = (above: string) => above + '\n---\n\n' + chart + '\nAfter\n';
    for (const above of ['- item', '> quote', 'text\n']) {
      expect(findBlocks(notUnder(above))[0].heading).toBe('');
    }
    expect(findBlocks('Text\n---\n\n' + chart)[0].heading).toBe('Text');
    expect(findBlocks('    code\n---\n\n' + chart)[0].heading).toBe('');
    expect(findBlocks('# Top\n\n## Sub\n\n# Next\n\n' + chart)[0].headings).toBe(findBlocks('# Next\n\n' + chart)[0].headings);
    // A copy above under its own heading, or a block added right above the shown one,
    // still leaves the shown block under its headings: found.
    expect(again(before, '# Backup\n\n## Diagram\n\n' + chart + '\n' + before, 0)).toBe(1);
    expect(again(setext, 'Backup\n======\n\n' + chart + '\n' + setext, 0)).toBe(1);
  });

  // Round 7: another block changed to the shown block's text, the shown block changed in
  // place, both under the same heading and text above: its place read as like the shown
  // block's above as the other's did, and more like it below, yet the other was taken.
  // A heading written again another way (`Original` underlined, then `# Original`) above
  // the shown block made it so even where the place read more like it above; and with the
  // text next to the shown block changed too, neither place read like it above (B29).
  test('B29: another block changed to the shown block\'s text, the shown one changed in place, both under the same heading: never the other', () => {
    const other = '```mermaid\nflowchart TD\n  x --> y\n```\n';
    const before = '## Two\n\nSee below.\n\n' + chart + '\n## Two\n\nSee below.\n\n' + other + '\nMore.\n';
    expect(again(before, '## Two\n\nSee below.\n\n' + changed + '\n## Two\n\nSee below.\n\n' + chart + '\nMore.\n', 0)).toBe(-1);
    const setext = 'Original\n===\n\nNotes\n---\n\n' + chart + '\nEnd.\n\nNotes\n---\n\n' + other;
    expect(again(setext, '# Original\n\nNotes\n---\n\n' + changed + '\nEnd.\n\nNotes\n---\n\n' + chart, 0)).toBe(-1);
    expect(again(setext, 'Original\n===\n\nNotes\n---\n\n' + changed + '\nEnd.\n\nNotes\n---\n\n' + chart, 0)).toBe(-1);
    const three = '## Three\n\n' + chart + '\nend\n\n## Three\n\n' + other;
    expect(again(three, '## Three\n\n' + changed + '\n\n## Three\n\n' + chart, 0)).toBe(-1);
    const intro = '## One\n\nsome text\n' + chart + '\n\n## One\n\nintro\n' + other;
    expect(again(intro, '## One\n\nedited intro\n' + changed + '\n\n## One\n\nintro\n' + chart, 0)).toBe(-1);
    // The shown section moved below another under other headings: still followed.
    const parts = '# A\n\nText.\n\n' + chart + '\n# B\n\n' + other;
    expect(again(parts, '# B\n\n' + other + '\n# A\n\nText.\n\n' + chart, 0)).toBe(1);
    // The shown block as it was and the other one changed: still the shown block.
    expect(again(before, '## Two\n\nSee below.\n\n' + chart + '\n## Two\n\nSee below.\n\n' + changed + '\nMore.\n', 0)).toBe(0);
  });

  // Round 7: headings read otherwise than Markdown reads them, so a backup under another
  // heading read as standing under the shown block's: a closing "#" with no space before
  // it taken off (`# Original#` read as "Original", B30); a line like a numbered item
  // that cannot start one in the middle of an underlined heading (B31); `#` alone, an
  // empty heading, not read as one (B32); and a heading inside a list item taking the
  // place of the file's heading above the list (oB30).
  test('B30 to B32, oB30: a backup under a heading Markdown reads as another: never the backup', () => {
    const backup = (head: string, other: string) => [head + '\n\nintro\n' + chart + '\nend\n',
      other + '\n\nintro\n' + chart + '\nend\n\n' + head + '\n\nchanged intro\n' + changed + '\nchanged end\n'];
    for (const [head, other] of [['# Original#', '# Original'], ['Title\n2. continuation\n---', 'Backup text'], ['# Title\n\n#', '# Title']]) {
      const [before, after] = backup(head, other);
      expect(again(before, after, 0), head).not.toBe(0);
    }
    const item = (outer: string, inner: string, body: string) =>
      `# ${outer}\n\n- item\n\n  ${inner}\n\n  intro\n${body.replace(/^/gm, '  ').replace(/ +$/, '')}\n  end\n`;
    for (const inner of ['One\n  ===', '# One']) {
      const before = item('Top', inner, chart);
      expect(findBlocks(before)[0].headings, inner).toBe('1 Top');
      expect(again(before, item('Backup', inner, chart) + '\n' + item('Renamed', inner, changed), 0), inner).toBe(-1);
    }
    // The headings as Markdown reads them.
    const heading = (above: string) => findBlocks(above + '\n\n' + chart)[0].heading;
    expect(heading('# Original#')).toBe('Original#');
    expect(heading('# Original #')).toBe('Original');
    expect(heading('# Original \\#')).toBe('Original \\#');
    expect(heading('## ##')).toBe('');
    expect(findBlocks('# Top\n\n#\n\n' + chart)[0].headings).toBe('1 ');
    expect(heading('#hashtag')).toBe('');
    expect(heading('Title\n2. continuation\n---')).toBe('Title 2. continuation');
    for (const list of ['1. item', '- item', '2. item']) expect(heading('Title\n\n' + list + '\n---'), list).toBe('');
    expect(heading('Title\n1. item\n---')).toBe('');
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

  // Each document as pandoc's CommonMark reader reads it (2026-11-12): a fenced block
  // takes no lazy lines, so a line indented less than the item's text ends both.
  test('B23: a fenced block in a list item ends where the item ends (bug hunt round 4)', () => {
    // `***` ends the item and its unclosed `~~~` block; the next `~~~` opens a plain
    // block at the margin, holding a Mermaid-looking example.
    expect(findBlocks('- a\n  ~~~\n***\n  ~~~\n     ```mermaid\n     flowchart TD\n       a --> b\n     ```\n')).toEqual([]);
    // B17: an unclosed block in an item no longer hides a real block below the item.
    const below = findBlocks('- a\n  ```text\n  open\nend of the list\n\n```mermaid\nflowchart TD\n  a\n```\n');
    expect(below.map((b) => [b.open, b.locked])).toEqual([[5, null]]);
    // A Mermaid block whose item ends before its closing line: shown, never changed,
    // without the line that ended it.
    const cut = findBlocks('- a\n  ```mermaid\n  flowchart TD\n    a\nnot in the item\n');
    expect(cut.map((b) => [b.text, b.locked])).toEqual([['flowchart TD\n  a\n', 'the block has no closing fence line.']]);
    const inner = findBlocks('- a\n  - b\n    ```mermaid\n    flowchart TD\n  in a\n    ```\n');
    expect(inner.map((b) => [b.text, b.locked])).toEqual([['flowchart TD\n', 'the block has no closing fence line.']]);
    // Blank lines, and lines indented to the item's text, go on in the block.
    expect(findBlocks('- a\n  ```mermaid\n  flowchart TD\n\n    a\n  ```\n').map((b) => b.locked)).toEqual([null]);
    // In an item, the closing line may stand up to three columns past the item's text,
    // even when the opening line is three columns in at most.
    const closed = findBlocks('1. step\n   ```mermaid\n   flowchart TD\n     ```\nafter\n');
    expect(closed.map((b) => [b.text, b.close, b.locked])).toEqual([['flowchart TD\n', 3, null]]);
  });

  test('R1: a fence or a heading inside HTML is none (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const opens = (md: string) => findBlocks(md).map((b) => b.open);
    // HTML runs to a blank line, or for a comment to the line holding `-->`.
    expect(opens('<details>\n' + chart + '</details>\n')).toEqual([]);
    expect(opens('<div align="center">\n' + chart)).toEqual([]);
    expect(opens('<!--\n' + chart + '-->\n')).toEqual([]);
    expect(opens('<!-- note\n\n' + chart + '-->\n')).toEqual([]);
    expect(opens('<span>\n' + chart)).toEqual([]);
    expect(opens('<details>\n</details>\n\n' + chart)).toEqual([3]);
    expect(opens('<!-- a note -->\n' + chart)).toEqual([1]);
    expect(opens('<!--\nnote\n-->\n' + chart)).toEqual([3]);
    // A whole tag alone on its line cannot interrupt text: it is more of the text.
    expect(opens('Some text\n<span>\n' + chart)).toEqual([2]);
    // The HTML took the opening fence, so the closing one opens a plain block.
    expect(opens('<div>\n```mermaid\nflowchart TD\n\n```\n\n' + chart)).toEqual([]);
    // Inside a list item, the HTML ends with the item.
    expect(opens('- item\n  <div>\n  ' + chart.trimEnd().split('\n').join('\n  ') + '\n')).toEqual([]);
    expect(opens('- item\n  <div>\nafter\n\n' + chart)).toEqual([4]);
    // Headings inside HTML are none; a line starting with `<` that opens no HTML is text.
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    expect(headings('## Real\n\n<!--\n# Old\n-->')).toBe('2 Real');
    expect(headings('## Real\n\n<div>\n# Shown as text\n</div>')).toBe('2 Real');
    expect(headings('# Top\n\n<!-- # not a heading -->\n## Real')).toBe('1 Top\n2 Real');
    expect(headings('<span>a</span>\n===')).toBe('1 <span>a</span>');
    expect(headings('Text\n<span>\n---')).toBe('2 Text <span>');
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `${head}\n\n<div>\n## Notes\n</div>\n\n${intro}\n${body}\n${end}\n`;
    const after = part('## Backup', chart) + '\n' + part('## Original', changed, 'changed intro', 'changed end');
    expect(findBlocks(after).map((b) => b.headings)).toEqual(['2 Backup', '2 Original']);
    expect(again(part('## Original', chart), after, 0)).toBe(-1);
  });

  test('R4: a thematic break written with spaces is no list item (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    expect(headings('# Top\n\n* * *\n  ## Part')).toBe('1 Top\n2 Part');
    expect(headings('# Top\n\n- - -\n   ### Part')).toBe('1 Top\n3 Part');
    expect(headings('# Top\n\n_ _ _\n  ## Part')).toBe('1 Top\n2 Part');
    // A list item holding a break is still one.
    expect(headings('# Top\n\n- * * *\n  ## In the item')).toBe('1 Top');
    // Under a break, a `---` is another break and a `===` text: no heading.
    for (const brk of ['- - -', '* * *', '_ _ _', '---', '***']) {
      for (const under of ['---', '  ====']) expect(headings(`# Top\n\n${brk}\n${under}`), brk + under).toBe('1 Top');
    }
    // A block below one closes at its own closing line, not where an item would end.
    expect(findBlocks('* * *\n  ```mermaid\n  flowchart TD\nnot in an item\n  ```\n').map((b) => b.close)).toEqual([4]);
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `* * *\n  ## ${head}\n\n${intro}\n${body}\n${end}\n`;
    const after = '# Doc\n\n' + part('Backup', chart) + '\n' + part('Original', changed, 'changed intro', 'changed end');
    expect(again('# Doc\n\n' + part('Original', chart), after, 0)).toBe(-1);
  });

  test('R2: a link reference definition is no heading\'s text (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    expect(headings('[ref]: /url\n---')).toBe('');
    expect(headings('[ref]: /url\n===')).toBe('');
    expect(headings('[ref]: /url\nTitle\n===')).toBe('1 Title');
    expect(headings('[ref]: <the url> "a title"\n[other]: /x\n---')).toBe('');
    expect(headings("[ref]:\n  /url\n  'a title\n  over two lines'\n---")).toBe('');
    expect(headings('[ref]: /a_(b)_c (title)\n---')).toBe('');
    // Not a definition: text after its title, no label, a link, no destination.
    expect(headings('[ref]: /url "title" more\n---')).toBe('2 [ref]: /url "title" more');
    expect(headings('[ref]: /url\n"title" more\n===')).toBe('1 "title" more');
    expect(headings('[ ]: /url\n---')).toBe('2 [ ]: /url');
    expect(headings('[a](b)\n---')).toBe('2 [a](b)');
    expect(headings('[ref]:\n---')).toBe('2 [ref]:');
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `## ${head}\n[link]: /x\n---\n\n${intro}\n${body}\n${end}\n`;
    const after = '# Doc\n\n' + part('Backup', chart) + '\n' + part('Original', changed, 'changed intro', 'changed end');
    expect(again('# Doc\n\n' + part('Original', chart), after, 0)).toBe(-1);
  });

  test('R3: a line starting with `|` is a heading\'s text unless a table starts above it (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    expect(headings('| a | b |\n---')).toBe('2 | a | b |');
    expect(headings('  | a | b |\n===')).toBe('1 | a | b |');
    expect(headings('Text\n| a |\n===')).toBe('1 Text | a |');
    expect(headings('| a | b |\n|---|\n---')).toBe('2 | a | b | |---|');
    // GitHub's table: a header row over a delimiter row of as many cells. Under it, a
    // `---` or `===` is no underline (a row of the table, or a thematic break).
    expect(headings('# Top\n\n| a | b |\n|---|---|\n| x | y |\n---')).toBe('1 Top');
    expect(headings('# Top\n\na | b\n:-- | --:\nx | y\n===')).toBe('1 Top');
    expect(headings('# Top\n\nText\n| a |\n| --- |\n---')).toBe('1 Top');
    expect(headings('# Top\n\n| a \\| b |\n|---|---|\n---')).toBe('1 Top\n2 | a \\| b | |---|---|');
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `| ${head} |\n---\n\n${intro}\n${body}\n${end}\n`;
    const after = '# Doc\n\n' + part('Backup', chart) + '\n' + part('Original', changed, 'changed intro', 'changed end');
    expect(again('# Doc\n\n' + part('Original', chart), after, 0)).toBe(-1);
  });

  test('R5: lines indented four columns or more above an underline (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    // A code sample right above the text: the heading's text starts below it.
    expect(headings('    code\nTitle\n===')).toBe('1 Title');
    expect(headings('    # code\n    more\n   Title\n---')).toBe('2 Title');
    expect(headings('    code\n===')).toBe('');
    // Under text, a line indented four columns or more is more of it, whatever it looks like.
    expect(headings('Title\n    - more\n===')).toBe('1 Title - more');
    expect(headings('Title\n     > more\n===')).toBe('1 Title > more');
    expect(headings('Title\n    ```\n===')).toBe('1 Title ```');
    // In a list item, all of it is the item's.
    expect(headings('- a\n\n    code\nTitle\n===')).toBe('');
    expect(headings('- a\n    code\nTitle\n===')).toBe('');
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `    code\n${head}\n---\n\n${intro}\n${body}\n${end}\n`;
    const after = '# Doc\n\n' + part('Backup', chart) + '\n' + part('Original', changed, 'changed intro', 'changed end');
    expect(again('# Doc\n\n' + part('Original', chart), after, 0)).toBe(-1);
  });

  test('R7: a line like an underline with no text above it is text (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    expect(headings('--\n---')).toBe('2 --');
    expect(headings('===\n   ===')).toBe('1 ===');
    expect(headings('=\n---')).toBe('2 =');
    expect(headings('  ==\n  --')).toBe('2 ==');
    // Under a heading's underline, no text stands above.
    expect(headings('Title\n===\n===')).toBe('1 Title');
    expect(headings('Title\n===\n===\n---')).toBe('1 Title\n2 ===');
    // Under link reference definitions alone, it is text too, but `---` a thematic break.
    expect(headings('[ref]: /u\n===\nx\n===')).toBe('1 === x');
    expect(headings('[ref]: /u\n--\nx\n---')).toBe('2 -- x');
    expect(headings('[ref]: /u\n-\nx\n---')).toBe('2 - x');
    expect(headings('---\n---')).toBe('');
    expect(headings('-\n---')).toBe('');
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `${head}\n===\n\n${intro}\n${body}\n${end}\n`;
    const after = '# Doc\n\n' + part('==', chart) + '\n' + part('===', changed, 'changed intro', 'changed end');
    expect(again('# Doc\n\n' + part('===', chart), after, 0)).toBe(-1);
  });

  test('R8: text right under a quote that leaves no paragraph open is no more of the quote (the CommonMark comparison, T5.16)', () => {
    const chart = '```mermaid\nflowchart TD\n  a --> b\n```\n';
    const headings = (above: string) => findBlocks(above + '\n\n' + chart)[0].headings;
    // The quote's last line is blank, a heading, a thematic break or a fence line.
    expect(headings('> ---\nx  \n=')).toBe('1 x');
    expect(headings('> ~~~\n  #notheading\n==')).toBe('1 #notheading');
    expect(headings('> ###### Flow#\n text\n---')).toBe('2 text');
    expect(headings('> ````\n  | a | b |\n--')).toBe('2 | a | b |');
    expect(headings('>\nx\n===')).toBe('1 x');
    expect(headings('> a\n> ---\nx\n===')).toBe('1 x');
    expect(headings('> > # h\nx\n===')).toBe('1 x');
    expect(headings('   > # h\nx\n===')).toBe('1 x');
    expect(headings('> - ---\nx\n===')).toBe('1 x');
    expect(headings('>> ***\nx\n---')).toBe('2 x');
    // Under quoted text, the lines are more of it.
    expect(headings('> a\nx\n===')).toBe('');
    expect(headings('> a\n===')).toBe('');
    expect(headings('> ```a`b\nx\n===')).toBe('');
    expect(headings('> - a\nx\n===')).toBe('');
    expect(headings('> ===\nx\n===')).toBe('');
    expect(headings('> --\nx\n===')).toBe('');
    expect(headings('> a\n>     ~~~\nx\n===')).toBe('');
    // So a backup under another heading is never taken for the shown block.
    const again = (before: string, after: string, was: number) => findAgain(before, findBlocks(before), after, findBlocks(after), was);
    const changed = chart.replace('a --> b', 'a --> c');
    const part = (head: string, body: string, intro = 'intro', end = 'end') => `> ---\n${head}\n===\n\n${intro}\n${body}\n${end}\n`;
    const after = '# Doc\n\n' + part('Backup', chart) + '\n' + part('Original', changed, 'changed intro', 'changed end');
    expect(again('# Doc\n\n' + part('Original', chart), after, 0)).toBe(-1);
  });
});

describe('a long list is read in good time (bug hunt round 3: B20)', () => {
  const fence = ['    ```mermaid', '    flowchart TD', '      a', '    ```', ''];
  const items = (n: number, gap: boolean) => Array.from({ length: n }, (_, i) => (gap ? [`    - item ${i}`, ''] : [`    - item ${i}`])).flat();
  const timed = (lines: string[]) => {
    const t = performance.now();
    const found = findBlocks(lines.join('\n')).length;
    return { found, ms: performance.now() - t };
  };

  // Each indented item doubled the time: 24 items took about 10 s.
  test('24 indented items above an indented fence: under a paragraph, under a bullet, with blank lines between', () => {
    for (const [lines, found] of [
      [['Intro:', ...items(24, false), ...fence], 0],
      [['- parent', ...items(24, false), ...fence], 1],
      [['- parent', '', ...items(24, true), ...fence], 1],
    ] as const) {
      const r = timed([...lines]);
      expect(r.found).toBe(found);
      expect(r.ms).toBeLessThan(500);
    }
  });

  test('3,000 of them', () => {
    const r = timed(['- parent', ...items(3000, false), ...fence]);
    expect(r.found).toBe(1);
    expect(r.ms).toBeLessThan(2000);
  });
});
