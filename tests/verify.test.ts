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
  });
});

describe('an arrow keeps its own settings through an edit (bug hunt S11, S13, S14)', () => {
  const edit = async (text: string, op: Op) => (await applyChecked(text, op)).text;

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
