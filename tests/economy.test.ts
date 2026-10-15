import { describe, expect, it } from "vitest";
import { FRAMES_PER_MINUTE } from "../analysis";
import { economy, incomeRate, lineSaturation, supplyBlocks } from "../economy";
import type { PlayerSeries, ReplayTimeline } from "../vendor/scm-sim";

const EVERY = 48;
const frames = (n: number) => Array.from({ length: n }, (_, i) => i * EVERY);

describe("income", () => {
  it("is what was gathered over the minute before, a minute", () => {
    const f = frames(120);
    // 8 minerals a sample: 8 × (a minute's frames / 48) a minute.
    const rate = incomeRate(f, f.map((_, i) => 50 + i * 8));
    const perMinute = (8 * FRAMES_PER_MINUTE) / EVERY;
    expect(rate[0]).toBe(0);
    expect(rate[10]).toBeCloseTo(perMinute, 6);
    expect(rate[100]).toBeCloseTo(perMinute, 6);
  });

  it("falls when mining stops, over the minute it takes the window to pass", () => {
    const f = frames(120);
    const gathered = f.map((_, i) => (i < 60 ? i * 8 : 60 * 8));
    const rate = incomeRate(f, gathered);
    expect(rate[59]).toBeGreaterThan(0);
    expect(rate[119]).toBe(0);
  });
});

describe("supply blocks", () => {
  it("are the spans at the limit, below 200", () => {
    const f = frames(10);
    const used = [9, 9, 10, 10, 10, 12, 200, 200, 200, 190];
    const max = [10, 10, 10, 10, 18, 18, 200, 200, 200, 200];
    expect(supplyBlocks(f, used, max)).toEqual([{ from: 2 * EVERY, to: 4 * EVERY }]);
  });

  it("run to the end, or to when the player left", () => {
    const f = frames(6);
    const used = [9, 10, 10, 10, 10, 10], max = [10, 10, 10, 10, 10, 10];
    expect(supplyBlocks(f, used, max)).toEqual([{ from: 1 * EVERY, to: 5 * EVERY }]);
    expect(supplyBlocks(f, used, max, 3 * EVERY)).toEqual([{ from: 1 * EVERY, to: 3 * EVERY }]);
  });
});

/** A timeline of two players and an observer, with the counts of what was gathered when `gathered` is set. */
function timeline(n: number, gathered: boolean): ReplayTimeline {
  const f = frames(n);
  const series = (slot: number, perSample: number, workers: number): PlayerSeries => ({
    slot,
    minerals: f.map(() => 100), gas: f.map(() => 20),
    supplyUsed: f.map(() => 10), supplyMax: f.map(() => (perSample ? 20 : 0)),
    workers: f.map((_, i) => Math.min(workers, 4 + i)), army: f.map(() => 0), armyValue: f.map(() => 0), buildings: f.map(() => 1),
    ...(gathered ? { mineralsGathered: f.map((_, i) => 50 + i * perSample), gasGathered: f.map((_, i) => i * (perSample >> 1)) } : {}),
  });
  return {
    version: gathered ? 4 : 3, frames: f[n - 1], total: f[n - 1], ended: null, map: { width: 64, height: 64 },
    players: [{ slot: 0, name: "A", race: 1 }, { slot: 1, name: "B", race: 2 }, { slot: 2, name: "Obs", race: 0 }],
    events: [], research: [],
    samples: { every: EVERY, frame: f, players: [series(0, 8, 20), series(1, 4, 12), series(2, 0, 0)] },
    positions: null,
  };
}

const noLines = { lines: [], fields: [] };
const noIndex = { owner: new Int8Array(0), type: new Int16Array(0) };

describe("a game's economy", () => {
  it("leaves the observer out, and counts what each player mined", () => {
    const n = 301;
    const e = economy(timeline(n, true), noLines, noIndex);
    expect(e.exact).toBe(true);
    expect(e.players.map((p) => p.slot)).toEqual([0, 1]);
    const [a, b] = e.players;
    expect(a.mined).toEqual({ minerals: 300 * 8, gas: 300 * 4 });
    expect(b.mined).toEqual({ minerals: 300 * 4, gas: 300 * 2 });
    const minutes = (300 * EVERY) / FRAMES_PER_MINUTE;
    expect(a.averageIncome).toBeCloseTo((300 * 12) / minutes, 6);
    expect(a.averageBank).toBe(120);
    expect(a.peakWorkers).toEqual({ n: 20, frame: 16 * EVERY });
  });

  it("does without income on an engine that does not count what was gathered", () => {
    const e = economy(timeline(50, false), noLines, noIndex);
    expect(e.exact).toBe(false);
    expect(e.players[0].income).toBeNull();
    expect(e.players[0].averageIncome).toBeNull();
    expect(e.players[0].averageBank).toBe(120);
  });

  it("stops a player's numbers where they left", () => {
    const e = economy(timeline(301, true), noLines, noIndex, new Map([[1, 100 * EVERY]]));
    expect(e.players[1].mined).toEqual({ minerals: 100 * 4, gas: 100 * 2 });
  });
});

describe("workers at the mineral lines", () => {
  it("counts each player's workers at the nearest line, minute by minute, from three", () => {
    const t = timeline(3, true);
    // Unit 0 and 1: SCVs of player 0; unit 2: a Marine of player 0; unit 3: a Probe of player 1, far from any line.
    const index = { owner: Int8Array.from([0, 0, 0, 1]), type: Int16Array.from([7, 7, 0, 64]) };
    const lines = { lines: [{ x: 100, y: 100, fields: 8 }, { x: 1000, y: 1000, fields: 7 }], fields: [] };
    const rows = [[0, 110, 100], [1, 90, 120], [2, 100, 100], [3, 2000, 2000]];
    const sample = (k: number) => rows.slice(0, k);
    const samples = [sample(4), sample(4), sample(4)];
    t.positions = {
      every: EVERY, frame: t.samples.frame,
      start: Uint32Array.from([0, 4, 8, 12]),
      unit: Uint32Array.from(samples.flat().map((r) => r[0])),
      x: Uint16Array.from(samples.flat().map((r) => r[1])),
      y: Uint16Array.from(samples.flat().map((r) => r[2])),
    };
    // Two workers is not a base yet.
    expect(lineSaturation(t, lines, index, [0, 1])).toEqual([]);
    index.owner = Int8Array.from([0, 0, 0, 0]);
    index.type = Int16Array.from([7, 7, 7, 7]);
    t.positions.x[3] = t.positions.x[7] = t.positions.x[11] = 105;
    t.positions.y[3] = t.positions.y[7] = t.positions.y[11] = 95;
    const [row] = lineSaturation(t, lines, index, [0, 1]);
    expect(row).toMatchObject({ line: 0, player: 0, fields: 8, first: 0 });
    expect(row.perMinute[0]).toBe(4);
  });
});
