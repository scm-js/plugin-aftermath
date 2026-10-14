/**
 * What many games on one map say about the map: where players start and how they fare from each place, which
 * bases are taken, when and in what order, where the fighting happens and whether the nearer player comes out
 * ahead there, and the ground nobody ever enters. Made from games already played through (`played.ts`,
 * `fights.ts`); pure and tested.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";
import type { Fight } from "./fights";
import type { Standing } from "./played";

/** Command Center, Hatchery, Nexus: what makes a place a base. */
const HALLS = new Set([106, 131, 154]);
/** Halls this near each other are one base (ten tiles); fights this near are one place (fifteen). */
const SITE_RADIUS = 320;
const SPOT_RADIUS = 480;
/** The ground is counted in squares of four tiles. */
export const VISIT_CELL = 128;
/** A fight spot is listed once it has seen this many fights. */
const MIN_SPOT_FIGHTS = 2;

export interface GameInput {
  timeline: ReplayTimeline;
  standing: readonly Standing[];
  fights: readonly Fight[];
  /** The game's player number of whoever won, or null when that cannot be told. */
  winner: number | null;
}

export interface Site {
  /** Pixels, the middle of the halls built there. */
  x: number;
  y: number;
  /** Where it lies as on a clock face, 1 to 12, or 0 for the middle of the map. */
  clock: number;
  /** Games in which a player started here, and how many of those players won (of the ones in games with a winner). */
  starts: number;
  startWins: number;
  startDecided: number;
  /** Games in which a player who started elsewhere built a base here. */
  taken: number;
  /** When it was first taken, the middle game's frame; and which base it usually was for its taker (2: the first after the start). */
  medianFrame: number | null;
  medianOrder: number | null;
}

export interface FightSpot {
  x: number;
  y: number;
  clock: number;
  fights: number;
  games: number;
  /** What fell there in all, minerals and gas; 0 when the editor has no costs. */
  value: number;
  medianFrame: number;
  /** Of the fights here that one side clearly won: how many, and how many of those the player who started nearer won. */
  decided: number;
  nearerWon: number;
}

export interface MapReport {
  games: number;
  /** Games with a winner known. */
  decided: number;
  medianFrames: number;
  /** When the first fight of a game began, the middle game's; null when no game had one. */
  medianFirstFight: number | null;
  sites: Site[];
  spots: FightSpot[];
  /** In squares of `VISIT_CELL` pixels: in how many games any player's unit stood there. */
  visited: { width: number; height: number; games: Uint16Array };
  /** The share of those squares no unit ever stood in, 0 to 1. Water and cliffs are among them. */
  neverEntered: number;
}

const median = (list: number[]): number | null => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
};

/** 12 at the top, 3 on the right; 0 for a point within an eighth of the map's size of its middle. */
export function clockOf(x: number, y: number, widthPx: number, heightPx: number): number {
  const dx = (x - widthPx / 2) / widthPx, dy = (y - heightPx / 2) / heightPx;
  if (Math.hypot(dx, dy) < 0.125) return 0;
  const h = (((Math.atan2(dx, -dy) / (Math.PI * 2)) * 12) + 12) % 12, low = Math.floor(h);
  // A corner lies between two hours; it is called by the one nearer the top or the bottom (1, 5, 7, 11), as players do.
  const hour = Math.abs(h - low - 0.5) < 0.15 ? (low % 6 < 3 ? low : low + 1) : Math.round(h);
  return ((hour + 11) % 12) + 1;
}

interface Cluster { sx: number; sy: number; n: number }
function nearest<T extends Cluster>(list: T[], x: number, y: number, radius: number): T | null {
  let best: T | null = null, bestD = radius;
  for (const c of list) { const d = Math.hypot(c.sx / c.n - x, c.sy / c.n - y); if (d <= bestD) { best = c; bestD = d; } }
  return best;
}

export function mapReport(games: readonly GameInput[], map: { width: number; height: number }): MapReport {
  const widthPx = map.width * 32, heightPx = map.height * 32;
  interface SiteAcc extends Cluster { starts: number; startWins: number; startDecided: number; frames: number[]; orders: number[] }
  interface SpotAcc extends Cluster { fights: number; games: Set<number>; value: number; frames: number[]; decided: number; nearerWon: number }
  const sites: SiteAcc[] = [], spots: SpotAcc[] = [];
  const siteAt = (x: number, y: number) => {
    let s = nearest(sites, x, y, SITE_RADIUS);
    if (!s) { s = { sx: 0, sy: 0, n: 0, starts: 0, startWins: 0, startDecided: 0, frames: [], orders: [] }; sites.push(s); }
    s.sx += x; s.sy += y; s.n++;
    return s;
  };
  const cw = Math.ceil(widthPx / VISIT_CELL), chh = Math.ceil(heightPx / VISIT_CELL);
  const visited = new Uint16Array(cw * chh), seen = new Uint8Array(cw * chh);
  const firstFights: number[] = [];

  games.forEach((game, g) => {
    // Where each player started: the hall they had at the first frame.
    const startOf = new Map<number, { x: number; y: number }>();
    for (const b of game.standing) if (b.from === 0 && HALLS.has(b.type) && !startOf.has(b.owner)) startOf.set(b.owner, { x: b.x, y: b.y });
    for (const [player, at] of startOf) {
      const s = siteAt(at.x, at.y);
      s.starts++;
      if (game.winner !== null) { s.startDecided++; if (game.winner === player) s.startWins++; }
    }
    // The bases built after: each place once a player, in the order that player took them.
    const taken = new Map<SiteAcc, number>(), count = new Map<number, number>(), mine = new Map<number, Set<SiteAcc>>();
    for (const b of [...game.standing].sort((a, c) => a.from - c.from)) {
      if (b.from === 0 || !HALLS.has(b.type)) continue;
      const home = startOf.get(b.owner);
      if (home && Math.hypot(home.x - b.x, home.y - b.y) <= SITE_RADIUS) continue;
      const s = siteAt(b.x, b.y), had = mine.get(b.owner) ?? new Set<SiteAcc>();
      mine.set(b.owner, had);
      if (had.has(s)) continue;
      had.add(s);
      const order = (count.get(b.owner) ?? 1) + 1;
      count.set(b.owner, order);
      s.orders.push(order);
      if (!taken.has(s)) taken.set(s, b.from);
    }
    for (const [s, frame] of taken) s.frames.push(frame);

    // The fights, by place; the nearer player is the one whose start is closer.
    if (game.fights.length) firstFights.push(game.fights[0].from);
    for (const f of game.fights) {
      let s = nearest(spots, f.x, f.y, SPOT_RADIUS);
      if (!s) { s = { sx: 0, sy: 0, n: 0, fights: 0, games: new Set(), value: 0, frames: [], decided: 0, nearerWon: 0 }; spots.push(s); }
      s.sx += f.x; s.sy += f.y; s.n++;
      s.fights++; s.games.add(g); s.value += f.value; s.frames.push(f.from);
      if (f.winner === null) continue;
      let nearer = -1, nearD = Infinity;
      for (const side of f.sides) { const at = startOf.get(side.player); if (!at) continue; const d = Math.hypot(at.x - f.x, at.y - f.y); if (d < nearD) { nearD = d; nearer = side.player; } }
      if (nearer < 0) continue;
      s.decided++;
      if (f.winner === nearer) s.nearerWon++;
    }

    // The ground this game's units stood on.
    const p = game.timeline.positions;
    if (p) {
      seen.fill(0);
      for (let r = 0; r < p.unit.length; r++) {
        const cx = Math.floor(p.x[r] / VISIT_CELL), cy = Math.floor(p.y[r] / VISIT_CELL);
        if (cx >= 0 && cy >= 0 && cx < cw && cy < chh) seen[cy * cw + cx] = 1;
      }
      // (A building stands where no unit's place is recorded.)
      for (const b of game.standing) { const cx = Math.floor(b.x / VISIT_CELL), cy = Math.floor(b.y / VISIT_CELL); if (cx >= 0 && cy >= 0 && cx < cw && cy < chh) seen[cy * cw + cx] = 1; }
      for (let i = 0; i < seen.length; i++) visited[i] += seen[i];
    }
  });

  let empty = 0;
  for (const n of visited) if (!n) empty++;
  const siteOut: Site[] = sites.map((s) => {
    const x = s.sx / s.n, y = s.sy / s.n;
    return { x, y, clock: clockOf(x, y, widthPx, heightPx), starts: s.starts, startWins: s.startWins, startDecided: s.startDecided, taken: s.frames.length, medianFrame: median(s.frames), medianOrder: median(s.orders) };
  }).sort((a, b) => (b.starts > 0 ? 1 : 0) - (a.starts > 0 ? 1 : 0) || b.taken - a.taken || (a.clock || 13) - (b.clock || 13));
  const spotOut: FightSpot[] = spots.filter((s) => s.fights >= MIN_SPOT_FIGHTS).map((s) => {
    const x = s.sx / s.n, y = s.sy / s.n;
    return { x, y, clock: clockOf(x, y, widthPx, heightPx), fights: s.fights, games: s.games.size, value: s.value, medianFrame: median(s.frames)!, decided: s.decided, nearerWon: s.nearerWon };
  }).sort((a, b) => b.fights - a.fights);
  return {
    games: games.length, decided: games.filter((g) => g.winner !== null).length,
    medianFrames: median(games.map((g) => g.timeline.frames)) ?? 0, medianFirstFight: median(firstFights),
    sites: siteOut, spots: spotOut,
    visited: { width: cw, height: chh, games: visited }, neverEntered: games.some((g) => g.timeline.positions) && visited.length ? empty / visited.length : 0,
  };
}

/** Who won, as far as a replay shows it: the one player who never left, or else the one player with a building standing at the end. */
export function winnerOf(players: readonly { index: number; left: boolean }[], standing: readonly Standing[]): number | null {
  const stayed = players.filter((p) => !p.left);
  if (stayed.length === 1 && players.length > 1) return stayed[0].index;
  const alive = new Set<number>();
  for (const b of standing) if (b.to === null) alive.add(b.owner);
  const holding = players.filter((p) => alive.has(p.index));
  return holding.length === 1 && players.length > 1 ? holding[0].index : null;
}
