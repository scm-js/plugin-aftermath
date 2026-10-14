/**
 * What a replay shows once the game has been played through by the site's engine (the
 * scm-sim plugin's `analyse`): not the orders but what came of them. Everything here is
 * made from a `ReplayTimeline` and nothing else, so it is pure and tested.
 *
 * A player is named by the game's player number, which is `ReplayPlayer.index`.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";

/** Larva, egg, cocoon, lurker egg, what is fired or laid, and the spells that are units: never a line of what was made. */
export const NOT_MADE = new Set([13, 14, 33, 35, 36, 59, 73, 85, 97, 101, 105, 202]);
const EGGS = new Set([36, 59, 97]);
/** Mineral fields and the geyser. */
const RESOURCES = new Set([176, 177, 178, 188]);
export const WORKERS = new Set([7, 41, 64]);
export const isBuilding = (type: number) => type >= 106 && type <= 201 && !RESOURCES.has(type);
const counted = (type: number) => type >= 0 && type < 203 && !NOT_MADE.has(type) && !RESOURCES.has(type);

/** Units of one type started close together read as one line. */
const FOLD_FRAMES = 3 * 24;

export interface MadeRow {
  kind: "unit" | "upgrade" | "tech";
  /** When it was started: a building's site, a unit's training or its egg. For research, when it finished. */
  frame: number;
  /** units.dat id, or the upgrade's or technology's. */
  id: number;
  /** An upgrade's level. */
  level?: number;
  /** When it was finished, or null when it never was (cancelled, or killed first). */
  done: number | null;
  /** When it was lost, or null when it lasted the game. */
  lost: number | null;
  building: boolean;
  /** Pixels, where it began. */
  x: number;
  y: number;
  /** Lines folded into this one. */
  count: number;
}

/** What one player really made, in the order it was started. Units there at the start are not listed. */
export function madeRows(t: ReplayTimeline, player: number, options: { workers?: boolean } = {}): MadeRow[] {
  const rows: MadeRow[] = [];
  const rowOf = new Map<number, MadeRow>();
  const eggAt = new Map<number, number>();
  const ignored = new Set<number>();
  for (const e of t.events) {
    if (e.kind === "born") {
      if (e.hallucination) { ignored.add(e.unit); continue; }
      if (e.frame === 0 || e.owner !== player || !counted(e.type)) continue;
      const row: MadeRow = { kind: "unit", frame: e.frame, id: e.type, done: null, lost: null, building: isBuilding(e.type), x: e.x, y: e.y, count: 1 };
      rows.push(row); rowOf.set(e.unit, row);
    } else if (ignored.has(e.unit)) continue;
    else if (e.kind === "morph") {
      const before = rowOf.get(e.unit);
      if (EGGS.has(e.type)) { eggAt.set(e.unit, e.frame); continue; }
      // A building given up (a cancelled hatchery is a drone again, a refinery that falls is a geyser again).
      if (before && before.building && !isBuilding(e.type)) { before.lost ??= e.frame; rowOf.delete(e.unit); continue; }
      if (e.owner !== player || !counted(e.type)) continue;
      const row: MadeRow = { kind: "unit", frame: eggAt.get(e.unit) ?? e.frame, id: e.type, done: null, lost: null, building: isBuilding(e.type), x: e.x, y: e.y, count: 1 };
      eggAt.delete(e.unit);
      rows.push(row); rowOf.set(e.unit, row);
    } else if (e.kind === "done") {
      const row = rowOf.get(e.unit);
      if (row && row.done === null && row.id === e.type) row.done = e.frame;
    } else if (e.kind === "died") {
      const row = rowOf.get(e.unit);
      if (row) row.lost ??= e.frame;
    }
  }
  for (const r of t.research) if (r.player === player) rows.push({ kind: r.kind, frame: r.frame, id: r.id, level: r.level, done: r.frame, lost: null, building: false, x: 0, y: 0, count: 1 });
  rows.sort((a, b) => a.frame - b.frame);
  const out: MadeRow[] = [];
  for (const r of rows) {
    if (r.kind === "unit" && !options.workers && WORKERS.has(r.id)) continue;
    const last = out[out.length - 1];
    if (last && r.kind === "unit" && last.kind === "unit" && !r.building && last.id === r.id && r.frame - last.frame <= FOLD_FRAMES * last.count) { last.count++; continue; }
    out.push({ ...r });
  }
  return out;
}

/** A building as it stood: from its site to its end, the type it had over that time. */
export interface Standing {
  type: number;
  owner: number;
  /** Pixels, its centre. */
  x: number;
  y: number;
  from: number;
  done: number | null;
  /** The frame it was gone or became another type; null when it stood to the end. */
  to: number | null;
}

/** Every building of the eight players through the game, the ones there at the start among them. */
export function buildings(t: ReplayTimeline): Standing[] {
  const out: Standing[] = [];
  const open = new Map<number, Standing>();
  const start = (unit: number, e: { type: number; owner: number; x: number; y: number; frame: number }) => {
    if (!isBuilding(e.type) || e.owner > 7) return;
    const s: Standing = { type: e.type, owner: e.owner, x: e.x, y: e.y, from: e.frame, done: null, to: null };
    out.push(s); open.set(unit, s);
  };
  const end = (unit: number, frame: number) => { const s = open.get(unit); if (s) { s.to = frame; open.delete(unit); } };
  for (const e of t.events) {
    if (e.kind === "born") start(e.unit, e);
    else if (e.kind === "morph") { end(e.unit, e.frame); start(e.unit, e); }
    else if (e.kind === "done") { const s = open.get(e.unit); if (s && s.done === null) s.done = e.frame; }
    else if (e.kind === "given") { end(e.unit, e.frame); start(e.unit, e); const s = open.get(e.unit); if (s) s.done = e.frame; }
    else if (e.kind === "died") end(e.unit, e.frame);
  }
  return out;
}

export interface Point { frame: number; player: number; x: number; y: number }

/** Where the players' units and buildings were lost. A player who leaves loses nothing by it. */
export function lossPoints(t: ReplayTimeline): Point[] {
  const ignored = new Set<number>();
  const out: Point[] = [];
  for (const e of t.events) {
    if (e.kind === "born" && e.hallucination) ignored.add(e.unit);
    else if (e.kind === "died" && e.owner <= 7 && counted(e.type) && !ignored.has(e.unit)) out.push({ frame: e.frame, player: e.owner, x: e.x, y: e.y });
  }
  return out;
}

/** What each player lost: how many, and what they cost. A cancelled building is counted, as the game takes part of its cost. */
export function losses(t: ReplayTimeline, cost: (type: number) => number): Map<number, { units: number; value: number }> {
  const out = new Map<number, { units: number; value: number }>();
  const ignored = new Set<number>();
  for (const e of t.events) {
    if (e.kind === "born" && e.hallucination) ignored.add(e.unit);
    if (e.kind !== "died" || e.owner > 7 || !counted(e.type) || ignored.has(e.unit)) continue;
    const row = out.get(e.owner) ?? { units: 0, value: 0 };
    row.units++; row.value += cost(e.type);
    out.set(e.owner, row);
  }
  return out;
}

/** For every unit of the timeline: who it belonged to and what it was last, as far as the events say. */
export interface UnitIndex { owner: Int8Array; type: Int16Array }
export function unitIndex(t: ReplayTimeline): UnitIndex {
  let n = 0;
  for (const e of t.events) if (e.unit >= n) n = e.unit + 1;
  const owner = new Int8Array(n).fill(-1), type = new Int16Array(n).fill(-1);
  for (const e of t.events) {
    if (e.kind === "born") { owner[e.unit] = e.owner; type[e.unit] = e.hallucination ? -1 : e.type; }
    else if (e.kind === "morph" && type[e.unit] >= 0) type[e.unit] = e.type;
  }
  return { owner, type };
}

/** Where the players' fighting units stood, sample by sample (workers, larvae and eggs left out). */
export function* presencePoints(t: ReplayTimeline, index: UnitIndex): Generator<Point> {
  const p = t.positions;
  if (!p) return;
  for (let i = 0; i < p.frame.length; i++) {
    for (let r = p.start[i]; r < p.start[i + 1]; r++) {
      const u = p.unit[r], type = index.type[u], owner = index.owner[u];
      if (owner < 0 || owner > 7 || !counted(type) || WORKERS.has(type)) continue;
      yield { frame: p.frame[i], player: owner, x: p.x[r], y: p.y[r] };
    }
  }
}

/** The last sample at or before `frame`, -1 before the first. */
export function sampleAt(frames: readonly number[], frame: number): number {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid] <= frame) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/**
 * The units on the map at `frame`: each from its place in the sample before, moved toward its place in the sample
 * after by how far the frame is between them. `each` is called once a unit.
 */
export function unitsAt(t: ReplayTimeline, frame: number, each: (unit: number, x: number, y: number) => void): void {
  const p = t.positions;
  if (!p) return;
  const i = sampleAt(p.frame, frame);
  if (i < 0) return;
  const next = i + 1 < p.frame.length ? i + 1 : -1;
  const k = next < 0 ? 0 : Math.min(1, Math.max(0, (frame - p.frame[i]) / (p.frame[next] - p.frame[i])));
  let ahead: Map<number, number> | null = null;
  if (next >= 0 && k > 0) { ahead = new Map(); for (let r = p.start[next]; r < p.start[next + 1]; r++) ahead.set(p.unit[r], r); }
  for (let r = p.start[i]; r < p.start[i + 1]; r++) {
    const u = p.unit[r], a = ahead?.get(u);
    if (a === undefined) each(u, p.x[r], p.y[r]);
    else each(u, p.x[r] + (p.x[a] - p.x[r]) * k, p.y[r] + (p.y[a] - p.y[r]) * k);
  }
}

export type Metric = "armyValue" | "army" | "workers" | "supplyUsed" | "minerals" | "gas" | "buildings";

/** One player's numbers through the game, an entry a sample (`t.samples.frame`), or null for a player the game did not have. */
export function series(t: ReplayTimeline, player: number, metric: Metric): number[] | null {
  return t.samples.players.find((p) => p.slot === player)?.[metric] ?? null;
}
