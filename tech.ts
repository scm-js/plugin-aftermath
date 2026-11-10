/**
 * The technology of a played game, read out of the engine's timeline: the buildings that open each player's tech
 * (the first of each kind, from its site to when it was finished), what they researched (upgrade levels and
 * technologies, from when the research began to when it was done), and the army they fielded, unit type by unit type,
 * minute by minute.
 *
 * Research is seen at the timeline's samples, so its end is late by up to `samples.every` frames (two seconds); its
 * start is that end less the research time from upgrades.dat / techdata.dat. A Lair, a Hive or a Greater Spire is
 * seen only once it is finished (the hall is the hall while it morphs), so its start is its end less its build time.
 * Without the game's tables neither start is known, and the item is a moment.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";
import { FRAMES_PER_MINUTE as MINUTE } from "./analysis";
import { buildings, counted, isBuilding, WORKERS } from "./played";
import { KINDS } from "./roles";

/**
 * The buildings that open a player's tech (`Kinds.tech`): the game's lists, in the order each race reaches them (town
 * halls, supply and defences are not there; a Lair and a Hive are, and a race's first gas and its first unit producer,
 * since the timing of those is tech), or with a mod's units table every building but halls, defences and resources.
 */
export const isTechBuilding = (type: number) => KINDS.tech.has(type);

/** Overlords make supply, not an army (none known with a mod's units table). */
const NOT_ARMY = KINDS.supplyOnly;
/** A type that is another's in another mode: a sieged tank is a tank (none known with a mod's units table). */
const SAME_AS = KINDS.sameAs;

export interface TechItem {
  kind: "building" | "upgrade" | "tech";
  /** units.dat id for a building, else the upgrade's or technology's. */
  id: number;
  /** An upgrade's level; 1 otherwise. */
  level: number;
  player: number;
  /** When it began: the building's site, the research's start (its end when the research time is not known). */
  start: number;
  /** When it was finished. */
  done: number;
}

export interface ArmyRow {
  player: number;
  /** units.dat id (a sieged tank counted as a tank). */
  type: number;
  /** How many the player had at the end of each minute (the last minute: at the game's end). */
  perMinute: number[];
  /** The most at once at a minute's end. */
  peak: number;
  /** The first minute it had any. */
  first: number;
}

export interface PlayerTech {
  slot: number;
  /** The first of each tech building finished, in the order they were finished. */
  buildings: TechItem[];
  /** Upgrade levels and technologies, in the order they were finished. */
  research: TechItem[];
  /** Each upgrade's level at the end. */
  levels: Map<number, number>;
}

export interface Tech {
  players: PlayerTech[];
  army: ArmyRow[];
  minutes: number;
}

/** How long a building takes to build or a research to finish, in frames, or null when not known (no game data). */
export type Durations = (kind: "unit" | "upgrade" | "tech", id: number, level: number) => number | null;

/** The first of each tech building each player finished, by player. A building given away still counts for who made it. */
export function techBuildings(t: ReplayTimeline, players: readonly number[], time: Durations): Map<number, TechItem[]> {
  const out = new Map<number, TechItem[]>(players.map((p) => [p, []]));
  const seen = new Set<string>();
  const finished = buildings(t).filter((b) => b.done !== null && b.from > 0 && isTechBuilding(b.type)).sort((a, b) => a.done! - b.done!);
  for (const b of finished) {
    const list = out.get(b.owner), key = `${b.owner}:${b.type}`;
    if (!list || seen.has(key)) continue;
    seen.add(key);
    // A morph seen only at its end began its build time before.
    const span = time("unit", b.type, 1);
    const start = span && b.done! - b.from < span / 2 ? Math.max(0, b.done! - span) : b.from;
    list.push({ kind: "building", id: b.type, level: 1, player: b.owner, start, done: b.done! });
  }
  return out;
}

/** What each player researched, by player, with when each began as far as the research time says. */
export function researchItems(t: ReplayTimeline, players: readonly number[], time: Durations): Map<number, TechItem[]> {
  const out = new Map<number, TechItem[]>(players.map((p) => [p, []]));
  for (const r of t.research) {
    const list = out.get(r.player);
    if (!list) continue;
    const span = time(r.kind, r.id, r.level);
    list.push({ kind: r.kind, id: r.id, level: r.level, player: r.player, start: span ? Math.max(0, r.frame - span) : r.frame, done: r.frame });
  }
  for (const list of out.values()) list.sort((a, b) => a.done - b.done);
  return out;
}

/** The army a player could fight with: units made, not workers, overlords, buildings or what is fired or laid. */
export const isArmy = (type: number) => counted(type) && !isBuilding(type) && !WORKERS.has(type) && !NOT_ARMY.has(type);

/** Each player's army unit type by unit type, counted at the end of every minute. */
export function armyRows(t: ReplayTimeline, players: readonly number[]): ArmyRow[] {
  const minutes = Math.max(1, Math.ceil(t.frames / MINUTE));
  const want = new Set(players);
  const alive = new Map<number, { type: number; owner: number }>();
  const ignored = new Set<number>();
  const rows = new Map<string, ArmyRow>();
  const count = (m: number) => {
    const here = new Map<string, number>();
    for (const u of alive.values()) {
      const type = SAME_AS.get(u.type) ?? u.type;
      if (!want.has(u.owner) || !isArmy(type)) continue;
      const key = `${u.owner}:${type}`;
      here.set(key, (here.get(key) ?? 0) + 1);
    }
    for (const [key, n] of here) {
      let row = rows.get(key);
      if (!row) {
        const [player, type] = key.split(":").map(Number);
        row = { player, type, perMinute: new Array(minutes).fill(0), peak: 0, first: m };
        rows.set(key, row);
      }
      row.perMinute[m] = n;
      row.peak = Math.max(row.peak, n);
    }
  };
  let m = 0;
  for (const e of t.events) {
    while (m < minutes - 1 && e.frame >= (m + 1) * MINUTE) count(m++);
    if (e.kind === "born") {
      if (e.hallucination) { ignored.add(e.unit); continue; }
      alive.set(e.unit, { type: e.type, owner: e.owner });
    } else if (ignored.has(e.unit)) continue;
    else if (e.kind === "morph" || e.kind === "given") {
      const u = alive.get(e.unit);
      if (u) { u.type = e.type; u.owner = e.owner; }
    } else if (e.kind === "died") alive.delete(e.unit);
  }
  while (m < minutes) count(m++);
  return [...rows.values()].sort((a, b) => a.player - b.player || a.first - b.first || b.peak - a.peak);
}

/** The whole technology of a played game, for `players` (by slot). */
export function tech(t: ReplayTimeline, players: readonly number[], time: Durations): Tech {
  const built = techBuildings(t, players, time), researched = researchItems(t, players, time);
  return {
    players: players.map((slot) => {
      const research = researched.get(slot) ?? [];
      const levels = new Map<number, number>();
      for (const r of research) if (r.kind === "upgrade") levels.set(r.id, Math.max(levels.get(r.id) ?? 0, r.level));
      return { slot, buildings: built.get(slot) ?? [], research, levels };
    }),
    army: armyRows(t, players),
    minutes: Math.max(1, Math.ceil(t.frames / MINUTE)),
  };
}
