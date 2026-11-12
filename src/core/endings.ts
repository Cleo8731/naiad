// Line endings, kept line by line. A file may mix LF, CRLF and a lone CR: each counts as
// a line break, and Naiad works on the text with LF only. When the text is written back,
// every line that is still there keeps the ending it had in the file; a changed line
// keeps the ending of the line it took the place of; an added line takes the ending of
// the line above it. A byte-order mark is kept. Spec: FILE-FORMAT.md, "What Naiad
// changes in a file". Text in, text out; no browser code.

const BOM = '﻿';

/** The text as Naiad works on it: no byte-order mark, every line break a plain LF. */
export function plainText(raw: string): string {
  return (raw.startsWith(BOM) ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
}

/** The lines of a file and the line break after each one (the last line has none). */
function split(body: string): { lines: string[]; ends: string[] } {
  const lines: string[] = [];
  const ends: string[] = [];
  const re = /\r\n|\n|\r/g;
  let from = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    lines.push(body.slice(from, m.index));
    ends.push(m[0]);
    from = m.index + m[0].length;
  }
  lines.push(body.slice(from));
  return { lines, ends };
}

/** The line break most lines of the file end with (on a tie, the first one used). */
function commonest(ends: string[]): string {
  const count = new Map<string, number>();
  for (const e of ends) count.set(e, (count.get(e) ?? 0) + 1);
  let best = '\n';
  let most = 0;
  for (const [e, n] of count) if (n > most) { best = e; most = n; }
  return best;
}

/** Cells of the table used to match the changed middle of a file; past it no line there is matched. */
const MATCH_LIMIT = 1_000_000;

/**
 * For each new line, the index of the old line it is the same as, or -1. Lines equal at
 * the start and the end are matched first; the middle by the longest common run of lines.
 * Of the runs that long, the one with the most lines at the same place in the middle:
 * when lines are changed in place to the text of a line beside them, which line is which
 * is told by its place, not by the first copy found (bug hunt round 4, D28). A
 * description's lines are matched the same way (`descriptions.ts`).
 */
export function matchLines(a: string[], b: string[]): Int32Array {
  const out = new Int32Array(b.length).fill(-1);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) { out[p] = p; p++; }
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
    out[b.length - 1 - s] = a.length - 1 - s;
    s++;
  }
  const n = a.length - p - s;
  const m = b.length - p - s;
  if (n === 0 || m === 0 || n * m > MATCH_LIMIT) return out;
  // Longest common subsequence of the middle lines, read back from the end. A matched
  // pair is worth `unit`, and one more when both lines stand at the same place: more
  // than the most such points a run can gain, so the longest run always wins (the
  // largest worth is about min(n, m)², at most 1,000,000 here, well inside a Uint32).
  const ids = new Map<string, number>();
  const id = (l: string) => { let v = ids.get(l); if (v === undefined) ids.set(l, v = ids.size); return v; };
  const x = Array.from({ length: n }, (_, i) => id(a[p + i]));
  const y = Array.from({ length: m }, (_, j) => id(b[p + j]));
  const unit = Math.min(n, m) + 1;
  const worth = (i: number, j: number) => unit + (i === j ? 1 : 0);
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      t[i * w + j] = x[i] === y[j] ? Math.max(skip, t[(i + 1) * w + j + 1] + worth(i, j)) : skip;
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (x[i] === y[j] && t[i * w + j] === t[(i + 1) * w + j + 1] + worth(i, j)) { out[p + j] = p + i; i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * The file to write: `text` (LF only) with the byte-order mark and the line endings of
 * `raw`, the file as it is on disk now, kept line by line.
 */
export function withEndingsOf(raw: string, text: string): string {
  const bom = raw.startsWith(BOM);
  const old = split(bom ? raw.slice(1) : raw);
  const lines = text.split('\n');
  const matched = matchLines(old.lines, lines);
  const fallback = commonest(old.ends);
  // For each new line, the old index of the next matched line at or below it.
  const nextOld = new Int32Array(lines.length + 1).fill(old.lines.length);
  for (let j = lines.length - 1; j >= 0; j--) nextOld[j] = matched[j] >= 0 ? matched[j] : nextOld[j + 1];

  let out = bom ? BOM : '';
  let prevOld = -1; // old index of the last matched line above
  let prevNew = -1; // its new index
  let above = '';   // the ending given to the line above
  for (let j = 0; j < lines.length; j++) {
    out += lines[j];
    if (j === lines.length - 1) break;
    let end: string | undefined;
    if (matched[j] >= 0) {
      prevOld = matched[j];
      prevNew = j;
      end = old.ends[matched[j]];
    } else {
      // A changed line: the old line in the same place between the same matched lines.
      const k = prevOld + 1 + (j - prevNew - 1);
      if (k < nextOld[j]) end = old.ends[k];
    }
    above = end ?? (above || fallback);
    out += above;
  }
  return out;
}
