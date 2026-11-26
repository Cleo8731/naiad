// Export (T6.3; the user, 2026-11-25, Q220 and Q222): the whole chart saved as a picture,
// an SVG or a PNG, the chart alone, in the theme on screen. The picture is a copy of the
// chart as drawn (`Chart.picture`). Mermaid writes its colours into the drawing's own
// style; Naiad's own drawing rules (rounder corners, the direction marks' look) live in
// `style.css` under `.canvas`, so they are copied into the picture here, and so is the
// chart's font, Lexend, so the picture looks the same on a computer without it.

import lexendUrl from './fonts/lexend.woff2?url';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The parts of a rule's selector, split at its commas but not at those inside brackets
 * (`.node :is(polygon, path)` is one part).
 */
function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

/** A rule for what only the window shows: under the pointer, selected, highlighted, a trace, a drop, the clickable copies, the pointer's shape. */
const WINDOW_ONLY = /\.(?:hov|sel|hl|lit|drop|edge-hit)\b|\[data-|tracing|highlighting|^\.canvas svg$/;

/**
 * Naiad's drawing rules for the chart (`style.css`, under `.canvas`), for a drawing
 * outside the window: each rule's selector starts at `scope` (`#chart3`) instead.
 */
export function drawingRules(scope: string): string {
  const out: string[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const kept = selectorParts(rule.selectorText).filter((s) => s.startsWith('.canvas ') && !WINDOW_ONLY.test(s));
      if (!kept.length || /^\s*transition\b/.test(rule.style.cssText)) continue;
      out.push(`${kept.map((s) => `${scope} ${s.slice('.canvas '.length)}`).join(', ')} { ${rule.style.cssText} }`);
    }
  }
  return out.join('\n');
}

/** A `<style>` for a drawing, holding `css`. */
export function styleElement(css: string): SVGStyleElement {
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = css;
  return style;
}

/**
 * Gives every element inside a copy of the chart a new id (`prefix` + its id) and points
 * the copy's references at them: `url(#…)` in attributes and in its own style, and `#…`
 * links. A copy laid in the same page as the chart needs it: `url(#id)` finds the first
 * element of that id in the page, the chart's own, which a print hides, so the copy's
 * arrowheads were not drawn (seen in T6.3's trial, 2026-11-25). The copy itself keeps its
 * id, which Mermaid's style and Naiad's rules name.
 */
export function renameIds(svg: SVGSVGElement, prefix: string): void {
  const names = new Map<string, string>();
  for (const el of svg.querySelectorAll('[id]')) {
    names.set(el.id, prefix + el.id);
    el.id = prefix + el.id;
  }
  if (!names.size) return;
  const swap = (text: string) =>
    text.replace(/url\((['"]?)#([^'")]+)\1\)/g, (all, q: string, id: string) => (names.has(id) ? `url(${q}#${names.get(id)}${q})` : all));
  for (const el of svg.querySelectorAll('*')) {
    if (el.localName === 'style') { el.textContent = swap(el.textContent ?? ''); continue; }
    for (const a of el.attributes) {
      if (a.value.includes('url(')) a.value = swap(a.value);
      else if (a.localName === 'href' && a.value.startsWith('#') && names.has(a.value.slice(1))) a.value = `#${names.get(a.value.slice(1))}`;
    }
  }
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Lexend as an `@font-face` that carries the font itself, read once; '' if it cannot be read (the picture then names the font only). */
let lexend: Promise<string> | null = null;
function lexendFace(): Promise<string> {
  lexend ??= fetch(lexendUrl)
    .then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      const data = base64(new Uint8Array(await r.arrayBuffer()));
      return `@font-face { font-family: 'Lexend'; font-style: normal; font-weight: 400 700; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
    })
    .catch(() => { lexend = null; return ''; });
  return lexend;
}

/** A drawing's size, from its `viewBox`. */
export function sizeOf(svg: SVGSVGElement): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  return [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : { x: 0, y: 0, w: Number(svg.getAttribute('width')) || 0, h: Number(svg.getAttribute('height')) || 0 };
}

/**
 * The picture as an SVG file's text: the drawing on its background (a dark chart stays
 * dark, Q222), with Naiad's drawing rules and the font inside it.
 */
export async function svgFile(drawing: SVGSVGElement, background: string): Promise<string> {
  const svg = drawing.cloneNode(true) as SVGSVGElement;
  const { x, y, w, h } = sizeOf(svg);
  const rect = document.createElementNS(SVG_NS, 'rect');
  for (const [name, value] of [['x', x], ['y', y], ['width', w], ['height', h]] as const) rect.setAttribute(name, String(value));
  rect.setAttribute('fill', background);
  svg.prepend(rect);
  const css = [await lexendFace(), drawingRules(svg.id ? `#${CSS.escape(svg.id)}` : 'svg')].filter(Boolean).join('\n');
  if (css) svg.prepend(styleElement(css));
  return new XMLSerializer().serializeToString(svg);
}

/** The longest side and the most pixels a PNG gets: a browser draws nothing on a canvas past about these. */
const MOST_SIDE = 16384;
const MOST_PIXELS = 120_000_000;

/** The picture as a PNG file's bytes: the SVG file drawn at twice its size, less for a chart too large for that. */
export async function pngFile(svgText: string, w: number, h: number): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  await img.decode();
  const scale = Math.min(2, MOST_SIDE / w, MOST_SIDE / h, Math.sqrt(MOST_PIXELS / (w * h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
  if (!blob) throw new Error('the chart is too large for a PNG picture');
  return new Uint8Array(await blob.arrayBuffer());
}
