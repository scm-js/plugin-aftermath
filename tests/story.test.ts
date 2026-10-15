import { describe, expect, it } from "vitest";
import type { PlayerSeries, ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import type { Fight } from "../fights";
import type { Standing } from "../played";
import { advantage, bases, hardestHit, leads, story, totals } from "../story";
import { lineAt, mineralLines } from "../played";

const CC = 106, HATCHERY = 131, MARINE = 0, ZERGLING = 37, HT = 67, ARCHON = 68;
const cost = (type: number) => (type === ZERGLING ? 25 : type === HT ? 200 : 50);

/** A player's numbers a sample; `army` and `armyValue` given a sample, the rest the same throughout. */
function player(slot: number, armyValue: number[], more: Partial<PlayerSeries> = {}): PlayerSeries {
  const n = armyValue.length, same = (v: number) => Array.from({ length: n }, () => v);
  return { slot, minerals: same(0), gas: same(0), supplyUsed: same(0), supplyMax: same(0), workers: same(10), army: armyValue.map((v) => Math.round(v / 50)), armyValue, buildings: same(1), ...more };
}
function timeline(players: PlayerSeries[], events: UnitEvent[] = [], frames?: number): ReplayTimeline {
  const n = players[0]?.armyValue.length ?? 0;
  return {
    version: 3, frames: frames ?? n * 48, total: frames ?? n * 48, ended: null, map: { width: 64, height: 64 },
    players: players.map((p) => ({ slot: p.slot, name: `p${p.slot}`, race: 1 })), events, research: [],
    samples: { every: 48, frame: Array.from({ length: n }, (_, i) => i * 48), players }, positions: null,
  };
}
const hall = (owner: number, x: number, y: number, from: number, done: number | null = from + 100, type = CC): Standing => ({ type, owner, x, y, from, done, to: null });

describe("the army lead", () => {
  it("is one army less the other, in a game of two, and nothing in any other", () => {
    const t = timeline([player(0, [0, 1000, 3000]), player(1, [0, 2000, 1000])]);
    expect(advantage(t)).toEqual({ a: 0, b: 1, frames: [0, 48, 96], lead: [0, -1000, 2000], byCount: false });
    // A third player with workers makes it a game of three; an observer with none does not count.
    expect(advantage(timeline([player(0, [0]), player(1, [0]), player(2, [0])]))).toBeNull();
    expect(advantage(timeline([player(0, [0, 1]), player(1, [0, 1]), player(2, [0, 0], { workers: [0, 0] })]))?.a).toBe(0);
  });

  it("counts units where the engine gave no costs", () => {
    const t = timeline([player(0, [0, 0], { army: [0, 5] }), player(1, [0, 0], { army: [0, 2] })]);
    expect(advantage(t)).toMatchObject({ lead: [0, 3], byCount: true });
  });

  it("says how long each led, by how much at most and when, and how long neither was far ahead", () => {
    // Even, then the first ahead for two samples, then the second ahead once by a lot.
    const t = timeline([player(0, [1000, 3000, 4000, 1000]), player(1, [1000, 1000, 1000, 5000])]);
    const l = leads(t, advantage(t)!);
    expect([l.a.frames, l.a.most, l.a.at, l.b.frames, l.b.most, l.b.at, l.even]).toEqual([96, 3000, 96, 48, 4000, 144, 48]);
  });
});

describe("the bases", () => {
  /** Mineral lines as a timeline has them: fields born at the first frame, owned by no player. */
  const fields = (lines: [number, number][]): UnitEvent[] => lines.flatMap(([x, y], n) => Array.from({ length: 6 }, (_, i) => ({ frame: 0, kind: "born" as const, unit: 1000 + n * 10 + i, type: 176, owner: 11, x: x + i * 32, y })));
  // Mineral lines above the start, the natural, the middle and the other player's start; and one stray field.
  const map = mineralLines({ ...timeline([]), events: [...fields([[60, -60], [60, 540], [940, 840], [1840, 1740]]), { frame: 0, kind: "born", unit: 999, type: 176, owner: 11, x: 3000, y: 3000 }] });

  it("finds the mineral lines, and leaves out a field on its own", () => {
    expect(map.lines.map((l) => [Math.round(l.x), Math.round(l.y), l.fields])).toEqual([[140, -60, 6], [140, 540, 6], [1020, 840, 6], [1920, 1740, 6]]);
    expect([lineAt(map, 100, 100), lineAt(map, 100, 700), lineAt(map, 1500, 1500), lineAt(map, 3000, 3010)]).toEqual([0, 1, -1, -1]);
  });

  it("counts a hall at a mineral line that was not the player's, once, built and finished or landed", () => {
    const standing = [
      hall(0, 100, 100, 0, 0), hall(1, 1900, 1900, 0, 0, HATCHERY),
      hall(0, 100, 700, 2000), // the natural
      hall(0, 160, 100, 2500), // beside the start: the same line, not a base
      hall(1, 1300, 1900, 2600, 3000, HATCHERY), // a macro hatchery, no minerals near: not a base
      hall(0, 1000, 1000, 2900, null), // never finished
      hall(0, 3000, 3100, 3000), // by a stray field: not a base
      hall(0, 140, 690, 7000), // a second hall at the natural: not a new base
    ];
    // A Command Center built away from the minerals and flown to the middle line.
    const landed = [{ player: 0, frame: 6000, x: 1000, y: 1000 }];
    expect(bases(standing, map, landed).map((b) => [b.player, b.frame, b.line, b.nth])).toEqual([[0, 2000, 1, 2], [0, 6000, 2, 3]]);
  });
});

describe("the game in numbers", () => {
  it("gives each player their largest army, most workers, bases, and what they lost and killed", () => {
    const ev = (frame: number, kind: UnitEvent["kind"], unit: number, type: number, owner: number, more: Partial<UnitEvent> = {}): UnitEvent => ({ frame, kind, unit, type, owner, x: 500, y: 500, ...more });
    const events = [
      ev(0, "born", 0, MARINE, 0), ev(0, "born", 1, ZERGLING, 1), ev(0, "born", 2, ZERGLING, 1), ev(0, "born", 3, HT, 0), ev(0, "born", 4, HT, 0),
      ev(100, "died", 1, ZERGLING, 1, { by: 0, byOwner: 0 }), ev(110, "died", 2, ZERGLING, 1, { by: 0, byOwner: 0 }), ev(120, "died", 0, MARINE, 0),
      // Two templars become an Archon: not a loss.
      ev(200, "morph", 3, ARCHON, 0, { from: HT }), ev(200, "died", 4, HT, 0),
    ];
    const t = timeline([player(0, [0, 2000, 1500], { workers: [4, 20, 18] }), player(1, [0, 500, 900])], events);
    const taken = [{ player: 0, frame: 50, x: 100, y: 900, line: 1, nth: 2 }];
    expect(totals(t, taken, cost).map((r) => [r.player, r.armyMost, r.armyAt, r.workersMost, r.bases, r.lost, r.lostUnits, r.killed, r.killedUnits])).toEqual([
      [0, 2000, 48, 20, 2, 50, 1, 50, 2],
      [1, 900, 96, 10, 1, 50, 2, 0, 0],
    ]);
  });
});

describe("the story", () => {
  const fight = (from: number, key: boolean, sides: [number, number][] = [[0, 100], [1, 300]]): Fight => ({
    from, to: from + 100, x: 0, y: 0, rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, points: [], losses: 4, value: sides.reduce((a, [, v]) => a + v, 0), winner: 0,
    kind: "battle", tier: key ? "major" : "minor", share: 0.2, turning: false, importance: 0.2, key,
    sides: sides.map(([player, lostValue]) => ({ player, lost: 2, lostValue, killed: 0, killedValue: 0, army: 0, armyValue: 0, had: 1000, lostTypes: new Map() })),
  });

  it("puts the key fights, the bases and who left in order, and leaves the rest out", () => {
    const lines = story([fight(3000, true), fight(4000, false), fight(9000, true)], [{ player: 1, frame: 5000, x: 0, y: 0, line: 0, nth: 2 }], [{ player: 1, frame: 9500 }]);
    expect(lines.map((l) => [l.kind, l.frame])).toEqual([["fight", 3000], ["base", 5000], ["fight", 9000], ["left", 9500]]);
  });

  it("names who lost the most in a fight", () => {
    expect(hardestHit(fight(0, true))).toBe(1);
    expect(hardestHit(fight(0, true, [[0, 500], [1, 300]]))).toBe(0);
  });
});
