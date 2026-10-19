import { describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import { engagement, fights, kills, topKillers, type Fight } from "../fights";
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

describe("how much a fight mattered", () => {
  const DRONE = 41, HT = 67, ARCHON = 68, BUNKER = 125;
  /** Samples every 48 frames, the same numbers throughout unless `at` says otherwise from that frame. */
  const samples = (frames: number, players: { slot: number; army: number; armyValue: number; workers: number; at?: [number, number][] }[]) => {
    const frame = Array.from({ length: Math.ceil(frames / 48) }, (_, i) => i * 48);
    return {
      every: 48, frame,
      players: players.map((p) => {
        const value = (f: number) => [...(p.at ?? [])].reverse().find(([from]) => f >= from)?.[1] ?? p.armyValue;
        return { slot: p.slot, minerals: frame.map(() => 0), gas: frame.map(() => 0), supplyUsed: frame.map(() => 0), supplyMax: frame.map(() => 0), workers: frame.map(() => p.workers), army: frame.map(() => p.army), armyValue: frame.map(value), buildings: frame.map(() => 1) };
      }),
    };
  };
  const players = [{ slot: 0, name: "a", race: 1 }, { slot: 1, name: "b", race: 0 }];

  it("calls a fight decisive when one side lost much of what it had, and a few units lost in passing minor", () => {
    next = 0;
    const tanks = Array.from({ length: 4 }, () => born(TANK, 0)), lings = Array.from({ length: 40 }, () => born(ZERGLING, 1));
    const events = [...tanks, ...lings,
      // A: four zerglings lost in passing, from an army of 40 and twenty drones.
      ...lings.slice(0, 4).map((l, i) => died(500 + i, l, 300, 300, tanks[0])),
      // B: twenty more, and a tank, far off and later.
      ...lings.slice(4, 24).map((l, i) => died(3000 + i * 4, l, 2000, 2000, tanks[1])), died(3050, tanks[2], 2010, 2000, lings[30]),
    ];
    const t = timeline(events, { players, samples: samples(5000, [{ slot: 0, army: 4, armyValue: 1000, workers: 20 }, { slot: 1, army: 40, armyValue: 1000, workers: 20 }]) });
    const [a, b] = fights(t, cost, unitIndex(t));
    // B: the zerg lost 500 of 2000 (half its army and its drones at 50), the terran 250 of 2000.
    expect([a.tier, a.kind, b.tier, b.kind, b.winner]).toEqual(["minor", "battle", "major", "battle", 0]);
    expect(b.sides.map((s) => [s.player, s.lostValue, s.had])).toEqual([[0, 250, 2000], [1, 500, 2000]]);
    expect(b.share).toBeCloseTo(750 / 4000);
    // The zerg loses all but a few: decisive.
    next = 0;
    const tanks2 = Array.from({ length: 4 }, () => born(TANK, 0)), lings2 = Array.from({ length: 40 }, () => born(ZERGLING, 1));
    const t2 = timeline([...tanks2, ...lings2, ...lings2.map((l, i) => died(3000 + i * 2, l, 2000, 2000, tanks2[0]))], { players, samples: samples(5000, [{ slot: 0, army: 4, armyValue: 1000, workers: 20 }, { slot: 1, army: 40, armyValue: 1000, workers: 20 }]) });
    expect(fights(t2, cost, unitIndex(t2)).map((f) => [f.tier, f.winner])).toEqual([["decisive", 0]]);
  });

  it("says when a fight was about workers or buildings", () => {
    next = 0;
    const tank = born(TANK, 0), drones = Array.from({ length: 6 }, () => born(DRONE, 1)), bunkers = Array.from({ length: 4 }, () => born(BUNKER, 0)), ling = born(ZERGLING, 1), marine = born(MARINE, 0);
    const t = timeline([tank, ...drones, ...bunkers, ling,
      ...drones.map((d, i) => died(1000 + i * 10, d, 500, 500, tank)),
      ...bunkers.map((b, i) => died(4000 + i * 10, b, 2500, 2500, ling)), died(4040, marine, 2500, 2500, ling)]);
    expect(fights(t, cost, unitIndex(t)).map((f) => f.kind)).toEqual(["workers", "buildings"]);
  });

  it("leaves out the templar that went into an Archon", () => {
    next = 0;
    const hts = Array.from({ length: 8 }, () => born(HT, 1));
    const events: UnitEvent[] = [...hts];
    // Four pairs merge: one becomes the Archon, the other leaves with no killer, at that moment and place.
    for (let i = 0; i < 8; i += 2) {
      events.push({ frame: 1000 + i, kind: "morph", unit: hts[i].unit, type: ARCHON, owner: 1, x: 500, y: 500, from: HT });
      events.push({ frame: 1000 + i, kind: "died", unit: hts[i + 1].unit, type: HT, owner: 1, x: 510, y: 500 });
    }
    const t = timeline(events);
    expect(fights(t, cost, unitIndex(t))).toEqual([]);
  });

  it("makes one fight of one that pauses and comes again nearby", () => {
    next = 0;
    const a = Array.from({ length: 10 }, () => born(MARINE, 0)), b = Array.from({ length: 10 }, () => born(MARINE, 1));
    const t = timeline([...a, ...b,
      ...a.slice(0, 5).map((u, i) => died(1000 + i, u, 500, 500, b[0])),
      // Eight seconds later, twenty tiles on.
      ...b.slice(0, 5).map((u, i) => died(1200 + i, u, 1140, 500, a[9]))]);
    expect(fights(t, cost, unitIndex(t)).map((f) => [f.from, f.to, f.losses])).toEqual([[1000, 1204, 10]]);
  });

  it("finds the fight that turned the game, and picks a few key moments for its length", () => {
    next = 0;
    const tanks = Array.from({ length: 30 }, () => born(TANK, 0)), lings = Array.from({ length: 200 }, () => born(ZERGLING, 1));
    const events: UnitEvent[] = [...tanks, ...lings];
    let l = 0;
    // Five skirmishes the zerg wins a little of; then at 6000 a fight that costs the terran most of its army.
    for (let k = 0; k < 5; k++) for (let i = 0; i < 4; i++) events.push(died(1000 + k * 600 + i, lings[l++], 300 + k * 900, 300, tanks[0]));
    for (let i = 0; i < 20; i++) events.push(died(6000 + i * 3, tanks[i], 2000, 2000, lings[150]));
    events.sort((x, y) => x.frame - y.frame);
    // The terran leads in army until the fight; the zerg after it to the end.
    const t = timeline(events, { frames: 9000, players, samples: samples(9000, [
      { slot: 0, army: 30, armyValue: 7500, workers: 30, at: [[6100, 2500]] },
      { slot: 1, army: 200, armyValue: 5000, workers: 30 },
    ]) });
    const list = fights(t, cost, unitIndex(t));
    const turn = list.filter((f) => f.turning);
    expect(turn.map((f) => [f.from, f.winner, f.tier])).toEqual([[6000, 1, "decisive"]]);
    // Six minutes and more played: at least three key moments, but never a skirmish among them.
    expect(list.filter((f) => f.key).every((f) => f.tier !== "minor")).toBe(true);
    expect(list.filter((f) => f.key)).toContain(turn[0]);
  });

  it("weighs by count where the editor has no costs", () => {
    next = 0;
    const a = Array.from({ length: 10 }, () => born(MARINE, 0)), b = Array.from({ length: 10 }, () => born(MARINE, 1));
    const t = timeline([...a, ...b, ...b.slice(0, 8).map((u, i) => died(1000 + i, u, 500, 500, a[0])), died(1010, a[1], 500, 500, b[9])],
      { players, samples: samples(5000, [{ slot: 0, army: 10, armyValue: 0, workers: 0 }, { slot: 1, army: 10, armyValue: 0, workers: 0 }]) });
    const [f] = fights(t, () => 0, unitIndex(t));
    expect([f.value, f.winner, f.tier, f.share]).toEqual([0, 0, "decisive", 9 / 20]);
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

describe("the heart of a fight", () => {
  const fight = (points: { frame: number; x: number; y: number }[]): Fight => ({
    from: points[0].frame, to: points[points.length - 1].frame, x: 0, y: 0, rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, points, losses: points.length, value: 0,
    sides: [{ player: 0 }, { player: 3 }] as Fight["sides"], winner: null, kind: "battle", tier: "major", share: 0, turning: false, importance: 0, key: true,
  });

  it("is the 45 seconds with the most losses, a stray loss before them left out", () => {
    const e = engagement(fight([{ frame: 1000, x: 9, y: 9 }, { frame: 1500, x: 100, y: 200 }, { frame: 1600, x: 300, y: 150 }, { frame: 1720, x: 200, y: 400 }, { frame: 3000, x: 2000, y: 2000 }]));
    expect(e).toEqual({ from: 1500, to: 1720, x0: 100, y0: 150, x1: 300, y1: 400, players: [0, 3] });
  });

  it("runs 45 seconds at most, the earliest when two stretches have as many", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ frame: 500 + i * 100, x: i, y: i }));
    const e = engagement(fight(points));
    expect(e.from).toBe(500);
    expect(e.to).toBe(1500);
    expect(e.x1).toBe(10);
  });
});
