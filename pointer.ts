/*
 * The pointer over a zoomed element. The editor's Interface size (Preferences ▸ View) zooms its panels with CSS
 * `zoom`, and then two kinds of pixel are in play: a pointer event and `getBoundingClientRect` speak the page's,
 * while an element's own lengths (`clientWidth`, a `style.left`, what a canvas is drawn in) are its own. A distance
 * taken from the pointer is divided by the zoom before it is compared with one of the element's.
 */

/** How much an element is zoomed, its ancestors' zooms multiplied: 1 at 100%, and in a browser that does not say. */
export function zoomOf(el: Element | null | undefined): number {
  const z = (el as { currentCSSZoom?: number } | null | undefined)?.currentCSSZoom;
  return typeof z === "number" && z > 0 ? z : 1;
}

/** Where a point of the page (`clientX`, `clientY`) is over an element, in the element's own pixels from its corner. */
export function pointIn(el: Element, clientX: number, clientY: number): { x: number; y: number } {
  const r = el.getBoundingClientRect(), z = zoomOf(el);
  return { x: (clientX - r.left) / z, y: (clientY - r.top) / z };
}

/** Where a tooltip is asked for: `offsetX`/`offsetY` in the target's own pixels, `x`/`y` in the page's. */
export interface TipPoint {
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
}
