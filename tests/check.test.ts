// @vitest-environment jsdom
// The checker (src/core/check.ts) with Mermaid's own parser as its reader: what it
// reports, on which line of the file, and what "fix" changes.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { checkFile, checkFlowchart, fixFile, formatReport, type Finding } from '../src/core/check';
import { reading } from '../src/semantics';
import { fixtures } from './fixtures';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const check = (text: string): Promise<Finding[]> => checkFlowchart(text, reading);
const brief = (fs: Finding[]): string[] => fs.map((f) => `${f.line} ${f.rule}`);

describe('a file with nothing wrong', () => {
  for (const [name, text] of Object.entries(fixtures)) {
    test(`${name}: no findings`, async () => {
      expect(await check(text)).toEqual([]);
    });
  }

  test('comments, frontmatter and a directive above the header', async () => {
    expect(await check('%% a note\n\nflowchart TD\n  A --> B\n')).toEqual([]);
    expect(await check('---\ntitle: T\n---\nflowchart TD\n  A --> B\n')).toEqual([]);
    expect(await check('%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B\n')).toEqual([]);
  });
});

describe('what Mermaid rejects, on the line of the file', () => {
  const cases: [string, string, number][] = [
    ['parentheses in a title', 'flowchart TD\n  A --> B\n  C[Title with (parens)] --> B\n', 3],
    ['a node named end', 'flowchart TD\n  A --> B\n  B --> C\n  end --> B\n', 4],
    ['a style ending in a comma', 'flowchart TD\n  A --> B\n  style A fill:#f00,\n', 3],
    ['an unclosed bracket, found at the end of the text', 'flowchart TD\n  A --> B\n\n  C[Title --> B\n\n%% @A\n%% text\n', 4],
    ['below comment lines', 'flowchart TD\n  A --> B\n%% @A\n%% text\n%% .\n%% more\n  C[Title with (parens)] --> B\n', 7],
    ['below a note and empty lines above the header', '%% a note\n\nflowchart TD\n  A --> B\n  C[Title with (parens)] --> B\n', 5],
    ['below frontmatter', '---\ntitle: T\n---\nflowchart TD\n  A --> B\n  C[Title with (parens)] --> B\n', 6],
    ['below frontmatter and an empty line', '---\ntitle: T\n---\n\nflowchart TD\n  C[Title with (parens)] --> B\n', 6],
  ];
  for (const [name, text, line] of cases) {
    test(name, async () => {
      const found = await check(text);
      expect(found.filter((f) => f.rule === 'mermaid').map((f) => f.line)).toEqual([line]);
    });
  }

  test('the hints name the commonest causes', async () => {
    const message = async (t: string) => (await check(t)).find((f) => f.rule === 'mermaid')?.message ?? '';
    expect(await message('flowchart TD\n  C[Title with (parens)] --> B\n')).toMatch(/double quotes/);
    expect(await message('flowchart TD\n  end --> B\n')).toMatch(/"end" closes a group/);
    expect(await message('flowchart TD\n  A --> B\n  style A fill:#f00,\n')).toMatch(/ends with a comma/);
  });

  test('a text with no header, and a diagram that is not a flowchart', async () => {
    expect(brief(await check('A --> B\n'))).toContain('1 mermaid');
    expect((await check('sequenceDiagram\n  A->>B: hi\n')).some((f) => f.rule === 'mermaid')).toBe(true);
  });
});

describe('what breaks the Naiad file format', () => {
  test('a comment after a statement', async () => {
    const found = await check('flowchart TD\n  A --> B %% note\n  B --> C\n');
    expect(brief(found)).toEqual(['2 comment-after-statement']);
  });

  test('a comment after a statement does not hide a problem further down', async () => {
    const found = await check('flowchart TD\n  A --> B %% note\n  B --> C\n  D[Title with (parens)] --> B\n');
    expect(brief(found)).toEqual(['2 comment-after-statement', '4 mermaid']);
  });

  test('a bare %% line, inside a description and outside', async () => {
    const found = await check('flowchart TD\n  A --> B\n%%\n%% @A\n%% one\n%%\n%% two\n');
    expect(brief(found)).toEqual(['3 bare-comment', '6 bare-comment']);
    expect(found.every((f) => f.fixable)).toBe(true);
  });

  test('a description block for an id the flowchart does not have', async () => {
    const found = await check('flowchart TD\n  A[Start] --> B\n%% @Start\n%% text\n');
    expect(brief(found)).toEqual(['3 description-without-node']);
  });

  test('a description block for a group is accepted', async () => {
    expect(await check('flowchart TD\n  subgraph g [Group]\n    A --> B\n  end\n%% @g\n%% text\n')).toEqual([]);
  });

  test('two description blocks for one id', async () => {
    const found = await check('flowchart TD\n  A --> B\n%% @A\n%% one\n\n%% @A\n%% two\n');
    expect(brief(found)).toEqual(['6 second-description']);
    expect(found[0].message).toMatch(/line 3/);
  });

  test('a subgraph with no end is reported once', async () => {
    const found = await check('flowchart TD\n  subgraph g\n  A --> B\n');
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map((f) => f.line)).size).toBe(found.length);
  });
});

const MD = [
  '# Title',
  '',
  'Text.',
  '',
  '```mermaid',
  'flowchart TD',
  '  A --> B',
  '%%',
  '  C[Title with (parens)] --> B',
  '```',
  '',
  '1. A list',
  '',
  '   ```mermaid',
  '   flowchart LR',
  '     X --> Y',
  '   %% @Z',
  '   %% text',
  '   ```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  A->>B: hi',
  '```',
  '',
].join('\n');

describe('Markdown files', () => {
  test('each flowchart block is checked, with lines of the file', async () => {
    const report = await checkFile('doc.md', MD, reading);
    expect(report.charts).toBe(2);
    expect(brief(report.findings)).toEqual(['8 bare-comment', '9 mermaid', '17 description-without-node']);
  });

  test('a file with no flowchart block', async () => {
    const report = await checkFile('doc.md', '# Title\n\n```mermaid\npie\n  "a": 1\n```\n', reading);
    expect(brief(report.findings)).toEqual(['1 markdown']);
  });

  test('a block Naiad shows but does not change', async () => {
    const report = await checkFile('doc.md', '  ```mermaid\n  flowchart TD\nA --> B\n  ```\n', reading);
    expect(report.findings.some((f) => f.rule === 'markdown' && f.line === 1)).toBe(true);
  });
});

describe('the printed report', () => {
  test('names the file, the line and the count', async () => {
    const text = 'flowchart TD\n  A --> B\n%%\n';
    const out = formatReport('flow.mmd', text, await checkFile('flow.mmd', text, reading));
    expect(out.split('\n')[0]).toMatch(/^flow\.mmd:3: /);
    expect(out).toMatch(/flow\.mmd: 1 problem$/);
    const clean = formatReport('flow.mmd', fixtures.sample, await checkFile('flow.mmd', fixtures.sample, reading));
    expect(clean).toBe('flow.mmd: no problems');
  });
});

describe('fix', () => {
  test('changes only the bare %% lines', async () => {
    const text = 'flowchart TD\n  A --> B\n  %%\n%% @A\n%% one\n%%\n%% two\n';
    const fixed = await fixFile('flow.mmd', text, reading);
    expect(fixed.refused).toBeNull();
    expect(fixed.lines).toEqual([3, 6]);
    const before = text.split('\n');
    const after = fixed.raw.split('\n');
    expect(after.length).toBe(before.length);
    expect(after[2]).toBe('  %% .');
    expect(after[5]).toBe('%% .');
    expect(after.filter((l, i) => l !== before[i]).length).toBe(2);
    expect(await check(fixed.raw)).toEqual([]);
  });

  test('keeps CRLF newlines and a byte-order mark', async () => {
    const text = '﻿flowchart TD\r\n  A --> B\r\n%%\r\n';
    const fixed = await fixFile('flow.mmd', text, reading);
    expect(fixed.raw).toBe('﻿flowchart TD\r\n  A --> B\r\n%% .\r\n');
  });

  test('keeps each line\'s own ending in a file that mixes them (bug hunt S1)', async () => {
    const mixed = await fixFile('flow.mmd', 'flowchart TD\r\n  A --> B\n%%\r\n%% x\n', reading);
    expect(mixed.raw).toBe('flowchart TD\r\n  A --> B\n%% .\r\n%% x\n');
    const loneCr = await fixFile('flow.mmd', 'flowchart TD\r  A --> B\r%%\r', reading);
    expect(loneCr.raw).toBe('flowchart TD\r  A --> B\r%% .\r');
    const md = '# Title\r\nintro\r\n\n```mermaid\nflowchart TD\n  A --> B\n%%\n```\nafter\r\n';
    expect((await fixFile('doc.md', md, reading)).raw).toBe(md.replace('%%\n', '%% .\n'));
  });

  test('a file with nothing to fix comes back as it was', async () => {
    for (const text of Object.values(fixtures)) {
      const fixed = await fixFile('flow.mmd', text, reading);
      expect(fixed.raw).toBe(text);
      expect(fixed.lines).toEqual([]);
    }
  });

  test('refuses while Mermaid cannot read the flowchart', async () => {
    const text = 'flowchart TD\n  C[Title with (parens)] --> B\n%%\n';
    const fixed = await fixFile('flow.mmd', text, reading);
    expect(fixed.raw).toBe(text);
    expect(fixed.refused).toMatch(/nothing was changed/);
  });

  test('in a Markdown file, only lines inside a flowchart block change', async () => {
    const md = MD.replace('  C[Title with (parens)] --> B\n', '').replace('Text.', 'Text.\n\n%%');
    const fixed = await fixFile('doc.md', md, reading);
    expect(fixed.refused).toBeNull();
    const before = md.split('\n');
    const after = fixed.raw.split('\n');
    const changed = after.map((l, i) => (l !== before[i] ? i + 1 : 0)).filter(Boolean);
    expect(changed).toEqual(fixed.lines);
    expect(changed.length).toBe(1);
    expect(before[changed[0] - 1]).toBe('%%');
    expect(after[changed[0] - 1]).toBe('%% .');
    expect(before[4]).toBe('%%'); // the bare %% in the Markdown text itself is not a flowchart line
    expect(after[4]).toBe('%%');
  });
});
