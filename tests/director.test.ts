import { describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import type { Fight } from "../fights";
import { unitIndex } from "../played";
import { direct, groupsAt, lookAt, shotAt, type Shot } from "../director";

const MARINE = 0, ZERGLING = 37, CC = 106, HATCHERY = 131;
const cost = (type: number) => (type === ZERGLING ? 25 : type === MARINE ? 50 : 400);

/**
 * A game of `samples` samples 48 frames apart. Units are born at frame 0; `at(unit, sample)` says where each stands
 * (null: not on the map).
 */
function game(units: { type: number; owner: number }[], samples: number, at: (unit: number, sample: number) => [number, number] | null): ReplayTimeline {
  const events: UnitEvent[] = units.map((u, i) => ({ frame: 0, kind: "born", unit: i, type: u.type, owner: u.owner, x: at(i, 0)?.[0] ?? 0, y: at(i, 0)?.[1] ?? 0 }));
  const frame: number[] = [], start: number[] = [0], unit: number[] = [], x: number[] = [], y: number[] = [];
  for (let s = 0; s < samples; s++) {
    frame.push(s * 48);
    units.forEach((_, i) => { const p = at(i, s); if (p) { unit.push(i); x.push(p[0]); y.push(p[1]); } });
    start.push(unit.length);
  }
  return {
    version: 3, frames: samples * 48, total: samples * 48, ended: null, map: { width: 128, height: 128 },
    players: [{ slot: 0, name: "a", race: 1 }, { slot: 1, name: "b", race: 0 }], events, research: [],
    samples: { every: 48, frame, players: [] },
    positions: { every: 48, frame, start: Uint32Array.from(start), unit: Uint32Array.from(unit), x: Uint16Array.from(x), y: Uint16Array.from(y) },
  };
}

const fight = (from: number, to: number, x: number, y: number): Fight => ({
  from, to, x, y, rect: { x0: x, y0: y, x1: x, y1: y }, points: [{ frame: from, x, y }, { frame: to, x: x + 64, y }], losses: 10, value: 2000, winner: 0,
  kind: "battle", tier: "decisive", share: 0.4, turning: false, importance: 0.6, key: true,
  sides: [0, 1].map((player) => ({ player, lost: 5, lostValue: 1000, killed: 5, killedValue: 1000, army: 0, armyValue: 0, had: 3000, lostTypes: new Map() })),
});

describe("the camera's groups", () => {
  it("makes one group of a player's units in touching squares, and leaves workers and buildings out", () => {
    const units = [
      { type: MARINE, owner: 0 }, { type: MARINE, owner: 0 }, { type: MARINE, owner: 0 }, // together
      { type: MARINE, owner: 0 }, // far away
      { type: 7, owner: 0 }, { type: CC, owner: 0 }, // a worker and a building
      { type: ZERGLING, owner: 1 },
    ];
    const t = game(units, 1, (i) => [[100, 100], [300, 120], [520, 140], [3000, 3000], [110, 100], [120, 120], [140, 100]][i] as [number, number]);
    const groups = groupsAt(t, unitIndex(t), 0, cost).sort((a, b) => a.player - b.player || b.units - a.units);
    expect(groups.map((g) => [g.player, g.units, g.value, Math.round(g.x)])).toEqual([[0, 3, 150, 307], [0, 1, 50, 3000], [1, 1, 25, 140]]);
  });
});

describe("the camera", () => {
  it("looks at nothing without positions", () => {
    const t = game([], 3, () => null);
    expect(direct({ ...t, positions: null }, unitIndex(t), [], [], cost)).toEqual([]);
  });

  it("goes between the players' starts when there is nothing else to see", () => {
    const t = game([{ type: CC, owner: 0 }, { type: HATCHERY, owner: 1 }], 30, (i) => (i === 0 ? [200, 200] : [3800, 3800]));
    const shots = direct(t, unitIndex(t), [], [], cost);
    expect(shots.map((s) => [s.kind, s.players[0]]).slice(0, 3)).toEqual([["home", 0], ["home", 1], ["home", 0]]);
  });

  it("follows an army, and cuts to a fight a few seconds before its first loss, holding it until it is over", () => {
    // Ten marines walking right; a fight elsewhere from sample 20 to sample 26.
    const units = [{ type: CC, owner: 0 }, { type: HATCHERY, owner: 1 }, ...Array.from({ length: 10 }, () => ({ type: MARINE, owner: 0 }))];
    const t = game(units, 40, (i, s) => (i === 0 ? [200, 200] : i === 1 ? [3800, 3800] : [400 + s * 20 + i, 1000]));
    const f = fight(20 * 48, 26 * 48, 3000, 600);
    const shots = direct(t, unitIndex(t), [f], [], cost);
    const army = shots.find((s) => s.kind === "army")!;
    expect(army.players).toEqual([0]);
    // The path follows the army as it walks.
    expect(army.path[1].x).toBeGreaterThan(army.path[0].x);
    const onFight = shots.find((s) => s.kind === "fight")!;
    expect(onFight.fight).toBe(f);
    expect(onFight.from).toBeLessThanOrEqual(f.from - 48);
    expect(onFight.to).toBeGreaterThanOrEqual(f.to);
  });

  it("through one player's eyes, follows only that player, and looks at a meeting from their side", () => {
    // Player 1's zerglings walk at player 0's marines, who stand still; nothing else happens.
    const units = [{ type: CC, owner: 0 }, { type: HATCHERY, owner: 1 },
      ...Array.from({ length: 10 }, () => ({ type: MARINE, owner: 0 })), ...Array.from({ length: 12 }, () => ({ type: ZERGLING, owner: 1 }))];
    const t = game(units, 40, (i, s) => (i === 0 ? [200, 200] : i === 1 ? [3800, 3800] : i < 12 ? [1000 + i, 1000] : [3000 - s * 50 + i, 1000]));
    const all = direct(t, unitIndex(t), [], [], cost);
    expect(all.some((s) => s.players.every((pl) => pl === 1))).toBe(true);
    for (const only of [0, 1]) {
      const shots = direct(t, unitIndex(t), [], [], cost, only);
      expect(shots.length).toBeGreaterThan(0);
      expect(shots.every((s) => s.players.includes(only))).toBe(true);
    }
    const meeting = direct(t, unitIndex(t), [], [], cost, 0).find((s) => s.kind === "meeting")!;
    expect(meeting.path.every((pt) => Math.abs(pt.x - 1006) < 10)).toBe(true);
  });

  it("finds the shot at a frame, and where it looks between two points of its path", () => {
    const shots: Shot[] = [
      { kind: "home", from: 0, to: 96, players: [0], path: [{ frame: 0, x: 0, y: 0 }] },
      { kind: "army", from: 96, to: 400, players: [0], path: [{ frame: 96, x: 100, y: 100 }, { frame: 144, x: 200, y: 100 }] },
    ];
    expect([shotAt(shots, 0), shotAt(shots, 95), shotAt(shots, 96), shotAt(shots, 1000)]).toEqual([0, 0, 1, 1]);
    expect(lookAt(shots[1], 120)).toEqual({ x: 150, y: 100 });
    expect(lookAt(shots[1], 500)).toEqual({ x: 200, y: 100 });
  });
});
