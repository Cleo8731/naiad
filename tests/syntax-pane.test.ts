// @vitest-environment jsdom
// The Syntax pane's colours, line numbers, wrapping and full-window button (the user,
// 2026-11-25). The text area stays the one place the text is typed; a coloured copy of
// its text is drawn under it, so the copy must hold exactly the text, every time the
// text changes, and colouring must never add, drop or move a character.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colourLines, colouredHtml, type Kind } from '../src/syntax-colours';
import { fixtures, sample } from './fixtures';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

/** The pieces of one line as "kind:text", plain pieces left out. */
const kinds = (line: string) => colourLines(line)[0].filter((p) => p.kind !== 'plain').map((p) => `${p.kind}:${p.text}`);

describe('colouring a line', () => {
  it('keeps every character of every line of the sample and the fixtures, in order', () => {
    const texts = [sample, ...Object.values(fixtures), readFileSync('skills/naiad/template.mmd', 'utf8')];
    for (const text of texts) {
      const lines = colourLines(text);
      expect(lines.map((pieces) => pieces.map((p) => p.text).join('')).join('\n')).toBe(text);
    }
  });

  it('colours the header, nodes, titles and arrows', () => {
    expect(kinds('flowchart TD')).toEqual(['keyword:flowchart', 'direction:TD']);
    expect(kinds('    order(Order placed) --> pay{Payment OK?}')).toEqual([
      'id:order', 'bracket:(', 'title:Order placed', 'bracket:)', 'arrow:-->', 'id:pay', 'bracket:{', 'title:Payment OK?', 'bracket:}',
    ]);
    expect(kinds('a-->b')).toEqual(['id:a', 'arrow:-->', 'id:b']);
    expect(kinds('    pay -- yes --> pack')).toEqual(['id:pay', 'arrow:--', 'label:yes', 'arrow:-->', 'id:pack']);
    expect(kinds('    a -->|no| b')).toEqual(['id:a', 'arrow:-->|', 'label:no', 'arrow:|', 'id:b']);
    expect(kinds('    a[("Sure (really)?")]')).toEqual(['id:a', 'bracket:[(', 'title:"Sure (really)?"', 'bracket:)]']);
    expect(kinds('    a -.-> b ==> c')).toEqual(['id:a', 'arrow:-.->', 'id:b', 'arrow:==>', 'id:c']);
  });

  it('colours groups, classes and styles', () => {
    expect(kinds('    subgraph prep [Preparation]')).toEqual(['keyword:subgraph', 'id:prep', 'bracket:[', 'title:Preparation', 'bracket:]']);
    expect(kinds('    end')).toEqual(['keyword:end']);
    expect(kinds('    classDef warm fill:#fde,stroke:#c44')).toEqual([
      'keyword:classDef', 'class:warm', 'prop:fill', 'bracket::', 'value:#fde', 'prop:stroke', 'bracket::', 'value:#c44',
    ]);
    expect(kinds('    a:::warm')).toEqual(['id:a', 'bracket::::', 'class:warm']);
  });

  it('tells a description from other comments', () => {
    const lines = colourLines('flowchart TD\n%% a note\n    a\n%% @a\n%% What a does.\n%% .\n\n%% a note again').map((pieces) => pieces.map((p) => p.kind));
    const has = (i: number, kind: Kind) => lines[i].includes(kind);
    expect(has(1, 'desc')).toBe(false); // a comment before any description
    expect(lines[3]).toEqual(['comment', 'plain', 'mark']);
    expect(has(4, 'desc') && has(5, 'desc')).toBe(true);
    expect(has(7, 'desc')).toBe(false); // after a blank line the description has ended
  });

  it('escapes the text it draws', () => {
    expect(colouredHtml('a["<b>&"]')).toBe('<div class="ln"><span class="s-id">a</span><span class="s-bracket">[</span><span class="s-title">&quot;&lt;b&gt;&amp;&quot;</span><span class="s-bracket">]</span></div>');
  });
});

describe('the pane', () => {
  const FILE = 'C:/syntax/flow.mmd';
  const TEXT = 'flowchart TD\n    a(First) --> b(Second)\n\n%% @a\n%% What happens first.\n';
  let disk: FakeDisk;
  const copy = () => document.querySelector<HTMLElement>('.textpane .code:not([hidden]) .code-copy')!;
  const copied = () => [...copy().children].map((ln) => ln.textContent).join('\n');
  const button = () => document.querySelector<HTMLButtonElement>('[data-act="syntax-full"]')!;
  const pane = () => document.querySelector<HTMLElement>('.textpane')!;

  beforeEach(() => { localStorage.clear(); disk = new FakeDisk(); disk.files.set(FILE, TEXT); });
  afterEach(() => { stopApps(); localStorage.clear(); });

  it('draws the text, one numbered line each, and follows typing, edits and the file', async () => {
    const ui = await startApp(disk, FILE);
    expect(copied()).toBe(TEXT);
    expect(copy().children).toHaveLength(TEXT.split('\n').length); // one line number each
    expect(ui.area().getAttribute('wrap')).toBeNull(); // long lines wrap
    ui.type(TEXT + '    b --> c(Third)\n');
    expect(copied()).toBe(ui.area().value);
    ui.direction('LR');
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
    expect(copied()).toBe(ui.area().value);
    disk.outside(FILE, TEXT.replace('First', 'Start'));
    expect(await ui.until((t) => t.includes('Start'))).toBe(true);
    expect(copied()).toBe(ui.area().value);
  });

  it('fills the window and goes back with its button, and hiding the pane ends it', async () => {
    await startApp(disk, FILE);
    document.querySelector<HTMLButtonElement>('[data-act="syntax"]')!.click();
    if (pane().hidden) document.querySelector<HTMLButtonElement>('[data-act="syntax"]')!.click();
    expect(pane().hidden).toBe(false);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    button().click();
    expect(pane().classList.contains('full')).toBe(true);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().title).toBe('Show the chart again');
    button().click();
    expect(pane().classList.contains('full')).toBe(false);
    button().click();
    document.querySelector<HTMLButtonElement>('[data-act="syntax"]')!.click(); // hides the pane
    expect(pane().hidden).toBe(true);
    expect(pane().classList.contains('full')).toBe(false);
    await sleep(0);
  });

  it('covers the chart and the sidebar while it fills the window', () => {
    const css = readFileSync('src/style.css', 'utf8');
    expect(css).toMatch(/\.textpane\.full \{ position: absolute; inset: 0;/);
    expect(css).toMatch(/\.body\.split > \.textpane\.full \{ grid-area: auto; \}/);
    // The copy and the text area wrap the same way, with the same font and padding.
    expect(css).toMatch(/\.code-copy, \.code textarea \{[^}]*white-space: pre-wrap;/);
  });
});
