import { describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import { buildings, losses, lossPoints, madeRows, presencePoints, sampleAt, series, unitIndex, unitsAt } from "../played";

const SCV = 7, MARINE = 0, DRONE = 41, LARVA = 35, EGG = 36, ZERGLING = 37, HATCHERY = 131, LAIR = 132, DEPOT = 109, BARRACKS = 111, GEYSER = 188, REFINERY = 110;
const ev = (frame: number, kind: UnitEvent["kind"], unit: number, type: number, owner: number, more: Partial<UnitEvent> = {}): UnitEvent => ({ frame, kind, unit, type, owner, x: unit * 10, y: unit * 10, ...more });

function timeline(events: UnitEvent[], more: Partial<ReplayTimeline> = {}): ReplayTimeline {
  return { version: 1, frames: 1000, total: 1000, ended: null, map: { width: 64, height: 64 }, players: [{ slot: 0, name: "a", race: 1 }, { slot: 1, name: "b", race: 0 }], events, research: [], samples: { every: 48, frame: [], players: [] }, positions: null, ...more };
}

describe("what was really made", () => {
  it("lists what a player started, when it was finished and when it was lost, and not what was there at the start", () => {
    const t = timeline([
      ev(0, "born", 0, 106, 0), ev(0, "done", 0, 106, 0), ev(0, "born", 1, SCV, 0), ev(0, "done", 1, SCV, 0),
      ev(100, "born", 2, DEPOT, 0), ev(700, "done", 2, DEPOT, 0),
      ev(800, "born", 3, BARRACKS, 0), ev(900, "died", 3, BARRACKS, 0),
      ev(820, "born", 4, MARINE, 1),
    ]);
    expect(madeRows(t, 0).map((r) => [r.frame, r.id, r.done, r.lost, r.building])).toEqual([[100, DEPOT, 700, null, true], [800, BARRACKS, null, 900, true]]);
  });

  it("dates a zerg unit from its egg and a zerg building from the drone that became it", () => {
    const t = timeline([
      ev(0, "born", 0, LARVA, 1), ev(0, "done", 0, LARVA, 1),
      ev(50, "morph", 0, EGG, 1, { from: LARVA }), ev(300, "morph", 0, DRONE, 1, { from: EGG }), ev(300, "done", 0, DRONE, 1),
      ev(500, "morph", 0, HATCHERY, 1, { from: DRONE }), ev(2000, "done", 0, HATCHERY, 1),
      ev(3000, "morph", 0, LAIR, 1, { from: HATCHERY }), ev(4000, "done", 0, LAIR, 1),
    ]);
    expect(madeRows(t, 1, { workers: true }).map((r) => [r.frame, r.id, r.done])).toEqual([[50, DRONE, 300], [500, HATCHERY, 2000], [3000, LAIR, 4000]]);
    // Without the workers the drone's line goes, the buildings stay.
    expect(madeRows(t, 1).map((r) => r.id)).toEqual([HATCHERY, LAIR]);
  });

  it("counts a cancelled building as lost and not the drone that comes back as made", () => {
    const t = timeline([
      ev(10, "born", 0, DRONE, 1), ev(10, "done", 0, DRONE, 1),
      ev(500, "morph", 0, HATCHERY, 1, { from: DRONE }), ev(600, "morph", 0, DRONE, 1, { from: HATCHERY }),
    ]);
    expect(madeRows(t, 1, { workers: true }).map((r) => [r.id, r.done, r.lost])).toEqual([[DRONE, 10, null], [HATCHERY, null, 600]]);
  });

  it("gives a refinery to the player who built it on the geyser", () => {
    const t = timeline([ev(0, "born", 0, GEYSER, 11), ev(400, "morph", 0, REFINERY, 0, { from: GEYSER }), ev(400, "given", 0, REFINERY, 0, { from: 11 }), ev(900, "done", 0, REFINERY, 0)]);
    expect(madeRows(t, 0).map((r) => [r.frame, r.id, r.done])).toEqual([[400, REFINERY, 900]]);
  });

  it("folds units of one type started close together, leaves hallucinations out and puts research in its place", () => {
    const t = timeline([
      ev(100, "born", 0, MARINE, 0), ev(120, "born", 1, MARINE, 0), ev(150, "born", 2, MARINE, 0), ev(900, "born", 3, MARINE, 0),
      ev(950, "born", 4, MARINE, 0, { hallucination: true }), ev(960, "died", 4, MARINE, 0),
    ], { research: [{ frame: 500, player: 0, kind: "upgrade", id: 7, level: 1 }, { frame: 600, player: 1, kind: "tech", id: 3, level: 1 }] });
    expect(madeRows(t, 0).map((r) => [r.kind, r.frame, r.id, r.count])).toEqual([["unit", 100, MARINE, 3], ["upgrade", 500, 7, 1], ["unit", 900, MARINE, 1]]);
  });
});

describe("the buildings as they stood", () => {
  it("gives each its time, a new entry when it becomes another type, and an end when it falls", () => {
    const t = timeline([
      ev(0, "born", 0, HATCHERY, 1), ev(0, "done", 0, HATCHERY, 1),
      ev(3000, "morph", 0, LAIR, 1, { from: HATCHERY }), ev(4000, "done", 0, LAIR, 1), ev(5000, "died", 0, LAIR, 1),
      ev(10, "born", 1, MARINE, 0),
    ]);
    expect(buildings(t).map((s) => [s.type, s.from, s.done, s.to])).toEqual([[HATCHERY, 0, 0, 3000], [LAIR, 3000, 4000, 5000]]);
  });

  it("starts a refinery when the geyser becomes one, and finishes it when it is done", () => {
    const t = timeline([
      ev(0, "born", 0, GEYSER, 11),
      ev(400, "morph", 0, REFINERY, 0, { from: GEYSER }), ev(400, "given", 0, REFINERY, 0, { from: 11 }), ev(1000, "done", 0, REFINERY, 0),
      ev(2000, "given", 0, REFINERY, 11, { from: 0 }),
    ]);
    expect(buildings(t).map((s) => [s.type, s.owner, s.from, s.done, s.to])).toEqual([[REFINERY, 0, 400, 1000, 2000]]);
  });
});

describe("losses", () => {
  const t = timeline([
    ev(0, "born", 0, MARINE, 0), ev(0, "born", 1, MARINE, 0, { hallucination: true }), ev(0, "born", 2, LARVA, 1), ev(0, "born", 3, DEPOT, 0), ev(0, "born", 4, MARINE, 1),
    ev(100, "died", 0, MARINE, 0), ev(110, "died", 1, MARINE, 0), ev(120, "died", 2, LARVA, 1), ev(130, "died", 3, DEPOT, 0),
    ev(200, "given", 4, MARINE, 11, { from: 1 }), ev(300, "died", 4, MARINE, 11),
  ]);
  it("counts real units and buildings, not hallucinations, larvae or what a leaver left behind", () => {
    expect(lossPoints(t).map((p) => [p.frame, p.player])).toEqual([[100, 0], [130, 0]]);
    expect([...losses(t, (type) => (type === DEPOT ? 100 : 50))]).toEqual([[0, { units: 2, value: 150 }]]);
  });
});

describe("where units stood", () => {
  const t = timeline([ev(0, "born", 0, MARINE, 0), ev(0, "born", 1, SCV, 0), ev(0, "born", 2, LARVA, 1), ev(0, "born", 3, LARVA, 1), ev(40, "morph", 3, EGG, 1), ev(90, "morph", 3, ZERGLING, 1)], {
    positions: { every: 48, frame: [0, 48, 96], start: Uint32Array.from([0, 2, 5, 6]), unit: Uint32Array.from([0, 1, 0, 1, 3, 0]), x: Uint16Array.from([0, 5, 100, 5, 7, 200]), y: Uint16Array.from([0, 5, 0, 5, 7, 0]) },
  });
  it("finds the sample of a frame", () => {
    expect([-1, 0, 47, 48, 500].map((f) => sampleAt([0, 48, 96], f))).toEqual([-1, 0, 0, 1, 2]);
  });
  it("moves a unit between two samples and leaves one that is gone where it was", () => {
    const at = (frame: number) => { const out: number[][] = []; unitsAt(t, frame, (u, x, y) => out.push([u, x, y])); return out; };
    expect(at(0)).toEqual([[0, 0, 0], [1, 5, 5]]);
    expect(at(24)).toEqual([[0, 50, 0], [1, 5, 5]]);
    expect(at(72)).toEqual([[0, 150, 0], [1, 5, 5], [3, 7, 7]]);
    expect(at(96)).toEqual([[0, 200, 0]]);
  });
  it("counts fighting units for the heat: no workers, and no larva that stayed one", () => {
    expect([...presencePoints(t, unitIndex(t))].map((p) => [p.frame, p.player, p.x])).toEqual([[0, 0, 0], [48, 0, 100], [48, 1, 7], [96, 0, 200]]);
  });
});

describe("a player's numbers", () => {
  it("are the timeline's, by the game's player number", () => {
    const row = { slot: 2, minerals: [50, 60], gas: [0, 0], supplyUsed: [4, 5], supplyMax: [10, 10], workers: [4, 5], army: [0, 1], armyValue: [0, 50], buildings: [1, 1] };
    const t = timeline([], { samples: { every: 48, frame: [0, 48], players: [row] } });
    expect(series(t, 2, "armyValue")).toEqual([0, 50]);
    expect(series(t, 0, "armyValue")).toBeNull();
  });
});
