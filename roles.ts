/**
 * Which unit types are workers and which are town halls. The game's own are fixed numbers (an SCV is unit 7), but a
 * mod's data set may give those numbers to other units and add workers and halls of its own: the units table says
 * which are which, by its flags (`Worker`, `ResourceDepot`). The editor's table is read into these sets
 * (`useRoles`) when it is the replay's own; without it they hold the game's numbers.
 *
 * The sets are shared and filled in place, so every view that asks `WORKERS.has(type)` follows the data set.
 */

/** SCV, Drone, Probe. */
export const GAME_WORKERS: readonly number[] = [7, 41, 64];
/** Command Center, Hatchery, Nexus: the halls a player puts down. */
export const GAME_HALLS: readonly number[] = [106, 131, 154];
/** Every hall: the three put down, and a Lair and a Hive. */
export const GAME_DEPOTS: readonly number[] = [106, 131, 132, 133, 154];

/** units.dat's flag bits that say a unit's role. */
export const UNIT_FLAGS = { building: 1 << 0, worker: 1 << 3, depot: 1 << 12 } as const;

/** The workers of the data set in use: the game's three unless the units table says otherwise. */
export const WORKERS = new Set<number>(GAME_WORKERS);
/** The town halls a base is taken with; from the units table, every resource depot. */
export const TOWN_HALLS = new Set<number>(GAME_HALLS);
/** Every town hall, a Lair and a Hive among them. */
export const DEPOTS = new Set<number>(GAME_DEPOTS);

export interface Roles {
  workers: number[];
  halls: number[];
}

/**
 * The workers and halls a units table's flags name: a unit with the `Worker` flag, and a building with the
 * `ResourceDepot` flag. Null when the table names no worker or no hall (no table, or one this cannot read).
 */
export function rolesOf(flags: ArrayLike<number> | null | undefined): Roles | null {
  if (!flags) return null;
  const workers: number[] = [], halls: number[] = [];
  for (let id = 0; id < flags.length; id++) {
    const f = flags[id];
    if (f & UNIT_FLAGS.worker) workers.push(id);
    if (f & UNIT_FLAGS.depot && f & UNIT_FLAGS.building) halls.push(id);
  }
  return workers.length && halls.length ? { workers, halls } : null;
}

const fill = (set: Set<number>, ids: readonly number[]) => { set.clear(); for (const id of ids) set.add(id); };
const same = (set: Set<number>, ids: readonly number[]) => set.size === ids.length && ids.every((id) => set.has(id));

/** Fill the shared sets from `roles`, or with the game's numbers for null. True when anything changed. */
export function useRoles(roles: Roles | null): boolean {
  const workers = roles?.workers ?? GAME_WORKERS, halls = roles?.halls ?? GAME_HALLS, depots = roles?.halls ?? GAME_DEPOTS;
  if (same(WORKERS, workers) && same(TOWN_HALLS, halls) && same(DEPOTS, depots)) return false;
  fill(WORKERS, workers);
  fill(TOWN_HALLS, halls);
  fill(DEPOTS, depots);
  return true;
}
