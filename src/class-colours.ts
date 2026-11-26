// Class colours in the window (T6.5's finding, fixed with Q240, the user, 2026-11-26).
// Mermaid gives a node, group or arrow the colours of a class definition (`classDef`) or a
// `style` line as an inline style marked `!important`. No stylesheet rule can beat an
// inline `!important`, so on such an item the selection's border, the hover's lighter
// fill and a drop's dashed border never showed. In the window the mark is taken off the
// colours of the shapes (the colours themselves stay, and still beat every ordinary rule);
// a saved picture puts it back (`Chart.picture`). The chart's own class rules
// (`#chart3 .cls>*{…!important}`) are beaten by the weight of the window's rules instead
// (`style.css`, `.canvas:not(#_)`).

/** The colours a shape's inline style may hold that Naiad's window rules change. */
const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray'];
/** Names the properties whose `!important` was taken off, so a picture can put it back. */
const MARK = 'data-was-important';

/** Takes `!important` off the shapes' colours in a drawing shown in the window. Text keeps its own. */
export function unlockColours(svg: SVGSVGElement): void {
  for (const el of svg.querySelectorAll<SVGElement>('[style]')) {
    if (el.closest('.label, foreignObject')) continue;
    const props = PROPS.filter((p) => el.style.getPropertyPriority(p) === 'important');
    if (!props.length) continue;
    for (const p of props) el.style.setProperty(p, el.style.getPropertyValue(p));
    el.setAttribute(MARK, props.join(' '));
  }
}

/** Puts back what `unlockColours` took off, in a copy of the drawing (a saved picture). */
export function relockColours(svg: SVGSVGElement): void {
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
 * it grows about its centre, which is its `translate` (Mermaid draws a node round 0,0),
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
