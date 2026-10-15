import { describe, expect, it } from "vitest";
import type { Shot } from "../director";
import { along, cameraTrack, trackAt, type CameraTrack } from "../camera";

const VIEW = { width: 640, height: 480 }, MAP = { width: 4096, height: 4096 };
/** Game frames a second of the person's time at 1× (Fastest). */
const RATE = 1000 / 42;

/** A shot from `from` to `to` of `kind`, at `at(frame)` every 48 frames. */
function shot(kind: Shot["kind"], from: number, to: number, at: (frame: number) => [number, number]): Shot {
  const path: Shot["path"] = [];
  for (let f = from; f <= to; f += 48) { const [x, y] = at(f); path.push({ frame: f, x, y }); }
  return { kind, from, to, players: [0], path };
}
const track = (shots: Shot[], frames: number, rate = RATE, view = VIEW) => cameraTrack(shots, { view, map: MAP, frames, rate })!;
/** The track's points from one frame to another, as x and y. */
const span = (t: CameraTrack, from: number, to: number) => {
  const out: { frame: number; x: number; y: number }[] = [];
  for (let f = from; f <= to; f += t.every) out.push({ frame: f, ...trackAt(t, f) });
  return out;
};

describe("Spectate's camera track", () => {
  it("holds still while what it shows wobbles near the middle", () => {
    const t = track([shot("army", 0, 2400, (f) => [2000 + (f % 96 ? 40 : -40), 2000 + (f % 144 ? 30 : -30)])], 2400);
    const xs = span(t, 200, 2200).map((p) => p.x), ys = span(t, 200, 2200).map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
  });

  it("cuts to a shot more than a screen away, and is there when it starts", () => {
    const shots = [shot("home", 0, 960, () => [600, 600]), shot("fight", 960, 1920, () => [3200, 3000])];
    const t = track(shots, 1920);
    expect(t.cut[960 / t.every]).toBe(1);
    expect(t.cut.slice(1, 960 / t.every).every((c) => c === 0)).toBe(true);
    // The frame before, still on the first; from the cut, on the second.
    expect(trackAt(t, 958)).toEqual({ x: 600, y: 600 });
    const there = trackAt(t, 970);
    expect(Math.hypot(there.x - 3200, there.y - 3000)).toBeLessThan(2);
  });

  it("pans to a shot within reach: setting off a moment before it, speeding up and slowing down, in about a second", () => {
    const shots = [shot("army", 0, 960, () => [2000, 2000]), shot("fight", 960, 1920, () => [2400, 2150])];
    const t = track(shots, 1920);
    expect([...t.cut.slice(1)].every((c) => c === 0)).toBe(true);
    const points = span(t, 900, 1040), steps = points.slice(1).map((p, i) => p.x - points[i].x);
    // Moving before the shot changes (an observer saw it coming), and never back.
    expect(trackAt(t, 950).x).toBeGreaterThan(2000.5);
    expect(steps.every((d) => d >= -0.01)).toBe(true);
    // Fastest in the middle, gentle at both ends.
    const fastest = steps.indexOf(Math.max(...steps));
    expect(steps[0]).toBeLessThan(steps[fastest] / 4);
    expect(steps[steps.length - 1]).toBeLessThan(steps[fastest] / 4);
    // There within about a second of the person's time.
    const there = trackAt(t, 960 + RATE);
    expect(Math.hypot(there.x - 2400, there.y - 2150)).toBeLessThan(4);
  });

  it("times its pans in the person's seconds: eight times the game's frames at 8×", () => {
    const shots = [shot("army", 0, 1920, () => [2000, 2000]), shot("fight", 1920, 3840, () => [2400, 2000])];
    const moving = (t: CameraTrack) => span(t, 0, 3840).filter((p, i, all) => i > 0 && p.x - all[i - 1].x > 0.05).length;
    const slow = moving(track(shots, 3840)), fast = moving(track(shots, 3840, RATE * 8));
    expect(fast / slow).toBeGreaterThan(6);
    expect(fast / slow).toBeLessThan(10);
  });

  it("keeps the view on the map", () => {
    const t = track([shot("base", 0, 960, () => [10, 4090])], 960);
    for (const p of span(t, 0, 960)) {
      expect(p.x).toBeCloseTo(VIEW.width / 2, 3);
      expect(p.y).toBeCloseTo(MAP.height - VIEW.height / 2, 3);
    }
  });

  it("follows an army on the move with no corners in its speed, looking ahead of it", () => {
    const army = (f: number): [number, number] => [800 + f * 1.5, 2000];
    const t = track([shot("army", 0, 1920, army)], 1920);
    const points = span(t, 300, 1600);
    const steps = points.slice(1).map((p, i) => p.x - points[i].x);
    const jolts = steps.slice(1).map((d, i) => Math.abs(d - steps[i]));
    expect(Math.max(...jolts)).toBeLessThan(0.1);
    // Steady, the army is on the screen and the camera is ahead of it.
    for (const p of points.filter((p) => p.frame > 600)) {
      const [ax] = army(p.frame);
      expect(Math.abs(ax - p.x)).toBeLessThan(VIEW.width / 2);
      expect(p.x).toBeGreaterThan(ax);
    }
  });

  it("is nothing without shots", () => {
    expect(cameraTrack([], { view: VIEW, map: MAP, frames: 100, rate: RATE })).toBeNull();
  });
});

describe("reading a track", () => {
  const t: CameraTrack = { every: 2, x: Float32Array.from([0, 10, 20, 30, 500, 510]), y: Float32Array.from([0, 0, 0, 0, 0, 0]), cut: Uint8Array.from([1, 0, 0, 0, 1, 0]) };
  it("curves through its points, fractions of a frame too", () => {
    expect(trackAt(t, 2).x).toBeCloseTo(10);
    expect(trackAt(t, 3).x).toBeCloseTo(15);
    expect(trackAt(t, 2.5).x).toBeCloseTo(12.5);
  });
  it("holds its point up to a cut, and does not bend across one", () => {
    expect(trackAt(t, 7).x).toBeCloseTo(30);
    expect(trackAt(t, 8).x).toBeCloseTo(500);
    expect(trackAt(t, 9).x).toBeCloseTo(505);
    // Before the cut the curve is not pulled towards 500.
    expect(trackAt(t, 5).x).toBeGreaterThan(24);
    expect(trackAt(t, 5).x).toBeLessThan(26);
  });
  it("holds the first point before the game and the last after it", () => {
    expect(trackAt(t, -5).x).toBe(0);
    expect(trackAt(t, 100).x).toBe(510);
  });
});

describe("a shot's curve", () => {
  it("goes through the shot's points with no corner between them", () => {
    const path = [{ frame: 0, x: 0, y: 0 }, { frame: 48, x: 48, y: 0 }, { frame: 96, x: 48, y: 48 }];
    expect(along(path, 48)).toEqual({ x: 48, y: 0 });
    const before = along(path, 47), after = along(path, 49);
    expect(Math.abs((after.x - 48) - (48 - before.x))).toBeLessThan(0.1);
  });
});
