import { describe, expect, it } from "vitest";
import type { ReplayTimeline } from "../vendor/scm-sim";
import type { Fight } from "../fights";
import type { Standing } from "../played";
import type { Base } from "../story";
import { clockOf, mapReport, winnerOf, VISIT_CELL, type GameInput } from "../report";

const CC = 106;
const hall = (owner: number, x: number, y: number, from = 0, type = CC): Standing => ({ type, owner, x, y, from, done: from, to: null });
const fight = (from: number, x: number, y: number, winner: number | null, value = 100, tier: Fight["tier"] = "major"): Fight => ({ from, to: from + 100, x, y, rect: { x0: x, y0: y, x1: x, y1: y }, points: [], losses: 5, value, winner, kind: "battle", tier, share: 0.2, turning: false, importance: 0.2, key: false, sides: [0, 1].map((player) => ({ player, lost: 1, lostValue: 0, killed: 1, killedValue: 0, army: 0, armyValue: 0, had: 10, lostTypes: new Map() })) });
const game = (standing: Standing[], fights: Fight[], winner: number | null, frames = 10000, at: [number, number][] = [], bases: Base[] = []): GameInput => ({
  standing, fights, winner, bases,
  timeline: { version: 2, frames, total: frames, ended: null, map: { width: 64, height: 64 }, players: [], events: [], research: [], samples: { every: 48, frame: [], players: [] },
    positions: at.length ? { every: 48, frame: [0], start: Uint32Array.from([0, at.length]), unit: Uint32Array.from(at.map((_, i) => i)), x: Uint16Array.from(at.map((p) => p[0])), y: Uint16Array.from(at.map((p) => p[1])) } : null } as ReplayTimeline,
});
const MAP = { width: 64, height: 64 };
const base = (player: number, x: number, y: number, frame: number, nth: number): Base => ({ player, x, y, frame, nth, line: 0 });
// Starts top left and bottom right; a natural beside each, and a base in the middle.
const A = [200, 200] as const, B = [1800, 1800] as const, NAT_A = [200, 800] as const, NAT_B = [1800, 1200] as const, MID = [1024, 1024] as const;

describe("the clock", () => {
  it("names a place as on a clock face, and the middle as the middle", () => {
    const at = (x: number, y: number) => clockOf(x, y, 2048, 2048);
    expect([at(1024, 100), at(1950, 1024), at(1024, 1950), at(100, 1024), at(1900, 150), at(1030, 1000)]).toEqual([12, 3, 6, 9, 1, 0]);
  });
});

describe("the map's report", () => {
  it("counts who started where and how they fared", () => {
    const r = mapReport([
      game([hall(0, ...A), hall(1, ...B)], [], 0),
      game([hall(0, B[0] + 20, B[1]), hall(1, A[0], A[1] + 10)], [], 0),
      game([hall(0, ...A), hall(1, ...B)], [], null),
    ], MAP);
    expect([r.games, r.decided]).toEqual([3, 2]);
    const starts = r.sites.filter((s) => s.starts > 0).map((s) => [s.clock, s.starts, s.startWins, s.startDecided]);
    expect(starts).toEqual([[5, 3, 1, 2], [11, 3, 1, 2]].sort((a, b) => a[0] - b[0]));
  });

  it("lists the bases taken: in how many games, when, and which base it was", () => {
    const r = mapReport([
      game([hall(0, ...A), hall(1, ...B)], [], null, 10000, [], [base(0, ...NAT_A, 3000, 2), base(0, ...MID, 9000, 3), base(1, ...NAT_B, 4000, 2)]),
      game([hall(0, ...A), hall(1, ...B)], [], null, 10000, [], [base(0, NAT_A[0] + 30, NAT_A[1], 5000, 2)]),
    ], MAP);
    const taken = r.sites.filter((s) => s.taken > 0).map((s) => [Math.round(s.x / 100), Math.round(s.y / 100), s.starts, s.taken, s.medianFrame, s.medianOrder]);
    // The natural in both games, the others once: when it was first taken (the middle game's) and which base it was.
    expect(taken).toEqual([[2, 8, 0, 2, 3000, 2], [18, 12, 0, 1, 4000, 2], [10, 10, 0, 1, 9000, 3]]);
  });

  it("finds where the fighting is and whether the nearer player comes out ahead", () => {
    const starts = [hall(0, ...A), hall(1, ...B)];
    const r = mapReport([
      // A skirmish says nothing of where the fighting is, nor when it starts.
      game(starts, [fight(500, 1024, 1024, 0, 50, "minor"), fight(900, 1030, 1020, 1, 50, "minor"), fight(2000, 300, 700, 0), fight(6000, 1024, 1024, null)], 0),
      game(starts, [fight(3000, 320, 720, 1), fight(4000, 340, 690, 0), fight(7000, 1500, 300, 0)], 0),
    ], MAP);
    expect(r.spots.map((s) => [Math.round(s.x), s.fights, s.games, s.value, s.medianFrame, s.decided, s.nearerWon])).toEqual([[320, 3, 2, 300, 3000, 3, 2]]);
    expect(r.medianFirstFight).toBe(2000);
  });

  it("counts the ground no unit ever stood on", () => {
    const r = mapReport([
      game([hall(0, 64, 64)], [], null, 100, [[10, 10], [200, 10]]),
      game([], [], null, 100, [[10, 20]]),
    ], { width: 8, height: 8 });
    expect([r.visited.width, r.visited.height]).toEqual([256 / VISIT_CELL, 256 / VISIT_CELL]);
    expect([...r.visited.games]).toEqual([2, 1, 0, 0]);
    expect(r.neverEntered).toBe(0.5);
  });
});

describe("who won", () => {
  const b = (owner: number, to: number | null): Standing => ({ type: CC, owner, x: 0, y: 0, from: 0, done: 0, to });
  it("is the one player who never left, or else the one with a building standing", () => {
    expect(winnerOf([{ index: 0, left: false }, { index: 2, left: true }], [])).toBe(0);
    expect(winnerOf([{ index: 0, left: false }, { index: 2, left: false }], [b(0, 500), b(2, null)])).toBe(2);
    expect(winnerOf([{ index: 0, left: false }, { index: 2, left: false }], [b(0, null), b(2, null)])).toBeNull();
    expect(winnerOf([{ index: 0, left: false }], [b(0, null)])).toBeNull();
  });
});
