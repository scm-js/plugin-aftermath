/**
 * The camera of Spectate: where an observer would be looking at each moment of the game, worked out once for the whole
 * game from the timeline, so it can cut to two armies before they meet. Pure and tested.
 *
 * At each sample of where units stood, everything worth watching is a candidate with a score: a fight (the more it
 * matters, the more it scores, and from a few seconds before its first loss), two armies about to meet, a new base
 * going down, and each player's main army. The camera keeps its shot for a while unless something clearly better comes
 * along, holds a fight until it is over, and leaves an army it has followed for long so the other player gets a look.
 * The result is a list of shots, each with where to look at every sample it covers.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";
import type { Fight } from "./fights";
import { WORKERS, counted, isBuilding, type UnitIndex } from "./played";
import type { Base } from "./story";

/** Units this near each other are one group (eight tiles, by squares of that size touching). */
const GROUP_CELL = 256;
/** A group smaller than this is not an army: some value (minerals and gas), or units where nothing has a cost. */
const MIN_ARMY_VALUE = 300;
const MIN_ARMY_UNITS = 3;
/** Two armies this near (twenty tiles) are about to meet. */
const MEETING = 640;
/** The camera is at a fight this long before its first loss (four seconds), and stays this long after its last. */
const FIGHT_BEFORE = 96;
const FIGHT_AFTER = 48;
/** A new base is worth a look for this long (eight seconds). */
const BASE_LOOK = 192;
/** What has fallen this recently is where a fight is now (five seconds). */
const FRONT = 120;
/** A shot is kept at least this many samples, and an army followed at most this many before it gives way. */
const MIN_HOLD = 3;
const ARMY_HOLD = 8;
/** Something else takes the camera when it scores this much more than what is shown. */
const BETTER = 1.4;
/** A shot shorter than this many samples is left out: the camera goes straight to the next. */
const MIN_SHOT = 3;
/** Command Center, Hatchery, Nexus. */
const HALLS = new Set([106, 131, 154]);

export type ShotKind = "fight" | "meeting" | "base" | "army" | "home";

export interface Shot {
  kind: ShotKind;
  /** Frames: the shot runs from `from` to the next shot's `from`. */
  from: number;
  to: number;
  /** The fight shown. */
  fight?: Fight;
  /** The base going down. */
  base?: Base;
  /** The player whose army or home is followed; for a fight or a meeting, the players in it. */
  players: number[];
  /** Where to look, pixels, a point a sample, in order. */
  path: { frame: number; x: number; y: number }[];
}

interface Candidate {
  kind: ShotKind;
  /** The same thing from one sample to the next has the same key. */
  key: string;
  score: number;
  x: number;
  y: number;
  players: number[];
  fight?: Fight;
  base?: Base;
}

interface Group { player: number; x: number; y: number; value: number; units: number }

/** Each player's groups of fighting units at one sample: units in touching squares of `GROUP_CELL` are one group. */
export function groupsAt(t: ReplayTimeline, index: UnitIndex, sample: number, cost: (type: number) => number): Group[] {
  const p = t.positions;
  if (!p) return [];
  const cells = new Map<string, { player: number; cx: number; cy: number; sx: number; sy: number; value: number; units: number }>();
  for (let r = p.start[sample]; r < p.start[sample + 1]; r++) {
    const u = p.unit[r], type = index.type[u], owner = index.owner[u];
    if (owner < 0 || owner > 7 || !counted(type) || WORKERS.has(type) || isBuilding(type)) continue;
    const cx = Math.floor(p.x[r] / GROUP_CELL), cy = Math.floor(p.y[r] / GROUP_CELL), k = `${owner}:${cx}:${cy}`;
    let c = cells.get(k);
    if (!c) { c = { player: owner, cx, cy, sx: 0, sy: 0, value: 0, units: 0 }; cells.set(k, c); }
    c.sx += p.x[r]; c.sy += p.y[r]; c.value += cost(type); c.units++;
  }
  // Touching squares of one player are one group.
  const out: Group[] = [];
  const seen = new Set<string>();
  for (const [k, c] of cells) {
    if (seen.has(k)) continue;
    const g = { player: c.player, sx: 0, sy: 0, value: 0, units: 0 };
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const cell = cells.get(stack.pop()!)!;
      g.sx += cell.sx; g.sy += cell.sy; g.value += cell.value; g.units += cell.units;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const n = `${c.player}:${cell.cx + dx}:${cell.cy + dy}`;
        if (!seen.has(n) && cells.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    out.push({ player: g.player, x: g.sx / g.units, y: g.sy / g.units, value: g.value, units: g.units });
  }
  return out;
}

/**
 * The shots of the whole game; empty when the timeline keeps no positions. With `only`, the shots of one player's game,
 * for watching through their eyes: their fights, their army, their bases, their home — and an army about to meet theirs
 * is looked at from their side, not from the fog between.
 */
export function direct(t: ReplayTimeline, index: UnitIndex, fights: readonly Fight[], bases: readonly Base[], cost: (type: number) => number, only?: number): Shot[] {
  const p = t.positions;
  if (!p || !p.frame.length) return [];
  const costed = t.events.some((e) => e.kind === "died" && cost(e.type) > 0);
  const isArmy = (g: Group) => (costed ? g.value >= MIN_ARMY_VALUE : g.units >= MIN_ARMY_UNITS);
  const weight = (g: Group) => (costed ? g.value / 300 : g.units / 6);
  // Where each player started: what the camera looks at when there is nothing else, as an observer does early on.
  const homes = new Map<number, { x: number; y: number }>();
  for (const e of t.events) {
    if (e.frame > 0) break;
    if (e.kind === "born" && HALLS.has(e.type) && e.owner <= 7 && !homes.has(e.owner)) homes.set(e.owner, { x: e.x, y: e.y });
  }

  const candidates = (i: number, frame: number, previous: Map<number, Group>): Candidate[] => {
    const out: Candidate[] = [];
    // Fights, a few seconds before they begin, at where things fall now (or where they will).
    fights.forEach((f, n) => {
      if (frame < f.from - FIGHT_BEFORE || frame > f.to + FIGHT_AFTER) return;
      let sx = 0, sy = 0, k = 0;
      for (const pt of f.points) { if (pt.frame > frame + 24) break; if (pt.frame >= frame - FRONT) { sx += pt.x; sy += pt.y; k++; } }
      const base = f.tier === "minor" ? (f.kind === "workers" ? 30 : 15) + Math.min(30, f.value / 100) : 100 + 200 * f.importance;
      out.push({ kind: "fight", key: `f${n}`, score: base, x: k ? sx / k : f.x, y: k ? sy / k : f.y, players: f.sides.map((s) => s.player), fight: f });
    });
    // Each player's main army; and two armies of different players near each other.
    const groups = groupsAt(t, index, i, cost).filter(isArmy);
    const mains = new Map<number, Group>();
    for (const g of groups) { const m = mains.get(g.player); if (!m || g.value + g.units > m.value + m.units) mains.set(g.player, g); }
    for (const [player, g] of mains) {
      // More for an army on the move.
      const before = previous.get(player), moved = before ? Math.hypot(g.x - before.x, g.y - before.y) / 64 : 0;
      out.push({ kind: "army", key: `a${player}`, score: 10 + weight(g) + Math.min(10, moved), x: g.x, y: g.y, players: [player] });
    }
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
      const ga = groups[a], gb = groups[b];
      if (ga.player === gb.player || Math.hypot(ga.x - gb.x, ga.y - gb.y) > MEETING) continue;
      const players = [ga.player, gb.player].sort((x, y) => x - y);
      const own = only === undefined ? null : ga.player === only ? ga : gb.player === only ? gb : null;
      out.push({ kind: "meeting", key: `m${players.join("-")}`, score: 40 + weight(ga) + weight(gb), x: own ? own.x : (ga.x + gb.x) / 2, y: own ? own.y : (ga.y + gb.y) / 2, players });
    }
    bases.forEach((b, n) => {
      if (frame >= b.frame && frame <= b.frame + BASE_LOOK) out.push({ kind: "base", key: `b${n}`, score: 35, x: b.x, y: b.y, players: [b.player], base: b });
    });
    for (const [player, g] of mains) previous.set(player, g);
    for (const [player, at] of homes) out.push({ kind: "home", key: `h${player}`, score: 2, x: at.x, y: at.y, players: [player] });
    return only === undefined ? out : out.filter((c) => c.players.includes(only));
  };

  const shots: Shot[] = [];
  let cur: { shot: Shot; key: string; held: number } | null = null;
  const previous = new Map<number, Group>();
  for (let i = 0; i < p.frame.length; i++) {
    const frame = p.frame[i];
    const list = candidates(i, frame, previous);
    if (!list.length) { if (cur) cur.held++; continue; }
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    const same = cur ? list.find((c) => c.key === cur!.key) : undefined;
    let keep = false;
    if (cur && same) {
      // A fight is held until it is over; anything is held a few samples; an army followed long gives way.
      const tired = (same.kind === "army" || same.kind === "home") && cur.held >= ARMY_HOLD;
      keep = same.kind === "fight" ? best.score < same.score * BETTER || best.kind !== "fight"
        : cur.held < MIN_HOLD ? best.kind !== "fight" || best.score < same.score * BETTER
        : !tired && best.score < same.score * BETTER;
    }
    if (keep && same && cur) {
      cur.shot.path.push({ frame, x: same.x, y: same.y });
      cur.shot.to = frame;
      cur.held++;
      continue;
    }
    // A new shot: the best; or for an army or a home that has had its time, the best of another player's, else anything else.
    const top = (from: Candidate[]) => from.reduce<Candidate | null>((a, b) => (!a || b.score > a.score ? b : a), null);
    const pick: Candidate = cur && same && (same.kind === "army" || same.kind === "home") && best.key === cur.key
      ? top(list.filter((c) => !c.players.some((pl) => cur!.shot.players.includes(pl)))) ?? top(list.filter((c) => c.key !== cur!.key)) ?? best
      : best;
    if (cur && pick.key === cur.key) { cur.shot.path.push({ frame, x: pick.x, y: pick.y }); cur.shot.to = frame; cur.held = 0; continue; }
    const shot: Shot = { kind: pick.kind, from: frame, to: frame, players: pick.players, path: [{ frame, x: pick.x, y: pick.y }], ...(pick.fight ? { fight: pick.fight } : {}), ...(pick.base ? { base: pick.base } : {}) };
    if (cur) cur.shot.to = frame;
    shots.push(shot);
    cur = { shot, key: pick.key, held: 0 };
  }
  if (cur) cur.shot.to = Math.max(cur.shot.to, t.frames);
  // A shot of a moment or two is a flicker: the camera goes straight to what comes next, a little early.
  const every = p.frame.length > 1 ? p.frame[1] - p.frame[0] : 48;
  for (let i = shots.length - 2; i >= 0; i--) {
    if (shots[i].to - shots[i].from >= MIN_SHOT * every) continue;
    shots[i + 1].from = shots[i].from;
    shots.splice(i, 1);
  }
  return shots;
}

/** The shot at a frame, by its index, or -1 before the first. */
export function shotAt(shots: readonly Shot[], frame: number): number {
  let lo = 0, hi = shots.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (shots[mid].from <= frame) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

/** Where a shot looks at a frame: between the points of its path either side. */
export function lookAt(shot: Shot, frame: number): { x: number; y: number } {
  const path = shot.path;
  let i = 0;
  while (i + 1 < path.length && path[i + 1].frame <= frame) i++;
  const a = path[i], b = path[i + 1];
  if (!b || frame <= a.frame) return { x: a.x, y: a.y };
  const k = Math.min(1, (frame - a.frame) / Math.max(1, b.frame - a.frame));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}
