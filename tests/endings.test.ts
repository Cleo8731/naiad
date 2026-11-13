// Line endings kept line by line (src/core/endings.ts): a file that mixes LF, CRLF and a
// lone CR keeps every unchanged line's ending when Naiad writes it back.
import { describe, expect, test } from 'vitest';
import { plainText, withEndingsOf } from '../src/core/endings';

/** Writes `text` over `raw` the way a save does. */
const write = (raw: string, text: string) => withEndingsOf(raw, text);

describe('every line keeps its own ending', () => {
  test('an unchanged file comes back byte for byte', () => {
    for (const raw of ['a\r\nb\nc\rd', 'a\nb\n', 'a\r\nb\r\n', '﻿a\r\nb', '', '\n', '\r\n\r\n', 'x\r']) {
      expect(write(raw, plainText(raw))).toBe(raw);
    }
  });

  test('a changed line keeps the ending it had', () => {
    expect(write('a\r\nb\nc\r\n', 'a\nB\nc\n')).toBe('a\r\nB\nc\r\n');
    expect(write('a\nb\r\nc\n', 'a\nB\nc\n')).toBe('a\nB\r\nc\n');
  });

  test('an added line takes the ending of the line above it', () => {
    expect(write('a\r\nb\nc\r\n', 'a\nb\nnew\nc\n')).toBe('a\r\nb\nnew\nc\r\n');
    expect(write('a\r\nb\nc\r\n', 'a\nnew\nb\nc\n')).toBe('a\r\nnew\r\nb\nc\r\n');
    expect(write('a\nb\n', 'top\na\nb\n')).toBe('top\na\nb\n');
  });

  test('a removed line takes its ending with it', () => {
    expect(write('a\r\nb\nc\r\n', 'a\nc\n')).toBe('a\r\nc\r\n');
  });

  test('lines changed in place to the text of a line beside them keep their own endings (bug hunt round 4, D28)', () => {
    expect(write('h\r\n%%\n%% .\r%%\r\nA\n', 'h\n%% .\n%% .\n%% .\nA\n')).toBe('h\r\n%% .\n%% .\r%% .\r\nA\n');
    expect(write('h\r\n%%\r%% .\n%%\r\nA\n', 'h\n%% .\n%% .\n%% .\nA\n')).toBe('h\r\n%% .\r%% .\n%% .\r\nA\n');
  });

  test('lines between two changes keep theirs', () => {
    const ends = ['\n', '\r\n', '\r', '\r\n', '\n', '\n', '\r\n', '\r', '\n', '\r\n'];
    const raw = ends.map((e, i) => `line ${i}${e}`).join('');
    const text = plainText(raw).replace('line 1\n', 'LINE ONE\n').replace('line 8\n', 'LINE EIGHT\n');
    expect(write(raw, text)).toBe(raw.replace('line 1', 'LINE ONE').replace('line 8', 'LINE EIGHT'));
  });

  test('a byte-order mark and a last line without an ending are kept', () => {
    expect(write('﻿a\r\nb', 'a\nB')).toBe('﻿a\r\nB');
    expect(write('﻿a\r\nb', 'a\nb\nc')).toBe('﻿a\r\nb\r\nc');
  });

  test('a file with one kind of ending keeps it on added lines', () => {
    expect(write('a\r\nb\r\n', 'a\nb\nc\nd\n')).toBe('a\r\nb\r\nc\r\nd\r\n');
    expect(write('a\nb\n', 'a\nb\nc\nd\n')).toBe('a\nb\nc\nd\n');
    expect(write('a\rb\r', 'a\nx\nb\n')).toBe('a\rx\rb\r');
  });

  test('a file rewritten whole is written quickly, with its text intact', () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `old ${i}${i % 2 ? '\r\n' : '\n'}`).join('');
    const text = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n') + '\n';
    const started = Date.now();
    const out = write(raw, text);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(plainText(out)).toBe(text);
  });
});
