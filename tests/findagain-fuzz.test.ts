// The comparison fuzz of outside changes to a Markdown file: generated files whose shown
// flowchart block is known, changed on disk in generated ways, so each answer of
// `findAgain` is right (the shown block), locked (-1: Naiad cannot tell, and changes
// nothing more) or wrong (another block: the next save would go into it).
//
// Three generators, each with fixed seeds (bug hunt rounds 3, 4 and 7):
// - round 3's: up to four `##` sections, changes that add, copy, delete, edit, rename and
//   move them (B13);
// - round 4's: sections under `#` headings, a block changed to another block's text, a
//   backup kept, sections swapped (B22);
// - round 7's: headings at two levels (sections under `# Part` headings), underlined
//   headings (`===`, `---`), a whole part copied as a backup, a part renamed, a heading
//   underlined or its underline taken off (B26 to B29).
//
// What must hold, for each generator:
// - A wrong answer never lands on a block that was in the file before (moved, edited or
//   not), nor on a copy of one: only on a block the change wrote with the shown block's
//   text (a copy of it, or a block added holding the same text), a reading kept by
//   design (the copy that keeps the old surroundings takes the edits). In round 4's, the
//   only wrong answers are two look-alike sections swapped (B24, known). Every
//   severity-1 bug of `findAgain` so far (B13, B22, B29) broke this.
// - The wrong answers are no more than the figures below, the count when this test was
//   written; a change that lowers one lowers its figure here too.
// Changes where another block reads exactly like the shown one, under the same headings
// (twins), are left out: no reader could tell them apart.
import { describe, expect, test } from 'vitest';
import { findAgain, findBlocks } from '../src/core/markdown';

const MOST_WRONG = { round3: 250, round4: 166, round7: 170 };
const CASES = 30000;
const CASES_ROUND4 = 20000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Case { seed: number; key: string; before: string; after: string; was: number; truth: number; twin: boolean; forms: string; origin?: string[] }

// ---------------------------------------------------------------- round 3's, its draws unchanged (only where each section came from is noted)
interface Sec { id: number; head: string; pre: string[]; code: string; post: string[]; shown?: boolean; from?: string; edited?: boolean }
const render = (secs: Sec[]) => secs.map((s) => [`## ${s.head}`, '', ...s.pre, '```mermaid', 'flowchart TD', `  ${s.code}`, '```', '', ...s.post, ''].join('\n')).join('\n');
function cases(count: number): Case[] {
  const out: Case[] = [];
  for (let seed = 1; seed <= count; seed++) {
    const r = rng(seed);
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
    const n = 1 + Math.floor(r() * 4);
    const codes = ['a', 'b', 'c'];
    let id = 0;
    const mk = (code?: string): Sec => ({ id: id++, head: pick(['One', 'Two', 'Three', 'Notes']), pre: r() < 0.5 ? [pick(['intro', 'some text', 'see below'])] : [], code: code ?? pick(codes), post: r() < 0.5 ? [pick(['end', 'after', 'more'])] : [], from: 'added' });
    const uniq = ['a', 'b', 'c', 'd']; const secs: Sec[] = Array.from({ length: n }, (_, i) => mk(uniq[i]));
    for (const s of secs) s.from = 'there before';
    const was = Math.floor(r() * n);
    secs[was].shown = true;
    const before = render(secs);
    const cur = secs.map((s) => ({ ...s, pre: [...s.pre], post: [...s.post] }));
    const ops: string[] = [];
    const nops = 1 + Math.floor(r() * 3);
    for (let k = 0; k < nops; k++) {
      const op = pick(['insertNew', 'insertCopyOfShown', 'insertCopyOfOther', 'deleteOther', 'editShown', 'editOther', 'editProse', 'editHead', 'moveShown']);
      const si = cur.findIndex((s) => s.shown);
      if (op === 'insertNew') { cur.splice(Math.floor(r() * (cur.length + 1)), 0, mk()); ops.push(op); }
      else if (op === 'insertCopyOfShown') { const c = { ...cur[si], pre: [...cur[si].pre], post: [...cur[si].post], shown: false, id: id++, from: 'copy of the shown' }; if (r() < 0.5) c.head = pick(['One', 'Two', 'Copy']); cur.splice(Math.floor(r() * (cur.length + 1)), 0, c); ops.push(op); }
      else if (op === 'insertCopyOfOther') { const o = cur.filter((s) => !s.shown); if (o.length) { const p = pick(o); const c = { ...p, shown: false, id: id++, from: `copy of one ${p.from}` }; cur.splice(Math.floor(r() * (cur.length + 1)), 0, c); ops.push(op); } }
      else if (op === 'deleteOther') { const o = cur.map((s, i) => [s, i] as const).filter(([s]) => !s.shown); if (o.length) { cur.splice(pick(o)[1], 1); ops.push(op); } }
      else if (op === 'editShown') { cur[si].code = pick(['x', 'y', 'a', 'b']) + 'e'; ops.push(op); }
      else if (op === 'editOther') { const o = cur.filter((s) => !s.shown); if (o.length) { const s = pick(o); s.code = pick(['x', 'y', 'a', 'b']); s.edited = true; ops.push(op); } }
      else if (op === 'editProse') { const s = pick(cur); s.pre = r() < 0.5 ? [] : ['edited intro']; s.post = r() < 0.5 ? [] : ['edited end']; ops.push(op); }
      else if (op === 'editHead') { pick(cur).head = pick(['Renamed', 'One', 'Two']); ops.push(op); }
      else if (op === 'moveShown') { const [s] = cur.splice(si, 1); cur.splice(Math.floor(r() * (cur.length + 1)), 0, s); ops.push(op); }
    }
    const sh = cur.find((s) => s.shown)!;
    const sect = (s: Sec) => render([{ ...s, shown: false, id: 0 }]);
    const twin = cur.some((s) => !s.shown && sect(s) === sect(sh));
    out.push({ seed, key: [...new Set(ops)].sort().join('+'), before, after: render(cur), was, truth: cur.findIndex((s) => s.shown), twin, forms: 'flat ##', origin: cur.map((s) => (s.shown ? 'the shown' : s.from!) + (s.edited ? ', its block changed' : '')) });
  }
  return out;
}

// ---------------------------------------------------------------- round 7's widening
type Style = 'atx' | 'setext';
/** A section: its heading (level 1 or 2, `#` or underlined), the part it stands in (a level-1 heading above it), its text and block. */
interface Sec7 {
  id: number; head: string; level: 1 | 2; style: Style; part: string | null; pre: string[]; code: string; post: string[]; shown?: boolean;
  /** Where the section came from, for sorting wrong picks by kind: in the file before, added, or copied from the shown section or another; and whether its block was changed. */
  from: string; edited?: boolean;
}

const heading = (text: string, level: 1 | 2, style: Style): string[] =>
  style === 'setext' ? [text, level === 1 ? '===' : '---'] : [`${'#'.repeat(level)} ${text}`];

/** A part's heading is written above the first of its sections in a row; `partStyle` holds each part's style. */
function render7(secs: Sec7[], partStyle: Map<string, Style>): string {
  const out: string[] = [];
  let part: string | null | undefined;
  for (const s of secs) {
    if (s.part !== part && s.part !== null) out.push(...heading(s.part, 1, partStyle.get(s.part) ?? 'atx'), '');
    part = s.part;
    out.push(...heading(s.head, s.part === null ? s.level : 2, s.style), '', ...s.pre, '```mermaid', 'flowchart TD', `  ${s.code}`, '```', '', ...s.post, '');
  }
  return out.join('\n');
}

function cases7(count: number): Case[] {
  const out: Case[] = [];
  for (let seed = 1; seed <= count; seed++) {
    const r = rng(seed ^ 0x72370000);
    const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
    const parted = r() < 0.6;
    const underline = r() < 0.5; // whether any heading of the file is underlined
    const style = (): Style => (underline && r() < 0.6 ? 'setext' : 'atx');
    const partStyle = new Map<string, Style>();
    const partNames = ['Original', 'Current', 'Draft'];
    const parts = parted ? partNames.slice(0, 1 + Math.floor(r() * 2)) : [];
    for (const p of [...partNames, 'Backup', 'Old', 'Renamed part']) partStyle.set(p, style());
    let id = 0;
    const mk = (code: string, part: string | null): Sec7 => ({
      id: id++, head: pick(['One', 'Two', 'Diagram', 'Notes']), level: parted ? 2 : (r() < 0.5 ? 1 : 2), style: style(), part,
      pre: r() < 0.5 ? [pick(['intro', 'some text', 'see below'])] : [], code, post: r() < 0.5 ? [pick(['end', 'after', 'more'])] : [], from: 'added',
    });
    const n = 1 + Math.floor(r() * 4);
    const uniq = ['a', 'b', 'c', 'd'];
    // Sections of one part stand together, in the order of the parts.
    const secs: Sec7[] = Array.from({ length: n }, (_, i) => mk(uniq[i], parted ? parts[Math.min(parts.length - 1, Math.floor((i * parts.length) / n))] : null));
    const was = Math.floor(r() * n);
    for (const s of secs) s.from = 'there before';
    secs[was].shown = true;
    const before = render7(secs, partStyle);
    const cur = secs.map((s) => ({ ...s, pre: [...s.pre], post: [...s.post] }));
    const copy = (s: Sec7): Sec7 => ({ ...s, pre: [...s.pre], post: [...s.post], shown: false, id: id++, from: s.shown ? 'copy of the shown' : `copy of one ${s.from}` });
    const partOf = () => (parted ? pick([...new Set(cur.map((s) => s.part!)), 'Backup']) : null);
    const ops: string[] = [];
    const nops = 1 + Math.floor(r() * 3);
    for (let k = 0; k < nops; k++) {
      const op = pick(['insertNew', 'insertCopyOfShown', 'deleteOther', 'editShown', 'editOther', 'editProse', 'editHead', 'moveShown',
        'backupPart', 'backupPart', 'renamePart', 'restyleHead', 'restyleHead']);
      const si = cur.findIndex((s) => s.shown);
      const sh = cur[si];
      if (op === 'insertNew') { cur.splice(Math.floor(r() * (cur.length + 1)), 0, mk(pick(['a', 'b', 'c']), partOf())); ops.push(op); }
      else if (op === 'insertCopyOfShown') {
        const c = copy(sh);
        if (r() < 0.5) c.head = pick(['One', 'Diagram', 'Copy']);
        if (parted && r() < 0.5) c.part = partOf();
        cur.splice(Math.floor(r() * (cur.length + 1)), 0, c);
        ops.push(op);
      } else if (op === 'deleteOther') { const o = cur.map((s, i) => [s, i] as const).filter(([s]) => !s.shown); if (o.length) { cur.splice(pick(o)[1], 1); ops.push(op); } }
      else if (op === 'editShown') { sh.code = pick(['x', 'y', 'a', 'b']) + 'e'; ops.push(op); }
      else if (op === 'editOther') { const o = cur.filter((s) => !s.shown); if (o.length) { const s = pick(o); s.code = pick(['x', 'y', 'a', 'b']); s.edited = true; ops.push(op); } }
      else if (op === 'editProse') { const s = pick(cur); s.pre = r() < 0.5 ? [] : ['edited intro']; s.post = r() < 0.5 ? [] : ['edited end']; ops.push(op); }
      else if (op === 'editHead') { pick(cur).head = pick(['Renamed', 'One', 'Diagram']); ops.push(op); }
      else if (op === 'moveShown') { cur.splice(si, 1); cur.splice(Math.floor(r() * (cur.length + 1)), 0, sh); ops.push(op); }
      else if (op === 'backupPart' && parted) {
        // B26: the shown block's whole part copied under another part's heading, above or
        // below it; the original then changed in place, or not.
        const name = pick(['Backup', 'Old']);
        const mine = cur.map((s, i) => [s, i] as const).filter(([s]) => s.part === sh.part);
        const backup = mine.map(([s]) => ({ ...copy(s), part: name }));
        const at = r() < 0.5 ? mine[0][1] : mine[mine.length - 1][1] + 1;
        cur.splice(at, 0, ...backup);
        if (r() < 0.6) sh.code = pick(['x', 'y']) + 'e';
        ops.push(op);
      } else if (op === 'backupPart') {
        // In a file without parts: the shown section copied under a level-1 heading of its own.
        const c: Sec7 = { ...copy(sh), head: pick(['Backup', 'Old']), level: 1 };
        cur.splice(r() < 0.5 ? si : si + 1, 0, c);
        if (r() < 0.6) sh.code = pick(['x', 'y']) + 'e';
        ops.push(op);
      } else if (op === 'renamePart' && parted) {
        // B28's kind: a part's heading renamed, in the same change as the rest.
        const from = sh.part!;
        for (const s of cur) if (s.part === from) s.part = 'Renamed part';
        ops.push(op);
      } else if (op === 'restyleHead') {
        // A heading underlined, or its underline taken off: the same heading to a reader.
        const s = pick(cur);
        if (parted && r() < 0.5) partStyle.set(s.part!, partStyle.get(s.part!) === 'setext' ? 'atx' : 'setext');
        else s.style = s.style === 'setext' ? 'atx' : 'setext';
        ops.push(op);
      }
    }
    const sh = cur.find((s) => s.shown)!;
    // A twin stands under the same part and reads the same: no reader could tell them apart.
    const sect = (s: Sec7) => JSON.stringify([s.part, render7([{ ...s, shown: false, id: 0, part: null }], partStyle)]);
    const twin = cur.some((s) => !s.shown && sect(s) === sect(sh));
    const after = render7(cur, partStyle);
    const forms = [parted ? 'parts' : 'flat', /\n(===|---)\n/.test(before + after) ? 'underlined' : 'atx'].join(' ');
    const origin = cur.map((s) => (s.shown ? 'the shown' : s.from) + (s.edited ? ', its block changed' : ''));
    out.push({ seed, key: [...new Set(ops)].sort().join('+'), before, after, was, truth: cur.findIndex((s) => s.shown), twin, forms, origin });
  }
  return out;
}

// ---------------------------------------------------------------- round 4's, its draws unchanged
interface Sec4 { h: string; pre: string; body: string; post: string; shown: boolean }
const POOL = ['a --> b', 'x --> y', 'p --> q', 'a --> c', 'm --> n'];
const FENCE = '```';
const render4 = (secs: Sec4[]) =>
  secs.map((s) => '# ' + s.h + '\n\n' + s.pre + '\n\n' + FENCE + 'mermaid\nflowchart TD\n  ' + s.body + '\n' + FENCE + '\n\n' + s.post + '\n').join('\n');
function cases4(count: number): Case[] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const out: Case[] = [];
  for (let t = 0; t < count; t++) {
    const k = 2 + Math.floor(rnd() * 3);
    const secs: Sec4[] = Array.from({ length: k }, (_, i) => ({ h: pick(['Plan', 'Notes', 'Flow', 'Other', `Part ${i}`]), pre: pick(['Some text.', 'Intro.', '']), body: pick(POOL), post: pick(['End.', 'More text.', '']), shown: false }));
    const was = Math.floor(rnd() * k);
    secs[was].shown = true;
    const before = render4(secs);
    const after = secs.map((s) => ({ ...s }));
    const op = pick(['textElsewhere', 'insertBlock', 'deleteOther', 'changeShown', 'changeShownKeepBackup', 'copyShownBeside', 'changeOther', 'swap', 'changeShownToOther']);
    const others = after.filter((s) => !s.shown);
    const shown = () => after.find((x) => x.shown)!;
    if (op === 'textElsewhere') { const s = pick(after); s.post = s.post + ' Edited.'; }
    if (op === 'insertBlock') after.splice(Math.floor(rnd() * (k + 1)), 0, { h: pick(['New', 'Plan', 'Notes']), pre: '', body: pick(POOL), post: '', shown: false });
    if (op === 'deleteOther' && others.length) after.splice(after.indexOf(pick(others)), 1);
    if (op === 'changeShown') { const s = shown(); s.body = pick(POOL.filter((b) => b !== s.body)); }
    if (op === 'changeShownToOther' && others.length) shown().body = pick(others).body;
    if (op === 'changeShownKeepBackup') {
      const s = shown();
      const backup = { h: 'Backup', pre: '', body: s.body, post: '', shown: false };
      s.body = rnd() < 0.5 && others.length ? pick(others).body : pick(POOL.filter((b) => b !== s.body));
      after.splice(rnd() < 0.5 ? 0 : after.length, 0, backup);
    }
    if (op === 'copyShownBeside') { const i = after.findIndex((x) => x.shown); after.splice(i + (rnd() < 0.5 ? 0 : 1), 0, { ...after[i], h: 'Copy', shown: false }); }
    if (op === 'changeOther' && others.length) pick(others).body = pick(POOL);
    if (op === 'swap' && k >= 2) { const i = Math.floor(rnd() * k), j = Math.floor(rnd() * k); [after[i], after[j]] = [after[j], after[i]]; }
    out.push({ seed: t, key: op, before, after: render4(after), was, truth: after.findIndex((s) => s.shown), twin: false, forms: 'round 4' });
  }
  return out;
}

// ---------------------------------------------------------------- the checks
function check(all: Case[], most: number, never: (c: Case, got: number) => boolean) {
  const t = { total: 0, right: 0, wrong: 0, locked: 0 };
  const bad: string[] = [];
  for (const c of all) {
    if (c.twin) continue;
    const bb = findBlocks(c.before);
    const ab = findBlocks(c.after);
    const got = findAgain(c.before, bb, c.after, ab, c.was);
    t.total++;
    if (got === -1) t.locked++;
    else if (got === c.truth) t.right++;
    else {
      t.wrong++;
      if (never(c, got)) bad.push(`seed ${c.seed} (${c.key}): block ${got} taken (${c.origin?.[got] ?? c.key}), the shown block is ${c.truth}`);
    }
  }
  console.log(JSON.stringify(t));
  expect(bad.slice(0, 5), `${bad.length} wrong answers of a kind never allowed`).toEqual([]);
  expect(t.wrong, 'more wrong answers than when the test was written').toBeLessThanOrEqual(most);
}
const wasThere = (c: Case, got: number) => (c.origin?.[got] ?? '').startsWith('there before');

describe('findAgain over generated outside changes with a known answer', () => {
  test("round 3's changes", () => check(cases(CASES), MOST_WRONG.round3, wasThere), 120000);
  test("round 4's changes: wrong only where look-alike sections were swapped (B24)", () =>
    check(cases4(CASES_ROUND4), MOST_WRONG.round4, (c) => c.key !== 'swap'), 120000);
  test("round 7's changes: two heading levels, underlined headings, parts copied and renamed", () =>
    check(cases7(CASES), MOST_WRONG.round7, wasThere), 120000);
});
