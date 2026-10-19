/**
 * The fights of a game, found in what the engine's timeline says was lost: deaths close together in time and place
 * are one fight, and each has its sides, what each lost and killed, what each had there when it began, and who came
 * out ahead. Each is weighed against what the players had in the whole game at that moment, so a few units lost in
 * passing read as a skirmish and the fight that cost an army reads as the one that decided the game. Also the units
 * that killed the most. Pure, like `played.ts`, and made from a `ReplayTimeline` alone.
 */
import type { ReplayTimeline, UnitEvent } from "./vendor/scm-sim";
import { NOT_MADE, WORKERS, isBuilding, sampleAt, type UnitIndex } from "./played";

/** A death joins a fight whose last death was this recent (ten seconds) and whose middle is this near (fifteen tiles). */
const GAP_FRAMES = 240;
const RADIUS = 480;
/**
 * Two fights are one when the second follows within this long (ten seconds) this near (twenty-five tiles): an army
 * falls back and comes again, or the fight moves along a path. (Fifteen seconds made fights of two minutes and more.)
 */
const JOIN_GAP = 240;
const JOIN_RADIUS = 800;
/** Fewer deaths than this is not a fight at all, unless what fell was worth this much. */
const MIN_LOSSES = 4;
const MIN_VALUE = 400;
/** How far from the middle a unit may stand at the start and count as there. */
const PRESENT = RADIUS * 1.5;
/** A side is ahead when it came out this far in front, as a share of everything that fell. */
const AHEAD = 0.2;
/** Decisive: the side behind lost this much of everything it had (army and workers), and the side ahead won it clearly. */
const DECISIVE = 0.4;
/** Major: what fell was this much of everything the sides had, or one side lost this much of its own. */
const MAJOR_SHARE = 0.12;
const MAJOR_OWN = 0.25;
/** A kind of loss is what a fight was about when it was this much of what fell. */
const MOSTLY = 0.5;
/** A player leads in army once ahead by this share of the bigger army, and by at least this much (or this many units). */
const LEAD = 0.25;
const MIN_LEAD_VALUE = 600;
const MIN_LEAD_UNITS = 4;
/** The fight that turned the game may start this long after the lead changed hands, or end this long before. */
const TURN_AFTER = 480;
const TURN_BEFORE = 1440;
/** The key moments: every decisive fight, and about one for every six minutes played; never fewer than three or more than eight. */
const KEY_MINUTES = 6;
const MIN_KEYS = 3;
const MAX_KEYS = 8;
const FRAMES_PER_MINUTE = 60_000 / 42;

const RESOURCES = new Set([176, 177, 178, 188]);
/** High and Dark Templar: two become one Archon, and the one that is not kept leaves the game as a death nobody caused. */
const MERGES = new Map([[67, 68], [61, 63]]);
const WORKER_OF = [41, 7, 64];
const fell = (e: UnitEvent, ignored: ReadonlySet<number>) => e.kind === "died" && e.owner <= 7 && e.type < 203 && !NOT_MADE.has(e.type) && !RESOURCES.has(e.type) && !ignored.has(e.unit);

/** The templars that went into an Archon: a templar gone with no killer where, at that moment, another became an Archon. */
export function merged(t: ReplayTimeline): Set<number> {
  const out = new Set<number>();
  const morphs = t.events.filter((e) => e.kind === "morph" && e.from !== undefined && MERGES.get(e.from) === e.type);
  if (!morphs.length) return out;
  for (const e of t.events) {
    if (e.kind !== "died" || e.by !== undefined || !MERGES.has(e.type)) continue;
    if (morphs.some((m) => m.from === e.type && m.owner === e.owner && Math.abs(m.frame - e.frame) <= 8 && Math.hypot(m.x - e.x, m.y - e.y) <= 64)) out.add(e.unit);
  }
  return out;
}

export interface FightSide {
  player: number;
  lost: number;
  lostValue: number;
  killed: number;
  killedValue: number;
  /** Fighting units there when it began (not workers, not buildings), and what they cost; 0 when the timeline keeps no positions. */
  army: number;
  armyValue: number;
  /**
   * Everything the player had in the game when it began, wherever it stood: the army and the workers, by what they
   * cost (by how many where nothing has a cost). Never less than what the side lost in the fight.
   */
  had: number;
  /** What it lost, by type: units.dat id → how many. */
  lostTypes: Map<number, number>;
}

/** Armies against each other, workers picked off, or buildings brought down. */
export type FightKind = "battle" | "workers" | "buildings";
/**
 * Decisive: one side lost much of everything it had and the other came out clearly ahead. Major: a real share of the
 * players' forces fell. Minor: a skirmish.
 */
export type FightTier = "decisive" | "major" | "minor";

export interface Fight {
  from: number;
  to: number;
  /** Pixels: the middle of what fell, and the box around it. */
  x: number;
  y: number;
  rect: { x0: number; y0: number; x1: number; y1: number };
  /** Where and when each loss fell, in order: what the map follows while the fight goes on. */
  points: { frame: number; x: number; y: number }[];
  losses: number;
  value: number;
  sides: FightSide[];
  /** The player who came out clearly ahead, or null when it was even. */
  winner: number | null;
  kind: FightKind;
  tier: FightTier;
  /** What fell as a share of everything the sides had when it began, 0 to 1. */
  share: number;
  /** The fight after which the player ahead in army stayed ahead to the end. At most one a game, and only in a game of two. */
  turning: boolean;
  /** How much it mattered, for ranking: the share that fell, and more when one side lost much of its own and the other won. */
  importance: number;
  /** One of the game's key moments: the turning fight and the ones that mattered most, a few for the game's length. */
  key: boolean;
}

/** A kill as the overlay draws it: from where the killer stood to where the victim fell. */
export interface Kill { frame: number; x: number; y: number; fromX: number; fromY: number; player: number; by: number }

export function kills(t: ReplayTimeline): Kill[] {
  const out: Kill[] = [];
  for (const e of t.events) if (e.kind === "died" && e.by !== undefined && e.owner <= 7 && (e.byOwner ?? 99) <= 7) out.push({ frame: e.frame, x: e.x, y: e.y, fromX: e.byX ?? e.x, fromY: e.byY ?? e.y, player: e.owner, by: e.byOwner! });
  return out;
}

export function fights(t: ReplayTimeline, cost: (type: number) => number, index: UnitIndex): Fight[] {
  const ignored = merged(t);
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
  // A fight that spreads starts a second one beside itself, and one that pauses starts again: those are one fight.
  closed.sort((a, b) => a.deaths[0].frame - b.deaths[0].frame);
  for (let i = 0; i < closed.length; i++) {
    for (let j = i + 1; j < closed.length; j++) {
      const a = closed[i], b = closed[j];
      if (b.deaths[0].frame - a.last > JOIN_GAP) break;
      if (Math.hypot(a.sx / a.deaths.length - b.sx / b.deaths.length, a.sy / a.deaths.length - b.sy / b.deaths.length) > JOIN_RADIUS) continue;
      a.deaths.push(...b.deaths); a.deaths.sort((x, y) => x.frame - y.frame);
      a.sx += b.sx; a.sy += b.sy; a.last = Math.max(a.last, b.last);
      closed.splice(j, 1); j = i;
    }
  }

  // Weighed by cost, or by count where nothing has one (no game data in the editor).
  const costed = t.events.some((e) => e.kind === "died" && cost(e.type) > 0);
  const weigh = (type: number) => (costed ? cost(type) : 1);
  const races = new Map(t.players.map((p) => [p.slot, p.race] as const));
  /** What a player had in the whole game at a frame: the army and the workers. */
  const hadAt = (player: number, frame: number) => {
    const q = t.samples.players.find((p) => p.slot === player);
    const i = sampleAt(t.samples.frame, frame);
    if (!q || i < 0) return 0;
    const workers = q.workers[i] ?? 0, worker = WORKER_OF[races.get(player) ?? 1] ?? 7;
    return costed ? (q.armyValue[i] ?? 0) + workers * cost(worker) : (q.army[i] ?? 0) + workers;
  };

  const out: Fight[] = [];
  for (const f of closed) {
    const sides = new Map<number, FightSide>();
    const side = (player: number) => { let s = sides.get(player); if (!s) { s = { player, lost: 0, lostValue: 0, killed: 0, killedValue: 0, army: 0, armyValue: 0, had: 0, lostTypes: new Map() }; sides.set(player, s); } return s; };
    let value = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let weight = 0, workers = 0, buildings = 0;
    const lostWeight = new Map<number, number>();
    for (const e of f.deaths) {
      const v = cost(e.type), s = side(e.owner), wt = weigh(e.type);
      s.lost++; s.lostValue += v; s.lostTypes.set(e.type, (s.lostTypes.get(e.type) ?? 0) + 1);
      value += v; weight += wt;
      lostWeight.set(e.owner, (lostWeight.get(e.owner) ?? 0) + wt);
      if (WORKERS.has(e.type)) workers += wt;
      else if (isBuilding(e.type)) buildings += wt;
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

    // Weighed against the whole game: what each side had a moment before it began.
    let had = 0, ownWorst = 0, loserWorst = 0;
    for (const s of list) {
      const lost = lostWeight.get(s.player) ?? 0;
      s.had = Math.max(hadAt(s.player, from - 1), lost);
      had += s.had;
      const own = s.had > 0 ? lost / s.had : 0;
      ownWorst = Math.max(ownWorst, own);
      if (s.player !== winner) loserWorst = Math.max(loserWorst, own);
    }
    const share = had > 0 ? Math.min(1, weight / had) : 0;
    const tier: FightTier = winner !== null && loserWorst >= DECISIVE ? "decisive" : share >= MAJOR_SHARE || ownWorst >= MAJOR_OWN ? "major" : "minor";
    const kind: FightKind = buildings >= weight * MOSTLY ? "buildings" : workers >= weight * MOSTLY ? "workers" : "battle";
    const importance = share + (winner !== null ? loserWorst / 2 : 0);
    out.push({ from, to: f.last, x, y, rect: { x0, y0, x1, y1 }, points: f.deaths.map((e) => ({ frame: e.frame, x: e.x, y: e.y })), losses: f.deaths.length, value, sides: list, winner, kind, tier, share, turning: false, importance, key: false });
  }
  out.sort((a, b) => a.from - b.from);
  const turn = turningFight(t, out, costed);
  if (turn) turn.turning = turn.key = true;
  const decisive = out.filter((f) => f.tier === "decisive").length;
  const keys = Math.min(MAX_KEYS, Math.max(MIN_KEYS, decisive, Math.round(t.frames / FRAMES_PER_MINUTE / KEY_MINUTES)));
  const ranked = out.filter((f) => f.tier !== "minor" && !f.turning).sort((a, b) => b.importance - a.importance);
  for (const f of ranked.slice(0, keys - (turn ? 1 : 0))) f.key = true;
  return out;
}

/**
 * In a game of two: the moment the player ahead in army at the end last took the lead, and the biggest fight they won
 * around it. Null when the lead was never taken in a fight (one side simply built more), or the game had more players.
 */
function turningFight(t: ReplayTimeline, list: Fight[], costed: boolean): Fight | null {
  const frames = t.samples.frame;
  const players = t.samples.players.filter((q) => q.workers.some((n) => n > 0));
  if (players.length !== 2 || !frames.length) return null;
  const [a, b] = players;
  const army = (q: typeof a, i: number) => (costed ? q.armyValue[i] : q.army[i]) ?? 0;
  // Who leads, with some room so a lead does not flicker: 1 for a, -1 for b, 0 for neither.
  let state = 0, last = 0, changed = -1;
  for (let i = 0; i < frames.length; i++) {
    const va = army(a, i), vb = army(b, i), room = Math.max(costed ? MIN_LEAD_VALUE : MIN_LEAD_UNITS, LEAD * Math.max(va, vb));
    const now = va - vb > room ? 1 : vb - va > room ? -1 : state && Math.sign(va - vb) === state ? state : 0;
    if (now !== 0 && now !== last) { last = now; changed = frames[i]; }
    state = now;
  }
  if (!last || changed < 0) return null;
  const leader = last > 0 ? a.slot : b.slot;
  let best: Fight | null = null;
  for (const f of list) {
    if (f.tier === "minor" || f.winner !== leader || f.from > changed + TURN_AFTER || f.to < changed - TURN_BEFORE) continue;
    if (!best || f.value > best.value || (f.value === best.value && f.losses > best.losses)) best = f;
  }
  return best;
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

/** The most of a fight the game plays again (45 seconds), and the quiet that leaves a loss at its edge out (five seconds). */
export const ENGAGEMENT_MOST = 1080;
export const ENGAGEMENT_LULL = 120;

/** The heart of a fight, as the game is asked to play it again: its frames, the box around what fell, its sides. */
export interface Engagement { from: number; to: number; x0: number; y0: number; x1: number; y1: number; players: number[] }

/**
 * The heart of a fight: the 45 seconds of it with the most losses (the earliest, when two have as many), from the first
 * loss in them to the last, less a loss at either edge five seconds or more from the rest. A fight as found here can join skirmishes over minutes, and the game playing all of that
 * again with other rules would be another game, not the same engagement fought another way; and a stray loss before
 * the armies meet (a scout, a lone unit picked off) must not decide where it starts.
 */
export function engagement(f: Fight): Engagement {
  const points = f.points.length ? f.points : [{ frame: f.from, x: f.x, y: f.y }];
  let best = 0, most = 0;
  for (let i = 0, j = 0; i < points.length; i++) {
    while (j < points.length && points[j].frame - points[i].frame <= ENGAGEMENT_MOST) j++;
    if (j - i > most) { most = j - i; best = i; }
  }
  const kept = points.slice(best, best + most);
  while (kept.length > 1 && kept[1].frame - kept[0].frame > ENGAGEMENT_LULL) kept.shift();
  while (kept.length > 1 && kept[kept.length - 1].frame - kept[kept.length - 2].frame > ENGAGEMENT_LULL) kept.pop();
  return {
    from: kept[0].frame, to: kept[kept.length - 1].frame,
    x0: Math.min(...kept.map((p) => p.x)), y0: Math.min(...kept.map((p) => p.y)),
    x1: Math.max(...kept.map((p) => p.x)), y1: Math.max(...kept.map((p) => p.y)),
    players: f.sides.map((s) => s.player),
  };
}
