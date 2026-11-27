// @vitest-environment jsdom
// Text that Mermaid reads as HTML or Markdown, typed into every box that writes a title or
// a label (Q280; the user, 2026-11-26: "extrapolate this to the wider class of bugs").
// Each edit must pass the edit check, and the box must read back the text as typed.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { applyChecked, type Op } from '../src/verify';
import { shown, snapshot } from '../src/semantics';
import { nodeLabel, parseDoc } from '../src/core/scan';
import { escapeText, parseLink } from '../src/core/edits';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const BASE = 'flowchart TD\n    a(Start) -->|go| b(Next)\n    m["`Mark`"] --> b\n    subgraph g [Group]\n        c(Inside)\n    end\n';

const SAMPLES = [
  // A `<` that Mermaid keeps as `&lt;`, and one it would read as a tag and drop.
  'count < 5?', 'x << y', 'a <= b', 'a <- b', 'a -> b', 'I <3 it', '<', '<a', 'a<', 'a<b', 'a <x b', 'a <x> b', 'a </x> b',
  'Promise<void>', 'Map<String, Int>', '<div>', '<script>x</script>', 'a <!-- b', 'a <? b', '日本語 < 中文',
  // Formatting tags Mermaid keeps, in any case.
  'x <b>bold</b> y', 'a<br>b', 'a<br/>b', '<i>it</i>', 'H<sub>2</sub>O', 'a <B>b</B>',
  // Backticks: a quoted label that starts and ends with one is Markdown.
  '`code`', '`code` here', 'here `code`', 'use `x` here', '`', '```', '`a',
  // Codes and entities, and other signs.
  '"quoted"', 'say #quot;hi#quot;', 'R&D', 'R&D <b>x</b>', 'no\u00a0break <i>c</i>', 'a &amp; b', 'love #9829;', 'a > b', 'a\tb', 'ok 👍🏽', 'https://example.com/a?b=c&d=e#f',
];

const EDITS: [string, (t: string) => Op, (text: string, snap: Awaited<ReturnType<typeof snapshot>>, created?: string) => string][] = [
  ['a title', (t) => ({ kind: 'setTitle', id: 'a', title: t }), (text) => nodeLabel(parseDoc(text), 'a')!.title],
  ['a Markdown title', (t) => ({ kind: 'setTitle', id: 'm', title: t }), (text) => nodeLabel(parseDoc(text), 'm')!.title],
  ['a new node', (t) => ({ kind: 'addNode', title: t, parent: null }), (text, _s, id) => nodeLabel(parseDoc(text), id!)!.title],
  ['an arrow label', (t) => ({ kind: 'setEdgeLabel', index: 0, label: t }), (text) => {
    const doc = parseDoc(text);
    const e = doc.edges[0];
    return parseLink(doc.info[e.line].chains![e.chain].links[e.link].raw).label;
  }],
  ['a group title', (t) => ({ kind: 'renameSubgraph', id: 'g', title: t }), (_t, snap) => shown(snap.subs.g.title)],
  ['a new group', (t) => ({ kind: 'groupNode', id: 'a', title: t }), (_t, snap, id) => shown(snap.subs[id!].title)],
];

// Mermaid's own code typed in a box (`#quot;`) reads back as the character it draws. A
// group's title is shown from Mermaid's reading, which writes a tag's name in lower case
// (`<B>` as `<b>`) and `<br/>` as `<br>`; and `&amp;` shows as the `&` it draws. Each pair
// draws the same.
const asRead = (what: string, t: string): string => {
  const drawn = t.replace(/#quot;/g, '"');
  return what.includes('group') ? drawn.replace(/<(\/?)B>/g, '<$1b>').replace(/&amp;/g, '&').replace(/<br\/>/g, '<br>') : drawn;
};

describe.each(EDITS)('%s', (what, op, readBack) => {
  test.each(SAMPLES)('%j is written, passes the check and reads back as typed', async (t) => {
    const res = await applyChecked(BASE, op(t));
    expect(readBack(res.text, await snapshot(res.text), res.created)).toBe(asRead(what, t));
  });
});

describe('escapeText', () => {
  test('writes a `<` that would start a tag as #lt;, and leaves the rest', () => {
    expect(escapeText('Promise<void>')).toBe('Promise#lt;void>');
    expect(escapeText('count < 5? <b>yes</b>')).toBe('count < 5? <b>yes</b>');
    expect(escapeText('a<br/>b <script>')).toBe('a<br/>b #lt;script>');
    expect(escapeText('say "hi"')).toBe('say #quot;hi#quot;');
  });
  test('writes a leading backtick as #96;, and every backtick in a Markdown title', () => {
    expect(escapeText('`code` here')).toBe('#96;code` here');
    expect(escapeText('use `x`')).toBe('use `x`');
    expect(escapeText('use `x`', true)).toBe('use #96;x#96;');
  });
});

test('a title that would change the chart\'s settings is still refused', async () => {
  await expect(applyChecked(BASE, { kind: 'setTitle', id: 'a', title: 'a %%{init}%% b' })).rejects.toThrow();
});
