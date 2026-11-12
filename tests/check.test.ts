// @vitest-environment jsdom
// The checker (src/core/check.ts) with Mermaid's own parser as its reader: what it
// reports, on which line of the file, and what "fix" changes.
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { checkFile, checkFlowchart, fixFile, formatReport, mermaidLength, signsUnquoted, type Finding } from '../src/core/check';
import { forMermaid, reading, snapshot } from '../src/semantics';
import { runCli, wellFormed } from '../src/cli';
import type { Backend } from '../src/backend';
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

describe('a "%%" that Mermaid reads as text is no comment (bug hunt D2)', () => {
  // Mermaid 12.3.0 reads a "%%" in the middle of a line as text: all of these are valid.
  const lines = [
    'A["50%% off"]', 'A[50%% off]', 'A("50%% off")', 'A["`50%% off`"]', 'A@{ label: "50%% off" }',
    'A -->|50%% off| B', 'A -- "50%% off" --> B', 'A -- 50%% off --> B', 'A == 50%% off ==> B',
    'A -. 50%% off .-> B', 'A["50%% off"] --> B["a %% b"]',
  ];
  for (const line of lines) {
    test(`D2: ${line}`, async () => {
      expect(await check(`flowchart TD\n  ${line}\n`)).toEqual([]);
    });
  }

  test('in front matter, and on the last line of a directive written over several lines', async () => {
    expect(await check('---\ntitle: 50%% off\n---\nflowchart TD\n  A --> B\n')).toEqual([]);
    expect(await check('%%{init: {\n  "theme": "dark"\n}}%%\nflowchart TD\n  A --> B\n')).toEqual([]);
  });

  test('inside a quoted title that runs over several lines: only the lines Naiad does not edit are named', async () => {
    const found = await check('flowchart TD\n  A["line one\n  50%% off"] --> B\n');
    expect(brief(found)).toEqual(['2 unreadable-line', '3 unreadable-line']);
  });

  test('fix puts right a bare "%%" in such a file, and leaves the title', async () => {
    const fixed = await fixFile('flow.mmd', 'flowchart TD\n  A["50%% off"] --> B\n%%\n', reading);
    expect(fixed.refused).toBeNull();
    expect(fixed.raw).toBe('flowchart TD\n  A["50%% off"] --> B\n%% .\n');
  });

  // Mermaid takes a bare "%%" after an empty `accTitle:` for the title's text; "fix" made
  // it a comment, and the next line, an arrow, became the title (bug hunt round 5, D32).
  test('D32: a bare "%%" that is an accessible title\'s text is no problem, and fix leaves it', async () => {
    const text = 'flowchart TD\naccTitle:\n%%\nA-->B\n';
    expect(await check(text)).toEqual([]);
    const fixed = await fixFile('flow.mmd', text, reading);
    expect(fixed).toEqual({ raw: text, lines: [], refused: null });
    expect((await snapshot(text)).accTitle).toBe('%%');
  });

  // A U+2028 does not end a line for Mermaid, so `%%`, a U+2028 and a "}" make one comment
  // line, which Mermaid drops; the scanner took the "}" for the end of the accessible
  // description, and "fix" changed a bare "%%" of its text (bug hunt round 6, D33).
  for (const sep of [' ', ' ']) {
    test(`D33: a "}" after "%%" and U+${sep.charCodeAt(0).toString(16).toUpperCase()} ends no accessible description`, async () => {
      const text = `flowchart TD\naccDescr {\n%%${sep}}\n%%\nhello\n}\nA-->B\n`;
      expect((await snapshot(text)).accDescr).toBe('%%\nhello');
      expect(await check(text)).toEqual([]);
      expect(await fixFile('flow.mmd', text, reading)).toEqual({ raw: text, lines: [], refused: null });
    });
  }

  // A "%%" in an accessible title or description was reported as a comment after a
  // statement, though Mermaid reads the line without error (bug hunt round 6, D34). One
  // after an `accDescr { ... }` closed on its line breaks Mermaid's reading: still
  // reported, as Mermaid's error.
  const accessible = [
    'accTitle: hello %% world', 'accTitle: 50%% off', 'accDescr: hello %% world', 'accDescr { hi %% world }',
    'accDescr {\n hi %% world\n}', 'accTitle:\n hi %% world', 'accDescr:\n\n hi %% world',
  ];
  for (const acc of accessible) {
    test(`D34: ${JSON.stringify(acc)} is no comment after a statement`, async () => {
      const chart = `flowchart TD\n${acc}\nA-->B\n`;
      await mermaid.parse(chart); // Mermaid reads it
      expect(await check(chart)).toEqual([]);
      expect(await fixFile('flow.mmd', chart, reading)).toEqual({ raw: chart, lines: [], refused: null });
    });
  }
  test('D34: a "%%" after an accessible description closed on its line is still reported', async () => {
    for (const chart of ['flowchart TD\naccDescr { hi } %% world\nA-->B\n', 'flowchart TD\naccDescr {\n hi\n} %% world\nA-->B\n']) {
      await expect(mermaid.parse(chart)).rejects.toThrow();
      expect((await check(chart)).length).toBeGreaterThan(0);
    }
  });

  // Also valid in Mermaid 12.3.0; the checker called them broken (bug hunt round 2, D11).
  const more = [
    'A --> B\n  click A "https://example.com/a%%b" "50%% off"', 'A --> B\n  click A call cb() "tip%%"',
    'A --> B\n  click A href "u%%" _blank',
    'subgraph "Title only %% x"\n    A --> B\n  end', 'subgraph "a%%"\n    A --> B\n  end',
    'subgraph S ["Sales %% growth"]\n    A --> B\n  end', 'subgraph s [a %% b]\n    A --> B\n  end',
    'subgraph s[a%%b]\n    A --> B\n  end',
  ];
  for (const text of more) {
    test(`D11: ${text.split('\n').find((l) => l.includes('%%'))!.trim()}`, async () => {
      const chart = `flowchart TD\n  ${text}\n`;
      await mermaid.parse(chart); // Mermaid reads it
      expect(await check(chart)).toEqual([]);
    });
  }

  test('D11: in a title in brackets over two lines: only the lines Naiad does not edit are named', async () => {
    const chart = 'flowchart TD\n  A[first\nsecond %% third]\n  A --> B\n';
    await mermaid.parse(chart);
    expect(brief(await check(chart))).toEqual(['2 unreadable-line', '3 unreadable-line']);
  });

  test('a comment after a statement is still named, after a title in brackets over two lines too', async () => {
    expect(brief(await check('flowchart TD\n  subgraph "x" %% c\n    A\n  end\n'))).toEqual(['2 comment-after-statement']);
    expect(brief(await check('flowchart TD\n  click A "u" %% c\n  A\n'))).toEqual(['2 comment-after-statement']);
    expect(brief(await check('flowchart TD\n  A[first\nsecond]\n  A --> B %% c\n'))).toEqual(['2 unreadable-line', '3 unreadable-line', '4 comment-after-statement']);
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

  // Mermaid reads the front matter before it drops comment lines, and takes a directive
  // out before that: a "%%" line in the front matter is YAML, and "%%%%{init}%%" leaves a
  // bare "%%" (bug hunt round 3, D17, D19).
  const unseen: [string, string, number, RegExp][] = [
    ['D17: a "%%" line first in the front matter', '---\n%% a comment\ntitle: T\n---\nflowchart TD\n  A --> B\n', 2, /front matter.*"# note"/],
    ['D17: a "%%" line further down the front matter', '---\ntitle: T\n%% a comment\n---\nflowchart TD\n  A --> B\n', 3, /front matter.*"# note"/],
    ['D19: "%%" before a directive above the header', '%%%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B\n', 1, /"%%" before "%%\{"/],
    ['D29: a bare "%%" line in the front matter', '---\n%%\n---\nflowchart TD\nA-->B\n', 2, /front matter.*"# note"/],
    ['D29: a bare "%%" line further down the front matter', '---\ntitle: T\n%%\n---\nflowchart TD\nA-->B\n', 3, /front matter.*"# note"/],
  ];
  for (const [name, text, line, message] of unseen) {
    test(name, async () => {
      const found = (await check(text)).filter((f) => f.rule === 'mermaid');
      expect(found.map((f) => f.line)).toEqual([line]);
      expect(found[0].message).toMatch(message);
    });
  }

  test('D17: "%%" lines Mermaid reads in front matter, and a directive in a comment line, are no problem', async () => {
    expect(await check('---\ntitle: |\n  %% @a\n  %% x\n---\nflowchart TD\n  A --> B\n')).toEqual([]);
    expect(await check('---\ntitle: T\n  %% indented\n---\nflowchart TD\n  A --> B\n')).toEqual([]);
    expect(await check('flowchart TD\n  A --> B\n  %% note %%{init: {"theme": "dark"}}%%\n')).toEqual([]);
  });

  test('D29: Mermaid is given the front matter as it stands, a bare "%%" line in it too', () => {
    expect(forMermaid('---\n%%\n---\nflowchart TD\n%%\nA\n')).toBe('---\n%%\n---\nflowchart TD\n\nA\n');
    expect(forMermaid('---\ntitle: T\n  %%\n---\nflowchart TD\n')).toBe('---\ntitle: T\n  %%\n---\nflowchart TD\n');
  });

  // Mermaid ends a line at LF, CR or CRLF; with the m flag "$" also stops before U+2028
  // and U+2029, so "%%" was taken apart from the rest of its line (bug hunt round 4, A37).
  test('A37: a "%%" line with U+2028 or U+2029 in it stays one comment', async () => {
    for (const sep of [' ', ' ']) {
      const text = `flowchart TD\n%%${sep}a --> b\nc\n`;
      expect(forMermaid(text)).toBe(text);
      const snap = await snapshot(text);
      expect(Object.keys(snap.nodes)).toEqual(['c']);
      expect(snap.edges).toEqual([]);
    }
    expect(forMermaid('flowchart TD\nx %%\nA\n')).toBe('flowchart TD\nx %%\nA\n');
    // A bare "%%" line ended by LF, CR or CRLF, or by the end of the text, is still blanked.
    expect(forMermaid('flowchart TD\n%%\r\n  %% \rA\n%%')).toBe('flowchart TD\n\r\n\rA\n');
  });

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

describe('a long line Mermaid rejects is checked in good time (bug hunt round 3, D18)', () => {
  // D's three files: a line of 8,000 brackets in three patterns.
  const lines: Record<string, string> = {
    parens: 'C' + '('.repeat(8000),
    'brackets and letters': 'C[x' + '(a'.repeat(8000),
    'two kinds of bracket': 'C' + '[('.repeat(8000) + 'x',
    'a label': 'A --' + '('.repeat(8000) + ' B',
  };
  for (const [name, line] of Object.entries(lines)) {
    test(`${name}: under 2 s`, async () => {
      const start = performance.now();
      const found = await check(`flowchart TD\n  A --> B\n  ${line}\n`);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(brief(found)).toContain('3 mermaid');
    }, 30_000);
  }

  test('the hint for a title in brackets is given for the same lines as before', () => {
    // The two patterns signsUnquoted replaces, which take minutes on a long line.
    const before = (s: string) => /[\[({][^"\])}]*[()\[\]{}|][^"]*[\])}]/.test(s) || /--[^->|]*[\[\](){}][^->]*--?>/.test(s);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const signs = '([{)]}|"->x -';
    let matched = 0;
    for (let n = 0; n < 100_000; n++) {
      const s = Array.from({ length: Math.floor(random() * 14) }, () => signs[Math.floor(random() * signs.length)]).join('');
      expect(signsUnquoted(s), JSON.stringify(s)).toBe(before(s));
      if (before(s)) matched++;
    }
    expect(matched).toBeGreaterThan(10_000);
  });
});

describe('a flowchart past Mermaid\'s 50,000-character limit (bug hunt round 3, D20)', () => {
  // Past its limit Mermaid draws only "Maximum text size in diagram exceeded". jsdom has
  // no layout, so the drawing gets a fixed size for each text.
  beforeAll(() => {
    (globalThis as any).SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 50, height: 20 });
  });
  const drawn = async (text: string): Promise<boolean> => {
    const { svg } = await mermaid.render(`size${Math.random().toString(36).slice(2)}`, forMermaid(text));
    return !/Maximum text size/.test(svg);
  };
  const limit = (fs: Finding[]) => fs.filter((f) => f.rule === 'mermaid' && /50,000/.test(f.message));

  test('one long title, and many nodes, are reported on the header line', async () => {
    const title = await check('flowchart TD\n  A["' + 'x'.repeat(60000) + '"] --> B\n');
    expect(brief(title)).toEqual(['1 mermaid']);
    expect(title[0].message).toMatch(/60,0\d\d characters .*limit of 50,000/);
    const nodes = Array.from({ length: 1200 }, (_, i) => `  N${i}["Step ${i}: a node with a longer title"] --> N${i + 1}`);
    expect(brief(limit(await check(['%% a note', 'flowchart LR', ...nodes, ''].join('\n'))))).toEqual(['2 mermaid']);
  }, 30_000);

  test('comments and descriptions do not count', async () => {
    const description = Array.from({ length: 1000 }, (_, i) => `%% Line ${i} of a long description, which Mermaid never reads.`);
    expect(await check(['flowchart TD', '  A --> B', '', '%% @A', ...description, ''].join('\n'))).toEqual([]);
  });

  // Each shape at the length Mermaid still draws, and one character past it.
  const shapes: Record<string, (pad: string) => string> = {
    plain: (p) => `flowchart TD\n  A["${p}"] --> B\n`,
    'front matter': (p) => `---\ntitle: A title\nconfig:\n  theme: dark\n---\n\nflowchart TD\n  A["${p}"]\n`,
    // An indented `---` in a YAML text ends nothing (bug hunt round 4, D30).
    'front matter with "---" in a YAML text': (p) => `---\ntitle: |\n  ---\n  ${'y'.repeat(2000)}\n---\nflowchart TD\n  A["${p}"]\n`,
    directives: (p) => `%%{init: {"theme": "dark"}}%%\n\n%%{\n  init: {"flowchart": {"curve": "basis"}}\n}%%\nflowchart TD\n  A["${p}"]\n`,
    comments: (p) => `%% above\n\n\nflowchart TD\n\n\n  %% a note\n  A["${p}"]\n\n%% @A\n%% A description.\n%% .\n%% More.\n\n  A --> B\n`,
    'trailing blank lines': (p) => `\n\nflowchart TD\n  A["${p}"]\n\n\n\n`,
  };
  for (const [name, shape] of Object.entries(shapes)) {
    test(`${name}: reported exactly when Mermaid does not draw it`, async () => {
      const pad = 'x'.repeat(50_000 - mermaidLength(shape('')));
      expect(mermaidLength(shape(pad))).toBe(50_000);
      expect(await drawn(shape(pad))).toBe(true);
      expect(limit(await check(shape(pad)))).toEqual([]);
      expect(await drawn(shape(pad + 'x'))).toBe(false);
      expect(limit(await check(shape(pad + 'x')))).toHaveLength(1);
    }, 30_000);
  }
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

  test('a comment after a title holding "%%", and after "end"', async () => {
    const found = await check('flowchart TD\n  A["a %% b"] %% c\n  A --> B["x %% y"] %% z\n  D[Title with (parens)] --> B\n');
    expect(brief(found)).toEqual(['2 comment-after-statement', '3 comment-after-statement', '4 mermaid']);
    expect(brief(await check('flowchart TD\n  subgraph S\n    A\n  end %% c\n'))).toContain('4 comment-after-statement');
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

  // Half a character pair (a lone surrogate) cannot cross to the desktop shell: the
  // program printed nothing and ended at its 60-second limit (bug hunt round 2, D13).
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const pre = 'A --> B %% ';
  const emojiLine = pre + 'x'.repeat(117 - 1 - pre.length) + '\u{1F600}' + 'tail tail tail tail';

  test('D13: a long line is cut between characters, never inside an emoji', async () => {
    const text = 'flowchart TD\n  ' + emojiLine + '\n';
    const out = formatReport('emoji.mmd', text, await checkFile('emoji.mmd', text, reading));
    expect(out).not.toMatch(LONE);
    const shown = out.split('\n').find((l) => l.startsWith('    '))!;
    expect(Array.from(shown.trim())).toHaveLength(120);
    expect(shown).toContain('\u{1F600}');
  });

  test('D13: fix of a file holding such a line reports what it wrote, in whole characters', async () => {
    let disk = 'flowchart TD\n  ' + emojiLine + '\n%%\n';
    let writes = 0;
    const backend = {
      read: async () => disk,
      write: async (_p: string, text: string) => { disk = text; writes++; return true; },
    } as unknown as Backend;
    const { output } = await runCli({ mode: 'fix', files: [{ name: 'emoji.mmd', path: 'C:/x/emoji.mmd' }] }, backend);
    expect(writes).toBe(1);
    expect(output).toMatch(/emoji\.mmd: fixed line 3/);
    expect(output).not.toMatch(LONE);
  });

  test('wellFormed replaces only a lone half of a pair', () => {
    expect(wellFormed('a\ud83d b \ude00 \u{1F600}')).toBe('a\ufffd b \ufffd \u{1F600}');
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
    // Beside a "%% ." line already there, each fixed line keeps its own ending (bug hunt
    // round 4, D28), and a second fix changes nothing.
    const beside = await fixFile('flow.mmd', 'flowchart TD\r\n%%\n%% .\r%%\r\nA-->B\n', reading);
    expect(beside.raw).toBe('flowchart TD\r\n%% .\n%% .\r%% .\r\nA-->B\n');
    expect((await fixFile('flow.mmd', beside.raw, reading)).raw).toBe(beside.raw);
  });

  test('leaves a "%%" line inside a quoted title that runs over several lines (bug hunt S3)', async () => {
    for (const text of [
      'flowchart TD\n  A["line1\n%%\nline2"] --> B\n',
      'flowchart TD\n  A["multi\n  %%\n  line"] --> B\n%% @A\n%% one\n%%\n%% two\n',
    ]) {
      const fixed = await fixFile('flow.mmd', text, reading);
      const inside = text.split('\n').findIndex((l) => l.trim() === '%%') + 1;
      expect(fixed.lines).not.toContain(inside);
      expect(fixed.raw.split('\n')[inside - 1]).toBe(text.split('\n')[inside - 1]);
      expect(brief(await check(text))).not.toContain(`${inside} bare-comment`);
    }
  });

  test('leaves a "%%" line inside front matter (bug hunt S4)', async () => {
    const text = '---\ntitle: |\n  one\n%%\n---\nflowchart TD\n  A --> B\n';
    const fixed = await fixFile('flow.mmd', text, reading);
    expect(fixed.raw).toBe(text);
    expect(fixed.lines).toEqual([]);
    const md = '---\ntitle: x\ndesc: |\n  ```mermaid\n  flowchart TD\n  %%\n  ```\n---\n\n```mermaid\nflowchart TD\n  A --> B\n%%\n```\n';
    const inMd = await fixFile('doc.md', md, reading);
    expect(inMd.raw).toBe(md.replace('%%\n```', '%% .\n```'));
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
