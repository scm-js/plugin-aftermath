/**
 * The fights of a game, found in what the engine's timeline says was lost: deaths close together in time and place
 * are one fight, and each has its sides, what each lost and killed, what each had there when it began, and who came
 * out ahead. Also the units that killed the most. Pure, like `played.ts`, and made from a `ReplayTimeline` alone.
 */
import type { ReplayTimeline, UnitEvent } from "./vendor/scm-sim";
import { NOT_MADE, WORKERS, isBuilding, sampleAt, type UnitIndex } from "./played";

/** A death joins a fight whose last death was this recent (ten seconds) and whose middle is this near (fifteen tiles). */
const GAP_FRAMES = 240;
const RADIUS = 480;
/** Fewer deaths than this is a skirmish, not listed, unless what fell was worth this much. */
const MIN_LOSSES = 4;
const MIN_VALUE = 400;
/** How far from the middle a unit may stand at the start and count as there. */
const PRESENT = RADIUS * 1.5;
/** A side is ahead when it came out this far in front, as a share of everything that fell. */
const AHEAD = 0.2;

const RESOURCES = new Set([176, 177, 178, 188]);
const fell = (e: UnitEvent, ignored: ReadonlySet<number>) => e.kind === "died" && e.owner <= 7 && e.type < 203 && !NOT_MADE.has(e.type) && !RESOURCES.has(e.type) && !ignored.has(e.unit);

export interface FightSide {
  player: number;
  lost: number;
  lostValue: number;
  killed: number;
  killedValue: number;
  /** Fighting units there when it began (not workers, not buildings), and what they cost; 0 when the timeline keeps no positions. */
  army: number;
  armyValue: number;
  /** What it lost, by type: units.dat id → how many. */
  lostTypes: Map<number, number>;
}

export interface Fight {
  from: number;
  to: number;
  /** Pixels: the middle of what fell, and the box around it. */
  x: number;
  y: number;
  rect: { x0: number; y0: number; x1: number; y1: number };
  losses: number;
  value: number;
  sides: FightSide[];
  /** The player who came out clearly ahead, or null when it was even. */
  winner: number | null;
}

/** A kill as the overlay draws it: from where the killer stood to where the victim fell. */
export interface Kill { frame: number; x: number; y: number; fromX: number; fromY: number; player: number; by: number }

export function kills(t: ReplayTimeline): Kill[] {
  const out: Kill[] = [];
  for (const e of t.events) if (e.kind === "died" && e.by !== undefined && e.owner <= 7 && (e.byOwner ?? 99) <= 7) out.push({ frame: e.frame, x: e.x, y: e.y, fromX: e.byX ?? e.x, fromY: e.byY ?? e.y, player: e.owner, by: e.byOwner! });
  return out;
}

export function fights(t: ReplayTimeline, cost: (type: number) => number, index: UnitIndex): Fight[] {
  const ignored = new Set<number>();
  interface Open { deaths: UnitEvent[]; sx: number; sy: number; last: number }
  const open: Open[] = [], closed: Open[] = [];
  for (const e of t.events) {
    if (e.kind === "born" && e.hallucination) { ignored.add(e.unit); continue; }
    if (!fell(e, ignored)) continue;
    for (let i = open.length - 1; i >= 0; i--) if (e.frame - open[i].last > GAP_FRAMES) closed.push(...open.splice(i, 1));
    let best: Open | null = null, bestD = RADIUS * RADIUS;
    for (const f of open) {
      const dx = f.sx / f.deaths.length - e.x, dy = f.sy / f.deaths.length - e.y, d = dx * dx + dy * dy;
      if (d <= bestD) { best = f; bestD = d; }
    }
    if (!best) { best = { deaths: [], sx: 0, sy: 0, last: e.frame }; open.push(best); }
    best.deaths.push(e); best.sx += e.x; best.sy += e.y; best.last = e.frame;
  }
  closed.push(...open);
  // A fight that spreads starts a second one beside itself; two that overlap in time and stand that close are one.
  closed.sort((a, b) => a.deaths[0].frame - b.deaths[0].frame);
  for (let i = 0; i < closed.length; i++) {
    for (let j = i + 1; j < closed.length; j++) {
      const a = closed[i], b = closed[j];
      if (b.deaths[0].frame - a.last > GAP_FRAMES) break;
      if (Math.hypot(a.sx / a.deaths.length - b.sx / b.deaths.length, a.sy / a.deaths.length - b.sy / b.deaths.length) > RADIUS) continue;
      a.deaths.push(...b.deaths); a.deaths.sort((x, y) => x.frame - y.frame);
      a.sx += b.sx; a.sy += b.sy; a.last = Math.max(a.last, b.last);
      closed.splice(j, 1); j--;
    }
  }

  const out: Fight[] = [];
  for (const f of closed) {
    const sides = new Map<number, FightSide>();
    const side = (player: number) => { let s = sides.get(player); if (!s) { s = { player, lost: 0, lostValue: 0, killed: 0, killedValue: 0, army: 0, armyValue: 0, lostTypes: new Map() }; sides.set(player, s); } return s; };
    let value = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of f.deaths) {
      const v = cost(e.type), s = side(e.owner);
      s.lost++; s.lostValue += v; s.lostTypes.set(e.type, (s.lostTypes.get(e.type) ?? 0) + 1);
      value += v;
      if (e.byOwner !== undefined && e.byOwner <= 7 && e.byOwner !== e.owner) { const k = side(e.byOwner); k.killed++; k.killedValue += v; }
      x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x); y1 = Math.max(y1, e.y);
    }
    if (f.deaths.length < MIN_LOSSES && value < MIN_VALUE) continue;
    const x = f.sx / f.deaths.length, y = f.sy / f.deaths.length, from = f.deaths[0].frame;
    // Who was there when it began: the sample before the first death.
    const p = t.positions;
    if (p) {
      const i = Math.max(0, sampleAt(p.frame, from));
      for (let r = p.start[i]; r < p.start[i + 1]; r++) {
        const u = p.unit[r], type = index.type[u], owner = index.owner[u];
        if (owner < 0 || owner > 7 || type < 0 || NOT_MADE.has(type) || WORKERS.has(type) || isBuilding(type)) continue;
        if (Math.hypot(p.x[r] - x, p.y[r] - y) > PRESENT) continue;
        const s = sides.get(owner);
        if (s) { s.army++; s.armyValue += cost(type); }
      }
    }
    // Ahead by what it killed less what it lost; by the count where nothing has a cost (no game data in the editor).
    const list = [...sides.values()].sort((a, b) => a.player - b.player);
    const score = (s: FightSide) => (value > 0 ? s.killedValue - s.lostValue : s.killed - s.lost);
    const ranked = [...list].sort((a, b) => score(b) - score(a));
    const total = value > 0 ? value : f.deaths.length;
    const winner = ranked.length > 1 && score(ranked[0]) - score(ranked[1]) > total * AHEAD ? ranked[0].player : null;
    out.push({ from, to: f.last, x, y, rect: { x0, y0, x1, y1 }, losses: f.deaths.length, value, sides: list, winner });
  }
  return out.sort((a, b) => a.from - b.from);
}

export interface Killer {
  unit: number;
  /** What it was at its last kill. */
  type: number;
  player: number;
  kills: number;
  value: number;
  /** Its first kill: when, and where it stood. */
  frame: number;
  x: number;
  y: number;
}

/** The units that killed the most, by what they killed was worth and then by how many. */
export function topKillers(t: ReplayTimeline, cost: (type: number) => number, limit = 8): Killer[] {
  const by = new Map<number, Killer>();
  const ignored = new Set<number>();
  for (const e of t.events) {
    if (e.kind === "born" && e.hallucination) { ignored.add(e.unit); continue; }
    if (!fell(e, ignored) || e.by === undefined || e.byOwner === undefined || e.byOwner > 7 || e.byOwner === e.owner) continue;
    let k = by.get(e.by);
    if (!k) { k = { unit: e.by, type: e.byType ?? -1, player: e.byOwner, kills: 0, value: 0, frame: e.frame, x: e.byX ?? e.x, y: e.byY ?? e.y }; by.set(e.by, k); }
    k.kills++; k.value += cost(e.type); k.type = e.byType ?? k.type;
  }
  return [...by.values()].sort((a, b) => b.value - a.value || b.kills - a.kills || a.frame - b.frame).slice(0, limit);
}
