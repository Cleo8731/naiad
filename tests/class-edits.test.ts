// @vitest-environment jsdom
// Classes in the window (T1.26; the user, 2026-11-26, Q263: "You should be able to create
// new classes, delete classes, and ... assign a class to the new node"): the four class
// edits, as text, each through the checked edit.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { applyChecked, type Op } from '../src/verify';
import { classNameProblem, classShapes, EditError } from '../src/core/edits';
import { snapshot } from '../src/semantics';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const edit = async (text: string, op: Op) => (await applyChecked(text, op)).text;
const BLUE = { fill: '#d0ebff', stroke: '#1c7ed6', color: '#1c2026' };

const FILE = [
  'flowchart TD',
  '    a[A] --> b[B]:::held',
  '    b --> c[C]',
  '    classDef held fill:#fff0cd,stroke:#996300',
  '    classDef stop fill:#ffe3e3,stroke:#e03131',
  '    class a,c stop',
  '',
].join('\n');

describe('a node put in a class', () => {
  test('joins the class\'s line and leaves the others', async () => {
    expect(await edit(FILE, { kind: 'setClass', id: 'c', cls: 'held' }))
      .toBe(FILE.replace('class a,c stop', 'class a stop\n    class c held'));
    expect(await edit(FILE, { kind: 'setClass', id: 'b', cls: 'stop' }))
      .toBe(FILE.replace('b[B]:::held', 'b[B]').replace('class a,c stop', 'class a,c,b stop'));
  });

  test('None takes it out of every class, its mark included', async () => {
    expect(await edit(FILE, { kind: 'setClass', id: 'b', cls: null })).toBe(FILE.replace('b[B]:::held', 'b[B]'));
    expect(await edit(FILE, { kind: 'setClass', id: 'a', cls: null })).toBe(FILE.replace('class a,c stop', 'class c stop'));
  });

  test('a class line written before the node is not used: Mermaid skips it', async () => {
    const before = 'flowchart TD\n  classDef k fill:#fff\n  class x k\n  a --> x\n';
    expect(await edit(before, { kind: 'setClass', id: 'a', cls: 'k' }))
      .toBe('flowchart TD\n  classDef k fill:#fff\n  class x k\n  a --> x\n  class a k\n');
  });

  test('a node inside a group gets its class line after the group', async () => {
    const before = 'flowchart TD\n  classDef k fill:#fff\n  subgraph g [G]\n    a\n  end\n';
    expect(await edit(before, { kind: 'setClass', id: 'a', cls: 'k' }))
      .toBe('flowchart TD\n  classDef k fill:#fff\n  subgraph g [G]\n    a\n  end\n  class a k\n');
    expect(await edit(before, { kind: 'setClass', id: 'g', cls: 'k' }))
      .toBe('flowchart TD\n  classDef k fill:#fff\n  subgraph g [G]\n    a\n  end\n  class g k\n');
  });

  test('a class the file does not define, or a group with no id of its own, is refused', async () => {
    await expect(applyChecked(FILE, { kind: 'setClass', id: 'a', cls: 'nope' })).rejects.toThrow(/no class "nope"/);
    const titled = 'flowchart TD\n  classDef k fill:#fff\n  subgraph "Only a title"\n    a\n  end\n';
    await expect(applyChecked(titled, { kind: 'setClass', id: 'subGraph0', cls: 'k' })).rejects.toThrow(/no id written/);
  });
});

describe('a new class', () => {
  test('goes after the last classDef line, and can take a node at once', async () => {
    expect(await edit(FILE, { kind: 'addClass', name: 'calm', styles: BLUE, node: null }))
      .toBe(FILE.replace('stroke:#e03131\n', 'stroke:#e03131\n    classDef calm fill:#d0ebff,stroke:#1c7ed6,color:#1c2026\n'));
    expect(await edit(FILE, { kind: 'addClass', name: 'calm', styles: BLUE, node: 'b' }))
      .toBe(FILE.replace('b[B]:::held', 'b[B]').replace('stroke:#e03131\n', 'stroke:#e03131\n    classDef calm fill:#d0ebff,stroke:#1c7ed6,color:#1c2026\n')
        + '    class b calm\n');
  });

  test('in a file with no classes, at the end', async () => {
    expect(await edit('flowchart TD\n  a --> b\n', { kind: 'addClass', name: 'calm', styles: BLUE, node: 'a' }))
      .toBe('flowchart TD\n  a --> b\n  classDef calm fill:#d0ebff,stroke:#1c7ed6,color:#1c2026\n  class a calm\n');
  });

  test('a name that is taken, empty, Mermaid\'s own or has other characters is refused, with why', () => {
    expect(classNameProblem(FILE, 'held')).toMatch(/already a class/);
    expect(classNameProblem(FILE, '')).toMatch(/needs a name/);
    expect(classNameProblem(FILE, 'end')).toMatch(/keeps for itself/);
    expect(classNameProblem(FILE, 'default')).toMatch(/keeps for itself/);
    expect(classNameProblem(FILE, 'two words')).toMatch(/only letters/);
    expect(classNameProblem(FILE, 'step-2_b')).toBeNull();
  });
});

describe('a class\'s colour', () => {
  test('changes where the class sets it, and keeps its other properties', async () => {
    const before = 'flowchart TD\n  a:::k\n  classDef k fill:#fff,stroke-width:2px\n  classDef k stroke:#000\n';
    expect(await edit(before, { kind: 'setClassStyle', name: 'k', changes: BLUE }))
      .toBe('flowchart TD\n  a:::k\n  classDef k fill:#d0ebff,stroke-width:2px\n  classDef k stroke:#1c7ed6,color:#1c2026\n');
  });

  test('a class defined on one line with another is left to the Syntax pane', async () => {
    const shared = 'flowchart TD\n  a:::k\n  classDef k,m fill:#fff\n';
    await expect(applyChecked(shared, { kind: 'setClassStyle', name: 'k', changes: BLUE })).rejects.toThrow(EditError);
  });
});

describe('a class deleted', () => {
  test('goes from its definition, its class lines and its marks; the nodes stay', async () => {
    expect(await edit(FILE, { kind: 'deleteClass', name: 'held' }))
      .toBe(FILE.replace('b[B]:::held', 'b[B]').replace('    classDef held fill:#fff0cd,stroke:#996300\n', ''));
    expect(await edit(FILE, { kind: 'deleteClass', name: 'stop' }))
      .toBe(FILE.replace('    classDef stop fill:#ffe3e3,stroke:#e03131\n', '').replace('    class a,c stop\n', ''));
    const after = await snapshot(await edit(FILE, { kind: 'deleteClass', name: 'stop' }));
    expect(Object.keys(after.nodes).sort()).toEqual(['a', 'b', 'c']);
    expect(after.classDefs.stop).toBeUndefined();
  });

  test('on a line it shares with another class, only its name goes', async () => {
    const shared = 'flowchart TD\n  a:::k --> b:::m\n  classDef k,m fill:#fff\n';
    expect(await edit(shared, { kind: 'deleteClass', name: 'k' })).toBe('flowchart TD\n  a --> b:::m\n  classDef m fill:#fff\n');
  });
});

test('Mermaid\'s reading holds the classes the file defines, in its order, and a group\'s classes', async () => {
  const a = await snapshot(FILE);
  expect(a.classDefs.held).toEqual(['fill:#fff0cd', 'stroke:#996300']);
  const grouped = await snapshot('flowchart TD\n  subgraph g [G]\n    a\n  end\n  classDef k fill:#fff\n  class g k\n');
  expect(grouped.subs.g.classes).toEqual(['k']);
});

// The classes round after 1.0.4 (the user, 2026-11-26): a class's shape (Q267, Q271),
// its own colour taken off a node put in it (Q270), a border (Q274), a new name (Q276).
describe('a class\'s shape', () => {
  const SHAPED = FILE.replace('    classDef held fill:#fff0cd,stroke:#996300\n', '    classDef held fill:#fff0cd,stroke:#996300\n    %% @class held shape: stadium\n');

  test('is a %% line under its classDef, which Mermaid skips; setting it reshapes the class\'s nodes', async () => {
    expect(await edit(FILE, { kind: 'setClassShape', name: 'held', shape: 'stadium', nodes: ['b'] }))
      .toBe(SHAPED.replace('b[B]:::held', 'b(["B"]):::held'));
    expect(classShapes(SHAPED).get('held')).toBe('stadium');
    expect(await edit(SHAPED, { kind: 'setClassShape', name: 'held', shape: 'diamond', nodes: [] }))
      .toBe(SHAPED.replace('shape: stadium', 'shape: diamond'));
    expect(await edit(SHAPED, { kind: 'setClassShape', name: 'held', shape: null, nodes: ['b'] })).toBe(FILE);
  });

  test('a node put in the class takes it, and loses its own colour', async () => {
    const own = SHAPED.replace('    class a,c stop\n', '    class a,c stop\n    style c fill:#f00,stroke-width:3px\n');
    expect(await edit(own, { kind: 'setClass', id: 'c', cls: 'held' }))
      .toBe(SHAPED.replace('c[C]', 'c(["C"])').replace('    class a,c stop\n', '    class a stop\n    class c held\n    style c stroke-width:3px\n'));
    // Out of a class, or into one with no shape, the shape stays.
    expect(await edit(SHAPED, { kind: 'setClass', id: 'b', cls: 'stop' })).toBe(SHAPED.replace('b[B]:::held', 'b[B]').replace('class a,c stop', 'class a,c,b stop'));
  });

  test('a line under a description is part of its text, not a shape', () => {
    expect(classShapes('flowchart TD\n  a\n%% @a\n%% @class held shape: diamond\n').size).toBe(0);
    expect(classShapes('flowchart TD\n  a\n  %% @class held shape: blob\n').size).toBe(0);
  });

  test('goes with its class, and follows a new name', async () => {
    expect(await edit(SHAPED, { kind: 'deleteClass', name: 'held' })).toBe(await edit(FILE, { kind: 'deleteClass', name: 'held' }));
    expect(await edit(SHAPED, { kind: 'renameClass', name: 'held', next: 'waiting' })).toBe(SHAPED.replace(/held/g, 'waiting'));
  });
});

describe('a class\'s border and name', () => {
  test('a border is set and taken off; its other properties stay', async () => {
    const thick = await edit(FILE, { kind: 'setClassStyle', name: 'held', changes: { 'stroke-width': '2px', 'stroke-dasharray': '5 3' } });
    expect(thick).toBe(FILE.replace('stroke:#996300', 'stroke:#996300,stroke-width:2px,stroke-dasharray:5 3'));
    expect(await edit(thick, { kind: 'setClassStyle', name: 'held', changes: { 'stroke-width': null, 'stroke-dasharray': null } })).toBe(FILE);
  });

  test('a new name reaches every line and mark; a name in use is refused', async () => {
    expect(await edit(FILE, { kind: 'renameClass', name: 'stop', next: 'halt' })).toBe(FILE.replace('classDef stop', 'classDef halt').replace('class a,c stop', 'class a,c halt'));
    await expect(applyChecked(FILE, { kind: 'renameClass', name: 'stop', next: 'held' })).rejects.toThrow('There is already a class "held".');
  });
});
