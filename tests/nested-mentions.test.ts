// @vitest-environment jsdom
// A delete keeps a bare mention of a node only if the node would otherwise lose its place
// (`Piece.optional`, src/core/edits.ts). A node also named inside a group nested in the
// mention's group already has its place there, so no line is added for it (bug hunt
// T6.5, oA48: one stray line in the person's file, though the chart was the same).
import { beforeAll, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { applyChecked } from '../src/verify';
import { snapshot } from '../src/semantics';
import { fixtures } from './fixtures';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const text = 'flowchart TD\nsubgraph G1\n  m --> u\n  subgraph G2\n    u --> v\n  end\nend\n';

test('deleting an arrow adds no line for a node already named in the inner group', async () => {
  const res = await applyChecked(text, { kind: 'deleteEdge', index: 0 });
  // m keeps a mention (it has no other); u does not need one (it is named in G2).
  expect(res.text).toBe('flowchart TD\nsubgraph G1\n  m\n  subgraph G2\n    u --> v\n  end\nend\n');
});

test('deleting a node adds no line for a node already named in the inner group', async () => {
  const res = await applyChecked(text, { kind: 'deleteNode', id: 'm' });
  expect(res.text).toBe('flowchart TD\nsubgraph G1\n  subgraph G2\n    u --> v\n  end\nend\n');
});

test('the "groups" fixture: deleting a2 --> b1 adds no bare b1 line', async () => {
  const snap = await snapshot(fixtures.groups);
  const index = snap.edges.findIndex((e) => e.start === 'a2' && e.end === 'b1');
  const res = await applyChecked(fixtures.groups, { kind: 'deleteEdge', index });
  expect(res.text).toContain('a2[Second]');
  expect(res.text).not.toMatch(/^\s*b1$/m);
});

test('a node named only in a sibling group still keeps its mention', async () => {
  // u's other mention is in G3, beside G1, not inside it: Mermaid gives u to the group
  // that names it first, so the delete must not drop the mention that holds it in G1.
  const t = 'flowchart TD\nsubgraph G1\n  m --> u\nend\nsubgraph G3\n  u --> v\nend\n';
  const res = await applyChecked(t, { kind: 'deleteEdge', index: 0 });
  expect(res.text).toMatch(/^\s*u$/m);
});
