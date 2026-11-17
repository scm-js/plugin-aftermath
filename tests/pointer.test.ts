import { describe, expect, it } from "vitest";
import { pointIn, zoomOf } from "../pointer";

/** An element as the browser reports it: its box in the page's pixels, and how much it is zoomed. */
const element = (left: number, top: number, zoom?: number) =>
  ({ getBoundingClientRect: () => ({ left, top }), ...(zoom === undefined ? {} : { currentCSSZoom: zoom }) }) as unknown as Element;

describe("the pointer over a zoomed element", () => {
  it("is 1 where the browser does not say, and for no element", () => {
    expect(zoomOf(element(0, 0))).toBe(1);
    expect(zoomOf(null)).toBe(1);
    expect(zoomOf(element(0, 0, 0))).toBe(1);
    expect(zoomOf(element(0, 0, 1.3))).toBe(1.3);
  });

  it("is the distance from the corner at 100%", () => {
    expect(pointIn(element(100, 40), 360, 50)).toEqual({ x: 260, y: 10 });
  });

  it("is divided by the zoom at a larger interface size", () => {
    // A 400 px canvas at 130% is 520 px of the page: its middle is 260 page pixels in, 200 of its own.
    const at = pointIn(element(100, 40, 1.3), 360, 53);
    expect(at.x).toBeCloseTo(200);
    expect(at.y).toBeCloseTo(10);
  });
});
