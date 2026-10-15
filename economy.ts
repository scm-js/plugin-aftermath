/**
 * The economy of a played game, read out of the engine's timeline: what each player mined and how fast, what they
 * left in the bank, when they were supply blocked, and how many workers stood at each mineral line.
 *
 * Income comes from the game's own counts of what was gathered (timeline version 4), so it is exact; a timeline from
 * an older engine has no such counts, and everything here but income still holds for it.
 */
import type { PlayerSeries, ReplayTimeline } from "./vendor/scm-sim";
import { FRAMES_PER_MINUTE as MINUTE } from "./analysis";
import { type MineralLines, type UnitIndex, WORKERS } from "./played";

/** Income is measured over the minute before each sample. */
const INCOME_WINDOW = MINUTE;
/** A worker counts at a mineral line within this many pixels of the line's middle: the fields and the hall are 5 to 7 tiles apart. */
const LINE_REACH = 8 * 32;
/** Supply 200 is the game's ceiling: at it nothing is blocked, the player is maxed. */
const MAX_SUPPLY = 200;

export interface PlayerEconomy {
  slot: number;
  /** Minerals and gas gathered per minute at each sample, over the minute before it; null without the game's counts. */
  income: { minerals: number[]; gas: number[] } | null;
  /** What was gathered over the game; null without the game's counts. */
  mined: { minerals: number; gas: number } | null;
  /** Minerals and gas a minute, on average over the time the player was in the game; null without the game's counts. */
  averageIncome: number | null;
  /** Minerals and gas in the bank, on average over that time. */
  averageBank: number;
  /** The most workers at once, and when. */
  peakWorkers: { n: number; frame: number };
  /** The times the player stood at their supply limit (below 200), in frames. */
  blocks: { from: number; to: number }[];
  blockedFrames: number;
}

export interface LineSaturation {
  /** The mineral line (`MineralLines.lines`). */
  line: number;
  player: number;
  /** Pixels, the line's middle. */
  x: number;
  y: number;
  fields: number;
  /** Workers at the line, minute by minute (the average of the samples in that minute); 0 before and after. */
  perMinute: number[];
  /** The first minute it had workers of the player's. */
  first: number;
}

export interface Economy {
  /** Whether the timeline has the game's counts of what was gathered. */
  exact: boolean;
  players: PlayerEconomy[];
  /** Mineral lines worked by a player, in the order they were first worked. Empty without unit positions. */
  lines: LineSaturation[];
  minutes: number;
}

/** A player is in the game when it ever had supply: observers have none. */
export const playing = (s: PlayerSeries) => s.supplyMax.some((n) => n > 0);

/**
 * Minerals or gas gathered a minute at each sample, over the minute before it (the first minute over what there is of
 * it). `gathered` is the game's running count.
 */
export function incomeRate(frames: readonly number[], gathered: readonly number[], window = INCOME_WINDOW): number[] {
  const out: number[] = new Array(frames.length).fill(0);
  let j = 0;
  for (let i = 0; i < frames.length; i++) {
    while (j < i && frames[i] - frames[j] > window) j++;
    const span = frames[i] - frames[j];
    out[i] = span > 0 ? ((gathered[i] - gathered[j]) * MINUTE) / span : 0;
  }
  return out;
}

/** The spans a player stood at their supply limit, below 200: from the sample it was reached to the sample it was not. */
export function supplyBlocks(frames: readonly number[], used: readonly number[], max: readonly number[], until = Infinity): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = -1;
  for (let i = 0; i < frames.length && frames[i] <= until; i++) {
    const blocked = max[i] > 0 && max[i] < MAX_SUPPLY && used[i] >= max[i];
    if (blocked && from < 0) from = frames[i];
    else if (!blocked && from >= 0) { out.push({ from, to: frames[i] }); from = -1; }
  }
  if (from >= 0) out.push({ from, to: Math.min(until, frames[frames.length - 1]) });
  return out.filter((b) => b.to > b.from);
}

/** The mean of `values` over the samples up to `until`. */
function meanUntil(frames: readonly number[], values: (i: number) => number, until: number): number {
  let sum = 0, n = 0;
  for (let i = 0; i < frames.length && frames[i] <= until; i++) { sum += values(i); n++; }
  return n ? sum / n : 0;
}

/**
 * Workers at each mineral line, minute by minute, for each player who worked it: from where the units stood (workers
 * inside a refinery or carried in a transport are not on the map, so the counts are mineral workers).
 */
export function lineSaturation(t: ReplayTimeline, lines: MineralLines, index: UnitIndex, players: readonly number[]): LineSaturation[] {
  const p = t.positions;
  if (!p || !lines.lines.length) return [];
  const minutes = Math.ceil(t.frames / MINUTE);
  const sums = new Map<string, { line: number; player: number; sum: number[] }>();
  const samplesIn = new Array(minutes).fill(0);
  const want = new Set(players);
  for (let i = 0; i < p.frame.length; i++) {
    const m = Math.min(minutes - 1, Math.floor(p.frame[i] / MINUTE));
    samplesIn[m]++;
    for (let r = p.start[i]; r < p.start[i + 1]; r++) {
      const u = p.unit[r], owner = index.owner[u];
      if (!want.has(owner) || !WORKERS.has(index.type[u])) continue;
      const x = p.x[r], y = p.y[r];
      // The nearest line's middle, if near enough.
      let best = -1, bestD = LINE_REACH;
      for (let l = 0; l < lines.lines.length; l++) {
        const d = Math.hypot(lines.lines[l].x - x, lines.lines[l].y - y);
        if (d <= bestD) { bestD = d; best = l; }
      }
      if (best < 0) continue;
      const key = `${best}:${owner}`;
      let row = sums.get(key);
      if (!row) { row = { line: best, player: owner, sum: new Array(minutes).fill(0) }; sums.set(key, row); }
      row.sum[m]++;
    }
  }
  const out: LineSaturation[] = [];
  for (const row of sums.values()) {
    const perMinute = row.sum.map((s, m) => (samplesIn[m] ? s / samplesIn[m] : 0));
    // A line passed by now and then (a scout, workers on their way) is not a base: it needs three workers a minute.
    const first = perMinute.findIndex((n) => n >= 3);
    if (first < 0) continue;
    const l = lines.lines[row.line];
    out.push({ line: row.line, player: row.player, x: l.x, y: l.y, fields: l.fields, perMinute, first });
  }
  return out.sort((a, b) => a.first - b.first || a.player - b.player);
}

/** The whole economy of a played game. `leftAt`: the frame each player (by slot) left, if they did. */
export function economy(t: ReplayTimeline, lines: MineralLines, index: UnitIndex, leftAt: ReadonlyMap<number, number | null> = new Map()): Economy {
  const f = t.samples.frame;
  const end = f[f.length - 1] ?? 0;
  const inGame = t.samples.players.filter(playing);
  const exact = inGame.length > 0 && inGame.every((s) => Array.isArray(s.mineralsGathered) && s.mineralsGathered.length === f.length);
  const players = inGame.map((s): PlayerEconomy => {
    const until = leftAt.get(s.slot) ?? end;
    let last = 0;
    while (last + 1 < f.length && f[last + 1] <= until) last++;
    const income = exact ? { minerals: incomeRate(f, s.mineralsGathered!), gas: incomeRate(f, s.gasGathered!) } : null;
    const mined = exact ? { minerals: s.mineralsGathered![last] - s.mineralsGathered![0], gas: s.gasGathered![last] - s.gasGathered![0] } : null;
    const minutes = (f[last] - f[0]) / MINUTE;
    let peak = { n: 0, frame: 0 };
    for (let i = 0; i <= last; i++) if (s.workers[i] > peak.n) peak = { n: s.workers[i], frame: f[i] };
    const blocks = supplyBlocks(f, s.supplyUsed, s.supplyMax, until);
    return {
      slot: s.slot,
      income,
      mined,
      averageIncome: mined && minutes > 0 ? (mined.minerals + mined.gas) / minutes : null,
      averageBank: meanUntil(f, (i) => s.minerals[i] + s.gas[i], until),
      peakWorkers: peak,
      blocks,
      blockedFrames: blocks.reduce((a, b) => a + b.to - b.from, 0),
    };
  });
  return { exact, players, lines: lineSaturation(t, lines, index, players.map((p) => p.slot)), minutes: Math.ceil(t.frames / MINUTE) };
}
