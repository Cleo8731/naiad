/**
 * A group's title above the arrows (Q174, the user, 2026-11-18): Mermaid draws every group,
 * title and all, before the arrows, so an arrow entering a group from above ran straight
 * through its title. This moves each title into a layer of its own just after the arrows
 * and before the arrow labels, where it was, on a small plate in the group's colour, so
 * the line passes behind it, as at the gaps where two arrows cross. Drawing only: the
 * file and the layout are not touched.
 */
const NS = 'http://www.w3.org/2000/svg';
/** The plate reaches this far past the title at each side, and starts this far below
 * the group's top edge, so the edge stays whole. */
const SIDE = 5;
const TOP = 2;

export function raiseGroupTitles(svg: SVGSVGElement): void {
  for (const root of svg.querySelectorAll<SVGGElement>('g.root')) {
    const paths = [...root.children].find((c) => c.classList.contains('edgePaths'));
    const titles = [...root.querySelectorAll<SVGGElement>(':scope > g.clusters > g.cluster')]
      .map((group) => [group, group.querySelector<SVGGElement>(':scope > g.cluster-label')] as const)
      .filter((pair): pair is readonly [SVGGElement, SVGGElement] => pair[1] !== null);
    if (!paths || titles.length === 0) continue;
    const layer = document.createElementNS(NS, 'g');
    layer.setAttribute('class', 'group-titles');
    paths.after(layer);
    for (const [group, title] of titles) {
      const box = title.querySelector('foreignObject');
      if (box) {
        const plate = document.createElementNS(NS, 'rect');
        plate.setAttribute('class', 'group-plate');
        plate.setAttribute('x', String(-SIDE));
        plate.setAttribute('y', String(TOP));
        plate.setAttribute('width', String(Number(box.getAttribute('width') ?? 0) + 2 * SIDE));
        plate.setAttribute('height', String(Math.max(0, Number(box.getAttribute('height') ?? 0) - TOP)));
        const rect = group.querySelector<SVGRectElement>(':scope > rect');
        const fill = rect ? rect.style.fill || getComputedStyle(rect).fill : '';
        if (fill) plate.style.fill = fill;
        title.prepend(plate);
      }
      // A click on the title still selects its group; the group comes first in the
      // drawing, so a search for the group finds the group, not its title.
      if (group.dataset.sub !== undefined) title.dataset.sub = group.dataset.sub;
      layer.append(title);
    }
  }
}
