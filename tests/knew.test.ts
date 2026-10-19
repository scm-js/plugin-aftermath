import { describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import { armyInSight, firstLooks, knowledge, scouts, stateAt, threats, unseen } from "../knew";

const SCV = 7, MARINE = 0, TURRET = 124, BARRACKS = 111, PROBE = 64, GATEWAY = 160, STARGATE = 167, CARRIER = 72, DT = 61, ARCHIVES = 165;
const TERRAN = 1;

let next = 0;
const born = (frame: number, type: number, owner: number, x = 0, y = 0): UnitEvent => ({ frame, kind: "born", unit: next++, type, owner, x, y });
const ev = (frame: number, kind: UnitEvent["kind"], of: UnitEvent, type = of.type): UnitEvent => ({ frame, kind, unit: of.unit, type, owner: of.owner, x: of.x, y: of.y });
function timeline(events: UnitEvent[], sight: [unit: number, player: number, from: number, to: number, by?: number][], frames = 10000): ReplayTimeline {
  const sorted = [...events].sort((a, b) => a.frame - b.frame);
  return {
    version: 5, frames, total: frames, ended: null, map: { width: 128, height: 128 }, players: [{ slot: 0, name: "t", race: 1 }, { slot: 1, name: "p", race: 2 }],
    events: sorted, research: [], samples: { every: 1000, frame: Array.from({ length: frames / 1000 + 1 }, (_, i) => i * 1000), players: [] }, positions: null,
    sight: { every: 8, unit: Uint32Array.from(sight.map((s) => s[0])), player: Uint8Array.from(sight.map((s) => s[1])), from: Uint32Array.from(sight.map((s) => s[2])), to: Uint32Array.from(sight.map((s) => s[3])), by: Uint32Array.from(sight.map((s) => s[4] ?? 0xffffffff)) },
  };
}
const cost = (type: number) => (type === CARRIER ? 350 : type === DT ? 250 : 50);

describe("what each player knew", () => {
  it("reads a unit's state at a frame, morphs and the finish included", () => {
    const g = born(100, GATEWAY, 1);
    const k = knowledge(timeline([g, ev(500, "done", g), ev(900, "died", g)], []));
    const life = k.lives.get(g.unit)!;
    expect(stateAt(life, 99)).toBeNull();
    expect(stateAt(life, 200)).toEqual({ type: GATEWAY, done: false });
    expect(stateAt(life, 600)).toEqual({ type: GATEWAY, done: true });
    expect(stateAt(life, 900)).toBeNull();
  });

  it("finds a player's first look at the others, and their first building seen", () => {
    const probe = born(0, PROBE, 1), gate = born(1500, GATEWAY, 1), mine = born(0, SCV, 0);
    const k = knowledge(timeline([probe, gate, mine], [[probe.unit, 0, 1200, 1300], [gate.unit, 0, 2000, 2100], [mine.unit, 1, 800, 900]]));
    expect(firstLooks(k, 0, new Set([1]))).toEqual({ any: { frame: 1200, type: PROBE }, building: { frame: 2000, type: GATEWAY } });
    expect(firstLooks(k, 1, new Set([0]))).toEqual({ any: { frame: 800, type: SCV }, building: null });
  });

  it("finds each threat: when the others had it, when the player saw it, and the first answer", () => {
    const stargate = born(3000, STARGATE, 1), carrier = born(5000, CARRIER, 1), turret = born(4000, TURRET, 0);
    const archives = born(6000, ARCHIVES, 1);
    // The Stargate is never seen; the Carrier at 6500. The Templar Archives is seen at 7000 and nothing answers it.
    const k = knowledge(timeline([stargate, carrier, turret, archives], [[carrier.unit, 0, 6500, 6600], [archives.unit, 0, 7000, 7100]]));
    expect(threats(k, 0, TERRAN, new Set([1]))).toEqual([
      // The Turret was there before the Templar Archives was started: one the player already had, not an answer to it.
      { kind: "cloaked", made: { frame: 6000, type: ARCHIVES }, seen: { frame: 7000, type: ARCHIVES }, answer: null, already: { frame: 4000, type: TURRET } },
      // Started once the Stargate was, before it was seen.
      { kind: "air", made: { frame: 3000, type: STARGATE }, seen: { frame: 6500, type: CARRIER }, answer: { frame: 4000, type: TURRET }, already: null },
    ]);
  });

  it("ranks the others' buildings by how long they stood unseen", () => {
    const rax = born(1000, BARRACKS, 0), gate = born(1000, GATEWAY, 1), stargate = born(2000, STARGATE, 1), start = born(0, GATEWAY, 1);
    const t = timeline([rax, gate, stargate, ev(5000, "died", stargate), start], [[gate.unit, 0, 1500, 1600]]);
    expect(unseen(knowledge(t), t, 0, new Set([1])).map((u) => [u.type, u.seen, u.unseenFor])).toEqual([[STARGATE, null, 3000], [GATEWAY, 1500, 500]]);
  });

  it("measures the share of the others' army a player could see, by cost, finished units only", () => {
    const dt = born(1500, DT, 1), carrier = born(1500, CARRIER, 1), probe = born(0, PROBE, 1);
    const events = [dt, ev(1800, "done", dt), carrier, ev(1900, "done", carrier), probe];
    const t = timeline(events, [[dt.unit, 0, 1900, 2100], [probe.unit, 0, 0, 9000]], 3000);
    const a = armyInSight(knowledge(t), t, 0, new Set([1]), cost);
    expect(a.frames).toEqual([0, 1000, 2000, 3000]);
    expect(a.total).toEqual([0, 0, 600, 600]);
    expect(a.seen).toEqual([0, 0, 250, 0]);
    expect(a.share).toBeCloseTo(250 / 1200);
  });
});

describe("the map as a player knew it", () => {
  const GATE = 160, ZEALOT = 65;
  it("shows what is seen, remembers a building as it was until it is seen gone, a unit for half a minute, and the rest as unseen", async () => {
    const { knownAt, placedBuildings, trails, knowledge: know } = await import("../knew");
    const gate = born(100, GATE, 1, 500, 600), zealot = born(200, ZEALOT, 1, 50, 60), hidden = born(300, GATE, 1, 900, 900);
    const events = [gate, ev(400, "done", gate), ev(3000, "died", gate), zealot, ev(250, "done", zealot), hidden];
    const t = timeline(events, [[gate.unit, 0, 1000, 1100], [zealot.unit, 0, 1000, 1100]], 4000);
    t.positions = { every: 500, frame: [1000, 1500, 2000], start: Uint32Array.from([0, 1, 2, 3]), unit: Uint32Array.from([zealot.unit, zealot.unit, zealot.unit]), x: Uint16Array.from([70, 400, 800]), y: Uint16Array.from([80, 400, 800]) };
    const k = know(t), where = trails(t), placed = placedBuildings(t), them = new Set([1]);
    const at = (f: number) => knownAt(k, where, placed, 0, them, f).map((x) => `${x.unit}:${x.known}@${x.x},${x.y}`).sort();
    // While seen: where they are.
    expect(at(1050)).toEqual([`${gate.unit}:seen@500,600`, `${hidden.unit}:unseen@900,900`, `${zealot.unit}:seen@70,80`].sort());
    // After: the zealot where it was last seen, though it walked on; the gateway as it was.
    expect(at(1500)).toEqual([`${gate.unit}:remembered@500,600`, `${hidden.unit}:unseen@900,900`, `${zealot.unit}:remembered@70,80`].sort());
    // Past half a minute the zealot is no longer on their map, only the truth; the gateway is, even once it is gone.
    expect(at(3500)).toEqual([`${gate.unit}:remembered@500,600`, `${hidden.unit}:unseen@900,900`, `${zealot.unit}:unseen@800,800`].sort());
  });
});

describe("a scout's worth", () => {
  it("credits each opponent's unit to the unit that showed it first, and counts the new kinds", () => {
    const scv = born(0, SCV, 0), marine = born(500, MARINE, 0);
    const gate = born(100, GATEWAY, 1), gate2 = born(300, GATEWAY, 1), probe = born(0, PROBE, 1), dt = born(2000, DT, 1);
    const t = timeline([scv, marine, gate, gate2, probe, dt], [
      [gate.unit, 0, 1000, 1100, scv.unit], [probe.unit, 0, 1010, 1100, scv.unit], [gate2.unit, 0, 1020, 1100, scv.unit],
      // Seen again later by the marine: not a first, so not the marine's.
      [gate.unit, 0, 3000, 3100, marine.unit], [dt.unit, 0, 3000, 3100, marine.unit],
      // Seen first through no unit of theirs: nobody's.
      [probe.unit, 0, 5, 9],
    ]);
    const list = scouts(knowledge(t), 0, new Set([1]), cost);
    expect(list.map((s) => [s.unit, s.type, s.worth, s.kinds, s.revealed.length])).toEqual([
      [marine.unit, MARINE, 250, [DT], 1],
      [scv.unit, SCV, 100, [GATEWAY], 2],
    ]);
  });
});
