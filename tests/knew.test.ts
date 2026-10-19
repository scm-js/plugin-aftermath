import { describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import { armyInSight, firstLooks, knowledge, stateAt, threats, unseen } from "../knew";

const SCV = 7, MARINE = 0, TURRET = 124, BARRACKS = 111, PROBE = 64, GATEWAY = 160, STARGATE = 167, CARRIER = 72, DT = 61, ARCHIVES = 165;
const TERRAN = 1;

let next = 0;
const born = (frame: number, type: number, owner: number, x = 0, y = 0): UnitEvent => ({ frame, kind: "born", unit: next++, type, owner, x, y });
const ev = (frame: number, kind: UnitEvent["kind"], of: UnitEvent, type = of.type): UnitEvent => ({ frame, kind, unit: of.unit, type, owner: of.owner, x: of.x, y: of.y });
function timeline(events: UnitEvent[], sight: [unit: number, player: number, from: number, to: number][], frames = 10000): ReplayTimeline {
  const sorted = [...events].sort((a, b) => a.frame - b.frame);
  return {
    version: 5, frames, total: frames, ended: null, map: { width: 128, height: 128 }, players: [{ slot: 0, name: "t", race: 1 }, { slot: 1, name: "p", race: 2 }],
    events: sorted, research: [], samples: { every: 1000, frame: Array.from({ length: frames / 1000 + 1 }, (_, i) => i * 1000), players: [] }, positions: null,
    sight: { every: 8, unit: Uint32Array.from(sight.map((s) => s[0])), player: Uint8Array.from(sight.map((s) => s[1])), from: Uint32Array.from(sight.map((s) => s[2])), to: Uint32Array.from(sight.map((s) => s[3])) },
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
