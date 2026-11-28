// Class colors in the window (T6.5's finding, fixed with Q240, the user, 2026-11-26).
// Mermaid gives a node, group or arrow the colors of a class definition (`classDef`) or a
// `style` line as an inline style marked `!important`. No stylesheet rule can beat an
// inline `!important`, so on such an item the selection's border, the hover's lighter
// fill and a drop's dashed border never showed. In the window the mark is taken off the
// colors of the shapes (the colors themselves stay, and still beat every ordinary rule);
// a saved picture puts it back (`Chart.picture`). The chart's own class rules
// (`#chart3 .cls>*{…!important}`) lose the mark on the shapes' colors as well, so a
// node's own `style` color beats its class's (1.0.2); the shapes' inline styles already
// hold the class's colors, so nothing else changes.

/** The colors a shape's inline style may hold that Naiad's window rules change. */
const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray'];
/** Names the properties whose `!important` was taken off, so a picture can put it back. */
const MARK = 'data-was-important';

/** A rule of the drawing's own stylesheet for a node's shapes: Mermaid's rule for a `classDef`, `.process>*{…}`. */
const SHAPE_RULE = /[^{}]*>\s*\*\s*\{[^}]*\}/g;
/** A shape color in such a rule, with its `!important`. */
const IMPORTANT = /([{;]\s*)(fill|stroke|stroke-width|stroke-dasharray)(\s*:\s*[^;!}]*?)\s*!important/gi;

/**
 * Takes `!important` off the shapes' colors in a drawing shown in the window. Text keeps
 * its own. The drawing's class rules lose it too: Mermaid also writes a class's colors
 * into each shape's inline style, under the node's own `style` colors, so without the
 * mark on the shape a class rule that kept it would beat the node's own color (1.0.2,
 * the user: "Picking another swatch doesn't even change its color").
 */
export function unlockColors(svg: SVGSVGElement): void {
  for (const style of svg.querySelectorAll('style')) {
    const text = style.textContent ?? '';
    const next = text.replace(SHAPE_RULE, (rule) => rule.replace(IMPORTANT, '$1$2$3'));
    if (next !== text) style.textContent = next;
  }
  for (const el of svg.querySelectorAll<SVGElement>('[style]')) {
    if (el.closest('.label, foreignObject')) continue;
    const props = PROPS.filter((p) => el.style.getPropertyPriority(p) === 'important');
    if (!props.length) continue;
    for (const p of props) el.style.setProperty(p, el.style.getPropertyValue(p));
    el.setAttribute(MARK, props.join(' '));
  }
}

/** Puts back what `unlockColors` took off, in a copy of the drawing (a saved picture). */
export function relockColors(svg: SVGSVGElement): void {
  for (const el of svg.querySelectorAll<SVGElement>(`[${MARK}]`)) {
    for (const p of (el.getAttribute(MARK) ?? '').split(' ').filter(Boolean)) {
      el.style.setProperty(p, el.style.getPropertyValue(p), 'important');
    }
    el.removeAttribute(MARK);
  }
}

/** The parts of a node's shape: a plain shape, or a stadium's group of a fill path and a border path. */
const SHAPES = ':scope > :is(rect, polygon, circle, ellipse, path), .label-container, .label-container path';

/**
 * Makes a node ready to grow and lift under the pointer (Q240), once per drawing of it:
 * it grows about its center, which is its `translate` (Mermaid draws a node round 0,0),
 * and each part of its shape that has a fill keeps it as `--own-fill`, which the lighter
 * fill mixes with white (`style.css`). A part with no fill (a stadium's border) keeps none.
 */
export function readyToLift(g: SVGGElement): void {
  if (g.style.transformOrigin) return;
  const m = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/.exec(g.getAttribute('transform') ?? '');
  g.style.transformOrigin = m ? `${m[1]}px ${m[2]}px` : 'center';
  for (const shape of g.querySelectorAll<SVGElement>(SHAPES)) {
    if (shape.localName === 'g') continue;
    const fill = getComputedStyle(shape).fill;
    if (fill && fill !== 'none' && !/^rgba\(.*,\s*0\)$/.test(fill)) shape.style.setProperty('--own-fill', fill);
  }
}

/** Takes off a copy of the drawing what `readyToLift` added. */
export function unready(svg: SVGSVGElement): void {
  for (const el of svg.querySelectorAll<SVGElement>('g.node, g.node *')) {
    el.style.removeProperty('transform-origin');
    el.style.removeProperty('--own-fill');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }
}
