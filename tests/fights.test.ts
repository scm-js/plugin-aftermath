import { describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import { fights, kills, topKillers } from "../fights";
import { unitIndex } from "../played";

const MARINE = 0, TANK = 5, ZERGLING = 37, SCV = 7, SCARAB = 85;
const cost = (type: number) => (type === TANK ? 250 : type === ZERGLING ? 25 : 50);
let next = 0;
const born = (type: number, owner: number, x = 0, y = 0): UnitEvent => ({ frame: 0, kind: "born", unit: next++, type, owner, x, y });
const died = (frame: number, of: UnitEvent, x: number, y: number, by?: UnitEvent): UnitEvent => ({ frame, kind: "died", unit: of.unit, type: of.type, owner: of.owner, x, y, ...(by ? { by: by.unit, byType: by.type, byOwner: by.owner, byX: by.x, byY: by.y } : {}) });
const timeline = (events: UnitEvent[], more: Partial<ReplayTimeline> = {}): ReplayTimeline => ({ version: 2, frames: 5000, total: 5000, ended: null, map: { width: 128, height: 128 }, players: [], events, research: [], samples: { every: 48, frame: [], players: [] }, positions: null, ...more });

describe("fights", () => {
  it("makes one fight of deaths close in time and place, with what each side lost and killed and who came out ahead", () => {
    next = 0;
    const tank = born(TANK, 0, 1000, 1000), marines = [born(MARINE, 0), born(MARINE, 0)], lings = Array.from({ length: 8 }, () => born(ZERGLING, 1));
    const events = [tank, ...marines, ...lings,
      ...lings.slice(0, 6).map((l, i) => died(1000 + i * 20, l, 1050 + i, 1000, tank)),
      died(1040, marines[0], 1040, 1010, lings[6]), died(1100, marines[1], 1045, 1012, lings[7]),
    ].sort((a, b) => a.frame - b.frame);
    const t = timeline(events);
    const [f, ...rest] = fights(t, cost, unitIndex(t));
    expect(rest).toEqual([]);
    expect([f.from, f.to, f.losses, f.value, f.winner]).toEqual([1000, 1100, 8, 250, 0]);
    expect(f.sides.map((s) => [s.player, s.lost, s.lostValue, s.killed, s.killedValue])).toEqual([[0, 2, 100, 6, 150], [1, 6, 150, 2, 100]]);
    expect([...f.sides[1].lostTypes]).toEqual([[ZERGLING, 6]]);
    expect(f.rect.x0).toBe(1040);
  });

  it("keeps apart what is far away or long after, and does not list a death or two", () => {
    next = 0;
    const a = Array.from({ length: 5 }, () => born(MARINE, 0)), b = Array.from({ length: 5 }, () => born(MARINE, 1)), c = Array.from({ length: 5 }, () => born(MARINE, 0)), lone = born(MARINE, 1);
    const events = [...a, ...b, ...c, lone,
      ...a.map((u, i) => died(1000 + i, u, 500, 500)),
      ...b.map((u, i) => died(1002 + i, u, 3000, 3000)),
      ...c.map((u, i) => died(2000 + i, u, 510, 500)),
      died(4000, lone, 100, 100),
    ].sort((x, y) => x.frame - y.frame);
    const t = timeline(events);
    expect(fights(t, cost, unitIndex(t)).map((f) => [f.from, Math.round(f.x), f.losses])).toEqual([[1000, 500, 5], [1002, 3000, 5], [2000, 510, 5]]);
  });

  it("calls a fight even when neither side is clearly ahead, and leaves out a scarab going off", () => {
    next = 0;
    const a = [born(MARINE, 0), born(MARINE, 0)], b = [born(MARINE, 1), born(MARINE, 1)], scarab = born(SCARAB, 1);
    const events = [...a, ...b, scarab, died(100, a[0], 10, 10, b[0]), died(101, b[0], 12, 10, a[1]), died(102, a[1], 11, 10, b[1]), died(103, b[1], 12, 12, a[0]), died(104, scarab, 12, 12)];
    const t = timeline(events);
    const [f] = fights(t, cost, unitIndex(t));
    expect([f.losses, f.winner]).toEqual([4, null]);
  });

  it("counts who was there when it began, from the sample before", () => {
    next = 0;
    const m = Array.from({ length: 4 }, () => born(MARINE, 0)), z = Array.from({ length: 4 }, () => born(ZERGLING, 1)), far = born(TANK, 0), scv = born(SCV, 0);
    const events = [...m, ...z, far, scv, ...z.map((u, i) => died(100 + i, u, 500, 500, m[0]))];
    const all = [...m, ...z, far, scv];
    const t = timeline(events, { positions: { every: 48, frame: [96, 480], start: Uint32Array.from([0, all.length, all.length]), unit: Uint32Array.from(all.map((u) => u.unit)), x: Uint16Array.from(all.map((u) => (u === far ? 4000 : 520))), y: Uint16Array.from(all.map(() => 500)) } });
    const [f] = fights(t, cost, unitIndex(t));
    expect(f.sides.map((s) => [s.player, s.army, s.armyValue])).toEqual([[0, 4, 200], [1, 4, 100]]);
  });
});

describe("kills", () => {
  it("lists the units that killed the most, and each kill for the map", () => {
    next = 0;
    const tank = born(TANK, 0, 900, 900), marine = born(MARINE, 0, 10, 10), lings = Array.from({ length: 3 }, () => born(ZERGLING, 1)), other = born(TANK, 1);
    const events = [tank, marine, ...lings, other, died(50, lings[0], 1, 1, marine), died(60, lings[1], 2, 2, tank), died(70, other, 3, 3, tank), died(80, lings[2], 4, 4)];
    const t = timeline(events);
    expect(topKillers(t, cost).map((k) => [k.unit, k.type, k.player, k.kills, k.value, k.frame])).toEqual([[tank.unit, TANK, 0, 2, 275, 60], [marine.unit, MARINE, 0, 1, 25, 50]]);
    expect(kills(t).map((k) => [k.frame, k.fromX, k.x, k.player, k.by])).toEqual([[50, 10, 1, 1, 0], [60, 900, 2, 1, 0], [70, 900, 3, 1, 0]]);
  });
});
