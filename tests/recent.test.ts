// The recent list's rules (T1.15): newest first, each file once whatever its capital
// letters (as Windows compares paths), at most 50 kept, and what each entry shows.
// The pane in the app: recent-pane.test.ts.
import { describe, expect, it } from 'vitest';
import { fileName, folderLabel, readRecent, RECENT_KEEP, RECENT_SHOWN, samePath, withOpened, withoutPath } from '../src/recent';

describe('the recent list', () => {
  it('keeps 50 and shows 25 at a time (Q136)', () => {
    expect(RECENT_KEEP).toBe(50);
    expect(RECENT_SHOWN).toBe(25);
  });

  it('puts a file opened on top, and one opened again moves to the top, listed once', () => {
    expect(withOpened([], 'C:\\a.mmd')).toEqual(['C:\\a.mmd']);
    expect(withOpened(['C:\\a.mmd'], 'C:\\b.mmd')).toEqual(['C:\\b.mmd', 'C:\\a.mmd']);
    expect(withOpened(['C:\\b.mmd', 'C:\\a.mmd'], 'C:\\a.mmd')).toEqual(['C:\\a.mmd', 'C:\\b.mmd']);
  });

  it('counts two spellings of one path as the same file, keeping the latest spelling', () => {
    expect(samePath('C:\\Proj\\Flow.mmd', 'c:\\proj\\flow.MMD')).toBe(true);
    expect(samePath('C:\\proj\\a.mmd', 'C:\\proj\\b.mmd')).toBe(false);
    expect(withOpened(['C:\\b.mmd', 'c:\\PROJ\\a.mmd'], 'C:\\proj\\a.mmd')).toEqual(['C:\\proj\\a.mmd', 'C:\\b.mmd']);
    expect(withoutPath(['C:\\b.mmd', 'c:\\PROJ\\a.mmd'], 'C:\\proj\\a.mmd')).toEqual(['C:\\b.mmd']);
  });

  it('keeps at most 50, dropping the oldest', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `C:\\f${i}.mmd`);
    const after = withOpened(fifty, 'C:\\new.mmd');
    expect(after).toHaveLength(50);
    expect(after[0]).toBe('C:\\new.mmd');
    expect(after).not.toContain('C:\\f49.mmd');
  });

  it('reads what was kept, and anything unreadable as an empty list', () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent('not json')).toEqual([]);
    expect(readRecent('{"a":1}')).toEqual([]);
    expect(readRecent(JSON.stringify(['C:\\a.mmd', 3, '', null, 'c:\\A.mmd', 'C:\\b.mmd']))).toEqual(['C:\\a.mmd', 'C:\\b.mmd']);
    const sixty = Array.from({ length: 60 }, (_, i) => `C:\\f${i}.mmd`);
    expect(readRecent(JSON.stringify(sixty))).toEqual(sixty.slice(0, 50));
  });

  it('names each entry by its file, and under it the last two folders', () => {
    expect(fileName('D:\\work\\team\\proj\\docs\\flow.mmd')).toBe('flow.mmd');
    expect(fileName('C:/proj/docs/flow.mmd')).toBe('flow.mmd');
    expect(folderLabel('D:\\work\\team\\proj\\docs\\flow.mmd')).toBe('proj\\docs');
    expect(folderLabel('C:/proj/docs/flow.mmd')).toBe('proj/docs');
    expect(folderLabel('C:\\x\\flow.mmd')).toBe('C:\\x');
    expect(folderLabel('C:\\flow.mmd')).toBe('C:\\');
    expect(folderLabel('\\\\server\\share\\flow.mmd')).toBe('server\\share');
  });
});
