// The checker: where a file breaks the Naiad file format (FILE-FORMAT.md), with the line
// and the way to put it right. No browser code and no Mermaid import here: whoever runs
// it hands in a reader, which is Mermaid's own parser (src/cli.ts in the app).

import { parseDescriptions } from './descriptions';
import { plainText, withEndingsOf } from './endings';
import { findBlocks, isMarkdownPath } from './markdown';
import { parseDoc, usedIds } from './scan';

export type Rule =
  | 'mermaid' | 'comment-after-statement' | 'bare-comment' | 'unreadable-line'
  | 'description-without-node' | 'second-description' | 'markdown';

export interface Finding {
  /** Line in the file, counted from 1. */
  line: number;
  rule: Rule;
  message: string;
  /** `naiad fix` can put it right without changing what the flowchart means. */
  fixable: boolean;
}

/** What Mermaid makes of a flowchart: the ids it found, and a string that is the same
 *  for two texts exactly when they mean the same chart. */
export interface Reading { ids: string[]; shape: string }

/** Mermaid's parser. Throws, with Mermaid's message, when it rejects the text. */
export type Reader = (flowchartText: string) => Promise<Reading>;

export interface Report {
  findings: Finding[];
  /** Flowcharts looked at: 1 for a flowchart file, the number of flowchart blocks in a Markdown file. */
  charts: number;
}

const COMMENT_LINE = /^[ \t]*%%(?!\{)/;
const BARE_COMMENT = /^([ \t]*)%%[ \t]*$/;

const DIRECTIVE_LINE = /^[ \t]*%%\{/;
/** A comment that follows something else on its line. */
const TRAILING_COMMENT = /^([ \t]*\S.*?)[ \t]*%%.*$/;

/** The text as Mermaid is given it: every comment line emptied, so that the line
 *  numbers in Mermaid's messages can be turned back into lines of the file; and a
 *  comment after a statement cut off (it is reported by itself), so that Mermaid goes
 *  on to judge the lines below it. */
function forReading(lines: string[]): string {
  return lines
    .map((l) => {
      if (COMMENT_LINE.test(l)) return '';
      if (DIRECTIVE_LINE.test(l)) return l;
      return TRAILING_COMMENT.exec(l)?.[1] ?? l;
    })
    .join('\n');
}

/** Mermaid drops what stands above the first line of the flowchart (frontmatter, empty
 *  lines) before it counts lines. This is how many lines that is. */
function linesAbove(lines: string[]): number {
  let i = 0;
  const blank = (l: string) => l.trim() === '' || COMMENT_LINE.test(l);
  while (i < lines.length && blank(lines[i])) i++;
  if (i < lines.length && lines[i].trim() === '---') {
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j < lines.length) {
      i = j + 1;
      while (i < lines.length && blank(lines[i])) i++;
    }
  }
  return i;
}

/** A hint for the commonest reasons Mermaid stops at a line. */
function hint(line: string): string {
  const s = line.trim();
  if (/(^|[\s;&])end([\s;&\[({>-]|$)/.test(s) && !/^end\s*$/.test(s)) {
    return ' The word "end" closes a group, so it cannot be a node id in lower case: use another id.';
  }
  if (/^(style|classDef|linkStyle)\b.*,\s*$/.test(s)) return ' The style list ends with a comma: take it off.';
  // A title with brackets, quotes or a bar inside it and no double quotes around it.
  if (/[\[({][^"\])}]*[()\[\]{}|][^"]*[\])}]/.test(s) || /--[^->|]*[\[\](){}][^->]*--?>/.test(s)) {
    return ' A title or label that holds brackets or other signs goes in double quotes: id["Title (with brackets)"].';
  }
  return '';
}

/** Checks one flowchart. Lines are counted from 1 within `text`. */
export async function checkFlowchart(text: string, read: Reader): Promise<Finding[]> {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const doc = parseDoc(lines.join('\n'));
  const findings: Finding[] = [];
  const add = (index: number, rule: Rule, message: string, fixable = false) => {
    findings.push({ line: index + 1, rule, message, fixable });
  };

  // A comment that follows something else on its line.
  const trailing = new Set<number>();
  lines.forEach((l, i) => {
    if (COMMENT_LINE.test(l) || DIRECTIVE_LINE.test(l)) return;
    if (TRAILING_COMMENT.test(l)) {
      trailing.add(i);
      add(i, 'comment-after-statement', 'A comment must have its line to itself: Mermaid has no comment after a statement. Move the "%%" part to a line of its own.');
    }
  });

  // Mermaid's own verdict.
  let ids: Set<string> | null = null;
  try {
    ids = new Set((await read(forReading(lines))).ids);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const at = /Parse error on line (\d+)/.exec(message);
    if (at) {
      const index = Math.min(lines.length - 1, Number(at[1]) - 1 + linesAbove(lines));
      let last = lines.length - 1;
      while (last > 0 && (lines[last].trim() === '' || COMMENT_LINE.test(lines[last]))) last--;
      if (trailing.has(index)) {
        // Already reported as a comment after a statement.
      } else if (index > last) {
        // Mermaid read to the end still waiting for something to close.
        add(last, 'mermaid', 'Mermaid reaches the end of the flowchart with something still open: a bracket, a quote or a group. Look for the line where it opens; it may be above this one.');
      } else {
        add(index, 'mermaid', `Mermaid cannot read the flowchart from this line on.${hint(lines[index])}`);
      }
    } else if (/No diagram type detected/.test(message)) {
      add(Math.max(0, doc.header), 'mermaid', 'Mermaid finds no diagram here: the first line of a flowchart is "flowchart TD" (or LR, BT, RL).');
    } else {
      add(Math.max(0, doc.header), 'mermaid', `Mermaid rejects the flowchart: ${message.split('\n')[0]}`);
    }
  }

  for (const w of doc.warnings) {
    add(w.line, 'bare-comment', 'A line holding only "%%" is not a comment to Mermaid, which draws it as a node. For an empty line inside a description write "%% ."; otherwise delete the line.', true);
  }
  const taken = new Set(findings.map((f) => f.line));
  for (const p of doc.problems) {
    if (taken.has(p.line + 1)) continue;
    add(p.line, 'unreadable-line', `${p.message} Naiad shows the chart but refuses chart edits while this line stands: write it in a plainer form (one statement to a line).`);
  }

  // Description blocks. When Mermaid rejected the text, the ids come from the scanner.
  const known = ids ?? new Set([...usedIds(doc), ...doc.subs.map((s) => s.id)]);
  const seen = new Map<string, number>();
  for (const b of parseDescriptions(lines)) {
    const first = seen.get(b.id);
    if (first !== undefined) {
      add(b.start, 'second-description', `A second description block for "${b.id}" (the first is on line ${first + 1}); only the first is shown. Join the two into one block.`);
      continue;
    }
    seen.set(b.id, b.start);
    if (!known.has(b.id)) {
      add(b.start, 'description-without-node', `This description block names "${b.id}", and the flowchart has no node with that id, so it is shown nowhere. The line after "%% @" is a node's id exactly as written in the flowchart, not its title.`);
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** Checks a file: a flowchart file, or every flowchart block of a Markdown file. */
export async function checkFile(name: string, raw: string, read: Reader): Promise<Report> {
  const text = (raw.startsWith('﻿') ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
  if (!isMarkdownPath(name)) return { findings: await checkFlowchart(text, read), charts: 1 };

  const blocks = findBlocks(text).filter((b) => b.flowchart);
  if (!blocks.length) {
    return {
      charts: 0,
      findings: [{ line: 1, rule: 'markdown', fixable: false, message: 'This Markdown file holds no Mermaid flowchart block: a fenced block that opens with ```mermaid and whose first line is "flowchart TD".' }],
    };
  }
  const findings: Finding[] = [];
  for (const b of blocks) {
    if (b.locked) {
      findings.push({ line: b.open + 1, rule: 'markdown', fixable: false, message: `Naiad shows this flowchart block but cannot change it: ${b.locked}` });
    }
    // Line 1 of the block's text is the line after the opening fence.
    for (const f of await checkFlowchart(b.text, read)) findings.push({ ...f, line: f.line + b.open + 1 });
  }
  return { findings: findings.sort((a, b) => a.line - b.line), charts: blocks.length };
}

export interface Fixed {
  /** The file's new contents; equal to what was given when nothing was fixed. */
  raw: string;
  /** Lines changed, counted from 1. */
  lines: number[];
  /** Why nothing was changed, when a fix was possible but not safe. */
  refused: string | null;
}

/**
 * Puts right what cannot change the flowchart's meaning: a line holding only "%%"
 * becomes "%% ." (the empty-line marker). Each line is replaced in place; no other
 * byte of the file changes. Refuses when Mermaid reads a flowchart differently after.
 */
export async function fixFile(name: string, raw: string, read: Reader): Promise<Fixed> {
  const lines = plainText(raw).split('\n');
  const text = lines.join('\n');
  const none: Fixed = { raw, lines: [], refused: null };

  // The bare "%%" lines, as indexes into `lines`: those the scanner reads as comment
  // lines, so never a line of front matter or of a quoted text that runs over lines.
  const bare = (chart: string, first: number) => parseDoc(chart).warnings.map((w) => first + w.line);
  let targets: number[];
  if (isMarkdownPath(name)) {
    const blocks = findBlocks(text).filter((b) => b.flowchart);
    if (blocks.some((b) => b.locked)) {
      const fixable = blocks.some((b) => bare(b.text, 0).length > 0);
      return fixable ? { ...none, refused: 'a flowchart block in this file is one Naiad does not change (see the check).' } : none;
    }
    // Line 0 of a block's text is the line after its opening fence.
    targets = blocks.flatMap((b) => bare(b.text, b.open + 1));
  } else {
    targets = bare(text, 0);
  }

  const out = [...lines];
  const changed: number[] = [];
  for (const i of targets) {
    const m = BARE_COMMENT.exec(lines[i]);
    if (!m) continue;
    out[i] = `${m[1]}%% .`;
    changed.push(i + 1);
  }
  if (!changed.length) return none;

  // The check: every flowchart must mean the same to Mermaid before and after.
  const chartsOf = (all: string[]): string[] =>
    isMarkdownPath(name) ? findBlocks(all.join('\n')).filter((b) => b.flowchart).map((b) => b.text) : [all.join('\n')];
  const before = chartsOf(lines);
  const after = chartsOf(out);
  if (before.length !== after.length) return { ...none, refused: 'the fix would have changed the Mermaid blocks of the file.' };
  for (let k = 0; k < before.length; k++) {
    let a: Reading;
    let b: Reading;
    try {
      a = await read(forReading(before[k].split('\n')));
      b = await read(forReading(after[k].split('\n')));
    } catch {
      return { ...none, refused: 'Mermaid cannot read the flowchart, so nothing was changed. Put the other problems right first.' };
    }
    if (a.shape !== b.shape) return { ...none, refused: 'the fix would have changed what the flowchart means.' };
    const descriptions = (t: string) => JSON.stringify(parseDescriptions(t.split('\n')).map((d) => [d.id, d.text]));
    if (descriptions(before[k]) !== descriptions(after[k])) return { ...none, refused: 'the fix would have changed a description.' };
  }
  // Each line keeps its own line ending; the changed lines keep theirs too.
  return { raw: withEndingsOf(raw, out.join('\n')), lines: changed, refused: null };
}

const count = (n: number): string => (n === 1 ? '1 problem' : `${n} problems`);

/** The printed result of a check, ending with the count. */
export function formatReport(name: string, raw: string, report: Report): string {
  const lines = (raw.startsWith('﻿') ? raw.slice(1) : raw).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const f of report.findings) {
    out.push(`${name}:${f.line}: ${f.message}${f.fixable ? ' ("naiad fix" does this.)' : ''}`);
    const shown = (lines[f.line - 1] ?? '').trim();
    if (shown) out.push(`    ${shown.length > 120 ? `${shown.slice(0, 117)}...` : shown}`);
  }
  out.push(report.findings.length ? `${name}: ${count(report.findings.length)}` : `${name}: no problems`);
  return out.join('\n');
}
