/**
 * What a unit type is: a worker, a town hall, a building, a resource, something a player makes at all, a threat and
 * its answer, and the rest of what the views ask. The game's own are fixed numbers (an SCV is unit 7), but a mod's
 * data set may give those numbers to other units and add units of its own past the game's 228: the units table says
 * what each is, by its flags, its StarEdit group flags and its weapons. The editor's table is read into the shared
 * sets here (`rolesOf`, `useRoles`) when it is the replay's own; without it they hold the game's numbers.
 *
 * The game's own table is told by its columns (`GAME_TABLE`), and with it every set holds the game's lists, which know
 * things no column says (a Lurker hides, an Armory is the way to anti-air). A mod's table gives what its columns say,
 * and nothing that only the game's lists know: the views that need those say so (`KINDS.game` is false).
 *
 * The sets are shared and filled in place, so every view that asks `WORKERS.has(type)` follows the data set.
 */

/** SCV, Drone, Probe. */
export const GAME_WORKERS: readonly number[] = [7, 41, 64];
/** Command Center, Hatchery, Nexus: the halls a player puts down. */
export const GAME_HALLS: readonly number[] = [106, 131, 154];
/** Every hall: the three put down, and a Lair and a Hive. */
export const GAME_DEPOTS: readonly number[] = [106, 131, 132, 133, 154];

/** units.dat's flag bits that say what a unit is (the editor's `UnitFlag`). */
export const UNIT_FLAGS = {
  building: 1 << 0, flyer: 1 << 2, worker: 1 << 3, subunit: 1 << 4, cloakable: 1 << 9, twins: 1 << 10, depot: 1 << 12,
  container: 1 << 13, detector: 1 << 15, permanentCloak: 1 << 22, invincible: 1 << 29, produces: 0x80000000,
} as const;
/** units.dat's StarEdit group flags: a race's (bits 0–2), a unit ("men"), a building. */
export const GROUP_FLAGS = { zerg: 1 << 0, terran: 1 << 1, protoss: 1 << 2, men: 1 << 3, building: 1 << 4 } as const;
/** A weapon column's "none", and a subunit column's: the game's numbers, which the wider layouts keep. */
export const NO_WEAPON = 130;
export const NO_UNIT = 228;

/** The workers of the data set in use: the game's three unless the units table says otherwise. */
export const WORKERS = new Set<number>(GAME_WORKERS);
/** The town halls a base is taken with; from the units table, every resource depot. */
export const TOWN_HALLS = new Set<number>(GAME_HALLS);
/** Every town hall, a Lair and a Hive among them. */
export const DEPOTS = new Set<number>(GAME_DEPOTS);

export type ThreatKind = "cloaked" | "air";

/** What a unit type is, as lists of units.dat ids. */
export interface Kinds {
  /** The game's own lists: true; a units table's: false. */
  game: boolean;
  /** Buildings (not the resources, which the table calls buildings too). */
  buildings: number[];
  /** Mineral fields and geysers. */
  resources: number[];
  /** The mineral fields alone. */
  minerals: number[];
  /** What a player makes and loses: units and buildings, never resources, larvae, eggs, what is fired or laid, spells. */
  counted: number[];
  /** Larva, eggs, cocoons, what is fired or laid, the spells that are units: never a line of what was made. */
  notMade: number[];
  /** What a unit is while it morphs into another (an egg, a cocoon): the start of what it becomes. */
  eggs: number[];
  /** Units that give supply and do not fight (the Overlord): not an army. */
  supplyOnly: number[];
  /** Buildings that say little by standing unseen: supply, gas, static defence. */
  quiet: number[];
  /** Buildings that make units (the halls are `DEPOTS`). */
  production: number[];
  /** Buildings and units whose first is not news: supply and gas. */
  routine: number[];
  /** Buildings that open a player's tech. */
  tech: number[];
  /** Two from one egg: what units.dat asks is the price of the pair. */
  twins: number[];
  /** A type that is another's in another mode (a sieged tank is a tank): [this, that]. */
  sameAs: [number, number][];
  /** Two of a type become one of another (two templars an Archon): [the two, the one]; null for any such morph. */
  merges: [number, number][] | null;
  /** The worker of each race (0 Zerg, 1 Terran, 2 Protoss); empty when not known. */
  workerOf: number[];
  /** What makes a threat of each kind: its units, and the buildings that make them (seeing one is warning enough). */
  threats: Record<ThreatKind, { units: number[]; buildings: number[] }>;
  /**
   * The answers to each kind of threat: by race (0 Zerg, 1 Terran, 2 Protoss) with the game's lists, where a race that
   * is none of the three has none; `any` with a units table's, which are every race's.
   */
  answers: Record<ThreatKind, { byRace: Record<number, number[]> } | { any: number[] }>;
}

/** Mineral fields and the geyser. */
const GAME_RESOURCES = [176, 177, 178, 188];
/** Larva, egg, cocoon, lurker egg, what is fired or laid, and the spells that are units. */
const GAME_NOT_MADE = [13, 14, 33, 35, 36, 59, 73, 85, 97, 101, 105, 202];
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/** The game's own lists. */
export const GAME_KINDS: Kinds = {
  game: true,
  buildings: range(106, 201).filter((t) => !GAME_RESOURCES.includes(t)),
  resources: GAME_RESOURCES,
  minerals: [176, 177, 178],
  counted: range(0, 202).filter((t) => !GAME_NOT_MADE.includes(t) && !GAME_RESOURCES.includes(t)),
  notMade: GAME_NOT_MADE,
  eggs: [36, 59, 97],
  // The Overlord.
  supplyOnly: [42],
  // Pylon, Supply Depot, Refinery, Extractor, Assimilator, Creep Colony, Missile Turret, Bunker, Photon Cannon,
  // Sunken Colony, Spore Colony.
  quiet: [156, 109, 110, 149, 157, 143, 124, 125, 162, 146, 144],
  // Barracks, Factory, Starport, Gateway, Stargate, Robotics Facility.
  production: [111, 113, 114, 160, 167, 155],
  // Supply Depot, Refinery, Extractor, Pylon, Assimilator, Overlord.
  routine: [109, 110, 149, 156, 157, 42],
  // In the order each race reaches them. Town halls, supply and defences are not here; a Lair and a Hive are, and a
  // race's first gas and its first unit producer, since the timing of those is tech.
  tech: [
    // Barracks, Refinery, Academy, Factory, Machine Shop, Engineering Bay, Comsat Station, Starport, Control Tower,
    // Armory, Science Facility, Covert Ops, Physics Lab, Nuclear Silo.
    111, 110, 112, 113, 120, 122, 107, 114, 115, 123, 116, 117, 118, 108,
    // Spawning Pool, Extractor, Evolution Chamber, Lair, Hydralisk Den, Spire, Queen's Nest, Hive, Defiler Mound,
    // Ultralisk Cavern, Greater Spire, Nydus Canal.
    142, 149, 139, 132, 135, 141, 138, 133, 136, 140, 137, 134,
    // Gateway, Assimilator, Forge, Cybernetics Core, Citadel of Adun, Robotics Facility, Observatory, Robotics Support
    // Bay, Stargate, Templar Archives, Fleet Beacon, Arbiter Tribunal.
    160, 157, 166, 164, 163, 155, 159, 171, 167, 165, 169, 170,
  ],
  // Zergling, Scourge.
  twins: [37, 47],
  // A sieged Siege Tank is a Siege Tank.
  sameAs: [[30, 5]],
  // High and Dark Templar: two become one Archon or Dark Archon.
  merges: [[67, 68], [61, 63]],
  // Drone, SCV, Probe.
  workerOf: [41, 7, 64],
  threats: {
    // Dark Templar, Lurker and its egg, Arbiter; Templar Archives (Dark Templar), none for the Lurker (a Hydralisk Den is not one).
    cloaked: { units: [61, 103, 97, 71], buildings: [165, 170] },
    // Mutalisk, Guardian, Devourer, Wraith, Battlecruiser, Carrier, Scout, Arbiter; Spire, Greater Spire, Stargate, Fleet Beacon, Physics Lab.
    air: { units: [43, 44, 62, 8, 12, 72, 70, 71], buildings: [141, 137, 167, 169, 118] },
  },
  answers: {
    // Spore Colony; Missile Turret, Comsat Station, Science Vessel; Photon Cannon, Observatory, Observer.
    cloaked: { byRace: { 0: [144], 1: [124, 107, 9], 2: [162, 159, 84] } },
    // Spore Colony, Hydralisk Den, Hydralisk, Scourge, Spire, Mutalisk; Missile Turret, Armory, Goliath, Valkyrie, Wraith;
    // Photon Cannon, Stargate, Corsair, Scout, Archon.
    air: { byRace: { 0: [144, 135, 38, 47, 141, 43], 1: [124, 123, 3, 58, 8], 2: [162, 167, 60, 70, 68] } },
  },
};

/** As much of a units table as this reads (the editor's `UnitsDat` is one). */
export interface UnitTable {
  flags: ArrayLike<number>;
  groupFlags: ArrayLike<number>;
  subunit: ArrayLike<number>;
  groundWeapon: ArrayLike<number>;
  airWeapon: ArrayLike<number>;
  placementWidth: ArrayLike<number>;
  placementHeight: ArrayLike<number>;
}

/**
 * The game's own units table, told by its columns: a hash (`tableHash`) of the flags, the group flags, the subunits
 * and the weapons of its 228 types, as the game's `arr\units.dat` has them (the 1.16.1 file and the shorter original
 * alike). A mod that changes only costs, hit points or times keeps it, and its units are the game's.
 */
export const GAME_TABLE = { types: 228, hash: 0x6dcc1780 };

/** FNV-1a over the columns that say what each type is. */
export function tableHash(table: UnitTable): number {
  let h = 0x811c9dc5;
  const n = table.flags.length;
  for (const col of [table.flags, table.groupFlags, table.subunit, table.groundWeapon, table.airWeapon]) {
    for (let i = 0; i < n; i++) { h ^= (col[i] ?? 0) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h >>> 0;
}

export const isGameTable = (table: UnitTable) => table.flags.length === GAME_TABLE.types && tableHash(table) === GAME_TABLE.hash;

/**
 * What a units table says each type is. A type is one when the table has a row for it.
 *
 * - A building: the `Building` flag, not a resource. A resource: `ResourceContainer` and `Invincible` (a refinery is
 *   a container a player can lose). A mineral field: a resource that is not a geyser, and a geyser is what a gas
 *   building stands on, so of a gas building's size.
 * - Made by a player: a unit or a building by its group flags, not a turret (`Subunit`), nothing `Invincible` (what
 *   is fired, the spells that are units). What is not made and has a race (a larva, an egg, a cocoon) is what a unit
 *   is while it morphs. A Spider Mine or an Interceptor is a unit to the table, and is counted as one.
 * - Armed: a weapon of its own or its turret's (`NO_WEAPON` is none). Static defence: an armed building.
 * - A cloaked threat: an armed unit that is cloaked or can cloak; an air threat: an armed flyer, not a worker. A Carrier
 *   fights by what it launches and has no weapon of its own, so is none. No building is a threat: the table does not
 *   say what makes what.
 * - An answer: a detector, against cloaked units; against air, a unit or building that can hit air (a weapon of its
 *   own or its turret's in the air column). Every race's (`threats` counts only a kind the player had not had before).
 * - Production: a building with the `ProducesUnits` flag (the game's own table sets it on the Bunker and not on the
 *   Starport or the Stargate, which is why the game's list stands for the game). Tech: every building made that is not
 *   a hall, not armed and not a resource. Quiet: gas (a building that is a container) and static defence. Routine: gas.
 * - Two from one egg: `TwoUnitsInOneEgg`.
 *
 * Not in the table, so empty for a mod: which units give supply and do not fight, which buildings give supply (they
 * are counted with the rest), what a unit is in another mode, which two units become one (any such morph is looked
 * for), each race's worker, tiers.
 */
export function kindsOf(table: UnitTable): Kinds {
  const n = table.flags.length;
  const flag = (t: number, f: number) => ((table.flags[t] >>> 0) & f) !== 0;
  const group = (t: number, g: number) => ((table.groupFlags[t] ?? 0) & g) !== 0;
  const weapon = (w: number | undefined) => w !== undefined && w !== NO_WEAPON;
  const turret = (t: number) => { const s = table.subunit[t]; return s !== undefined && s !== NO_UNIT && s !== t && s < n ? s : -1; };
  const hits = (t: number, air: boolean) => {
    const col = air ? table.airWeapon : table.groundWeapon, s = turret(t);
    return weapon(col[t]) || (s >= 0 && weapon(col[s]));
  };
  const armed = (t: number) => hits(t, false) || hits(t, true);
  const all = range(0, n - 1);
  const resource = (t: number) => flag(t, UNIT_FLAGS.container) && flag(t, UNIT_FLAGS.invincible);
  const building = (t: number) => flag(t, UNIT_FLAGS.building) && !resource(t);
  const made = (t: number) => !resource(t) && !flag(t, UNIT_FLAGS.subunit) && !flag(t, UNIT_FLAGS.invincible) && group(t, GROUP_FLAGS.men | GROUP_FLAGS.building);
  const madeBuilding = (t: number) => building(t) && made(t);
  const unit = (t: number) => made(t) && !building(t);
  const gas = (t: number) => madeBuilding(t) && flag(t, UNIT_FLAGS.container);
  const size = (t: number) => `${table.placementWidth[t] ?? 0}x${table.placementHeight[t] ?? 0}`;
  const gasSizes = new Set(all.filter(gas).map(size));
  const races = GROUP_FLAGS.zerg | GROUP_FLAGS.terran | GROUP_FLAGS.protoss;
  return {
    game: false,
    buildings: all.filter(building),
    resources: all.filter(resource),
    minerals: all.filter((t) => resource(t) && !gasSizes.has(size(t))),
    counted: all.filter(made),
    notMade: all.filter((t) => !made(t) && !resource(t)),
    eggs: all.filter((t) => !made(t) && !resource(t) && !flag(t, UNIT_FLAGS.subunit) && !flag(t, UNIT_FLAGS.invincible) && group(t, races)),
    supplyOnly: [],
    quiet: all.filter((t) => gas(t) || (madeBuilding(t) && armed(t))),
    production: all.filter((t) => madeBuilding(t) && flag(t, UNIT_FLAGS.produces)),
    routine: all.filter(gas),
    tech: all.filter((t) => madeBuilding(t) && !flag(t, UNIT_FLAGS.depot) && !armed(t)),
    twins: all.filter((t) => made(t) && flag(t, UNIT_FLAGS.twins)),
    sameAs: [],
    merges: null,
    workerOf: [],
    threats: {
      cloaked: { units: all.filter((t) => unit(t) && armed(t) && flag(t, UNIT_FLAGS.cloakable | UNIT_FLAGS.permanentCloak)), buildings: [] },
      air: { units: all.filter((t) => unit(t) && armed(t) && flag(t, UNIT_FLAGS.flyer) && !flag(t, UNIT_FLAGS.worker)), buildings: [] },
    },
    answers: {
      cloaked: { any: all.filter((t) => made(t) && flag(t, UNIT_FLAGS.detector)) },
      air: { any: all.filter((t) => made(t) && !flag(t, UNIT_FLAGS.worker) && hits(t, true)) },
    },
  };
}

export interface Roles {
  workers: number[];
  halls: number[];
  /** What else each type is, from the table; absent or null for the game's own lists (the game's table, or flags alone). */
  kinds?: Kinds | null;
}

const isTable = (x: UnitTable | ArrayLike<number>): x is UnitTable => "flags" in x && "groupFlags" in x;

/**
 * The workers and halls a units table's flags name: a unit with the `Worker` flag, and a building with the
 * `ResourceDepot` flag; given the whole table (not its flags alone), what else each type is (`kindsOf`), or nothing
 * more for the game's own table. Null when the table names no worker or no hall (no table, or one this cannot read).
 */
export function rolesOf(table: UnitTable | ArrayLike<number> | null | undefined): Roles | null {
  if (!table) return null;
  const flags = isTable(table) ? table.flags : table;
  const workers: number[] = [], halls: number[] = [];
  for (let id = 0; id < flags.length; id++) {
    const f = flags[id];
    if (f & UNIT_FLAGS.worker) workers.push(id);
    if (f & UNIT_FLAGS.depot && f & UNIT_FLAGS.building) halls.push(id);
  }
  if (!workers.length || !halls.length) return null;
  if (!isTable(table)) return { workers, halls };
  return { workers, halls, kinds: isGameTable(table) ? null : kindsOf(table) };
}

/** The kinds in use, as sets filled in place (`GAME_KINDS` until a mod's table is used). */
export const KINDS = {
  game: true,
  /** Counts the changes, for what is kept worked out with the kinds of the time. */
  revision: 0,
  buildings: new Set<number>(),
  resources: new Set<number>(),
  minerals: new Set<number>(),
  counted: new Set<number>(),
  notMade: new Set<number>(),
  eggs: new Set<number>(),
  supplyOnly: new Set<number>(),
  quiet: new Set<number>(),
  production: new Set<number>(),
  routine: new Set<number>(),
  tech: new Set<number>(),
  twins: new Set<number>(),
  sameAs: new Map<number, number>(),
  merges: null as Map<number, number> | null,
  workerOf: [] as number[],
  threats: GAME_KINDS.threats,
  answers: GAME_KINDS.answers,
};
let kindsInUse: Kinds | null = null;

const fill = (set: Set<number>, ids: readonly number[]) => { set.clear(); for (const id of ids) set.add(id); };
const same = (set: Set<number>, ids: readonly number[]) => set.size === ids.length && ids.every((id) => set.has(id));
const sameKinds = (a: Kinds, b: Kinds) => a === b || JSON.stringify(a) === JSON.stringify(b);

function useKinds(k: Kinds): void {
  kindsInUse = k;
  KINDS.revision++;
  KINDS.game = k.game;
  for (const key of ["buildings", "resources", "minerals", "counted", "notMade", "eggs", "supplyOnly", "quiet", "production", "routine", "tech", "twins"] as const) fill(KINDS[key], k[key]);
  KINDS.sameAs.clear();
  for (const [a, b] of k.sameAs) KINDS.sameAs.set(a, b);
  KINDS.merges = k.merges ? new Map(k.merges) : null;
  KINDS.workerOf = [...k.workerOf];
  KINDS.threats = k.threats;
  KINDS.answers = k.answers;
}
useKinds(GAME_KINDS);

/** Fill the shared sets from `roles`, or with the game's numbers for null. True when anything changed. */
export function useRoles(roles: Roles | null): boolean {
  const workers = roles?.workers ?? GAME_WORKERS, halls = roles?.halls ?? GAME_HALLS, depots = roles?.halls ?? GAME_DEPOTS;
  const kinds = roles?.kinds ?? GAME_KINDS;
  const sameSorts = kindsInUse !== null && sameKinds(kindsInUse, kinds);
  if (same(WORKERS, workers) && same(TOWN_HALLS, halls) && same(DEPOTS, depots) && sameSorts) return false;
  fill(WORKERS, workers);
  fill(TOWN_HALLS, halls);
  fill(DEPOTS, depots);
  if (!sameSorts) useKinds(kinds);
  return true;
}

/* ── What the views ask ── */

/** A building of the data set in use (not a resource). */
export const isBuilding = (type: number) => KINDS.buildings.has(type);
/** Something a player makes and loses (`Kinds.counted`). */
export const counted = (type: number) => KINDS.counted.has(type);

/**
 * The answers a player of `race` (0 Zerg, 1 Terran, 2 Protoss, or another) starts to a kind of threat: with the game's
 * lists the race's own, and null (not known) for a race that is none of the three; with a mod's table every answer it
 * names, whatever the race.
 */
export function answersFor(kind: ThreatKind, race: number | null): number[] | null {
  const a = KINDS.answers[kind];
  if ("any" in a) return a.any;
  return race === null ? null : a.byRace[race] ?? null;
}
