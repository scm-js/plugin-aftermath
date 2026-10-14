/**
 * The `scm-sim.engine` service, as other plugins see it. Types only: take this file with
 * `import type` and reach the object through `api.services.watch("scm-sim.engine", …)`.
 * The provider's `ServiceInfo.version` is 1 for this shape.
 *
 * The timeline types are the engine's own (scm-sim `src/analysis/timeline.ts`), copied
 * here; `ReplayTimeline.version` says which form a timeline has.
 */

/**
 * `born`: the unit is there for the first time (a building's site, a unit leaving its
 * factory, a larva). `done`: it is finished. `morph`: it is another type now (`from` the
 * type before): a larva an egg, an egg a zergling, a drone a hatchery, a hatchery a lair,
 * a geyser a refinery. `given`: another player's now (`from` the owner before); a player
 * who leaves gives everything to a neutral player. `died`: gone, at the place it was
 * last seen.
 */
export type UnitEventKind = "born" | "done" | "morph" | "given" | "died";

export interface UnitEvent {
  frame: number;
  kind: UnitEventKind;
  /** The unit's number in this timeline, from 0 in the order of appearing. */
  unit: number;
  /** units.dat id, after the event. */
  type: number;
  /** Player slot 0..11, after the event. */
  owner: number;
  /** Pixels, the unit's centre. */
  x: number;
  y: number;
  /** `morph`: the type before. `given`: the owner before. */
  from?: number;
  /** `born`: a hallucination. */
  hallucination?: true;
  /**
   * `died`, from timeline version 2: the unit the game credited with the kill, its type and
   * owner then, and where it stood. The game counts a kill to a unit's name (a reaver's for
   * its scarab's, a carrier's for its interceptors', a templar's for its storm's). A death
   * nobody is credited with has none of these: a unit used up (a scarab, a spider mine), a
   * spell running out, a building cancelled, and what a spider mine killed.
   */
  by?: number;
  byType?: number;
  byOwner?: number;
  byX?: number;
  byY?: number;
}

/** An upgrade's level reached or a technology researched, seen at a sample (so `frame` is late by up to `samples.every`). */
export interface ResearchEvent {
  frame: number;
  player: number;
  kind: "upgrade" | "tech";
  /** upgrades.dat or techdata.dat id. */
  id: number;
  /** An upgrade's level; 1 for a technology. */
  level: number;
}

/** One player's numbers, an entry per sample (`samples.frame`). */
export interface PlayerSeries {
  slot: number;
  minerals: number[];
  gas: number[];
  supplyUsed: number[];
  supplyMax: number[];
  /** Finished workers. */
  workers: number[];
  /** Finished units that are neither buildings nor workers (larvae, eggs and what a unit fires are not counted). */
  army: number[];
  /** What those cost, minerals and gas together. */
  armyValue: number[];
  /** Finished buildings. */
  buildings: number[];
}

/** Where the units stood at regular frames: sample `i` is rows `start[i]` to `start[i + 1]` of `unit`, `x`, `y`. Buildings and units inside something are left out. */
export interface Positions {
  every: number;
  frame: number[];
  start: Uint32Array;
  unit: Uint32Array;
  x: Uint16Array;
  y: Uint16Array;
}

export interface ReplayTimeline {
  /** 1: as first written. 2: a `died` event says who killed the unit. */
  version: number;
  /** Frames played, and the replay's length. */
  frames: number;
  total: number;
  /** How the game stopped, in the engine's words, or null when the replay simply ran out. */
  ended: string | null;
  /** In tiles. */
  map: { width: number; height: number };
  /** Race: 0 zerg, 1 terran, 2 protoss. */
  players: { slot: number; name: string; race: number }[];
  events: UnitEvent[];
  research: ResearchEvent[];
  samples: { every: number; frame: number[]; players: PlayerSeries[] };
  /** Null when not asked for. */
  positions: Positions | null;
}

export interface AnalyseProgress {
  /** "starting": the engine is being fetched and the game started. "playing": `frame` of `frames`. */
  stage: "starting" | "playing";
  frame: number;
  frames: number;
}

export interface AnalyseOptions {
  /** Frames between samples of the players' numbers; 48 (two seconds at Fastest) when left out. */
  sampleEvery?: number;
  /** Frames between samples of where units stood; the same as `sampleEvery` when left out, 0 for none. */
  positionsEvery?: number;
  /** The file's name, for the engine's own messages. */
  name?: string;
  onProgress?(progress: AnalyseProgress): void;
  /** Aborting stops the game and rejects the promise with an `AbortError`. */
  signal?: AbortSignal;
}

export interface ScmSimStatus {
  /** Whether a replay or a map can be run here now. */
  available: boolean;
  /**
   * Where the engine reads the game from: the person's own 1.16.1 archives, a copy the
   * editor made (the Game Data page), a development server's files, or null when the
   * browser has none.
   */
  files: "archives" | "copy" | "server" | null;
  /** When not available: why, in words for the person. */
  reason: string | null;
  /** The `ReplayTimeline.version` the engine writes, or null when it could not be asked. */
  timeline: number | null;
}

export interface ScmSimService {
  /**
   * Whether this editor has the engine beside it at all: true at scmjs.dev and on a
   * stand-in for the site on one's own machine, false in the desktop app and an editor
   * hosted elsewhere. When false every other call rejects; offer what needs it only
   * when true.
   */
  readonly present: boolean;
  /** Asks the engine's page whether it can run a game now (it needs the person's copy of StarCraft). Asks again on every call. */
  status(): Promise<ScmSimStatus>;
  /**
   * Plays a replay to its end without showing it and resolves with what happened. A
   * twenty-minute game takes about ten to fifteen seconds; one replay runs at a time and
   * further calls wait their turn. Rejects with an `Error` worded for the person.
   */
  analyse(replay: Uint8Array, options?: AnalyseOptions): Promise<ReplayTimeline>;
  /**
   * Starts a map on the play page, in a tab of its own (one tab, used again by the next
   * call). `map` is a whole .scm / .scx file; left out, the open map as Save would write
   * it. Call it from the click that asks for it: a browser only lets a click open a tab.
   * Resolves when the game is on the page.
   */
  play(map?: { bytes: Uint8Array; name: string }): Promise<void>;
}
