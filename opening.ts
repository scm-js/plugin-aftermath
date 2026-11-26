/**
 * A build order the way players write it: each thing begun with the supply the player had then ("9 Pool", "13
 * Nexus"), and the opening's name, by a table of rules over the first buildings.
 *
 * The supply is the game's own count at the sample before the step (every two seconds), brought up to the step's frame
 * with the workers started since: a worker is a supply each and the one thing made often enough to matter there. A
 * Drone that becomes a building gives its supply back, so the step itself is counted before that, as players count.
 *
 * The names are for the game's own races and buildings: a mod's units table, or a race a data set adds, gets none.
 * Pure: no editor, no DOM.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";
import type { MadeRow } from "./played";
import { DEPOTS, KINDS, WORKERS, isBuilding } from "./roles";

/** The supply `player` had just before `frame`, or null before the first sample. */
export function supplyAt(t: ReplayTimeline, player: number, frame: number): number | null {
  const s = t.samples.players.find((p) => p.slot === player);
  const frames = t.samples.frame;
  if (!s) return null;
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid] < frame) lo = mid + 1; else hi = mid; }
  const i = lo - 1;
  if (i < 0) return null;
  return s.supplyUsed[i] + workerStarts(t, player, frames[i], frame);
}

/** Workers started by `player` after `from` and before `to`, less Drones that became buildings then. */
function workerStarts(t: ReplayTimeline, player: number, from: number, to: number): number {
  let n = 0;
  const ev = t.events;
  // Events are in frame order: start where `from` is.
  let lo = 0, hi = ev.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].frame <= from) lo = mid + 1; else hi = mid; }
  for (let k = lo; k < ev.length && ev[k].frame < to; k++) {
    const e = ev[k];
    if (e.owner !== player) continue;
    // A worker in training at its hall (one finished the frame it appears was not trained: it left a refinery).
    if (e.kind === "born" && WORKERS.has(e.type) && !e.hallucination && !finishedAt(t, k)) n++;
    // A larva that became an egg that is to be a worker.
    else if (e.kind === "morph" && KINDS.eggs.has(e.type)) { const into = hatchesInto(t, k, e.unit); if (into !== null && WORKERS.has(into)) n++; }
    // A Drone that became a building.
    else if (e.kind === "morph" && e.from !== undefined && WORKERS.has(e.from) && isBuilding(e.type)) n--;
  }
  return n;
}

/** Whether the unit born at event `k` is done in the same frame. */
function finishedAt(t: ReplayTimeline, k: number): boolean {
  const e = t.events[k];
  for (let j = k + 1; j < t.events.length && t.events[j].frame === e.frame; j++) if (t.events[j].unit === e.unit && t.events[j].kind === "done") return true;
  return false;
}

/** What the egg made at event `k` became, looking ahead; null when it never hatched. */
function hatchesInto(t: ReplayTimeline, k: number, unit: number): number | null {
  for (let j = k + 1; j < t.events.length; j++) {
    const e = t.events[j];
    if (e.unit !== unit) continue;
    if (e.kind === "morph") return e.type;
    if (e.kind === "died") return null;
  }
  return null;
}

/** The game's numbers for the buildings and units the openings are told by. */
const U = {
  overlord: 42, pool: 142, hatchery: 131,
  commandCenter: 106, depot: 109, barracks: 111, factory: 113, starport: 114,
  nexus: 154, pylon: 156, gateway: 160, core: 164, forge: 166,
} as const;

export type OpeningKind =
  | "pool" | "overpool" | "hatch" | "hatch-pool"
  | "bbs" | "cc-first" | "rax-fe" | "rax" | "one-one-one" | "two-fact" | "rax-fact"
  | "forge-fe" | "nexus-first" | "gates" | "gate-fe" | "gate-core";

export interface Opening {
  kind: OpeningKind;
  /** The supply the defining step was begun at, or the count it is named by ("2 Gate"). */
  n: number | null;
  /** A second supply, where the name has two ("12 Hatch, 11 Pool"). */
  m: number | null;
  /** Its first production building put down nearer an opponent's start than the player's own. */
  proxy: boolean;
}

/** A step with the supply it was begun at. */
export interface Step { row: MadeRow; supply: number | null }

/**
 * The opening `steps` (one player's, in order) make for `race` (0 Zerg, 1 Terran, 2 Protoss); null for a race or
 * a units table the rules do not know, or a start the rules have no name for. `home` and `others`: the player's start
 * and the other players', for telling a proxy.
 */
export function opening(steps: readonly Step[], race: number | null, home: { x: number; y: number } | null, others: readonly { x: number; y: number }[]): Opening | null {
  if (!KINDS.game || race === null || race > 2) return null;
  const built = steps.filter((s) => s.row.kind === "unit" && s.row.building && s.row.frame > 0);
  const first = (type: number) => built.find((s) => s.row.id === type) ?? null;
  const all = (type: number) => built.filter((s) => s.row.id === type);
  const at = (s: Step | null) => s?.row.frame ?? Infinity;
  const supply = (s: Step | null) => s?.supply ?? null;
  const proxied = (s: Step | null) => {
    if (!s || !home || !others.length) return false;
    const own = Math.hypot(s.row.x - home.x, s.row.y - home.y);
    return own > 40 * 32 && others.some((o) => Math.hypot(s.row.x - o.x, s.row.y - o.y) < own);
  };
  const named = (kind: OpeningKind, n: number | null, m: number | null, by: Step | null): Opening => ({ kind, n, m, proxy: proxied(by) });

  if (race === 0) {
    const pool = first(U.pool), hatch = first(U.hatchery);
    if (pool && at(pool) < at(hatch)) {
      const ovie = steps.find((s) => s.row.kind === "unit" && s.row.id === U.overlord && s.row.frame > 0 && s.row.frame < pool.row.frame) ?? null;
      if ((supply(pool) ?? 0) > 8 && ovie && supply(ovie) === 9 && (supply(pool) ?? 99) <= 10) return named("overpool", null, null, pool);
      return named("pool", supply(pool), null, pool);
    }
    if (hatch) return pool ? named("hatch-pool", supply(hatch), supply(pool), hatch) : named("hatch", supply(hatch), null, hatch);
    return null;
  }
  if (race === 1) {
    const rax = all(U.barracks), cc = first(U.commandCenter), depot = first(U.depot), fact = first(U.factory), port = first(U.starport);
    if (rax.length >= 2 && at(rax[1]) < at(depot)) return named("bbs", null, null, rax[0]);
    if (cc && at(cc) < at(rax[0] ?? null)) return named("cc-first", supply(cc), null, rax[0] ?? null);
    const raxBefore = (frame: number) => rax.filter((r) => r.row.frame < frame).length;
    if (cc && at(cc) < at(fact)) return raxBefore(cc.row.frame) === 1 ? named("rax-fe", null, null, rax[0]) : named("rax", raxBefore(cc.row.frame), null, rax[0] ?? null);
    if (fact) {
      if (port && at(port) < at(cc)) return named("one-one-one", null, null, rax[0] ?? fact);
      if (all(U.factory).filter((f) => at(f) < at(cc)).length >= 2) return named("two-fact", null, null, rax[0] ?? fact);
      return named("rax-fact", null, null, rax[0] ?? fact);
    }
    if (rax.length >= 2) return named("rax", rax.length, null, rax[0]);
    return null;
  }
  const nexus = first(U.nexus), forge = first(U.forge), gates = all(U.gateway), core = first(U.core);
  const gate = gates[0] ?? null;
  if (nexus && at(nexus) < at(gate) && at(nexus) < at(forge)) return named("nexus-first", supply(nexus), null, null);
  if (nexus && forge && at(forge) < at(gate) && at(nexus) < at(gate)) return named("forge-fe", null, null, forge);
  const gatesBeforeCore = gates.filter((g) => at(g) < at(core)).length;
  if (gatesBeforeCore >= 2) return named("gates", gatesBeforeCore, null, gate);
  if (nexus && gate && at(nexus) < at(core)) return named("gate-fe", null, null, gate);
  if (gate && core) return named("gate-core", null, null, gate);
  return null;
}

/** The first steps worth writing on a card: buildings, not supply buildings (a Pylon, a Supply Depot). */
export function keySteps(steps: readonly Step[], count = 4): Step[] {
  const supplyBuildings: ReadonlySet<number> = KINDS.game ? new Set<number>([U.depot, U.pylon]) : new Set<number>();
  return steps.filter((s) => s.row.kind === "unit" && s.row.building && s.row.frame > 0 && !supplyBuildings.has(s.row.id)).slice(0, count);
}

/** Each player's start: their town hall there when the game began. */
export function starts(t: ReplayTimeline): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  for (const e of t.events) {
    if (e.frame > 0) break;
    if (e.kind === "born" && DEPOTS.has(e.type) && e.owner <= 7 && !out.has(e.owner)) out.set(e.owner, { x: e.x, y: e.y });
  }
  return out;
}
