/**
 * What each player knew of their opponents (`them`, by slot): read from the timeline's sightings (`ReplayTimeline.sight`, when each player
 * could see each unit of their opponents', as the game decides it, fog and detection included). Nothing here is a guess
 * at what a player noticed: a unit on their screen and one at the edge of their sight count the same.
 *
 * - `firstLooks`: when a player first saw anything of another's, and the first building of theirs.
 * - `threats`: cloaked units and air units of the others: when they first had one, when the player first saw one (or
 *   the building that makes them), and the first answer the player started (detection, anti-air) once they had it.
 * - `unseen`: their opponents' buildings that stood the longest before the player saw them.
 * - `armyInSight`: at each sample, the share of their opponents' army (by cost) the player could see.
 */
import { isBuilding } from "./played";
import type { ReplayTimeline } from "./vendor/scm-sim";

/** One stretch of a player seeing a unit, frames from–to. */
export interface Stretch { player: number; from: number; to: number }

/** A unit's life as the timeline tells it: who owned it, and its state (type, finished) from each frame on. */
export interface Life {
  owner: number;
  born: number;
  died: number | null;
  /** Frame, type, finished: rising frames. */
  states: [number, number, boolean][];
}

export function lives(t: ReplayTimeline): Map<number, Life> {
  const out = new Map<number, Life>();
  for (const e of t.events) {
    let l = out.get(e.unit);
    if (e.kind === "born") {
      if (e.hallucination) continue;
      out.set(e.unit, { owner: e.owner, born: e.frame, died: null, states: [[e.frame, e.type, false]] });
      continue;
    }
    if (!l) continue;
    if (e.kind === "done") l.states.push([e.frame, e.type, true]);
    else if (e.kind === "morph") l.states.push([e.frame, e.type, false]);
    else if (e.kind === "given") l.owner = e.owner;
    else if (e.kind === "died") l.died = e.frame;
  }
  return out;
}

/** The unit's type and whether it was finished at `frame`; null before it was born or once it was gone. */
export function stateAt(l: Life, frame: number): { type: number; done: boolean } | null {
  if (frame < l.born || (l.died !== null && frame >= l.died)) return null;
  let s = l.states[0];
  for (const x of l.states) { if (x[0] > frame) break; s = x; }
  return { type: s[1], done: s[2] };
}

/** The sightings by unit; empty for a timeline without them. */
export function sightsOf(t: ReplayTimeline): Map<number, Stretch[]> {
  const out = new Map<number, Stretch[]>();
  const s = t.sight;
  if (!s) return out;
  for (let i = 0; i < s.unit.length; i++) {
    const list = out.get(s.unit[i]) ?? [];
    list.push({ player: s.player[i], from: s.from[i], to: s.to[i] });
    out.set(s.unit[i], list);
  }
  for (const list of out.values()) list.sort((a, b) => a.from - b.from);
  return out;
}

export const seenAt = (stretches: readonly Stretch[] | undefined, player: number, frame: number): boolean =>
  !!stretches?.some((s) => s.player === player && s.from <= frame && frame < s.to);

/** The first frame from `from` on that `player` saw the unit, or null. */
function firstSeen(stretches: readonly Stretch[] | undefined, player: number, from: number, until = Infinity): number | null {
  let best: number | null = null;
  for (const s of stretches ?? []) {
    if (s.player !== player || s.to <= from || s.from >= until) continue;
    const at = Math.max(s.from, from);
    if (best === null || at < best) best = at;
  }
  return best;
}

/** Each stage of a unit's life as one type: from the frame it became that type to the frame it stopped being it. */
function stages(l: Life, end: number): { type: number; from: number; to: number }[] {
  const out: { type: number; from: number; to: number }[] = [];
  for (const [frame, type] of l.states) {
    const last = out[out.length - 1];
    if (last && last.type === type) continue;
    if (last) last.to = frame;
    out.push({ type, from: frame, to: l.died ?? end });
  }
  return out;
}

export interface Knowledge {
  lives: Map<number, Life>;
  sights: Map<number, Stretch[]>;
  /** Whether the timeline has sightings at all (an engine from before them gives none). */
  has: boolean;
  end: number;
}

export function knowledge(t: ReplayTimeline): Knowledge {
  return { lives: lives(t), sights: sightsOf(t), has: !!t.sight, end: t.frames };
}

/* ── First looks ── */

export interface FirstLook {
  /** When the player first saw anything of their opponents', and what (units.dat id). */
  any: { frame: number; type: number } | null;
  /** When they first saw a building of theirs, and which. */
  building: { frame: number; type: number } | null;
}

export function firstLooks(k: Knowledge, player: number, them: ReadonlySet<number>): FirstLook {
  const out: FirstLook = { any: null, building: null };
  for (const [unit, list] of k.sights) {
    const l = k.lives.get(unit);
    if (!l || !them.has(l.owner)) continue;
    for (const s of list) {
      if (s.player !== player) continue;
      const st = stateAt(l, s.from);
      if (!st) continue;
      if (!out.any || s.from < out.any.frame) out.any = { frame: s.from, type: st.type };
      if (isBuilding(st.type) && (!out.building || s.from < out.building.frame)) out.building = { frame: s.from, type: st.type };
    }
  }
  return out;
}

/* ── Threats and answers ── */

export type ThreatKind = "cloaked" | "air";

/** What makes a threat of each kind: its units, and the buildings that make them (seeing one is warning enough). */
export const THREATS: Record<ThreatKind, { units: readonly number[]; buildings: readonly number[] }> = {
  // Dark Templar, Lurker and its egg, Arbiter; Templar Archives (Dark Templar), none for the Lurker (a Hydralisk Den is not one).
  cloaked: { units: [61, 103, 97, 71], buildings: [165, 170] },
  // Mutalisk, Guardian, Devourer, Wraith, Battlecruiser, Carrier, Scout, Arbiter; Spire, Greater Spire, Stargate, Fleet Beacon, Physics Lab.
  air: { units: [43, 44, 62, 8, 12, 72, 70, 71], buildings: [141, 137, 167, 169, 118] },
};

/** The answers a race starts to each kind of threat, by race (0 Zerg, 1 Terran, 2 Protoss). */
export const ANSWERS: Record<ThreatKind, Record<number, readonly number[]>> = {
  // Spore Colony; Missile Turret, Comsat Station, Science Vessel; Photon Cannon, Observatory, Observer.
  cloaked: { 0: [144], 1: [124, 107, 9], 2: [162, 159, 84] },
  // Spore Colony, Hydralisk Den, Hydralisk, Scourge, Spire, Mutalisk; Missile Turret, Armory, Goliath, Valkyrie, Wraith;
  // Photon Cannon, Stargate, Corsair, Scout, Archon.
  air: { 0: [144, 135, 38, 47, 141, 43], 1: [124, 123, 3, 58, 8], 2: [162, 167, 60, 70, 68] },
};

export interface Threat {
  kind: ThreatKind;
  /** When their opponents first had one (a unit or the building that makes them, started), and which. */
  made: { frame: number; type: number };
  /** When the player first saw one, and which; null when they never did. */
  seen: { frame: number; type: number } | null;
  /** The player's first answer started once the opponents had it (before or after seeing it), and which; null for none. */
  answer: { frame: number; type: number } | null;
  /** An answer the player had started before the opponents had it at all (a cannon of the opening), or null. */
  already: { frame: number; type: number } | null;
}

/** Each kind of threat their opponents had, as `player` met it. `race`: the player's (0 Zerg, 1 Terran, 2 Protoss). */
export function threats(k: Knowledge, player: number, race: number, them: ReadonlySet<number>): Threat[] {
  const out: Threat[] = [];
  for (const kind of ["cloaked", "air"] as ThreatKind[]) {
    const tells = new Set([...THREATS[kind].units, ...THREATS[kind].buildings]);
    const answers = new Set(ANSWERS[kind][race] ?? []);
    let made: Threat["made"] | null = null, seen: Threat["seen"] = null;
    const mine: { frame: number; type: number }[] = [];
    for (const [unit, l] of k.lives) {
      const theirs = them.has(l.owner);
      for (const st of stages(l, k.end)) {
        if (theirs && tells.has(st.type)) {
          if (!made || st.from < made.frame) made = { frame: st.from, type: st.type };
          const s = firstSeen(k.sights.get(unit), player, st.from, st.to);
          if (s !== null && (!seen || s < seen.frame)) seen = { frame: s, type: st.type };
        }
        if (l.owner === player && answers.has(st.type) && st.from > 0) mine.push({ frame: st.from, type: st.type });
      }
    }
    if (!made) continue;
    mine.sort((a, b) => a.frame - b.frame);
    const from = made.frame;
    out.push({ kind, made, seen, answer: mine.find((a) => a.frame >= from) ?? null, already: mine.find((a) => a.frame < from) ?? null });
  }
  return out;
}

/* ── Buildings unseen ── */

export interface Unseen {
  unit: number;
  type: number;
  owner: number;
  /** When it was started (its site, or its morph). */
  from: number;
  /** When the player first saw it; null when they never did. */
  seen: number | null;
  /** How long it stood unseen: to the first sight, or (never seen) to when it was lost or the game ended. */
  unseenFor: number;
  x: number;
  y: number;
}

/**
 * Buildings that say little by standing unseen: supply (Pylon, Supply Depot), gas (Refinery, Extractor, Assimilator),
 * the Creep Colony, and static defence (Missile Turret, Bunker, Photon Cannon, Sunken and Spore Colony).
 */
const QUIET_BUILDINGS = new Set([156, 109, 110, 149, 157, 143, 124, 125, 162, 146, 144]);

/**
 * The opponents' buildings by how long they stood before `player` saw them, longest first: town halls, production and
 * tech (not `QUIET_BUILDINGS`). Those there at the start are left out.
 */
export function unseen(k: Knowledge, t: ReplayTimeline, player: number, them: ReadonlySet<number>): Unseen[] {
  const where = new Map<number, { x: number; y: number }>();
  for (const e of t.events) if ((e.kind === "born" || e.kind === "morph") && isBuilding(e.type)) where.set(e.unit, { x: e.x, y: e.y });
  const out: Unseen[] = [];
  for (const [unit, l] of k.lives) {
    if (!them.has(l.owner) || l.born === 0) continue;
    for (const st of stages(l, k.end)) {
      if (!isBuilding(st.type) || QUIET_BUILDINGS.has(st.type)) continue;
      const seen = firstSeen(k.sights.get(unit), player, st.from, st.to);
      const p = where.get(unit) ?? { x: 0, y: 0 };
      out.push({ unit, type: st.type, owner: l.owner, from: st.from, seen, unseenFor: (seen ?? st.to) - st.from, x: p.x, y: p.y });
    }
  }
  return out.sort((a, b) => b.unseenFor - a.unseenFor || a.from - b.from);
}

/* ── The army in sight ── */

/** Not an army: larva, eggs, cocoon, what is fired or laid, spells that are units, and the Overlord (supply, not a fighter). */
const NOT_ARMY = new Set([13, 14, 33, 35, 36, 42, 59, 73, 85, 97, 101, 105, 202]);
const WORKER = new Set([7, 41, 64]);

export interface ArmyInSight {
  frames: number[];
  /** Cost of their opponents' army there at each sample, and of what of it the player could see. */
  total: number[];
  seen: number[];
  /** Over the game, the share seen of what there was (what was seen ÷ what there was, summed over the samples). */
  share: number | null;
}

/** At each sample of the timeline, their opponents' army and what of it `player` could see; `cost` by units.dat id. */
export function armyInSight(k: Knowledge, t: ReplayTimeline, player: number, them: ReadonlySet<number>, cost: (type: number) => number): ArmyInSight {
  const frames = t.samples.frame;
  const total = frames.map(() => 0), seen = frames.map(() => 0);
  for (const [unit, l] of k.lives) {
    if (!them.has(l.owner)) continue;
    const list = k.sights.get(unit);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f < l.born) continue;
      if (l.died !== null && f >= l.died) break;
      const st = stateAt(l, f);
      if (!st || !st.done || NOT_ARMY.has(st.type) || WORKER.has(st.type) || isBuilding(st.type)) continue;
      const c = cost(st.type);
      total[i] += c;
      if (seenAt(list, player, f)) seen[i] += c;
    }
  }
  const all = total.reduce((a, b) => a + b, 0);
  return { frames, total, seen, share: all > 0 ? seen.reduce((a, b) => a + b, 0) / all : null };
}
