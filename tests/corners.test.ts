// @vitest-environment jsdom
// The node corners (the user, 2026-11-16, Q164): a Rectangle's 4 px and a Rounded
// node's 16 px, further apart than before (6 px and 14 px) so the two shapes are told
// apart at a glance. A group keeps 12 px. Drawing only: the file is not touched.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';

const css = readFileSync(resolve('src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
const rule = (sel: string) => rules.find((r) => r.sel.split(',').map((s) => s.trim()).includes(sel))?.body ?? null;

describe('the node corners (Q164)', () => {
  test('a Rectangle has 4 px corners', () => {
    const body = rule('.canvas .node rect.label-container:not([rx])');
    expect(body).toMatch(/\brx:\s*4px/);
    expect(body).toMatch(/\bry:\s*4px/);
  });

  test('a group keeps 12 px corners', () => {
    expect(rule('.canvas .cluster > rect')).toMatch(/\brx:\s*12px/);
  });

  test('a Rounded node has 16 px corners', async () => {
    const init = vi.spyOn(mermaid, 'initialize');
    const { configureMermaid } = await import('../src/chart');
    configureMermaid(false);
    expect(init.mock.lastCall?.[0].themeVariables?.radius).toBe(16);
    init.mockRestore();
  });
});
