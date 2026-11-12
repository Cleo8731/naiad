// The checker: where a file breaks the Naiad file format (FILE-FORMAT.md), with the line
// and the way to put it right. No browser code and no Mermaid import here: whoever runs
// it hands in a reader, which is Mermaid's own parser (src/cli.ts in the app).

import { parseDescriptions } from './descriptions';
import { plainText, withEndingsOf } from './endings';
import { findBlocks, isMarkdownPath } from './markdown';
import { parseDoc, usedIds, type LineKind } from './scan';

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
export interface Reading {
  ids: string[];
  shape: string;
  /** The accessible title and description, the same for two texts exactly when Mermaid
   *  reads the same ones. */
  acc?: string;
}

/**
 * Mermaid's parser. Throws, with Mermaid's message, when it rejects the text. With
 * `asIs`, the text goes to Mermaid as it stands; otherwise the bare "%%" lines the scanner
 * warns about are blanked first (`forMermaid`).
 */
export type Reader = (flowchartText: string, asIs?: boolean) => Promise<Reading>;

export interface Report {
  findings: Finding[];
  /** Flowcharts looked at: 1 for a flowchart file, the number of flowchart blocks in a Markdown file. */
  charts: number;
}

/** A line Mermaid drops as a comment: "%%" and at least one more character, not "%%{". */
const COMMENT_LINE = /^\s*%%(?!\{)./;
const BARE_COMMENT = /^([ \t]*)%%[ \t]*$/;

/**
 * Lines that never hold a statement, so a "%%" in them never starts a comment. An
 * accessible title or description (`acc`) is text Mermaid reads without error with a
 * "%%" in it (bug hunt round 6, D34); a "%%" after an `accDescr { ... }` closed on its
 * line breaks Mermaid's reading, which the check reports as Mermaid's own error.
 */
const NO_STATEMENT = new Set<LineKind>(['comment', 'directive', 'frontmatter', 'string', 'acc']);

/**
 * The comments after a statement: for each line holding one, where its "%%" stands.
 * Mermaid has no such comment. It reads a "%%" in the middle of a line as text, which
 * belongs in a title or a label (`A["50%% off"]`, `A -->|50%% off| B`) and breaks a
 * statement anywhere else. So a comment starts at the first "%%" whose text before it
 * is a whole line the scanner can read (a statement, the header, a group's first or
 * last line, a style...); before a "%%" inside a title stands a text still open (bug
 * hunt D2): a quote still open (a link or tooltip of `click`, a group's title), or a
 * group's `[` title not yet closed (bug hunt round 2, D11). Front matter, a directive,
 * a quoted text over several lines and the lines of a title in brackets that runs over
 * several lines (D11) hold none.
 */
function commentsAfter(lines: string[]): Map<number, number> {
  const info = parseDoc(lines.join('\n')).info;
  const found = new Map<number, number>();
  let open = 0; // brackets an unreadable line above left open: the lines below are its title
  lines.forEach((l, i) => {
    if (open > 0) {
      open = Math.max(0, open + brackets(l));
      return;
    }
    if (NO_STATEMENT.has(info[i].kind)) return;
    if (info[i].kind === 'opaque') open = Math.max(0, brackets(l));
    for (let at = l.indexOf('%%'); at >= 0; at = l.indexOf('%%', at + 1)) {
      const before = l.slice(0, at).trim();
      if (!before || quotes(before) % 2 === 1) continue;
      const kind = /^end\s*;?$/.test(before) ? 'end' : parseDoc(before).info[0].kind;
      if (kind === 'opaque' || (kind === 'subgraph' && brackets(before) > 0)) continue;
      found.set(i, at);
      return;
    }
  });
  return found;
}

const quotes = (text: string): number => text.match(/"/g)?.length ?? 0;

/** Brackets opened and not closed in the text, quoted parts set aside (negative: more closed). */
function brackets(text: string): number {
  let n = 0;
  for (const c of text.replace(/"[^"]*"/g, '')) {
    if (c === '[' || c === '(' || c === '{') n++;
    else if (c === ']' || c === ')' || c === '}') n--;
  }
  return n;
}

/**
 * For each line, whether Mermaid drops it as a comment before it reads the flowchart. It
 * reads the front matter first, so a line of it is never dropped (a "%%" line there is
 * YAML); then it takes out every `%%{...}%%` directive; then it drops each line of "%%"
 * and at least one more character, not "%%{" (bug hunt round 3, D17, D19: a line
 * `%%%%{init}%%` is left a bare "%%", which is no comment).
 */
function droppedLines(lines: string[]): boolean[] {
  const info = parseDoc(lines.join('\n')).info;
  return lines.map((l, i) => {
    const kind = info[i]?.kind;
    return kind !== 'frontmatter' && kind !== 'directive' && COMMENT_LINE.test(l.replace(/%%\{.*?\}%%/g, ''));
  });
}

/** Mermaid's limit on the text of a diagram (its `maxTextSize`, which a file cannot
 *  change): past it, Mermaid draws only "Maximum text size in diagram exceeded". */
export const MERMAID_TEXT_LIMIT = 50_000;

/** Mermaid's own pattern for a `%%{...}%%` directive (its `directiveRegex`). */
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;

/**
 * The length Mermaid measures against its limit: the flowchart without its front matter,
 * its directives, its comment lines (descriptions included) and the blank lines that
 * start it, as Mermaid 12 prepares a text before it reads it (its `preprocessDiagram`;
 * a comment line takes the blank lines above it along).
 */
export function mermaidLength(text: string): number {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const info = parseDoc(lines.join('\n')).info;
  return lines
    .filter((_, i) => info[i]?.kind !== 'frontmatter')
    .join('\n')
    .replace(DIRECTIVE, '')
    .replace(/^\s*%%(?!\{)[^\n]+\n?/gm, '')
    .trimStart().length;
}

/** The text as Mermaid is given it: every line it drops as a comment emptied, so that
 *  the line numbers in Mermaid's messages can be turned back into lines of the file;
 *  and a comment after a statement cut off (it is reported by itself), so that Mermaid
 *  goes on to judge the lines below it. */
function forReading(lines: string[], comments = commentsAfter(lines), dropped = droppedLines(lines)): string {
  return lines
    .map((l, i) => {
      if (dropped[i]) return '';
      const at = comments.get(i);
      return at === undefined ? l : l.slice(0, at).trimEnd();
    })
    .join('\n');
}

/** Mermaid drops what stands above the first line of the flowchart (frontmatter, empty
 *  lines) before it counts lines. This is how many lines that is. */
function linesAbove(lines: string[], dropped: boolean[]): number {
  let i = 0;
  const blank = (k: number) => lines[k].trim() === '' || dropped[k];
  while (i < lines.length && blank(i)) i++;
  if (i < lines.length && lines[i].trim() === '---') {
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j < lines.length) {
      i = j + 1;
      while (i < lines.length && blank(i)) i++;
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
  if (/%%%%\{/.test(s)) return ' Take off the "%%" before "%%{": Mermaid takes the directive out, and the "%%" left is no comment.';
  if (signsUnquoted(s)) {
    return ' A title or label that holds brackets or other signs goes in double quotes: id["Title (with brackets)"].';
  }
  return '';
}

/**
 * Whether a line holds a title or label with brackets or a bar inside it and no double
 * quotes around it. A title: an opening bracket; then a bracket or a bar, with no quote
 * or closing bracket before it; then a closing bracket, with no quote before it. A
 * label: "--"; then a bracket, with no "-", ">" or "|" before it; then "->" or "-->",
 * with no "-" or ">" before it. Read in one pass, so a long line takes no longer than
 * its length (bug hunt round 3, D18: the two patterns this replaces, which match the same
 * lines, took minutes on a line of brackets).
 */
export function signsUnquoted(s: string): boolean {
  let opened = false; // an opening bracket, and no quote or closing bracket since
  let signed = false; // that, then a bracket or a bar, and no quote since
  let dashed = false; // "--", and no "-", ">" or "|" since
  let bracketed = false; // that, then a bracket, and no "-" or ">" since
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (signed && (c === ']' || c === ')' || c === '}')) return true;
    if (bracketed && c === '-' && (s[i + 1] === '>' || (s[i + 1] === '-' && s[i + 2] === '>'))) return true;
    signed = (signed && c !== '"') || (opened && '()[]{}|'.includes(c));
    opened = '[({'.includes(c) || (opened && !'"])}'.includes(c));
    bracketed = (bracketed && c !== '-' && c !== '>') || (dashed && '[](){}'.includes(c));
    dashed = (c === '-' && s[i - 1] === '-') || (dashed && !'->|'.includes(c));
  }
  return false;
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
  const trailing = commentsAfter(lines);
  for (const i of trailing.keys()) {
    add(i, 'comment-after-statement', 'A comment must have its line to itself: Mermaid has no comment after a statement. Move the "%%" part to a line of its own.');
  }

  // Mermaid's own verdict.
  const dropped = droppedLines(lines);
  const front = doc.info.map((li, i) => (li.kind === 'frontmatter' ? i : -1)).filter((i) => i >= 0);
  let ids: Set<string> | null = null;
  try {
    ids = new Set((await read(forReading(lines, trailing, dropped))).ids);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const at = /Parse error on line (\d+)/.exec(message);
    const yaml = /\((\d+):\d+\)/.exec(message);
    if (at) {
      const index = Math.min(lines.length - 1, Number(at[1]) - 1 + linesAbove(lines, dropped));
      let last = lines.length - 1;
      while (last > 0 && (lines[last].trim() === '' || dropped[last])) last--;
      if (trailing.has(index)) {
        // Already reported as a comment after a statement.
      } else if (index > last) {
        // Mermaid read to the end still waiting for something to close.
        add(last, 'mermaid', 'Mermaid reaches the end of the flowchart with something still open: a bracket, a quote or a group. Look for the line where it opens; it may be above this one.');
      } else {
        add(index, 'mermaid', `Mermaid cannot read the flowchart from this line on.${hint(lines[index])}`);
      }
    } else if (yaml && front.length) {
      // The YAML reader counts the lines of the front matter from 1, and may stop one
      // line past the one it cannot read.
      const [open, close] = [front[0], front[front.length - 1]];
      const percent = (k: number) => /^\s*%/.test(lines[k]);
      let index = Math.min(close, open + Number(yaml[1]));
      if (!percent(index) && index - 1 > open && percent(index - 1)) index--;
      add(index, 'mermaid', `Mermaid cannot read the front matter (the YAML between the "---" lines): ${message.split('\n')[0]}.${percent(index) ? ' In YAML a line cannot start with "%": write a note there as "# note", or put it below the front matter.' : ''}`);
    } else if (/No diagram type detected/.test(message)) {
      add(Math.max(0, doc.header), 'mermaid', 'Mermaid finds no diagram here: the first line of a flowchart is "flowchart TD" (or LR, BT, RL).');
    } else {
      add(Math.max(0, doc.header), 'mermaid', `Mermaid rejects the flowchart: ${message.split('\n')[0]}`);
    }
  }
  // Mermaid reads a text past its limit, and then draws only its message in its place.
  const size = mermaidLength(text);
  if (size > MERMAID_TEXT_LIMIT) {
    add(Math.max(0, doc.header), 'mermaid', `The flowchart is ${size.toLocaleString('en-US')} characters long without its comments and descriptions, past Mermaid's limit of 50,000: Mermaid draws only "Maximum text size in diagram exceeded" in its place. Split it into smaller flowcharts, or move long text from titles into descriptions.`);
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
    // The reading above blanks the lines the scanner takes for bare "%%" comments, so it
    // cannot see one the scanner misreads. Mermaid's reading of the text as it stands can:
    // there a "%%" line in an accessible text is its text (bug hunt round 7, D35 to D37).
    const accOf = async (t: string): Promise<string | null> => {
      try { return (await read(forReading(t.split('\n')), true)).acc ?? null; } catch { return null; }
    };
    const accBefore = await accOf(before[k]);
    if (accBefore !== null && accBefore !== (await accOf(after[k]))) {
      return { ...none, refused: 'the fix would have changed an accessible title or description.' };
    }
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
    // Counted and cut by characters, never inside one: half an emoji cannot be printed
    // (bug hunt round 2, D13).
    const shown = Array.from((lines[f.line - 1] ?? '').trim());
    if (shown.length) out.push(`    ${shown.length > 120 ? `${shown.slice(0, 117).join('')}...` : shown.join('')}`);
  }
  out.push(report.findings.length ? `${name}: ${count(report.findings.length)}` : `${name}: no problems`);
  return out.join('\n');
}
