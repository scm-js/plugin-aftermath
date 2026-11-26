import { describe, expect, it } from "vitest";
import { COUNT_UNTIL, covered, macro, merged, type MacroData } from "../macro";
import { keySteps, opening, supplyAt, type Step } from "../opening";
import type { MadeRow } from "../played";
import type { PlayerSeries, ReplayTimeline, UnitEvent } from "../vendor/scm-sim";

const EVERY = 48;
// The game's numbers: Command Center, SCV, Barracks, Marine, Comsat Station, Hatchery, Larva, Egg, Drone, Zergling.
const CC = 106, SCV = 7, RAX = 111, MARINE = 0, COMSAT = 107, HATCH = 131, LARVA = 35, EGG = 36, DRONE = 41, LING = 37;
const COSTS: Record<number, [number, number, number]> = { [SCV]: [50, 0, 300], [MARINE]: [50, 0, 360], [DRONE]: [50, 0, 300], [LING]: [50, 0, 420] };
const data: MacroData = {
  buildTime: (type) => COSTS[type]?.[2] ?? null,
  cost: (type) => ({ minerals: COSTS[type]?.[0] ?? 0, gas: COSTS[type]?.[1] ?? 0 }),
  addon: (type) => type === COMSAT,
};

/** A timeline of one player (slot 0) over `end` frames, with `minerals` at every sample and supply to spare unless `blocked`. */
function timeline(end: number, events: UnitEvent[], minerals: (frame: number) => number = () => 500, blocked: (frame: number) => boolean = () => false, race = 1): ReplayTimeline {
  const f = Array.from({ length: Math.floor(end / EVERY) + 1 }, (_, i) => i * EVERY);
  const s: PlayerSeries = {
    slot: 0, minerals: f.map(minerals), gas: f.map(() => 0),
    supplyUsed: f.map((x) => (blocked(x) ? 10 : 5)), supplyMax: f.map(() => 10),
    workers: f.map(() => 4), army: f.map(() => 0), armyValue: f.map(() => 0), buildings: f.map(() => 1),
  };
  return {
    version: 5, frames: end, total: end, ended: null, map: { width: 128, height: 128 },
    players: [{ slot: 0, name: "A", race }], events: [...events].sort((a, b) => a.frame - b.frame), research: [],
    samples: { every: EVERY, frame: f, players: [s] }, positions: null,
  };
}

let next = 0;
const ev = (frame: number, kind: UnitEvent["kind"], unit: number, type: number, x: number, y: number, extra: Partial<UnitEvent> = {}): UnitEvent => ({ frame, kind, unit, type, owner: 0, x, y, ...extra });
/** A building there from `from`, finished at `done`. */
function building(type: number, x: number, y: number, from: number, done: number): UnitEvent[] {
  const u = next++;
  return [ev(from, "born", u, type, x, y), ev(done, "done", u, type, x, y)];
}
/** A unit trained at the building in the middle `x`, `y`: born there when begun, done `time` later. */
function trained(type: number, x: number, y: number, from: number, time: number): UnitEvent[] {
  const u = next++;
  return [ev(from, "born", u, type, x, y), ev(from + time, "done", u, type, x + 40, y + 40)];
}

describe("production rhythm", () => {
  it("tells a building's work by the units born at its middle, and idle time between", () => {
    // (What is there at frame 0 was not trained: the first round begins a few frames in.)
    const events = [...building(CC, 100, 100, 0, 0), ...trained(SCV, 100, 100, 10, 290), ...trained(SCV, 100, 100, 600, 300)];
    const m = macro(timeline(1200, events), [0], data);
    const lane = m.players[0].lanes[0];
    expect(lane.kind).toBe("workers");
    expect(merged(lane.busy)).toEqual([{ from: 10, to: 300 }, { from: 600, to: 900 }]);
    expect(lane.idle).toEqual([{ from: 0, to: 10 }, { from: 300, to: 600 }, { from: 900, to: 1200 }]);
    expect(m.players[0].noWorker).toBe(610);
    expect(m.players[0].workersShort).toBe(2);
  });

  it("counts idle only while the player could pay and had the supply", () => {
    const events = [...building(CC, 100, 100, 0, 0), ...trained(SCV, 100, 100, 10, 290)];
    // No money from 480 to 720, supply blocked from 960.
    const m = macro(timeline(1200, events, (f) => (f >= 480 && f < 720 ? 20 : 500), (f) => f >= 960), [0], data);
    expect(m.players[0].lanes[0].idle).toEqual([{ from: 0, to: 10 }, { from: 300, to: 480 }, { from: 720, to: 960 }]);
  });

  it("keeps a building that never trained idle, by what its kind made elsewhere", () => {
    const events = [...building(CC, 100, 100, 0, 0), ...building(RAX, 300, 100, 0, 100), ...building(RAX, 500, 100, 0, 100), ...trained(MARINE, 300, 100, 100, 360)];
    const m = macro(timeline(1200, events), [0], data);
    const rax = m.players[0].lanes.filter((l) => l.kind === "units");
    expect(rax).toHaveLength(2);
    expect(covered(rax[1].idle)).toBe(1100);
    expect(rax[1].makes).toBe(MARINE);
    expect(m.players[0].productionIdle).toBe(1100 + (1200 - 460));
  });

  it("holds a building busy while its add-on goes up", () => {
    const comsat = next++;
    const events = [...building(CC, 100, 100, 0, 0), ...trained(SCV, 100, 100, 10, 290), ev(400, "born", comsat, COMSAT, 180, 116), ev(900, "done", comsat, COMSAT, 180, 116)];
    const lane = macro(timeline(1200, events), [0], data).players[0].lanes[0];
    expect(merged(lane.busy)).toEqual([{ from: 10, to: 300 }, { from: 400, to: 900 }]);
  });

  it("follows a building that lifted off by what it trains where it landed", () => {
    const events = [...building(CC, 100, 100, 0, 0), ...building(RAX, 300, 100, 0, 100), ...trained(MARINE, 300, 100, 100, 360), ...trained(MARINE, 900, 600, 600, 360)];
    const rax = macro(timeline(1200, events), [0], data).players[0].lanes.find((l) => l.kind === "units")!;
    expect(merged(rax.busy)).toEqual([{ from: 100, to: 460 }, { from: 600, to: 960 }]);
  });

  it("takes no worker leaving a refinery for one trained", () => {
    const scv = next++;
    const events = [...building(CC, 100, 100, 0, 0), ...building(110, 300, 100, 0, 0), ev(500, "born", scv, SCV, 300, 100), ev(500, "done", scv, SCV, 300, 100)];
    const lanes = macro(timeline(1200, events), [0], data).players[0].lanes;
    expect(lanes.every((l) => l.type !== 110)).toBe(true);
  });

  it("counts larvae waiting at a full hatchery", () => {
    const events: UnitEvent[] = [...building(HATCH, 1000, 1000, 0, 0)];
    // Three larvae from the start, one used at 600 (an egg that becomes a Drone).
    const larvae = [next++, next++, next++];
    for (const u of larvae) events.push(ev(0, "born", u, LARVA, 1000, 1060));
    events.push(ev(600, "morph", larvae[0], EGG, 1000, 1060, { from: LARVA }), ev(900, "morph", larvae[0], DRONE, 1000, 1060, { from: EGG }));
    // The hatchery is the first event of frame 0 here, so its larvae find it.
    const m = macro(timeline(1200, events, () => 500, () => false, 0), [0], data);
    const p = m.players[0];
    const lane = p.lanes.find((l) => l.kind === "larvae")!;
    expect(lane.idle).toEqual([{ from: 0, to: 600 }]);
    expect(p.larvaeWaiting).toBe(600);
    expect(p.noWorker).toBeNull();
  });

  it("lists the gaps a building was used again after, and stops counting workers at 10 minutes", () => {
    const end = COUNT_UNTIL + 2000;
    const events = [...building(CC, 100, 100, 0, 0), ...trained(SCV, 100, 100, 10, 290), ...trained(SCV, 100, 100, 1000, 300), ...trained(SCV, 100, 100, COUNT_UNTIL + 1000, 300)];
    const m = macro(timeline(end, events), [0], data);
    expect(m.players[0].noWorker).toBe(10 + 700 + (COUNT_UNTIL - 1300));
    expect(m.gaps.map((g) => [g.kind, g.from])).toEqual([["workers", 1300], ["workers", 300]]);
  });
});

/** Steps from (frame, type, supply) triples: buildings unless the type is a unit's. */
const steps = (list: [number, number, number][], units: number[] = []): Step[] => list.map(([frame, id, supply]) => ({
  row: { kind: "unit", frame, id, done: null, lost: null, building: !units.includes(id), x: 0, y: 0, count: 1 } as MadeRow, supply,
}));

describe("openings", () => {
  it("names a Zerg's pool, overpool and hatch first", () => {
    expect(opening(steps([[700, 142, 9], [1200, 131, 11]]), 0, null, [])).toMatchObject({ kind: "pool", n: 9 });
    expect(opening(steps([[600, 42, 9], [700, 142, 9]], [42]), 0, null, [])).toMatchObject({ kind: "overpool" });
    expect(opening(steps([[1000, 131, 12], [1200, 142, 11]]), 0, null, [])).toMatchObject({ kind: "hatch-pool", n: 12, m: 11 });
  });

  it("names a Terran's and a Protoss's", () => {
    expect(opening(steps([[700, 111, 8], [800, 111, 9], [900, 109, 10]]), 1, null, [])).toMatchObject({ kind: "bbs" });
    expect(opening(steps([[600, 109, 9], [1000, 111, 11], [1600, 106, 15]]), 1, null, [])).toMatchObject({ kind: "rax-fe" });
    expect(opening(steps([[600, 109, 9], [1000, 111, 11], [1600, 113, 15], [2000, 114, 20]]), 1, null, [])).toMatchObject({ kind: "one-one-one" });
    expect(opening(steps([[600, 156, 8], [900, 166, 10], [1300, 154, 13], [1500, 160, 14]]), 2, null, [])).toMatchObject({ kind: "forge-fe" });
    expect(opening(steps([[600, 156, 8], [900, 154, 11], [1300, 166, 12]]), 2, null, [])).toMatchObject({ kind: "nexus-first", n: 11 });
    expect(opening(steps([[600, 156, 8], [900, 160, 10], [1100, 160, 12], [1600, 164, 15]]), 2, null, [])).toMatchObject({ kind: "gates", n: 2 });
  });

  it("calls a first production building nearer an opponent's start a proxy", () => {
    const s = steps([[700, 160, 9], [900, 160, 10]]);
    for (const x of s) { x.row.x = 3500; x.row.y = 3500; }
    expect(opening(s, 2, { x: 200, y: 200 }, [{ x: 3800, y: 3800 }])).toMatchObject({ kind: "gates", proxy: true });
  });

  it("writes the first buildings, not the supply ones, on the card", () => {
    expect(keySteps(steps([[600, 156, 8], [900, 166, 10], [1300, 154, 13], [1400, 156, 14], [1500, 160, 14]])).map((s) => s.row.id)).toEqual([166, 154, 160]);
  });

  it("counts the supply at the sample before, with the workers started since", () => {
    const events = [...building(CC, 100, 100, 0, 0), ...trained(SCV, 100, 100, 60, 300)];
    const t = timeline(400, events);
    // Sample 48 says 5; an SCV begun at 60 makes it 6 by 80.
    expect(supplyAt(t, 0, 80)).toBe(6);
    expect(supplyAt(t, 0, 50)).toBe(5);
    expect(supplyAt(t, 0, 0)).toBeNull();
  });
});
