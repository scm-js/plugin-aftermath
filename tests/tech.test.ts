import { describe, expect, it } from "vitest";
import { FRAMES_PER_MINUTE as MINUTE } from "../analysis";
import { packRows } from "../charts";
import { armyRows, researchItems, tech, techBuildings, type Durations } from "../tech";
import { tierOf } from "../techview";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";

const MARINE = 0, TANK = 5, SIEGED = 30, ZERGLING = 37, OVERLORD = 42, SCV = 7, LARVA = 35, EGG = 36;
const HATCHERY = 131, LAIR = 132, POOL = 142, GEYSER = 188, EXTRACTOR = 149, BARRACKS = 111, FACTORY = 113, DEPOT = 109;
const ev = (frame: number, kind: UnitEvent["kind"], unit: number, type: number, owner: number, more: Partial<UnitEvent> = {}): UnitEvent => ({ frame, kind, unit, type, owner, x: 0, y: 0, ...more });

function timeline(events: UnitEvent[], more: Partial<ReplayTimeline> = {}): ReplayTimeline {
  return {
    version: 4, frames: 5 * MINUTE, total: 5 * MINUTE, ended: null, map: { width: 64, height: 64 },
    players: [{ slot: 0, name: "a", race: 1 }, { slot: 1, name: "b", race: 0 }], events, research: [],
    samples: { every: 48, frame: [], players: [] }, positions: null, ...more,
  };
}

/** Build times and research times as the game's tables have them, for the few the tests use. */
const durations: Durations = (kind, id, level) => kind === "unit" ? ({ [LAIR]: 1500, [POOL]: 1200, [EXTRACTOR]: 600, [BARRACKS]: 1200, [FACTORY]: 1200 }[id] ?? null)
  : kind === "upgrade" ? 4000 + 480 * (level - 1) : 1200;
const unknown: Durations = () => null;

describe("tech buildings", () => {
  it("are the first of each kind finished, from their site to when they were done", () => {
    const t = timeline([
      ev(100, "born", 1, BARRACKS, 0), ev(1300, "done", 1, BARRACKS, 0),
      ev(900, "born", 2, BARRACKS, 0), ev(2100, "done", 2, BARRACKS, 0),
      ev(1500, "born", 3, FACTORY, 0), ev(1600, "died", 3, FACTORY, 0),
      ev(2000, "born", 4, FACTORY, 0), ev(3200, "done", 4, FACTORY, 0),
      ev(200, "born", 5, DEPOT, 0), ev(800, "done", 5, DEPOT, 0),
    ]);
    expect(techBuildings(t, [0], durations).get(0)!.map((b) => [b.id, b.start, b.done])).toEqual([[BARRACKS, 100, 1300], [FACTORY, 2000, 3200]]);
  });

  it("date a Lair from its build time, as the hall turns into one only when it is done", () => {
    const t = timeline([
      ev(0, "born", 0, HATCHERY, 1), ev(0, "done", 0, HATCHERY, 1),
      ev(5000, "morph", 0, LAIR, 1, { from: HATCHERY }), ev(5000, "done", 0, LAIR, 1),
      ev(0, "born", 1, GEYSER, 11),
      ev(1000, "morph", 1, EXTRACTOR, 1, { from: GEYSER }), ev(1000, "given", 1, EXTRACTOR, 1, { from: 11 }), ev(1600, "done", 1, EXTRACTOR, 1),
    ]);
    expect(techBuildings(t, [1], durations).get(1)!.map((b) => [b.id, b.start, b.done])).toEqual([[EXTRACTOR, 1000, 1600], [LAIR, 3500, 5000]]);
    expect(techBuildings(t, [1], unknown).get(1)!.map((b) => [b.id, b.start, b.done])).toEqual([[EXTRACTOR, 1000, 1600], [LAIR, 5000, 5000]]);
  });
});

describe("research", () => {
  const t = timeline([], { research: [
    { frame: 6000, player: 0, kind: "upgrade", id: 7, level: 1 }, { frame: 9000, player: 0, kind: "upgrade", id: 7, level: 2 },
    { frame: 3000, player: 0, kind: "tech", id: 0, level: 1 }, { frame: 100, player: 3, kind: "tech", id: 0, level: 1 },
  ] });

  it("begins its research time before it was seen done, each level its own", () => {
    expect(researchItems(t, [0], durations).get(0)!.map((r) => [r.kind, r.level, r.start, r.done])).toEqual([["tech", 1, 1800, 3000], ["upgrade", 1, 2000, 6000], ["upgrade", 2, 4520, 9000]]);
  });

  it("is a moment without the game's tables, and leaves out players not asked for", () => {
    const got = researchItems(t, [0], unknown);
    expect([...got.keys()]).toEqual([0]);
    expect(got.get(0)!.every((r) => r.start === r.done)).toBe(true);
  });

  it("keeps each upgrade's last level", () => {
    expect([...tech(t, [0], durations).players[0].levels]).toEqual([[7, 2]]);
  });
});

describe("the army", () => {
  it("counts each type at the end of every minute: tanks in either mode, no workers, overlords, larvae or hallucinations", () => {
    const t = timeline([
      ev(10, "born", 0, MARINE, 0), ev(20, "born", 1, MARINE, 0), ev(30, "born", 2, SCV, 0), ev(40, "born", 3, TANK, 0),
      ev(50, "born", 4, MARINE, 0, { hallucination: true }),
      ev(MINUTE + 5, "morph", 3, SIEGED, 0, { from: TANK }), ev(MINUTE + 6, "born", 5, TANK, 0),
      ev(MINUTE + 10, "died", 0, MARINE, 0),
      ev(2 * MINUTE + 1, "given", 1, MARINE, 11, { from: 0 }),
      ev(10, "born", 6, OVERLORD, 1), ev(20, "born", 7, LARVA, 1),
      ev(MINUTE + 1, "morph", 7, EGG, 1, { from: LARVA }), ev(2 * MINUTE + 1, "morph", 7, ZERGLING, 1, { from: EGG }),
    ]);
    const rows = armyRows(t, [0, 1]).map((r) => [r.player, r.type, r.perMinute, r.peak, r.first]);
    expect(rows).toEqual([
      [0, MARINE, [2, 1, 0, 0, 0], 2, 0],
      [0, TANK, [1, 2, 2, 2, 2], 2, 0],
      [1, ZERGLING, [0, 0, 1, 1, 1], 1, 2],
    ]);
  });
});

describe("tiers", () => {
  const item = (id: number, done: number) => ({ kind: "building" as const, id, level: 1, player: 0, start: done - 100, done });
  it("is the furthest a race's buildings took the player, and when", () => {
    expect(tierOf(0, [item(POOL, 100), item(LAIR, 500)])).toEqual({ tier: 2, item: item(LAIR, 500) });
    expect(tierOf(0, [item(LAIR, 500), item(133, 900)])?.tier).toBe(3);
    expect(tierOf(2, [item(167, 700)])?.tier).toBe(2);
    expect(tierOf(1, [item(BARRACKS, 300)])).toBeNull();
  });
});

describe("rows of bars", () => {
  it("puts each bar in the first row where it fits, the earliest first", () => {
    expect(packRows([{ from: 0, to: 10 }, { from: 5, to: 8 }, { from: 11, to: 20 }, { from: 9, to: 12 }], 1)).toEqual([0, 1, 0, 1]);
    expect(packRows([])).toEqual([]);
  });
});
