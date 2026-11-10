import { afterEach, describe, expect, it } from "vitest";
import type { ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import { answersFor, counted, GAME_KINDS, GAME_TABLE, GROUP_FLAGS, isBuilding, isGameTable, KINDS, kindsOf, NO_UNIT, NO_WEAPON, rolesOf, tableHash, UNIT_FLAGS, useRoles, WORKERS, type UnitTable } from "../roles";
import { buildings, losses, madeRows, mineralLines } from "../played";
import { fights, merged } from "../fights";
import { armyInSight, firstLooks, knowledge, threats, unseen } from "../knew";
import { armyRows, techBuildings } from "../tech";
import { tierOf } from "../techview";

/*
 * A made units table in a mod's numbering: the game's numbers given to other units, and units past the game's 228.
 * (Unit numbers as Cosmonarchy BW has them where it helps to read; nothing of the mod's files is here.)
 */
const F = UNIT_FLAGS, G = GROUP_FLAGS;
const ZERG = G.zerg, TERRAN = G.terran;
const MEN = G.men, BLD = G.building;
const DRONE = 41, HATCH = 131, LARVA = 35, EGG = 36, ZLING = 37, POOL = 142, OVERLORD = 42, SPORE = 144, EXTRACTOR = 149, MUTA = 43;
const MINERAL = 176, GEYSER = 188, RICH = 514, RIDGE = 221;
const PILGRIM = 439, LANDLOCK = 429, MISSIONARY = 445, RADIX = 460, CANNON = 458, HELION = 453, EIDOLON = 1, TURRET = 4, GOLIATH = 3, ARCH = 457, SHELL = 85, SWARM = 202, TANK = 5, TANK_TURRET = 6;
const W = 7; // any weapon

function table(n = 700): UnitTable {
  const t = {
    flags: new Uint32Array(n), groupFlags: new Uint8Array(n), subunit: new Uint16Array(n).fill(NO_UNIT),
    groundWeapon: new Uint16Array(n).fill(NO_WEAPON), airWeapon: new Uint16Array(n).fill(NO_WEAPON),
    placementWidth: new Uint16Array(n).fill(32), placementHeight: new Uint16Array(n).fill(32),
  };
  const set = (id: number, flags: number, group: number, o: { gw?: boolean; aw?: boolean; sub?: number; size?: [number, number] } = {}) => {
    t.flags[id] = flags; t.groupFlags[id] = group;
    if (o.gw) t.groundWeapon[id] = W;
    if (o.aw) t.airWeapon[id] = W;
    if (o.sub !== undefined) t.subunit[id] = o.sub;
    if (o.size) { t.placementWidth[id] = o.size[0]; t.placementHeight[id] = o.size[1]; }
  };
  set(DRONE, F.worker, ZERG | MEN, { gw: true });
  set(HATCH, F.building | F.depot | F.produces, ZERG | BLD);
  set(LARVA, 0, ZERG);
  set(EGG, 0, ZERG);
  set(ZLING, F.twins, ZERG | MEN, { gw: true });
  set(POOL, F.building, ZERG | BLD);
  set(OVERLORD, F.flyer | F.detector, ZERG | MEN);
  set(SPORE, F.building | F.detector, ZERG | BLD, { aw: true });
  set(EXTRACTOR, F.building | F.container, ZERG | BLD, { size: [128, 64] });
  set(MUTA, F.flyer | F.twins, ZERG | MEN, { gw: true, aw: true });
  set(MINERAL, F.building | F.container | F.invincible, 1 << 7, { size: [64, 32] });
  set(RICH, F.building | F.container | F.invincible, 1 << 7, { size: [64, 32] });
  set(GEYSER, F.building | F.container | F.invincible, 1 << 7, { size: [128, 64] });
  set(RIDGE, F.building | F.container | F.invincible, 1 << 7, { size: [128, 64] });
  set(PILGRIM, F.worker, TERRAN | MEN, { gw: true });
  set(LANDLOCK, F.building | F.depot | F.produces, TERRAN | BLD);
  set(MISSIONARY, 0, TERRAN | MEN, { gw: true, aw: true });
  set(RADIX, F.building | F.produces, TERRAN | BLD);
  set(CANNON, F.building, TERRAN | BLD, { gw: true });
  set(ARCH, F.building | F.container, TERRAN | BLD, { size: [128, 64] });
  set(HELION, F.flyer, TERRAN | MEN, { aw: true });
  set(EIDOLON, F.permanentCloak, TERRAN | MEN, { gw: true });
  set(GOLIATH, 0, TERRAN | MEN, { sub: TURRET });
  set(TURRET, F.subunit | F.invincible, TERRAN | MEN, { gw: true, aw: true });
  set(TANK, 0, TERRAN | MEN, { sub: TANK_TURRET });
  set(TANK_TURRET, F.subunit | F.invincible, TERRAN | MEN, { gw: true });
  set(SHELL, F.invincible, TERRAN);
  set(SWARM, F.invincible, 1 << 7);
  return t;
}

afterEach(() => { useRoles(null); });

describe("what a unit type is, by a units table", () => {
  it("reads each kind from the flags, the group flags and the weapons, units past 228 among them", () => {
    const k = kindsOf(table());
    expect(k.game).toBe(false);
    expect(k.buildings).toEqual([HATCH, POOL, SPORE, EXTRACTOR, LANDLOCK, ARCH, CANNON, RADIX]);
    expect(k.resources).toEqual([MINERAL, GEYSER, RIDGE, RICH]);
    // A geyser is the size of a gas building.
    expect(k.minerals).toEqual([MINERAL, RICH]);
    // Never a turret, a resource, an egg or anything invincible (what is fired, a spell).
    expect(k.counted).toEqual([EIDOLON, GOLIATH, TANK, ZLING, DRONE, OVERLORD, MUTA, HATCH, POOL, SPORE, EXTRACTOR, LANDLOCK, PILGRIM, MISSIONARY, HELION, ARCH, CANNON, RADIX].sort((a, b) => a - b));
    expect(k.notMade).toEqual(expect.arrayContaining([TURRET, TANK_TURRET, LARVA, EGG, SHELL, SWARM]));
    expect(k.notMade).not.toContain(MINERAL);
    expect(k.eggs).toEqual([LARVA, EGG]);
    expect(k.quiet).toEqual([SPORE, EXTRACTOR, ARCH, CANNON]);
    expect(k.production).toEqual([HATCH, LANDLOCK, RADIX]);
    expect(k.routine).toEqual([EXTRACTOR, ARCH]);
    expect(k.tech).toEqual([POOL, EXTRACTOR, ARCH, RADIX]);
    expect(k.twins).toEqual([ZLING, MUTA]);
    expect(k.threats).toEqual({ cloaked: { units: [EIDOLON], buildings: [] }, air: { units: [MUTA, HELION], buildings: [] } });
    // Anti-air by a weapon of its own or its turret's; a worker is never an answer.
    expect(k.answers).toEqual({ cloaked: { any: [OVERLORD, SPORE] }, air: { any: [GOLIATH, MUTA, SPORE, MISSIONARY, HELION] } });
    // Not in a table: left empty, never the game's.
    expect([k.supplyOnly, k.sameAs, k.workerOf, k.merges]).toEqual([[], [], [], null]);
  });

  it("knows the game's own table by its columns, and reads it with the game's lists", () => {
    const t = table(GAME_TABLE.types);
    expect(tableHash(t)).toBe(tableHash(table(GAME_TABLE.types)));
    expect(isGameTable(t)).toBe(false);
    expect(rolesOf(t)!.kinds).not.toBeNull();
    // Flags alone say workers and halls, and nothing else.
    expect(rolesOf(t.flags)).toEqual({ workers: [DRONE], halls: [HATCH] });
  });

  it("fills the sets every view reads, and goes back to the game's lists without a table", () => {
    expect(isBuilding(LANDLOCK)).toBe(false);
    expect(counted(MISSIONARY)).toBe(false);
    expect(useRoles(rolesOf(table()))).toBe(true);
    expect(useRoles(rolesOf(table()))).toBe(false);
    expect(KINDS.game).toBe(false);
    expect([isBuilding(LANDLOCK), isBuilding(MINERAL), counted(MISSIONARY), counted(SHELL), WORKERS.has(PILGRIM)]).toEqual([true, false, true, false, true]);
    expect(answersFor("air", 0)).toEqual(answersFor("air", 69));
    useRoles(null);
    expect(KINDS.game).toBe(true);
    expect([isBuilding(LANDLOCK), isBuilding(150), counted(MISSIONARY), counted(0)]).toEqual([false, true, false, true]);
    expect(answersFor("cloaked", 1)).toEqual(GAME_KINDS.answers.cloaked && [124, 107, 9]);
    expect(answersFor("cloaked", null)).toBeNull();
  });
});

let next = 0;
const born = (frame: number, type: number, owner: number, x = 0, y = 0): UnitEvent => ({ frame, kind: "born", unit: next++, type, owner, x, y });
const ev = (frame: number, kind: UnitEvent["kind"], of: UnitEvent, type = of.type, extra: Partial<UnitEvent> = {}): UnitEvent => ({ frame, kind, unit: of.unit, type, owner: of.owner, x: of.x, y: of.y, ...extra });
function timeline(events: UnitEvent[], sight: [unit: number, player: number, from: number, to: number][], frames = 10000): ReplayTimeline {
  const sorted = [...events].sort((a, b) => a.frame - b.frame);
  return {
    version: 5, frames, total: frames, ended: null, map: { width: 128, height: 128 }, players: [{ slot: 0, name: "a", race: 69 }, { slot: 1, name: "z", race: 0 }],
    events: sorted, research: [], samples: { every: 1000, frame: Array.from({ length: frames / 1000 + 1 }, (_, i) => i * 1000), players: [] }, positions: null,
    sight: { every: 8, unit: Uint32Array.from(sight.map((s) => s[0])), player: Uint8Array.from(sight.map((s) => s[1])), from: Uint32Array.from(sight.map((s) => s[2])), to: Uint32Array.from(sight.map((s) => s[3])), by: Uint32Array.from(sight.map(() => 0xffffffff)) },
  };
}

describe("a game of a mod, read with its units table", () => {
  // Player 0 plays a race the mod adds, with buildings and units past 228; player 1 plays the mod's Zerg.
  const hall = born(0, LANDLOCK, 0, 100, 100), radix = born(1000, RADIX, 0, 200, 100), cannon = born(1500, CANNON, 0, 300, 100);
  const pilgrim = born(800, PILGRIM, 0), mission = born(2000, MISSIONARY, 0), helion = born(3000, HELION, 0), eidolon = born(3500, EIDOLON, 0);
  const hatch = born(0, HATCH, 1, 2000, 2000), lord = born(0, OVERLORD, 1), pool = born(1200, POOL, 1), larva = born(1300, LARVA, 1);
  const spore = born(4500, SPORE, 1), muta = born(5000, MUTA, 1), lord2 = born(5200, OVERLORD, 1);
  const fields = [0, 1, 2].map((i) => born(0, MINERAL, 11, 2000 + i * 32, 1800)), geyser = born(0, GEYSER, 11, 2100, 1800);
  const events = [hall, radix, ev(1900, "done", radix), cannon, ev(2200, "done", cannon), pilgrim, ev(1100, "done", pilgrim), mission, ev(2400, "done", mission), helion, ev(3400, "done", helion), eidolon, ev(3900, "done", eidolon),
    hatch, lord, pool, ev(2000, "done", pool), larva, ev(1400, "morph", larva, EGG, { from: LARVA }), ev(1800, "morph", larva, ZLING, { from: EGG }), ev(1900, "done", larva, ZLING),
    spore, ev(4900, "done", spore), muta, ev(5400, "done", muta), lord2, ev(5600, "done", lord2), ...fields, geyser,
    ev(6000, "died", mission, MISSIONARY, { by: larva.unit, byType: ZLING, byOwner: 1 }), ev(6100, "died", larva, ZLING, { by: mission.unit, byType: MISSIONARY, byOwner: 0 })];
  const sight: [number, number, number, number][] = [[radix.unit, 1, 2500, 2600], [mission.unit, 1, 2600, 2700], [hatch.unit, 0, 2800, 2900], [helion.unit, 1, 4000, 4100], [eidolon.unit, 1, 4200, 4300]];
  const t = timeline(events, sight);
  const cost = (type: number) => (type === HELION ? 300 : 100);

  it("before: with the game's numbers, the race's buildings and units past 228 are nothing, and its threats none", () => {
    useRoles(null);
    expect(buildings(t).filter((b) => b.owner === 0)).toEqual([]);
    // (Unit 1 is a Ghost to the game, and counted as one.)
    expect(madeRows(t, 0).map((r) => r.id)).toEqual([EIDOLON]);
    const k = knowledge(t);
    expect(firstLooks(k, 1, new Set([0])).building).toBeNull();
    expect(threats(k, 1, 0, new Set([0]))).toEqual([]);
  });

  it("after: buildings, what was made and lost, the first building seen, the army in sight and the threats", () => {
    useRoles(rolesOf(table()));
    expect(buildings(t).filter((b) => b.owner === 0).map((b) => b.type)).toEqual([LANDLOCK, RADIX, CANNON]);
    expect(madeRows(t, 0).map((r) => [r.id, r.building])).toEqual([[RADIX, true], [CANNON, true], [MISSIONARY, false], [HELION, false], [EIDOLON, false]]);
    // The zergling's row starts at its egg.
    expect(madeRows(t, 1).map((r) => [r.id, r.frame])).toEqual([[POOL, 1200], [ZLING, 1400], [SPORE, 4500], [MUTA, 5000], [OVERLORD, 5200]]);
    expect(losses(t, cost)).toEqual(new Map([[0, { units: 1, value: 100 }], [1, { units: 1, value: 100 }]]));
    expect(mineralLines(t).lines).toEqual([{ x: 2032, y: 1800, fields: 3 }]);
    const k = knowledge(t);
    expect(firstLooks(k, 1, new Set([0])).building).toEqual({ frame: 2500, type: RADIX });
    expect(unseen(k, t, 1, new Set([0])).map((u) => u.type)).toEqual([RADIX]);
    expect(armyInSight(k, t, 1, new Set([0]), cost).total.slice(2, 6)).toEqual([0, 100, 500, 500]);
    // The race the mod adds is answered like any other: the Overlord was there from the start (already had), the Spore
    // is the first new kind after the Eidolon; the second Overlord is no answer to the Helion, the Spore and the Mutalisk are.
    expect(threats(k, 1, null, new Set([0]))).toEqual([
      { kind: "cloaked", made: { frame: 3500, type: EIDOLON }, seen: { frame: 4200, type: EIDOLON }, answer: { frame: 4500, type: SPORE }, already: { frame: 0, type: OVERLORD } },
      { kind: "air", made: { frame: 3000, type: HELION }, seen: { frame: 4000, type: HELION }, answer: { frame: 4500, type: SPORE }, already: null },
    ]);
    expect(threats(k, 0, null, new Set([1]))).toEqual([
      { kind: "air", made: { frame: 5000, type: MUTA }, seen: null, answer: null, already: { frame: 2000, type: MISSIONARY } },
    ]);
  });

  it("after: tech buildings by the table, no tiers, the army without the game's exceptions, fights of types past 228", () => {
    useRoles(rolesOf(table()));
    const built = techBuildings(t, [0, 1], () => null);
    expect(built.get(0)!.map((b) => b.id)).toEqual([RADIX]);
    expect(built.get(1)!.map((b) => b.id)).toEqual([POOL]);
    expect(tierOf(1, [{ kind: "building", id: 113, level: 1, player: 0, start: 0, done: 10 }])).toBeNull();
    expect(armyRows(t, [1]).map((r) => r.type)).toEqual([OVERLORD, ZLING, MUTA]);
    const index = { owner: new Int8Array(0), type: new Int16Array(0) };
    expect(fights(t, cost, index).length).toBe(0);
  });

  it("takes a unit gone with no killer where another of its type became something else as gone into it", () => {
    useRoles(rolesOf(table()));
    const a = born(100, MISSIONARY, 0, 500, 500), b = born(100, MISSIONARY, 0, 520, 500);
    const t2 = timeline([a, b, ev(900, "morph", a, HELION, { from: MISSIONARY }), ev(900, "died", b)], []);
    expect(merged(t2)).toEqual(new Set([b.unit]));
    useRoles(null);
    expect(merged(t2)).toEqual(new Set());
  });
});
