// @vitest-environment jsdom
// The skill (skills/naiad) against the checker and FILE-FORMAT.md: the starter template
// and every example in the skill pass the check, and what the skill repeats from
// FILE-FORMAT.md and README.md is the same text there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { checkFile, checkFlowchart } from '../src/core/check';
import { parseDescriptions } from '../src/core/descriptions';
import { reading } from '../src/semantics';

const file = (path: string): string => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');
const skill = file('skills/naiad/SKILL.md');
const template = file('skills/naiad/template.mmd');
const format = file('FILE-FORMAT.md');
const readme = file('README.md');

/** The text between a heading and the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.replace(/^#+\s*/, '') === heading && l.startsWith('#'));
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const level = lines[start].match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#+\s/.test(l) && l.match(/^#+/)![0].length <= level);
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

describe('the starter template', () => {
  test('passes the check', async () => {
    expect((await checkFile('template.mmd', template, reading)).findings).toEqual([]);
  });

  test('is two nodes, one arrow and one description with an empty-line marker', async () => {
    expect((await reading(template)).ids.sort()).toEqual(['first', 'second']);
    expect(template.match(/-->/g)).toHaveLength(1);
    const blocks = parseDescriptions(template.split('\n'));
    expect(blocks.map((b) => b.id)).toEqual(['first']);
    expect(template.split('\n')).toContain('%% .');
  });
});

describe('the examples in the skill', () => {
  test('every Mermaid example passes the flowchart check', async () => {
    const examples = [...skill.matchAll(/^```mermaid\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
    expect(examples).toHaveLength(1);
    for (const example of examples) expect(await checkFlowchart(example, reading)).toEqual([]);
  });
});

describe('what the skill repeats from other files', () => {
  test('the forms that can be changed from the chart are those of FILE-FORMAT.md', () => {
    const inSkill = codeSpans(section(skill, 'Forms the user can change from the chart'));
    const inFormat = new Set(codeSpans(section(format, 'Mermaid syntax Naiad can edit from the chart')));
    expect(inSkill.length).toBeGreaterThan(30);
    expect(inSkill.filter((s) => !inFormat.has(s))).toEqual([]);
  });

  test('the section for the instruction file is the same in the README', () => {
    const snippet = (doc: string): string => doc.match(/^## Naiad flowcharts\n(?:.+\n){2}/m)![0];
    expect(snippet(skill)).toBe(snippet(readme));
    expect(snippet(skill)).toContain('following the naiad skill');
  });

  test('the commands and the install folder are those of FILE-FORMAT.md', () => {
    for (const text of ['naiad check flow.mmd', 'naiad fix flow.mmd', '%LOCALAPPDATA%\\Naiad\\bin\\naiad.exe']) {
      expect(skill).toContain(text);
      expect(format).toContain(text);
    }
  });

  test('the rules for quoted titles, the id "end" and one-line paragraphs are in both', () => {
    const flat = (doc: string): string => doc.replace(/\s+/g, ' ');
    for (const text of ['id{"Sure (really)?"}', 'Other punctuation needs no quotes.', 'The word `end` in lower case cannot be']) {
      expect(flat(skill)).toContain(text);
      expect(flat(format)).toContain(text);
    }
    expect(flat(skill)).toContain('write a paragraph as one line');
    expect(flat(format)).toContain('a paragraph is written as one line');
  });

  test('the two ways of showing a file are in the skill and the README', () => {
    const flat = (doc: string): string => doc.replace(/\s+/g, ' ');
    for (const text of ['naiad serve flow.mmd', 'naiad flow.mmd', 'http://127.0.0.1:', 'ten minutes after the page is closed']) {
      expect(flat(section(skill, '4. Show'))).toContain(text);
      expect(flat(readme)).toContain(text);
    }
  });

  test('the skill says to check that the page draws the chart, and what to do in a sandbox', () => {
    const flat = (doc: string): string => doc.replace(/\s+/g, ' ');
    for (const text of ['Check that the pane draws the chart', 'is not proof', 'outside the sandbox']) {
      expect(flat(section(skill, '4. Show'))).toContain(text);
    }
  });

  test('the highlights file is the same in the skill and FILE-FORMAT.md', () => {
    for (const text of ['.naiad/flow.mmd/highlights.txt', '\ncollect\nclean\ncollect --> clean\n```']) {
      expect(skill).toContain(text);
      expect(format).toContain(text);
    }
  });

  test('the skill names one place to install Naiad from', () => {
    // The address of this computer itself, in the showing step, is not a place to install from.
    const links = [...skill.matchAll(/https?:\/\/[^\s>)`]+/g)].map((m) => m[0])
      .filter((link) => !link.startsWith('http://127.0.0.1'));
    expect(links).toEqual(['https://github.com/Cleo8731/naiad/releases']);
  });
});
