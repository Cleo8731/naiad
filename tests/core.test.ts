import { describe, expect, test } from 'vitest';
import { parseDoc, tokenizeStatements, nodeLabel } from '../src/core/scan';
import { getDescriptions, setDescription } from '../src/core/descriptions';
import * as E from '../src/core/edits';
import { fixtures, sample } from './fixtures';

describe('scanner', () => {
  test('reads chains, groups of nodes and every arrow form', () => {
    const cases: [string, number, number][] = [
      ['A --> B', 1, 1], ['A-->B-->C', 1, 2], ['A & B --> C & D', 1, 1], ['A -- text --> B', 1, 1],
      ['A -->|text| B', 1, 1], ['A -. dotted .-> B', 1, 1], ['A == thick ==> B', 1, 1], ['A --o B', 1, 1],
      ['A <--> B', 1, 1], ['A ~~~ B', 1, 1], ['A e1@--> B', 1, 1], ['A --> B; C --> D', 2, 1],
      ['A["say (hi) [x]"] --> B{{hex}}', 1, 1], ['my-node --> other.node', 1, 1], ['A', 1, 0],
    ];
    for (const [line, chains, links] of cases) {
      const got = tokenizeStatements(line);
      expect(got, line).not.toBeNull();
      expect(got!.length, line).toBe(chains);
      expect(got![0].links.length, line).toBe(links);
    }
  });

  test('refuses lines it cannot read with certainty', () => {
    for (const line of ['A --> B %% note', 'A B', 'style A fill:#f00', 'A[unclosed --> B', 'A -->']) {
      expect(tokenizeStatements(line), line).toBeNull();
    }
  });

  test('reads every bracket shape', () => {
    const doc = parseDoc('flowchart TD\n  a[x]\n  b(x)\n  c([x])\n  d[[x]]\n  e[(x)]\n  f((x))\n  g{x}\n  h{{x}}\n  i[/x/]\n  j[\\x\\]\n  k[/x\\]\n  l[\\x/]\n  m(((x)))\n  n>x]\n');
    expect(doc.problems).toEqual([]);
    const types = 'abcdefghijklmn'.split('').map((id) => nodeLabel(doc, id)!.type);
    expect(types).toEqual(['square', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'diamond', 'hexagon',
      'lean_right', 'lean_left', 'trapezoid', 'inv_trapezoid', 'doublecircle', 'odd']);
  });

  test('numbers edges and subgraphs the way Mermaid does', () => {
    const doc = parseDoc(fixtures.chains);
    expect(doc.problems).toEqual([]);
    expect(doc.edges.map((e) => `${e.from.id}>${e.to.id}`)).toEqual(
      ['A>B', 'B>C', 'X>P', 'X>Q', 'Y>P', 'Y>Q', 'P>R', 'Q>R', 'A>X', 'B>Y', 'C>Q', 'C>A']);
    const g = parseDoc(fixtures.groups);
    expect(g.subs.map((s) => [s.id, s.title, s.explicitId])).toEqual(
      [['inner', 'Inner', true], ['outer', 'Outer group', true], ['subGraph2', 'Title only', false]]);
  });

  test('flags a bare %% and unreadable lines', () => {
    expect(parseDoc('flowchart TD\n  A\n%%\n').warnings.map((w) => w.line)).toEqual([2]);
    expect(parseDoc('flowchart TD\n  A --> B %% x\n').problems.map((p) => p.line)).toEqual([1]);
    expect(parseDoc('flowchart TD\n  subgraph s\n  A\n').problems.length).toBe(1);
  });
});

describe('only lower-case subgraph and end open and close a group, as in Mermaid (bug hunt A8)', () => {
  // Mermaid 12.3.0 reads END, End, SUBGRAPH or Subgraph on a line of its own as a node.
  for (const word of ['END', 'End', 'END;', 'SUBGRAPH', 'Subgraph']) {
    test(`${word} on a line of its own is a node`, () => {
      const doc = parseDoc(`flowchart TD\n  a[A] --> b[B]\n  ${word}\n`);
      expect(doc.problems).toEqual([]);
      expect(nodeLabel(doc, word.replace(';', ''))).not.toBeNull();
      expect(doc.subs).toEqual([]);
    });
  }

  test('a group closed by end, with an END node inside it', () => {
    const doc = parseDoc('flowchart TD\n  subgraph g [G]\n    a\n    END\n  end\n  a --> END\n');
    expect(doc.problems).toEqual([]);
    expect(doc.subs.map((s) => [s.id, s.line, s.endLine])).toEqual([['g', 1, 4]]);
    expect(nodeLabel(doc, 'END')).not.toBeNull();
  });
});

describe('description blocks', () => {
  test('reads the sample', () => {
    const d = getDescriptions(sample);
    expect([...d.keys()]).toEqual(['collect', 'clean', 'ship']);
    expect(d.get('collect')).toBe(
      'Pull the raw exports from the warehouse.\n\nDescriptions are **Markdown**: lists, `code` and links all work.\n- one file per day\n- never edited by hand');
  });

  test('a write followed by a read gives the same text back', () => {
    for (const desc of ['One line.', 'Two\nlines.', 'Para one.\n\nPara two.\n\n\nPara three.', '@mention\n.\n  indented', 'has %% and {braces} --> "x"']) {
      const out = setDescription(sample, 'train', desc);
      expect(getDescriptions(out).get('train'), desc).toBe(desc);
      expect(out.split('\n').some((l) => l.trim() === '%%'), 'never writes a bare %%').toBe(false);
    }
  });

  test('C37: U+2028 and U+2029 inside a description line are read back (bug hunt round 3)', () => {
    for (const ch of [' ', ' ']) {
      const out = setDescription(sample, 'train', `first${ch}second\nthird`);
      expect(getDescriptions(out).get('train')).toBe(`first${ch}second\nthird`);
      expect(getDescriptions(out).get('ship')).toBe(getDescriptions(sample).get('ship'));
      // As an agent may write it.
      expect(getDescriptions(`flowchart TD\n    a --> b\n\n%% @a\n%% one${ch}two\n%% three\n`).get('a')).toBe(`one${ch}two\nthree`);
    }
  });

  test('a line that is an indented @word stays in its description (bug hunt S10, A1)', () => {
    const typed = 'Example:\n```python\nclass Loader:\n    @staticmethod\n    def load(path):\n```\nCalled once a day.';
    for (const desc of [typed, 'Ping:\n  @bob\nlast line', 'Tab:\n\t@x\n.']) {
      const out = setDescription(sample, 'train', desc);
      const read = getDescriptions(out);
      expect(read.get('train'), out).toBe(desc);
      expect([...read.keys()], 'no block split off').toEqual(['collect', 'clean', 'ship', 'train']);
      // A second write replaces the whole of the first, and removing it leaves nothing.
      expect(setDescription(out, 'train', 'Short now.')).toBe(setDescription(sample, 'train', 'Short now.'));
      expect(setDescription(out, 'train', '')).toBe(sample);
    }
  });

  test('replaces in place, appends at the end, and removes cleanly', () => {
    const replaced = setDescription(sample, 'clean', 'New text.');
    expect(replaced).toBe(sample.replace('%% Check for nulls and duplicates. Rows that fail go back to *Fix the data*.', '%% New text.'));
    const added = setDescription(sample, 'fix', 'Added.');
    expect(added).toBe(`${sample}\n%% @fix\n%% Added.\n`);
    expect(setDescription(added, 'fix', '')).toBe(sample);
    expect(setDescription(sample, 'nobody', '')).toBe(sample);
  });

  test('a new block keeps every blank line at the end of the file (bug hunt S15, A6)', () => {
    for (const before of ['flowchart TD\n  a --> b\n\n\n\n', 'flowchart TD\n  a --> b\n  \n\t\n', 'flowchart TD\n  a --> b\n  ']) {
      const out = setDescription(before, 'a', 'Hello');
      expect(out.startsWith(before.replace(/\n$/, '')), JSON.stringify(out)).toBe(true);
      expect(getDescriptions(out).get('a')).toBe('Hello');
      expect(out.endsWith('\n'), 'the final newline as it was').toBe(before.endsWith('\n'));
    }
    expect(setDescription('flowchart TD\n  a --> b\n\n', 'a', 'Hi')).toBe('flowchart TD\n  a --> b\n\n%% @a\n%% Hi\n');
  });

  test('keeps a file with no final newline that way', () => {
    const out = setDescription(fixtures.noTrailingNewline, 'one', 'Hi.');
    expect(out).toBe(`${fixtures.noTrailingNewline}\n\n%% @one\n%% Hi.`);
  });

  test('tolerates a hand-typed bare %% as an empty line', () => {
    expect(getDescriptions('flowchart TD\n A\n%% @A\n%% one\n%%\n%% two\n').get('A')).toBe('one\n\ntwo');
  });
});

describe('edits change only the lines they must', () => {
  const changed = (before: string, after: string) => {
    const a = before.split('\n');
    const b = after.split('\n');
    return { removed: a.filter((l) => !b.includes(l)), added: b.filter((l) => !a.includes(l)) };
  };

  test('title', () => {
    expect(changed(sample, E.setTitle(sample, 'collect', 'Gather data'))).toEqual({
      removed: ['    collect[Collect data] --> clean{Clean?}'], added: ['    collect[Gather data] --> clean{Clean?}'] });
    expect(E.setTitle('flowchart TD\n  A --> B\n', 'B', 'The "end" (really)')).toBe('flowchart TD\n  A --> B["The #quot;end#quot; (really)"]\n');
  });

  test('shape', () => {
    expect(changed(sample, E.setShape(sample, 'train', 'hexagon'))).toEqual({
      removed: ['    clean -- yes --> train[Train model]'], added: ['    clean -- yes --> train{{"Train model"}}'] });
  });

  test('add node and arrow', () => {
    const n = E.addNode(sample, 'New node');
    expect(n.id).toBe('n1');
    expect(changed(sample, n.text)).toEqual({ removed: [], added: ['    n1[New node]'] });
    expect(n.text.indexOf('n1[New node]')).toBeLessThan(n.text.indexOf('style ship'));
    const inGroup = E.addNode(sample, 'Inside', 'review');
    expect(changed(sample, inGroup.text)).toEqual({ removed: [], added: ['        n1[Inside]'] });
    expect(changed(sample, E.addEdge(sample, 'ship', 'collect'))).toEqual({ removed: [], added: ['    ship --> collect'] });
  });

  test('a new node or group never takes the id of a kept description block (bug hunt S12, A3)', () => {
    const kept = 'flowchart TD\n  a --> b\n\n%% @n1\n%% An old note kept on purpose.\n%% @group1\n%% Another.\n';
    const n = E.addNode(kept, 'New node');
    expect(n.id).toBe('n2');
    expect(E.deleteNode(n.text, n.id)).toBe(kept);
    const g = E.addSubgraph(kept, 'G');
    expect(g.id).toBe('group2');
    expect(getDescriptions(g.text).get('group1')).toBe('Another.');
  });

  test('delete node keeps the rest of its lines', () => {
    const out = E.deleteNode(sample, 'clean');
    expect(changed(sample, out)).toEqual({
      removed: ['    collect[Collect data] --> clean{Clean?}', '    clean -- yes --> train[Train model]', '    clean -- no --> fix[Fix the data]',
        '    fix --> clean', '%% @clean', '%% Check for nulls and duplicates. Rows that fail go back to *Fix the data*.'],
      added: ['    collect[Collect data]', '    train[Train model]', '    fix[Fix the data]'] });
  });

  test('delete edge in a chain, and one of several written with &', () => {
    expect(E.deleteEdge('flowchart TD\n  A --> B --> C\n', 0)).toBe('flowchart TD\n  A\n  B --> C\n');
    expect(E.deleteEdge('flowchart TD\n  A --> B --> C\n  C --> A\n', 0)).toBe('flowchart TD\n  B --> C\n  C --> A\n');
    expect(E.deleteEdge('flowchart TD\n  A[One] --> B --> C\n', 0)).toBe('flowchart TD\n  A[One]\n  B --> C\n');
    expect(E.deleteEdge('flowchart TD\n  A & B --> C\n', 0)).toBe('flowchart TD\n  A\n  B --> C\n');
  });

  test('linkStyle numbers follow their edges', () => {
    const out = E.deleteEdge(fixtures.chains, 3); // X --> Q
    expect(out).toContain('linkStyle 1 stroke:#f00');
    expect(out).toContain('linkStyle 4,5 stroke:#0a0,stroke-width:3px');
    expect(out).toContain('linkStyle 8 stroke:#00f');
    expect(E.deleteEdge(fixtures.chains, 9)).not.toContain('linkStyle 9');
  });

  test('A26: a linkStyle stays on its arrow when the edit makes that arrow alike to another (bug hunt round 3)', () => {
    // Arrows: 0 a --o b, 1 d --o b (styled), 2 d --x b. Arrow 1 becomes d --x b, alike to arrow 2.
    const before = 'flowchart TD\n  a & d --o b\n  d --x b\n  linkStyle 1 stroke:#f00\n';
    expect(E.setEdgeStyle(before, 1, { arrow: 'cross' })).toBe('flowchart TD\n  a --o b\n  d --x b\n  d --x b\n  linkStyle 1 stroke:#f00\n');
    const labelled = 'flowchart TD\n  a & d --> b\n  d -->|go| b\n  linkStyle 1 stroke:#f00\n';
    expect(E.setEdgeLabel(labelled, 1, 'go')).toContain('linkStyle 1 stroke:#f00');
  });

  test('edge label and style', () => {
    expect(E.setEdgeLabel('flowchart TD\n  A --> B\n', 0, 'go')).toBe('flowchart TD\n  A -->|go| B\n');
    expect(E.setEdgeLabel('flowchart TD\n  A -- old --> B\n', 0, '')).toBe('flowchart TD\n  A --> B\n');
    expect(E.setEdgeStyle('flowchart TD\n  A -- keep --> B\n', 0, { stroke: 'dotted' })).toBe('flowchart TD\n  A -.->|keep| B\n');
    expect(E.setEdgeStyle('flowchart TD\n  A ==> B\n', 0, { arrow: 'none' })).toBe('flowchart TD\n  A === B\n');
  });

  test('style', () => {
    expect(changed(sample, E.setStyle(sample, 'ship', { fill: '#fff' }))).toEqual({
      removed: ['    style ship fill:#d3f9d8,stroke:#2f9e44,color:#1c2026'], added: ['    style ship fill:#fff,stroke:#2f9e44,color:#1c2026'] });
    expect(changed(sample, E.setStyle(sample, 'ship', { fill: null, stroke: null }))).toEqual({
      removed: ['    style ship fill:#d3f9d8,stroke:#2f9e44,color:#1c2026'], added: ['    style ship color:#1c2026'] });
    expect(changed(sample, E.setStyle(sample, 'ship', { fill: null, stroke: null, color: null })).added).toEqual([]);
    expect(changed(sample, E.setStyle(sample, 'fix', { fill: '#fee' }))).toEqual({ removed: [], added: ['    style fix fill:#fee'] });
  });

  test('refuses to touch a file with a line it cannot read', () => {
    expect(() => E.setTitle('flowchart TD\n  A --> B %% note\n', 'A', 'x')).toThrow(E.EditError);
  });
});
