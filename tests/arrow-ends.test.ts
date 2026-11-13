// @vitest-environment jsdom
import { beforeAll, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { applyChecked } from '../src/verify';
import { plainText, withEndingsOf } from '../src/core/endings';
beforeAll(() => mermaid.initialize({ startOnLoad: false }));
const move = async (text: string, index: number, end: 'start' | 'end', id: string) => (await applyChecked(text, { kind: 'setEdgeEnd', index, end, id })).text;

for (const [end, expected] of [
  ['start', 'flowchart TD\n  a\n  x --> b\n  x\n'],
  ['end', 'flowchart TD\n  b\n  a --> x\n  x\n'],
] as const) test(`single arrow ${end}`, async () => {
  expect(await move('flowchart TD\n  a --> b\n  x\n', 0, end, 'x')).toBe(expected);
});
for (const [index, end, lines] of [
  [0, 'start', '  a\n  x --> b\n  b --> c'],
  [0, 'end', '  a --> x\n  b --> c'],
  [1, 'start', '  a --> b\n  x --> c'],
  [1, 'end', '  a --> b\n  b --> x\n  c'],
] as const) test(`chain ${index} ${end}`, async () => {
  expect(await move('flowchart TD\n  a --> b --> c\n  x\n', index, end, 'x')).toBe(`flowchart TD\n${lines}\n  x\n`);
});
for (let index = 0; index < 4; index++) for (const end of ['start', 'end'] as const) test(`list pair ${index} ${end}`, async () => {
  const pairs = [['a','c'], ['a','d'], ['b','c'], ['b','d']];
  pairs[index][end === 'start' ? 0 : 1] = 'x';
  expect(await move('flowchart TD\n  a & b --> c & d\n  x\n', index, end, 'x'))
    .toBe(`flowchart TD\n${pairs.map(([a,b]) => `  ${a} --> ${b}`).join('\n')}\n  x\n`);
});
for (const token of ['-->|"quoted label"|', '-- quoted label -->', 'e1@-->|hello|']) test(`preserves ${token}`, async () => {
  const before = `flowchart TD\n  a ${token} b\n  a\n  x\n`;
  expect(await move(before, 0, 'start', 'x')).toBe(before.replace(`a ${token}`, `x ${token}`));
});
for (const index of [0,2]) test(`shared id owner ${index}`, async () => {
  const before = 'flowchart TD\n  a & b e1@--> c & d\n  x\n';
  const pairs = ['  a --> c','  a --> d','  b e1@--> c','  b --> d'];
  pairs[index] = pairs[index].replace(/ c$/, ' x');
  expect(await move(before, index, 'end', 'x')).toBe(`flowchart TD\n${pairs.join('\n')}\n  x\n`);
});
test('decorated old reference stays in place', async () => {
  expect(await move('flowchart TD\n  a[Alpha] --> b\n  x\n', 0, 'start', 'x'))
    .toBe('flowchart TD\n  a[Alpha]\n  x --> b\n  x\n');
});
test('loop, unchanged end, and missing or generated destinations', async () => {
  const before = 'flowchart TD\n  a --> b\n';
  expect(await move(before, 0, 'end', 'b')).toBe(before);
  expect(await move(before, 0, 'end', 'a')).toBe('flowchart TD\n  b\n  a --> a\n');
  await expect(move(before, 0, 'end', 'missing')).rejects.toThrow();
  await expect(move('flowchart TD\n  subgraph "Title only"\n    a\n  end\n  a --> b\n', 0, 'end', 'subGraph0')).rejects.toThrow();
});
test('group endpoint and its title survive a move off it', async () => {
  const before = 'flowchart TD\n  subgraph g[Group title]\n    a\n  end\n  x --> g\n  x --> a\n';
  expect(await move(before, 1, 'end', 'g')).toBe(before.replace('x --> a', 'x --> g'));
  expect(await move(before, 0, 'end', 'a')).toBe(before.replace('x --> g', 'x --> a'));
});
for (const [name, chart, target] of [
  ['outside', '  subgraph g[G]\n    a --> b\n  end\n  x\n', 'x'],
  ['later group', '  subgraph g[G]\n    a --> b\n  end\n  subgraph h[H]\n    x\n  end\n', 'x'],
  ['another group', '  subgraph g[G]\n    a --> b\n  end\n  subgraph h[H]\n    x\n  end\n', 'h'],
  ['ancestor group', '  subgraph g[G]\n    subgraph k[K]\n      a --> b\n    end\n  end\n  x\n', 'g'],
] as const) test(`relocates for ${name}`, async () => {
  const before = `flowchart TD\n${chart}`;
  const after = await move(before, 0, 'end', target);
  expect(after).toBe(before.replace('a --> b', 'a\n' + (name === 'ancestor group' ? '      ' : '    ') + 'b').replace(name === 'ancestor group' ? '  end\n  x' : '  end\n', `  end\n  a --> ${target}\n` + (name === 'ancestor group' ? '  x' : '')));
});
test('relocation renumbers explicit styles, including duplicates', async () => {
  const before = 'flowchart TD\n  subgraph g[G]\n    a --> b\n    a --> b\n  end\n  x\n  linkStyle 0 stroke:red\n  linkStyle 0,1 stroke:blue\n  linkStyle default interpolate basis\n';
  expect(await move(before, 0, 'end', 'x')).toBe('flowchart TD\n  subgraph g[G]\n    a --> b\n  end\n  a --> x\n  x\n  linkStyle 1 stroke:red\n  linkStyle 1,0 stroke:blue\n  linkStyle default interpolate basis\n');
});
test('disk ending restoration and absent final newline', async () => {
  const disk = 'flowchart TD\r\n  a --> b\r\n  a\r\n  x';
  const edited = await move(plainText(disk), 0, 'start', 'x');
  expect(withEndingsOf(disk, edited)).toBe('flowchart TD\r\n  x --> b\r\n  a\r\n  x');
});

test('edge settings and classes stay with the moved shared-link owner', async () => {
  const before = 'flowchart TD\n  a & b e1@--> c & d\n  x\n  e1@{ animate: true }\n  class e1 hot\n  classDef hot stroke:red\n';
  expect(await move(before, 2, 'end', 'x')).toBe('flowchart TD\n  a --> c\n  a --> d\n  b e1@--> x\n  b --> d\n  x\n  e1@{ animate: true }\n  class e1 hot\n  classDef hot stroke:red\n');
});
test('in-place styles remain on the same duplicate arrow', async () => {
  const before = 'flowchart TD\n  a --> b\n  a --> b\n  x\n  linkStyle 0 stroke:red\n  linkStyle 0,1 stroke:blue\n  linkStyle default interpolate basis\n';
  expect(await move(before, 0, 'end', 'x')).toBe(before.replace('a --> b', 'a --> x'));
});
test('keeps semicolon neighbours and an old node inside its group', async () => {
  const before = 'flowchart TD\n  subgraph g[G]\n    a --> b; c --> d\n  end\n  x\n';
  const after = await move(before, 0, 'end', 'c');
  expect(after).toBe('flowchart TD\n  subgraph g[G]\n    a --> c\n    b\n    c --> d\n  end\n  x\n');
});
test('a group can be joined from an arrow in its own block without relocation', async () => {
  const before = 'flowchart TD\n  subgraph g[G]\n    a --> b\n    b\n  end\n';
  expect(await move(before, 0, 'end', 'g')).toBe(before.replace('a --> b', 'a --> g'));
});
test('the id on a repeated list reference stays on its actual pair', async () => {
  const before = 'flowchart TD\n  a & a e1@--> b\n  x\n';
  expect(await move(before, 0, 'end', 'x')).toBe('flowchart TD\n  a e1@--> x\n  a --> b\n  x\n');
});
