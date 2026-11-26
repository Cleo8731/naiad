// An arrow under the pointer (Q244; the user, 2026-11-26: "Yes, softer glow"): the line,
// its direction mark and its arrowheads take the full accent colour with a faint glow,
// and its label grows 5% and lifts, as a node does (`style.css`). The arrowheads are
// shared `<marker>`s, which a rule on the line cannot colour, so the hovered line points
// at an accent copy of each, made once per drawing, and back at the original after.

/** The suffix of a marker's accent copy. */
const COPY = '-hov';
/** On a line, the marker it pointed at before the swap: `data-hov-marker-end`, `-start`. */
const KEPT = 'data-hov-marker-';
const ENDS = ['end', 'start'] as const;

/** An accent copy of the marker `ref` points at (`url(#id)`), made if missing; its `url(#…)`, or null. */
function accentCopy(svg: SVGSVGElement, ref: string): string | null {
  const id = /^url\(#(.+)\)$/.exec(ref)?.[1];
  if (!id || id.endsWith(COPY)) return null;
  const copyId = id + COPY;
  if (!svg.querySelector(`#${CSS.escape(copyId)}`)) {
    const marker = svg.querySelector(`#${CSS.escape(id)}`);
    if (!marker) return null;
    const copy = marker.cloneNode(true) as SVGElement;
    copy.id = copyId;
    copy.classList.add('hov-marker');
    marker.after(copy);
  }
  return `url(#${copyId})`;
}

/** Lights an arrow: its arrowheads swapped for accent copies, and its label made ready to grow about its centre. */
export function lightArrow(svg: SVGSVGElement, line: Element, label: SVGGElement | null): void {
  for (const end of ENDS) {
    const ref = line.getAttribute(`marker-${end}`);
    const copy = ref ? accentCopy(svg, ref) : null;
    if (!ref || !copy) continue;
    line.setAttribute(KEPT + end, ref);
    line.setAttribute(`marker-${end}`, copy);
  }
  if (!label || label.style.transformOrigin) return;
  const m = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/.exec(label.getAttribute('transform') ?? '');
  label.style.transformOrigin = m ? `${m[1]}px ${m[2]}px` : 'center';
  // The pill's own colour, which the lifted pill mixes with the accent (`style.css`).
  const pill = label.querySelector<HTMLElement>('.labelBkg');
  if (pill) pill.style.setProperty('--own-fill', getComputedStyle(pill).backgroundColor);
}

/** Puts every swapped arrowhead back on its line. */
export function unlightArrows(svg: SVGSVGElement): void {
  for (const end of ENDS) {
    for (const line of svg.querySelectorAll(`[${KEPT}${end}]`)) {
      line.setAttribute(`marker-${end}`, line.getAttribute(KEPT + end)!);
      line.removeAttribute(KEPT + end);
    }
  }
}

/** Takes off a copy of the drawing (a saved picture) what lighting an arrow added. */
export function unreadyArrows(svg: SVGSVGElement): void {
  unlightArrows(svg);
  for (const copy of svg.querySelectorAll('.hov-marker')) copy.remove();
  for (const el of svg.querySelectorAll<HTMLElement | SVGElement>('g.edgeLabel, g.edgeLabel .labelBkg')) {
    el.style.removeProperty('transform-origin');
    el.style.removeProperty('--own-fill');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }
}
