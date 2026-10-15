/**
 * A game told the way one player would tell another: who led and for how long, how each player's game went in
 * numbers, and what happened in the order it happened (the fights that mattered, the bases taken, who left). Made
 * from a `ReplayTimeline` and what `played.ts` and `fights.ts` read out of it; pure and tested.
 *
 * A player is named by the game's player number, which is `ReplayPlayer.index`.
 */
import type { PlayerSeries, ReplayTimeline } from "./vendor/scm-sim";
import { merged, type Fight } from "./fights";
import { counted, lineAt, type MineralLines, type Standing } from "./played";

/** Command Center, Hatchery, Nexus. */
const HALLS = new Set([106, 131, 154]);
/** A player leads once ahead by this share of the bigger army, and by at least this much (or this many units). */
const LEAD = 0.1;
const MIN_LEAD_VALUE = 300;
const MIN_LEAD_UNITS = 2;

/** The players who played: the ones who ever had a worker. */
export function playing(t: ReplayTimeline): PlayerSeries[] {
  return t.samples.players.filter((q) => q.workers.some((n) => n > 0));
}

/** One army against the other through the game, in a game of two. */
export interface Advantage {
  /** The two players: `a` above the line, `b` below. */
  a: number;
  b: number;
  frames: number[];
  /** `a`'s army less `b`'s, a value a sample. */
  lead: number[];
  /** By how many units rather than by what they cost (the engine gave no costs). */
  byCount: boolean;
}

export function advantage(t: ReplayTimeline): Advantage | null {
  const players = playing(t);
  if (players.length !== 2 || !t.samples.frame.length) return null;
  const [a, b] = players;
  const byCount = !players.some((q) => q.armyValue.some((n) => n > 0));
  const army = (q: PlayerSeries, i: number) => (byCount ? q.army[i] : q.armyValue[i]) ?? 0;
  return { a: a.slot, b: b.slot, frames: t.samples.frame, lead: t.samples.frame.map((_, i) => army(a, i) - army(b, i)), byCount };
}

export interface Lead {
  player: number;
  /** Frames this player was ahead by more than a little. */
  frames: number;
  /** The most they were ever ahead by, and when. */
  most: number;
  at: number;
}

/** How long each of the two led in army, and how long neither did. */
export function leads(t: ReplayTimeline, adv: Advantage): { a: Lead; b: Lead; even: number } {
  const out = { a: { player: adv.a, frames: 0, most: 0, at: 0 }, b: { player: adv.b, frames: 0, most: 0, at: 0 }, even: 0 };
  const qa = t.samples.players.find((q) => q.slot === adv.a)!, qb = t.samples.players.find((q) => q.slot === adv.b)!;
  const army = (q: PlayerSeries, i: number) => (adv.byCount ? q.army[i] : q.armyValue[i]) ?? 0;
  const end = Math.min(t.frames, adv.frames.length ? adv.frames[adv.frames.length - 1] + t.samples.every : 0);
  adv.frames.forEach((frame, i) => {
    const span = Math.max(0, (i + 1 < adv.frames.length ? adv.frames[i + 1] : end) - frame);
    const lead = adv.lead[i], room = Math.max(adv.byCount ? MIN_LEAD_UNITS : MIN_LEAD_VALUE, LEAD * Math.max(army(qa, i), army(qb, i)));
    const side = lead > room ? out.a : -lead > room ? out.b : null;
    if (!side) { out.even += span; return; }
    side.frames += span;
    if (Math.abs(lead) > side.most) { side.most = Math.abs(lead); side.at = frame; }
  });
  return out;
}

export interface Base {
  player: number;
  frame: number;
  /** Pixels, the hall's middle. */
  x: number;
  y: number;
  /** The mineral line (`MineralLines.lines`). */
  line: number;
  /** Which base it was for the player: 2 is the first after the start. */
  nth: number;
}

/** A Command Center the replay's orders landed: where its middle came down, and when the order was given. */
export interface Landing { player: number; frame: number; x: number; y: number }

/**
 * The bases each player took after the start: the first time they had a hall at a mineral line that was not their
 * start's, built there and finished, or flown there and landed. A hall away from any mineral line (a macro hatchery,
 * a proxy, a Command Center built to fly) is no base, and a second hall at a line a player had is no new one.
 */
export function bases(standing: readonly Standing[], minerals: MineralLines, landings: readonly Landing[] = []): Base[] {
  const arrivals = [
    ...standing.filter((b) => HALLS.has(b.type) && b.owner <= 7 && (b.from === 0 || b.done !== null)).map((b) => ({ player: b.owner, frame: b.from, x: b.x, y: b.y })),
    ...landings,
  ].sort((a, b) => a.frame - b.frame);
  const out: Base[] = [];
  const had = new Map<number, Set<number>>();
  for (const a of arrivals) {
    const line = lineAt(minerals, a.x, a.y);
    if (line < 0) continue;
    const mine = had.get(a.player) ?? new Set<number>();
    had.set(a.player, mine);
    if (mine.has(line)) continue;
    mine.add(line);
    if (a.frame === 0) continue;
    out.push({ player: a.player, frame: a.frame, x: a.x, y: a.y, line, nth: out.filter((o) => o.player === a.player).length + 2 });
  }
  return out;
}

export interface PlayerTotals {
  player: number;
  /** The biggest army they had, by what it cost (or by count, as the advantage), and when. */
  armyMost: number;
  armyAt: number;
  workersMost: number;
  /** Bases taken, the start among them. */
  bases: number;
  /** What they lost and what they killed, by what it cost; and how many. */
  lost: number;
  lostUnits: number;
  killed: number;
  killedUnits: number;
}

/** Each playing player's game in numbers. */
export function totals(t: ReplayTimeline, taken: readonly Base[], cost: (type: number) => number): PlayerTotals[] {
  const players = playing(t);
  const byCount = !players.some((q) => q.armyValue.some((n) => n > 0));
  const out = new Map<number, PlayerTotals>();
  for (const q of players) {
    const row: PlayerTotals = { player: q.slot, armyMost: 0, armyAt: 0, workersMost: Math.max(0, ...q.workers), bases: 1, lost: 0, lostUnits: 0, killed: 0, killedUnits: 0 };
    q.armyValue.forEach((_, i) => { const n = (byCount ? q.army[i] : q.armyValue[i]) ?? 0; if (n > row.armyMost) { row.armyMost = n; row.armyAt = t.samples.frame[i]; } });
    out.set(q.slot, row);
  }
  for (const b of taken) { const row = out.get(b.player); if (row) row.bases = Math.max(row.bases, b.nth); }
  const ignored = merged(t);
  for (const e of t.events) {
    if (e.kind === "born" && e.hallucination) { ignored.add(e.unit); continue; }
    if (e.kind !== "died" || !counted(e.type) || ignored.has(e.unit)) continue;
    const v = cost(e.type), lost = out.get(e.owner);
    if (lost) { lost.lost += v; lost.lostUnits++; }
    const by = e.byOwner !== undefined && e.byOwner !== e.owner ? out.get(e.byOwner) : undefined;
    if (by) { by.killed += v; by.killedUnits++; }
  }
  return [...out.values()];
}

export type StoryLine =
  | { kind: "fight"; frame: number; fight: Fight }
  | { kind: "base"; frame: number; base: Base }
  | { kind: "left"; frame: number; player: number };

/** What happened, in order: the key fights, the bases taken, the players who left. */
export function story(fights: readonly Fight[], taken: readonly Base[], left: readonly { player: number; frame: number }[]): StoryLine[] {
  const out: StoryLine[] = [
    ...fights.filter((f) => f.key).map((fight) => ({ kind: "fight" as const, frame: fight.from, fight })),
    ...taken.map((base) => ({ kind: "base" as const, frame: base.frame, base })),
    ...left.map((l) => ({ kind: "left" as const, frame: l.frame, player: l.player })),
  ];
  return out.sort((x, y) => x.frame - y.frame);
}

/** Who lost the most in a fight: the one a fight about workers or buildings happened to. */
export function hardestHit(f: Fight): number | null {
  let worst: number | null = null, most = -1;
  for (const s of f.sides) { const n = f.value > 0 ? s.lostValue : s.lost; if (n > most) { most = n; worst = s.player; } }
  return worst;
}
