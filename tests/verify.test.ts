// @vitest-environment jsdom
// Runs every edit on every node, arrow and group of each fixture, and checks each result
// against Mermaid's own parser (src/verify.ts): the new file must parse, and must differ
// from the old chart only in the way the edit intends.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { applyChecked, type Op } from '../src/verify';
import { snapshot } from '../src/semantics';
import { EditError } from '../src/core/edits';
import { parseDoc } from '../src/core/scan';
import { getDescriptions } from '../src/core/descriptions';
import { fixtures } from './fixtures';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

async function opsFor(text: string): Promise<Op[]> {
  const snap = await snapshot(text);
  const nodes = Object.keys(snap.nodes);
  const subs = Object.keys(snap.subs);
  const ops: Op[] = [
    { kind: 'addNode', title: 'New node', parent: null },
    { kind: 'addNode', title: 'Odd "title" (here) [x] end', parent: null },
    { kind: 'setDirection', dir: 'LR' }, { kind: 'setDirection', dir: 'TD' },
  ];
  if (nodes.length > 1) ops.push({ kind: 'addEdge', from: nodes[0], to: nodes[nodes.length - 1] }, { kind: 'addEdge', from: nodes[1], to: nodes[1] });
  for (const id of nodes) {
    ops.push(
      { kind: 'setTitle', id, title: 'Renamed' }, { kind: 'setTitle', id, title: 'Say "hi" (now) [x] {y} | end' },
      { kind: 'setShape', id, shape: 'diamond' }, { kind: 'setShape', id, shape: 'stadium' }, { kind: 'setShape', id, shape: 'lean_right' },
      { kind: 'setShape', id, shape: 'square' },
      { kind: 'deleteNode', id },
      { kind: 'setStyle', id, changes: { fill: '#abcdef', stroke: '#123456' } }, { kind: 'setStyle', id, changes: { fill: null, stroke: null, color: null } },
      { kind: 'setDescription', id, description: 'A new description.\n\nWith two paragraphs.' }, { kind: 'setDescription', id, description: '' },
      { kind: 'moveNode', id, target: null }, { kind: 'groupNode', id, title: 'New group' },
    );
    for (const target of subs) ops.push({ kind: 'moveNode', id, target });
  }
  snap.edges.forEach((_, index) => {
    ops.push(
      { kind: 'deleteEdge', index }, { kind: 'setEdgeLabel', index, label: 'label' }, { kind: 'setEdgeLabel', index, label: 'a "b" (c) | d' },
      { kind: 'setEdgeLabel', index, label: '' }, { kind: 'setEdgeStyle', index, stroke: 'dotted' }, { kind: 'setEdgeStyle', index, stroke: 'thick' },
      { kind: 'setEdgeStyle', index, stroke: 'normal' }, { kind: 'setEdgeStyle', index, arrow: 'none' }, { kind: 'setEdgeStyle', index, arrow: 'both' },
      { kind: 'setEdgeStyle', index, arrow: 'circle' }, { kind: 'setEdgeStyle', index, arrow: 'cross' }, { kind: 'setEdgeStyle', index, arrow: 'arrow' },
    );
  });
  for (const id of subs) {
    ops.push(
      { kind: 'renameSubgraph', id, title: 'Renamed group' }, { kind: 'renameSubgraph', id, title: 'One' },
      { kind: 'setSubgraphDirection', id, dir: 'LR' }, { kind: 'setSubgraphDirection', id, dir: null },
      { kind: 'ungroup', id }, { kind: 'addNode', title: 'Inside', parent: id },
      { kind: 'setStyle', id, changes: { fill: '#eeeeee' } }, { kind: 'setStyle', id, changes: { fill: null } },
    );
  }
  return ops;
}

describe.each(Object.keys(fixtures))('every edit on fixture "%s"', (name) => {
  test('is exact, or is refused with a reason', async () => {
    const text = fixtures[name];
    const ops = await opsFor(text);
    const refused: string[] = [];
    for (const op of ops) {
      try {
        const res = await applyChecked(text, op);
        expect(parseDoc(res.text).problems, JSON.stringify(op)).toEqual([]);
        expect(res.text.endsWith('\n'), 'final newline kept as it was').toBe(text.endsWith('\n'));
        if (op.kind !== 'setDescription' && op.kind !== 'deleteNode') {
          expect([...getDescriptions(res.text)], `descriptions untouched by ${JSON.stringify(op)}`).toEqual([...getDescriptions(text)]);
        }
      } catch (e) {
        if (!(e instanceof EditError)) throw e;
        refused.push(`${JSON.stringify(op)} -> ${e.message}`);
      }
    }
    expect(refused, `${refused.length} of ${ops.length} refused`).toEqual([]);
    // Each fixture runs hundreds of edits through Mermaid: 0.5 to 4.5 s alone, and past
    // Vitest's 5 s when the other test files run beside it.
  }, 30_000);
});

describe('an arrow keeps its own settings through an edit (bug hunt S11, S13, S14)', () => {
  const edit = async (text: string, op: Op) => (await applyChecked(text, op)).text;

  test('splitting an & list keeps the arrow\'s own id on the pair Mermaid gives it to (A2)', async () => {
    // Mermaid gives `e1` to the last node before the arrow and the first after it: b --> c.
    const before = 'flowchart TD\n  a & b e1@--> c & d\n  e1@{ animate: true }\n';
    expect(await edit(before, { kind: 'setEdgeLabel', index: 0, label: 'x' }))
      .toBe('flowchart TD\n  a -->|x| c\n  a --> d\n  b e1@--> c\n  b --> d\n  e1@{ animate: true }\n');
    expect(await edit(before, { kind: 'setEdgeLabel', index: 2, label: 'x' }))
      .toBe('flowchart TD\n  a --> c\n  a --> d\n  b e1@-->|x| c\n  b --> d\n  e1@{ animate: true }\n');
  });

  test('deleting a node of an & list never gives the arrow\'s own id to another pair (A2)', async () => {
    const classed = 'flowchart TD\n  a & b e1@--> c\n  class e1 k\n  classDef k stroke:#f00\n';
    expect(await edit(classed, { kind: 'deleteNode', id: 'b' })).toBe('flowchart TD\n  a --> c\n  class e1 k\n  classDef k stroke:#f00\n');
    expect(await edit(classed, { kind: 'deleteNode', id: 'a' })).toBe(classed.replace('a & b', 'b'));
    // With a settings line for the arrow that goes, the edit is refused: the line would
    // turn into a node, and it is never moved onto another arrow.
    const animated = 'flowchart TD\n  a & b e1@--> c\n  e1@{ animate: true }\n';
    await expect(applyChecked(animated, { kind: 'deleteNode', id: 'b' })).rejects.toThrow(EditError);
  });

  test('changing an arrow\'s style or label keeps a Markdown label Markdown (A4)', async () => {
    expect(await edit('flowchart TD\n  a -->|"`**bold** x`"| b\n', { kind: 'setEdgeStyle', index: 0, stroke: 'dotted' }))
      .toBe('flowchart TD\n  a -.->|"`**bold** x`"| b\n');
    expect(await edit('flowchart TD\n  a -- "`**bold** x`" --> b\n', { kind: 'setEdgeStyle', index: 0, arrow: 'none' }))
      .toBe('flowchart TD\n  a ---|"`**bold** x`"| b\n');
    expect(await edit('flowchart TD\n  a -->|"`**bold** x`"| b\n', { kind: 'setEdgeLabel', index: 0, label: 'say "hi"' }))
      .toBe('flowchart TD\n  a -->|"`say #quot;hi#quot;`"| b\n');
  });

  test('moving a node keeps each linkStyle line on the arrow it was written for (A5)', async () => {
    const before = 'flowchart TD\n  subgraph g [G]\n    a -->|one| b\n  end\n  a -->|two| b\n  linkStyle 0 interpolate step\n';
    expect(await edit(before, { kind: 'moveNode', id: 'a', target: null }))
      .toBe('flowchart TD\n  subgraph g [G]\n    b\n  end\n  a -->|two| b\n  a -->|one| b\n  linkStyle 1 interpolate step\n');
  });

  test('Mermaid\'s reading of an arrow holds its own id, settings, curve and label kind', async () => {
    const snap = await snapshot('flowchart TD\n  a & b e1@-->|"`**m**`"| c\n  e1@{ animate: true }\n  class e1 k\n  linkStyle 0 interpolate step\n');
    expect(snap.edges.map(({ start, end, markdown, interpolate, classes, animate, id }) => ({ start, end, markdown, interpolate, classes, animate, id })))
      .toEqual([
        { start: 'a', end: 'c', markdown: true, interpolate: 'step', classes: [], animate: false, id: '' },
        { start: 'b', end: 'c', markdown: true, interpolate: '', classes: ['k'], animate: true, id: 'e1' },
      ]);
  });
});

describe('a comment never joins a description block (bug hunt S24)', () => {
  // A description block runs on through every comment line under it, so a line that
  // kept a comment apart from a block must not simply go: the fuzz test found ungroup
  // adding "a --> b (commented out)" to a node's description.
  const edit = async (text: string, op: Op) => (await applyChecked(text, op)).text;

  test('ungrouping, when the group begins with a comment, under a block', async () => {
    const before = 'flowchart TD\n  %% @a\n  %% About a.\n  subgraph g [G]\n    %% a --> b (commented out)\n    b\n  end\n  a --> b\n';
    expect(await edit(before, { kind: 'ungroup', id: 'g' }))
      .toBe('flowchart TD\n  %% @a\n  %% About a.\n\n  %% a --> b (commented out)\n  b\n  a --> b\n');
  });

  test('ungrouping, when the group ends with a block and a comment follows it', async () => {
    const before = 'flowchart TD\n  subgraph g [G]\n    b\n    %% @b\n    %% About b.\n  end\n  %% a note\n  b --> c\n';
    expect(await edit(before, { kind: 'ungroup', id: 'g' }))
      .toBe('flowchart TD\n  b\n  %% @b\n  %% About b.\n\n  %% a note\n  b --> c\n');
  });

  test('deleting the node whose line stood between a block and a comment', async () => {
    const before = 'flowchart TD\n  a --> c\n  %% @a\n  %% About a.\n  b\n  %% a note\n';
    expect(await edit(before, { kind: 'deleteNode', id: 'b' }))
      .toBe('flowchart TD\n  a --> c\n  %% @a\n  %% About a.\n\n  %% a note\n');
  });
});

describe('a directive in a description or a title never changes the chart\'s settings (bug hunt A7)', () => {
  // Mermaid finds `%%{ ... }%%` anywhere in the text, inside a comment line too.
  const settings = async (text: string) => JSON.stringify(await mermaid.parse(text));
  const BASE = 'flowchart TD\n  a[A] --> b[B]\n';
  const DARK = '%%{init: {"theme": "dark"}}%%';
  const refused = /settings/;

  test('typed into a description: written with a backslash, read back as typed', async () => {
    const typed = [`Set the look with ${DARK} on a line of its own.`, DARK, 'Already %%\\{once}%%', '%%\\\\{twice}%%', '%%%{odd}'];
    for (const description of typed) {
      const { text } = await applyChecked(BASE, { kind: 'setDescription', id: 'a', description });
      expect(await settings(text)).toBe(await settings(BASE));
      expect(getDescriptions(text).get('a')).toBe(description);
    }
    expect((await applyChecked(BASE, { kind: 'setDescription', id: 'a', description: DARK })).text)
      .toBe(`${BASE}\n%% @a\n%% %%\\{init: {"theme": "dark"}}%%\n`);
  });

  test('a description written by hand that holds one: replacing or deleting it is refused', async () => {
    const before = `${BASE}\n%% @a\n%% ${DARK}\n`;
    expect(getDescriptions(before).get('a')).toBe(DARK);
    expect(await settings(before)).not.toBe(await settings(BASE)); // Mermaid does read it
    await expect(applyChecked(before, { kind: 'setDescription', id: 'a', description: 'New text.' })).rejects.toThrow(refused);
    await expect(applyChecked(before, { kind: 'deleteNode', id: 'a' })).rejects.toThrow(refused);
    const other = (await applyChecked(before, { kind: 'setTitle', id: 'b', title: 'Bee' })).text;
    expect(await settings(other)).toBe(await settings(before));
  });

  test('a title holding one is refused', async () => {
    await expect(applyChecked(BASE, { kind: 'setTitle', id: 'a', title: "%%{init: {'theme': 'dark'}}%%" })).rejects.toThrow(refused);
  });
});

describe('a node named END or SUBGRAPH on a line of its own (bug hunt A8)', () => {
  // Mermaid reads `end` and `subgraph` as keywords in lower case only.
  for (const word of ['END', 'SUBGRAPH']) {
    test(`${word}: chart edits work, the node's included`, async () => {
      const before = `flowchart TD\n  a[A] --> b[B]\n  ${word}\n`;
      expect((await applyChecked(before, { kind: 'setTitle', id: 'a', title: 'Renamed' })).text)
        .toBe(before.replace('a[A]', 'a[Renamed]'));
      expect((await applyChecked(before, { kind: 'addEdge', from: 'b', to: word })).text)
        .toBe(`${before}  b --> ${word}\n`);
      expect((await applyChecked(before, { kind: 'deleteNode', id: word })).text)
        .toBe('flowchart TD\n  a[A] --> b[B]\n');
    });
  }
});

describe('a space after a group\'s name makes the name a title only (bug hunt round 3: A28)', () => {
  // Mermaid takes the space with the name, up to the line's end or a `;`, so the group is
  // `subGraph0`; spaces after the `;` do not count.
  const forms: [string, string][] = [
    ['subgraph g ', 'subGraph0'], ['subgraph g\t', 'subGraph0'], ['subgraph g ;', 'subGraph0'], ['subgraph "g" ', 'subGraph0'],
    ['subgraph g ', 'subGraph0'], ['subgraph g; ', 'g'], ['subgraph "g";\t', 'g'], ['subgraph\tg', 'g'],
  ];
  const groupOps = (id: string): Op[] => [
    { kind: 'renameSubgraph', id, title: 'Renamed group' }, { kind: 'setSubgraphDirection', id, dir: 'LR' },
    { kind: 'ungroup', id }, { kind: 'addNode', title: 'Inside', parent: id }, { kind: 'setStyle', id, changes: { fill: '#eeeeee' } },
  ];
  for (const [line, id] of forms) {
    test(`${JSON.stringify(line)} is ${id}, and its edits work`, async () => {
      const before = `flowchart TD\n  ${line}\n    a\n  end\n`;
      expect(Object.keys((await snapshot(before)).subs)).toEqual([id]);
      expect(parseDoc(before).subs.map((s) => s.id)).toEqual([id]);
      for (const op of groupOps(id)) await applyChecked(before, op);
    });
  }
});

describe('a single " in an accessible title or description (bug hunt round 2: A15)', () => {
  // Mermaid reads `accTitle:` and `accDescr:` as plain text to the end of the line, and
  // `accDescr {` to its "}": a quote there opens no string.
  const forms = [
    '  accTitle: A 5" screen',
    '  accDescr: A 5" screen',
    '  accDescr { A 5" screen\n  more }',
    '  accDescr {\n  A 5" screen\n  }',
  ];
  for (const form of forms) {
    test(JSON.stringify(form), async () => {
      const before = `flowchart TD\n${form}\n  a[A] --> b[B]\n`;
      await snapshot(before); // Mermaid reads it
      expect(parseDoc(before).info.map((i) => i.kind)).not.toContain('string');
      expect((await applyChecked(before, { kind: 'setTitle', id: 'a', title: 'Renamed' })).text)
        .toBe(before.replace('a[A]', 'a[Renamed]'));
    });
  }
});

describe('a "{" in a one-line accessible title or description opens nothing (bug hunt round 3: A23, xA24)', () => {
  // Only `accDescr {` opens a text that runs to its "}"; `accTitle:` and `accDescr:` hold
  // plain text to the end of the line, a "{" included.
  for (const form of ['accTitle: A 5" screen { text', 'accDescr: braces { here', 'accDescr:{', 'accTitle:{ a']) {
    test(JSON.stringify(form), async () => {
      const before = `flowchart TD\n  ${form}\n  a[A] --> b[B]\n`;
      await snapshot(before); // Mermaid reads it
      expect(parseDoc(before).info.map((i) => i.kind)).toEqual(['header', 'acc', 'statement', 'blank']);
      expect((await applyChecked(before, { kind: 'setTitle', id: 'a', title: 'Renamed' })).text)
        .toBe(before.replace('a[A]', 'a[Renamed]'));
    });
  }
});

describe('a comment line in a multi-line accessible description never ends it (bug hunt round 3: A24)', () => {
  // Mermaid drops comment lines before it reads, inside `accDescr { }` too: a "}" in one
  // ends nothing.
  test('chart edits work', async () => {
    const before = 'flowchart TD\n  accDescr {\n  first\n  %% a comment with } in it\n  second\n  }\n  a[A] --> b[B]\n';
    await snapshot(before); // Mermaid reads it
    const doc = parseDoc(before);
    expect(doc.problems).toEqual([]);
    expect(doc.info.map((i) => i.kind)).toEqual(['header', 'acc', 'acc', 'acc', 'acc', 'acc', 'statement', 'blank']);
    expect((await applyChecked(before, { kind: 'setTitle', id: 'a', title: 'Renamed' })).text)
      .toBe(before.replace('a[A]', 'a[Renamed]'));
  });
  test('a description holding "}" in a block inside it leaves the file readable', async () => {
    const before = 'flowchart TD\n  accDescr {\n  %% @a\n  a[A] --> b[B]\n  }\n  c[C]\n';
    const { text } = await applyChecked(before, { kind: 'setDescription', id: 'a', description: '{x}' });
    expect(parseDoc(text).problems).toEqual([]);
    expect(parseDoc(text).info.map((i) => i.kind).slice(-2)).toEqual(['statement', 'blank']);
  });
});

describe('an accessible title is read where Mermaid reads one (bug hunt round 3: A25, A30)', () => {
  // Mermaid's lexer reads `accTitle\s*:\s*` before anything else on a line, and its `\s*`
  // runs on over the line break: with nothing after the colon, the next line that is
  // not blank or a comment is the text, not a statement.
  for (const kind of ['accTitle', 'accDescr']) {
    test(`${kind}: with nothing after the colon`, async () => {
      const top = `flowchart TD\n  ${kind}:\n\n  %% a note\n  a --> c\n`;
      const before = `${top}  c --> d\n`;
      expect(parseDoc(before).info.map((i) => i.kind)).toEqual(['header', 'acc', 'blank', 'comment', 'acc', 'statement', 'blank']);
      const res = (await applyChecked(before, { kind: 'deleteNode', id: 'c' })).text;
      expect(res.startsWith(top)).toBe(true);
      expect(res).not.toContain('c --> d');
    });
  }
  test('accTitle:::hot is a title, not a node', async () => {
    const before = 'flowchart TD\n  accTitle:::hot\n  a[A] --> b[B]\n  accTitle --> a\n';
    expect(parseDoc(before).info[1].kind).toBe('acc');
    expect((await applyChecked(before, { kind: 'deleteNode', id: 'accTitle' })).text)
      .toBe('flowchart TD\n  accTitle:::hot\n  a[A] --> b[B]\n');
  });
});

describe('a "%%" line in the front matter is not a description (bug hunt round 3: xA23)', () => {
  // Mermaid reads the front matter (a first line `---` to the next `---` line) before it
  // drops comments, so a `%%` line in it is YAML text: an edit leaves it as it is.
  const front = '---\ntitle: |\n  %% @a\n  %% Original metadata\n---\n';
  const before = `${front}flowchart TD\n  a\n`;
  test('a description set on the node is added below the chart', async () => {
    expect((await applyChecked(before, { kind: 'setDescription', id: 'a', description: 'New description' })).text)
      .toBe(`${before}\n%% @a\n%% New description\n`);
  });
  test('deleting the node leaves the front matter', async () => {
    expect((await applyChecked(before, { kind: 'deleteNode', id: 'a' })).text).toBe(`${front}flowchart TD\n`);
  });
  test('the node has no description until one is written below', () => {
    expect(getDescriptions(before).get('a')).toBeUndefined();
    expect(getDescriptions(`${before}\n%% @a\n%% Real one\n`).get('a')).toBe('Real one');
    // Only at the very top: Mermaid finds no front matter after a blank line.
    expect(getDescriptions(`\n${before}`).get('a')).toBe('Original metadata');
  });
});

describe('the front matter is found as Mermaid finds it, and no edit changes it (bug hunt round 4: A35, A36)', () => {
  // Mermaid's pattern: the closing `---` stands after exactly the spaces the opening one
  // stands after, which may be any space but a line break (a no-break space too).
  test('fences after a no-break space: a description is added below the chart, the YAML left as it is', async () => {
    const before = '\u00a0---\ntitle: |\n  %% @a\n  %% precious\n\u00a0---\nflowchart TD\na\n';
    expect(Object.keys((await snapshot(before)).nodes)).toEqual(['a']);
    expect((await applyChecked(before, { kind: 'setDescription', id: 'a', description: 'new' })).text)
      .toBe(`${before}\n%% @a\n%% new\n`);
    expect(getDescriptions(before).get('a')).toBeUndefined();
  });
  test('an indented "---" inside a YAML text does not end the front matter', async () => {
    const before = '---\ntitle: |\n  ---\n  a\n---\nflowchart TD\na\n';
    expect(Object.keys((await snapshot(before)).nodes)).toEqual(['a']);
    expect((await applyChecked(before, { kind: 'setTitle', id: 'a', title: 'new' })).text)
      .toBe(before.replace('\na\n', '\na[new]\n'));
    expect(parseDoc(before).info.map((l) => l.kind).slice(0, 6))
      .toEqual(['frontmatter', 'frontmatter', 'frontmatter', 'frontmatter', 'frontmatter', 'header']);
  });
  test('the front matter is read at the very top only, and only when it is closed', () => {
    expect(parseDoc('\n---\ntitle: x\n---\nflowchart TD\na\n').info[1].kind).not.toBe('frontmatter');
    expect(parseDoc('---\ntitle: x\nflowchart TD\na\n').info[0].kind).not.toBe('frontmatter');
    expect(parseDoc('  ---\ntitle: x\n  ---\nflowchart TD\na\n').info.map((l) => l.kind).slice(0, 4))
      .toEqual(['frontmatter', 'frontmatter', 'frontmatter', 'header']);
  });
});

describe('a bare "%%" line Mermaid reads as text reaches Mermaid as it stands (bug hunt round 5: A38, A39)', () => {
  // Mermaid drops a `%%` line only when something follows the `%%`. Inside an accessible
  // description or a title written over several lines, a bare one is part of the text;
  // only the bare lines the scanner warns about (where Mermaid would draw a node) are
  // blanked for Mermaid.
  test('A38: an edit that would change an accessible description is refused', async () => {
    const before = 'flowchart TD\naccDescr {\nFirst\n%% @a\n%%\nLast\n}\na\n';
    expect((await snapshot(before)).accDescr).toBe('First\n%%\nLast');
    // Removing the description takes the bare line with it. (Writing one keeps it, as an
    // empty line at the block's start, since A42, so the accessible description stays.)
    await expect(applyChecked(before, { kind: 'setDescription', id: 'a', description: '' })).rejects.toThrow(EditError);
    const written = await applyChecked(before, { kind: 'setDescription', id: 'a', description: 'new' });
    expect(written.text).toBe('flowchart TD\naccDescr {\nFirst\n%% @a\n%%\n%% new\nLast\n}\na\n');
    expect((await snapshot(written.text)).accDescr).toBe('First\n%%\nLast');
  });
  test('A39: a title written over several lines keeps its bare "%%" line', async () => {
    expect((await snapshot('flowchart TD\na["First\n%%\nLast"]\n')).nodes.a.text).toBe('First\n%%\nLast');
  });
  // Mermaid drops directives before it reads, so a "}" in one ends no accessible
  // description; the scanner ended it there, warned about the bare line after it, and
  // the checked edit could not see that line go (bug hunt round 6, A43).
  test('A43: a directive inside an accessible description ends nothing', async () => {
    const before = 'flowchart TD\naccDescr {\nFirst\n%%{init: {"theme":"dark"}}%%\n%% @a\n%%\nLast\n}\na\n';
    expect(parseDoc(before).info.map((i) => i.kind).slice(1, 8)).toEqual(['acc', 'acc', 'acc', 'acc', 'acc', 'acc', 'acc']);
    expect(parseDoc(before).warnings).toEqual([]);
    expect((await snapshot(before)).accDescr).toBe('First\n%%\nLast');
    await expect(applyChecked(before, { kind: 'setDescription', id: 'a', description: '' })).rejects.toThrow(EditError);
    // Over several lines too; and a "}" after the directive, on its line, still ends it.
    const several = 'flowchart TD\naccDescr {\nFirst\n%%{init: {\n"theme": "dark"}}%%\n%%\nLast\n}\na\n';
    expect(parseDoc(several).info.map((i) => i.kind).slice(1, 9)).toEqual(['acc', 'acc', 'acc', 'acc', 'acc', 'acc', 'acc', 'statement']);
    expect((await snapshot(several)).accDescr).toBe((await snapshot(before)).accDescr);
    expect(parseDoc('flowchart TD\naccDescr {\nx %%{init: {}}%% }\n%%\na\n').info[3].kind).toBe('comment');
  });
});

// A "%%{" left open runs to the end of the file, so the scanner read the empty line after
// the last line break as part of it; a new style line went after that line break, and
// the file lost its last one (bug hunt round 6, oA42; the charts are the fuzz's).
describe('a "%%{" left open does not move a new line past the last line break (oA42)', () => {
  const simple = [
    'flowchart RL', '    %%{ init', '    B', '    %% a plain comment', '    subgraph sub-2["Step two"]', '    end',
    '    B@{ shape: notch-rect, label: "a **b**" }', '    linkStyle default interpolate basis stroke-width:2px', '',
  ].join('\n');
  const big = [
    'graph BT', 'accTitle:', '%% ', '    %%{ init',
    '    A[\\"50% off\\"\\] -.- graphy == thick text ==> A([Load data]) --x 日本:::hot',
    '    node1[/Load data/]:::hot e1@<==> 日本[\\Step 2/] o--o A -. dotted text .-> graphy{"Paren (x) [y] {z}"}',
    '    e1@{ animate: true }', '    classDef cold fill:#69f,color:#fff,stroke-width:2px', '    classDef a,b font-style:italic',
    '    class A,node1 hot', '    style node1 fill:#d3f9d8,stroke:#2f9e44', '',
    '%% @n3', '%% %% ', '%% %%  ', '%% \\@x\t', '%% a %% b', '',
  ].join('\n');
  test.each([['a short chart', simple, 'B'], ['a chart with a description block', big, '日本']] as const)('%s', async (_, text, id) => {
    const res = await applyChecked(text, { kind: 'setStyle', id, changes: { color: '#000' } });
    expect(res.text.startsWith(text), 'every old line kept, in order').toBe(true);
    expect(res.text.endsWith('\n'), 'the last line break kept').toBe(true);
    expect(res.text.slice(text.length)).toBe(`    style ${id} color:#000\n`);
  });
});

describe('a bare "%%" after an empty accessible title is its text (bug hunt round 5: A41, D32)', () => {
  // Mermaid drops a `%%` line only when something follows the `%%`, so an `accTitle:` or
  // `accDescr:` with nothing after the colon takes a bare one for its text, and the next
  // line is a statement.
  for (const kind of ['accTitle', 'accDescr']) {
    test(`${kind}: deleting another node keeps the first arrow's style`, async () => {
      const before = `flowchart TD\n${kind}:\n\n  %%\na --> b\nc --> d\nlinkStyle 0 stroke:#f00\n`;
      expect(parseDoc(before).info.map((i) => i.kind)).toEqual(['header', 'acc', 'blank', 'acc', 'statement', 'statement', 'linkStyle', 'blank']);
      expect(parseDoc(before).warnings).toEqual([]);
      expect((await applyChecked(before, { kind: 'deleteNode', id: 'c' })).text).toBe(before.replace('c --> d', 'd'));
    });
  }
  test('"%%" with a space after it is a comment, and the next line is the text', () => {
    expect(parseDoc('flowchart TD\naccTitle:\n%% \na --> b\n').info.map((i) => i.kind)).toEqual(['header', 'acc', 'comment', 'acc', 'blank']);
  });
});

test('a second edit works on the first edit\'s output', async () => {
  let text = fixtures.groups;
  const steps: Op[] = [
    { kind: 'addNode', title: 'Extra', parent: 'inner' }, { kind: 'addEdge', from: 'n1', to: 'lone' }, { kind: 'moveNode', id: 'b1', target: null },
    { kind: 'deleteEdge', index: 0 }, { kind: 'ungroup', id: 'inner' }, { kind: 'groupNode', id: 'lone', title: 'Solo' },
    { kind: 'setEdgeLabel', index: 1, label: 'next' }, { kind: 'deleteNode', id: 'a2' }, { kind: 'renameSubgraph', id: 'subGraph1', title: 'Named now' },
  ];
  for (const op of steps) text = (await applyChecked(text, op)).text;
  const snap = await snapshot(text);
  expect(Object.keys(snap.nodes).sort()).toEqual(['a1', 'b1', 'b2', 'c1', 'lone', 'n1']);
  expect(getDescriptions(text).get('a1')).toBe('The first step.');
});
