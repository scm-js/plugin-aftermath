import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseReplay } from "@scm-js/replay";
import { analyse } from "../analysis";
import { readChk } from "../chk";
import { castable, castInput, castRace, castSegments, raceWords, type CastPlayer } from "../cast";
import { knowledge, threats } from "../knew";
import { tierOf } from "../techview";
import { assumedDataSet, modSigns, openModOf, replayDataSet } from "../modreplay";
import { WORKERS as PLAYED_WORKERS } from "../played";
import { TOWN_HALLS as ANALYSIS_HALLS, WORKERS as ANALYSIS_WORKERS } from "../analysis";
import { canName, declare, declaredRows, editorHints, editorSources, hintsFrom, labelOf, tableRace, letterFiles, nameCandidates, namedRow, RACE_LETTERS, raceRows, raceView, tblStrings, withRace, workedOutLike, type DataSetRace, type RaceEditor } from "../races";
import { DEPOTS, GAME_DEPOTS, GAME_HALLS, GAME_WORKERS, rolesOf, TOWN_HALLS, UNIT_FLAGS, useRoles, WORKERS } from "../roles";
import type { ReplayTimeline } from "../vendor/scm-sim";

/* A data set that adds race 69 (the examples are a real mod's: Cosmonarchy's Askosi, which plays as Terran). */
const ZERG = 1, TERRAN = 2, PROTOSS = 4;
/** A units table's group flags: unit 0 Terran, 37 Zerg, 65 Protoss, 300 Terran (a mod's own unit), 7 none. */
const groupFlags = (() => { const f = new Uint8Array(400); f[0] = TERRAN; f[37] = ZERG; f[65] = PROTOSS; f[300] = TERRAN; f[301] = TERRAN | ZERG; return f; })();
const ASKOSI: DataSetRace = { id: 69, name: "Askosi", letter: "a", like: 1 };
const game = (english: string) => `[${english}]`;
const unnamed = (id: number) => `Race ${id}`;

/** An editor's plugin API as a race sees it: the November 2026 calls, or an editor from before them. */
function editor(kind: "new" | "old", declared: unknown[] = [], profileId = "cosmonarchy"): RaceEditor & { kept: unknown[][] } {
  const kept: unknown[][] = [];
  let rows = declared;
  const names = { race: (v: number) => (v === 1 ? "Terran" : kind === "new" ? (raceRows(rows).find((r) => r.id === v)?.name ?? `Race ${v}`) : `Race ${v}`) };
  if (kind === "old") return { kept, names, gameData: { source: () => ({ profile: { id: profileId } }) } };
  return {
    kept, names,
    gameData: {
      source: () => ({ profile: { id: profileId, races: rows } }),
      races: () => rows,
      setRaces(races: readonly DataSetRace[]) { if (profileId === "starcraft") return null; kept.push([...races]); rows = [...races]; return { profile: { id: profileId } }; },
    },
  };
}

describe("a race's rows, as a carrier holds them", () => {
  it("keeps rows of 8–255 with a name of 1–40 characters, sorted, the first of an id, and drops the rest without throwing", () => {
    expect(raceRows([
      { id: 71, name: " Kogri ", like: 1 }, { id: 69, name: "Askosi", letter: "a", like: 1, extra: true }, { id: 69, name: "Again" },
      { id: 2, name: "Protoss" }, { id: 256, name: "Too high" }, { id: 70, name: "" }, { id: 72, name: "x".repeat(41) }, { id: 73.5, name: "Half" },
      { id: 74, name: "Bad like", like: 5, letter: "AB" }, null, "row", 7,
    ])).toEqual([
      { id: 69, name: "Askosi", letter: "a", like: 1 }, { id: 71, name: "Kogri", like: 1 }, { id: 74, name: "Bad like" },
    ]);
    expect(raceRows(undefined)).toEqual([]);
    expect(raceRows({ id: 69 })).toEqual([]);
  });
});

describe("naming a race", () => {
  it("gives the game's own eight their names, whatever any data set says", () => {
    expect(raceView(1, { tag: [{ id: 1, name: "Not Terran" }] })).toEqual({ id: 1, name: "Terran", like: 1, from: "game" });
    expect(raceView(6).name).toBe("Random");
    expect(raceView(3).name).toBe("Independent");
  });

  it("names a race a data set adds by the replay's own tag first, then the editor's rows, then the editor's name", () => {
    const fromEditor = { editor: [{ id: 69, name: "Editor's" }], editorName: () => "Editor's call" };
    expect(raceView(69, { tag: [ASKOSI], ...fromEditor }).name).toBe("Askosi");
    expect(raceView(69, fromEditor).name).toBe("Editor's");
    expect(raceView(69, { editorName: () => "Askosi" }).name).toBe("Askosi");
  });

  it("has no name where nobody gives one, an older editor's \"Race 69\" included, and then reads Race 69, never Random or Terran", () => {
    const v = raceView(69, { editorName: () => "Race 69" });
    expect(v.name).toBeNull();
    expect(labelOf(v, game, unnamed)).toBe("Race 69");
    expect(labelOf(raceView(69, { tag: [ASKOSI] }), game, unnamed)).toBe("Askosi");
    expect(labelOf(raceView(1), game, unnamed)).toBe("[Terran]");
    expect(labelOf(raceView(6), game, unnamed)).toBe("[Random]");
  });

  it("reads the editor both ways: an editor with the race calls names a declared race, one without says Race 69", () => {
    const declared = editor("new", [ASKOSI]);
    expect(labelOf(raceView(69, editorSources(declared)), game, unnamed)).toBe("Askosi");
    expect(raceView(69, editorSources(declared)).like).toBe(1);
    const older = editor("old");
    expect(editorSources(older).editor).toEqual([]);
    expect(labelOf(raceView(69, editorSources(older)), game, unnamed)).toBe("Race 69");
    // An editor that has the profile's rows but not `races()` is read through its profile.
    const profileOnly: RaceEditor = { gameData: { source: () => ({ profile: { id: "m", races: [ASKOSI] } }) } };
    expect(raceView(69, editorSources(profileOnly)).name).toBe("Askosi");
    // A throwing call is no name.
    expect(raceView(69, editorSources({ names: { race: () => { throw new Error("x"); } } })).name).toBeNull();
  });
});

describe("what a race plays as", () => {
  it("is the race itself for the game's three", () => {
    expect(raceView(0).like).toBe(0);
    expect(raceView(2, { units: () => [0, 0, 0], groupFlags }).like).toBe(2);
  });

  it("is declared: the tag's row, else the editor's", () => {
    expect(raceView(69, { tag: [{ id: 69, name: "A", like: 2 }], editor: [{ id: 69, name: "B", like: 0 }] })).toMatchObject({ like: 2, from: "declared" });
    expect(raceView(69, { tag: [{ id: 69, name: "A" }], editor: [{ id: 69, name: "B", like: 0 }] })).toMatchObject({ name: "A", like: 0, from: "declared" });
  });

  it("is worked out from the flag most of the player's units carry, where nothing declares it", () => {
    expect(raceView(69, { units: () => [0, 300, 300, 37], groupFlags })).toEqual({ id: 69, name: null, like: 1, from: "units" });
    // Random's value and the game's others are worked out the same way.
    expect(raceView(6, { units: () => [37, 37, 0], groupFlags })).toMatchObject({ name: "Random", like: 0, from: "units" });
  });

  it("is not known with no units, no table, no flag, or a tie", () => {
    expect(raceView(69, { units: () => [], groupFlags }).like).toBeNull();
    expect(raceView(69, { units: () => [0, 0], groupFlags: null })).toEqual({ id: 69, name: null, like: null, from: null });
    expect(workedOutLike([7, 7, 999, -1], groupFlags)).toBeNull();
    expect(workedOutLike([0, 37], groupFlags)).toBeNull();
    // A unit with two flags counts for both.
    expect(workedOutLike([301, 0], groupFlags)).toBe(1);
    expect(workedOutLike([301, 37, 37], groupFlags)).toBe(0);
  });
});

/** A `.tbl`: a count, the offsets, the strings each ending in a zero. */
function tbl(strings: string[]): Uint8Array {
  const head = 2 + strings.length * 2;
  const body = strings.map((s) => [...s].map((c) => c.charCodeAt(0)).concat(0));
  const out = new Uint8Array(head + body.reduce((n, b) => n + b.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(0, strings.length, true);
  let at = head;
  body.forEach((b, i) => { view.setUint16(2 + i * 2, at, true); out.set(b, at); at += b.length; });
  return out;
}

describe("the game's own lists of each race (tiers, answers to a threat)", () => {
  const FACTORY = 113, TURRET = 124, STARGATE = 167;
  it("are read for 0–2 only, never for what a race a data set adds plays as", () => {
    expect([tableRace(0), tableRace(1), tableRace(2)]).toEqual([0, 1, 2]);
    expect(tableRace(69)).toBeNull();
    expect(tableRace(6)).toBeNull();
    expect(tableRace(undefined)).toBeNull();
    // A race that plays as Terran is not given Terran's tiers: a Factory is Terran's second tier, not its.
    const askosi = raceView(69, { tag: [ASKOSI] });
    expect(askosi.like).toBe(1);
    const factory = [{ kind: "building" as const, id: FACTORY, level: 1, start: 0, done: 500, player: 0 }];
    expect(tierOf(tableRace(1), factory)?.tier).toBe(2);
    expect(tierOf(tableRace(askosi.id), factory)).toBeNull();
  });

  it("find no answer to a threat for a race that is none of the three, rather than Terran's", () => {
    const stargate = { frame: 3000, kind: "born" as const, unit: 1, type: STARGATE, owner: 1, x: 0, y: 0 };
    const turret = { frame: 4000, kind: "born" as const, unit: 2, type: TURRET, owner: 0, x: 0, y: 0 };
    const tl: ReplayTimeline = {
      version: 5, frames: 10000, total: 10000, ended: null, map: { width: 128, height: 128 }, players: [{ slot: 0, name: "w", race: 69 }, { slot: 1, name: "p", race: 2 }],
      events: [stargate, turret], research: [], samples: { every: 1000, frame: [0], players: [] }, positions: null,
      sight: { every: 8, unit: new Uint32Array(), player: new Uint8Array(), from: new Uint32Array(), to: new Uint32Array(), by: new Uint32Array() },
    };
    const k = knowledge(tl);
    expect(threats(k, 0, 1, new Set([1]))[0].answer).toEqual({ frame: 4000, type: TURRET });
    expect(threats(k, 0, tableRace(69), new Set([1]))[0].answer).toBeNull();
  });
});

describe("names to offer for a race", () => {
  const theGame = tbl(["Zerg", "Terran", "Protoss", "Game"]);
  it("are the strings the data set's network.tbl has past the game's own", () => {
    expect(tblStrings(theGame)).toEqual(["Zerg", "Terran", "Protoss", "Game"]);
    const mod = tbl(["Zerg", "Terran", "Protoss", "Game", "Askosi", "\x04Bloodsummon\x01 ", "Kogri", "kogri", "", "x".repeat(41), "Taken"]);
    expect(nameCandidates(mod, theGame, ["TAKEN"])).toEqual(["Askosi", "Bloodsummon", "Kogri"]);
  });

  it("are none when the game's own table, or the data set's, cannot be read", () => {
    const mod = tbl(["Zerg", "Terran", "Protoss", "Game", "Askosi"]);
    expect(nameCandidates(mod, null)).toEqual([]);
    expect(nameCandidates(null, theGame)).toEqual([]);
    expect(nameCandidates(mod, new Uint8Array([9]))).toEqual([]);
    expect(nameCandidates(mod, mod)).toEqual([]);
  });

  it("are the editor's own where it offers them, checked: names of 1–40 characters, letters a to y other than t, p and n", () => {
    expect(hintsFrom({ names: [" Askosi ", "Kogri", "Kogri", "", "x".repeat(41), 7, null], letters: ["a", "k", "t", "p", "n", "z", "B", "ab", 1, "a"] }))
      .toEqual({ names: ["Askosi", "Kogri"], letters: ["a", "k"] });
    for (const bad of [null, undefined, "Askosi", 3, [], { names: "Askosi", letters: "a" }]) expect(hintsFrom(bad)).toEqual({ names: [], letters: [] });
  });

  it("are asked of the editor when it has the call, and read by the plugin only when it has not", async () => {
    const offers = (answer: () => Promise<unknown>): RaceEditor => ({ gameData: { raceCandidates: answer } });
    expect(await editorHints(offers(async () => ({ names: ["Askosi", "Bloodsummon"], letters: ["a", "b"] })))).toEqual({ names: ["Askosi", "Bloodsummon"], letters: ["a", "b"] });
    // A rejection, or an answer of another shape, is no hints (not the plugin's own reading).
    expect(await editorHints(offers(async () => { throw new Error("no"); }))).toEqual({ names: [], letters: [] });
    expect(await editorHints(offers(async () => "Askosi"))).toEqual({ names: [], letters: [] });
    // An editor without the call: null, and the plugin reads the files itself.
    expect(await editorHints(editor("old"))).toBeNull();
    expect(await editorHints({})).toBeNull();
  });

  it("offer letters other than the game's, by its per-race files", () => {
    expect(RACE_LETTERS).not.toContain("z");
    expect(RACE_LETTERS).not.toContain("t");
    expect(RACE_LETTERS).not.toContain("p");
    expect(RACE_LETTERS).not.toContain("n");
    expect(RACE_LETTERS).toContain("a");
    expect(letterFiles("a")).toEqual(["game\\aconsole.pcx", "rez\\statbtna.bin"]);
  });
});

describe("naming a race in the editor", () => {
  const unnamedView = raceView(69, editorSources(editor("new")));

  it("is offered beside Race 69, with a data set that is not the game's own, in an editor that can keep it", () => {
    expect(canName(unnamedView, editor("new"), true)).toBe(true);
    // Not: an older editor, the game's own data set, a replay of another data set than the editor's, a named race, the game's races.
    expect(canName(unnamedView, editor("old"), true)).toBe(false);
    expect(canName(unnamedView, editor("new", [], "starcraft"), true)).toBe(false);
    expect(canName(unnamedView, editor("new"), false)).toBe(false);
    expect(canName(raceView(69, { tag: [ASKOSI] }), editor("new"), true)).toBe(false);
    expect(canName(raceView(6), editor("new"), true)).toBe(false);
  });

  it("makes the row of what was given, or says what is wrong", () => {
    expect(namedRow(69, "  Askosi ", "A", "1")).toEqual({ id: 69, name: "Askosi", letter: "a", like: 1 });
    expect(namedRow(69, "Askosi", "", "")).toEqual({ id: 69, name: "Askosi" });
    expect(namedRow(69, "  ", "", "")).toBe("name");
    expect(namedRow(69, "x".repeat(41), "", "")).toBe("long");
    expect(namedRow(69, ` ${"x".repeat(40)} `, "", "")).toEqual({ id: 69, name: "x".repeat(40) });
    expect(namedRow(69, "Askosi", "t", "")).toBe("letter");
    expect(namedRow(69, "Askosi", "ab", "")).toBe("letter");
  });

  it("declares it beside the rows the data set has, keeping what the plugin does not know of them, and the name shows", () => {
    const ed = editor("new", [{ id: 71, name: "Kogri", note: "kept" }, { id: 69, name: "Old" }]);
    expect(declare(ed, { id: 69, name: "Askosi", like: 1 })).not.toBeNull();
    expect(ed.kept).toEqual([[{ id: 69, name: "Askosi", like: 1 }, { id: 71, name: "Kogri", note: "kept" }]]);
    expect(labelOf(raceView(69, editorSources(ed)), game, unnamed)).toBe("Askosi");
    expect(declaredRows(ed).map((r) => r.id)).toEqual([69, 71]);
  });

  it("declares nothing in an editor without the call, or for the game's own data set", () => {
    expect(declare(editor("old"), ASKOSI)).toBeNull();
    expect(declare(editor("new", [], "starcraft"), ASKOSI)).toBeNull();
    expect(withRace([{ id: 71 }, { id: 8 }], { id: 69 })).toEqual([{ id: 8 }, { id: 69 }, { id: 71 }]);
  });
});

describe("workers and town halls", () => {
  it("are the units table's: the Worker flag, and the buildings with the ResourceDepot flag", () => {
    const flags = new Uint32Array(400);
    flags[7] = UNIT_FLAGS.worker; flags[310] = UNIT_FLAGS.worker;
    flags[106] = UNIT_FLAGS.depot | UNIT_FLAGS.building; flags[320] = UNIT_FLAGS.depot | UNIT_FLAGS.building;
    flags[50] = UNIT_FLAGS.depot; // not a building
    expect(rolesOf(flags)).toEqual({ workers: [7, 310], halls: [106, 320] });
    expect(rolesOf(new Uint32Array(10))).toBeNull();
    expect(rolesOf(null)).toBeNull();
  });

  it("fill the sets every view reads, and go back to the game's numbers without the table", () => {
    expect(PLAYED_WORKERS).toBe(WORKERS);
    expect(ANALYSIS_WORKERS).toBe(WORKERS);
    expect(ANALYSIS_HALLS).toBe(TOWN_HALLS);
    try {
      expect(useRoles({ workers: [7, 310], halls: [106, 320] })).toBe(true);
      expect([...WORKERS]).toEqual([7, 310]);
      expect([...TOWN_HALLS]).toEqual([106, 320]);
      expect([...DEPOTS]).toEqual([106, 320]);
      expect(useRoles({ workers: [7, 310], halls: [106, 320] })).toBe(false);
    } finally {
      useRoles(null);
    }
    expect([...WORKERS]).toEqual(GAME_WORKERS);
    expect([...TOWN_HALLS]).toEqual(GAME_HALLS);
    expect([...DEPOTS]).toEqual(GAME_DEPOTS);
  });

  it("are what the build order and the bases a replay took go by", () => {
    const rep = analyseMade([[0, 310], [5, 320]]);
    try {
      useRoles({ workers: [310], halls: [320] });
      const again = analyse(rep.replay);
      expect(again.players[0].expansions.map((p) => p.unit)).toEqual([320]);
    } finally {
      useRoles(null);
    }
    expect(analyse(rep.replay).players[0].expansions).toEqual([]);
  });
});

/** A made replay of one player who builds unit `type` at tile (x, 0) for each pair. */
function analyseMade(builds: [x: number, type: number][]) {
  const replay = {
    format: "1.21" as const,
    header: { engine: 1, frames: 1000, started: null, title: "", mapWidth: 64, mapHeight: 64, speed: 6, gameType: 2, host: "", mapName: "Made" },
    players: [{ index: 0, slot: 0, id: 0, type: 2, race: 69, team: 0, name: "Made", color: "#ff0000" }],
    commands: builds.map(([x, type], i) => ({ frame: 100 + i * 10, player: 0, kind: "build" as const, type: 0x0c, x, y: 0, unit: type, order: 30 })),
    unknownCommands: 0, chk: new Uint8Array(), mod: null,
  };
  return analyse(replay);
}

describe("the cast's prompt for a race the game does not have", () => {
  const timeline: ReplayTimeline = {
    version: 4, frames: 2000, total: 2000, ended: null, map: { width: 64, height: 64 },
    players: [{ slot: 0, name: "W", race: 69 }, { slot: 1, name: "Z", race: 0 }],
    events: [{ frame: 0, kind: "born", unit: 1, type: 7, owner: 0, x: 0, y: 0 }],
    research: [], samples: { every: 1000, frame: [0, 1000], players: [] }, positions: null,
  };
  const names = { unit: (id: number) => `Unit ${id}`, upgrade: (id: number) => `Upgrade ${id}`, tech: (id: number) => `Tech ${id}`, place: () => "the middle" };
  const player = (more: Partial<CastPlayer>): CastPlayer => ({ index: 0, name: "W", race: 69, leftAt: null, build: [{ frame: 50, kind: "build", id: 111, count: 1 }], ...more });
  const input = (p: CastPlayer) => castInput({
    map: "M", timeline, winner: null, fights: [], bases: [], names,
    players: [p, { index: 1, name: "Z", race: 0, leftAt: null, build: [] }],
  }, castSegments([], 2000));

  it("tells the race's true name and what it plays as, and lists it by what it plays as", () => {
    const p = player({ raceName: "Askosi", like: 1 });
    expect(castRace(p)).toBe("Terran");
    expect(raceWords(p)).toBe("Askosi, a race the game does not have, which plays as Terran");
    const got = input(p);
    expect(got.game.players).toEqual([{ id: 0, name: "W", race: "Terran", result: "unknown" }, { id: 1, name: "Z", race: "Zerg", result: "unknown" }]);
    expect(got.game.openings?.[0]).toMatch(/^W \(Askosi, a race the game does not have, which plays as Terran\), supply/);
    expect(got.moments[0].before[0]).toBe("W plays Askosi, a race the game does not have, which plays as Terran; the list of players says Terran for it");
  });

  it("says Race 69 with no name, and leaves the player out of the list when what it plays as is not known, never calling it Terran", () => {
    const p = player({ like: null });
    expect(castRace(p)).toBeNull();
    const got = input(p);
    expect(got.game.players.map((x) => x.id)).toEqual([1]);
    expect(got.game.openings?.[0]).toMatch(/^W \(Race 69, a race the game does not have; what it plays as is not known\)/);
    expect(got.moments[0].before[0]).toBe("W plays Race 69, a race the game does not have; what it plays as is not known; the list of players leaves them out");
    expect(JSON.stringify(got)).not.toMatch(/W \(Terran\)/);
  });
});

describe("a cast no player of which can be told to the server", () => {
  const p = (race: number, like?: 0 | 1 | 2 | null): CastPlayer => ({ index: 0, name: "W", race, ...(like !== undefined ? { like } : {}), leftAt: null, build: [] });
  it("is one where every player's race is none of the three and plays as none known", () => {
    expect(castable([p(69, null), p(70, null)])).toBe(false);
    expect(castable([p(69, null), p(0)])).toBe(true);
    expect(castable([p(69, 1)])).toBe(true);
    expect(castable([])).toBe(false);
  });

  it("is never sent: making its input throws rather than send an empty list of players", () => {
    const timeline: ReplayTimeline = { version: 4, frames: 2000, total: 2000, ended: null, map: { width: 64, height: 64 }, players: [], events: [], research: [], samples: { every: 1000, frame: [0, 1000], players: [] }, positions: null };
    const names = { unit: (id: number) => `Unit ${id}`, upgrade: (id: number) => `Upgrade ${id}`, tech: (id: number) => `Tech ${id}`, place: () => "the middle" };
    expect(() => castInput({ map: "M", timeline, winner: null, fights: [], bases: [], names, players: [p(69, null)] }, castSegments([], 2000))).toThrow(/Zerg, Terran or Protoss/);
  });
});

describe("a mod's races handed on", () => {
  const tag = { v: 1, dataSet: { hash: "0123456789abcdef", name: "Mod", url: null, races: [ASKOSI, { id: 3, name: "Bad" }] }, plugins: [], firegraft: null, noplugins: false, engine: null, madeBy: "test" };
  it("goes with the replay's data set to the engine, and with the open mod's", () => {
    expect(replayDataSet(tag)).toEqual({ hash: "0123456789abcdef", name: "Mod", races: [ASKOSI] });
    const open = openModOf({ hash: "0123456789abcdef", profile: { id: "mod", name: "Mod", races: [ASKOSI] } })!;
    expect(open.races).toEqual([ASKOSI]);
    expect(assumedDataSet(open)).toEqual({ hash: "0123456789abcdef", name: "Mod", live: true, races: [ASKOSI] });
    expect(openModOf({ hash: "0123456789abcdef", profile: { id: "mod", name: "Mod" } })).toEqual({ hash: "0123456789abcdef", name: "Mod", url: null });
  });

  it("does not stop a race past 7 being a sign of a mod", () => {
    expect(modSigns([{ name: "W", race: 69 }, { name: "Z", race: 6 }], { tileset: 0, tiles: new Uint16Array(4) })).toEqual([{ kind: "race", player: "W", race: 69 }]);
  });
});

// The replay a mod's own release recorded, where it is on this machine (never committed, nor anything of the mod's).
const REAL = process.env.SCM_RACES_REPLAY ?? `${homedir()}/.cache/scmjs-cosmonarchy/replays/40ca0e2_17-28_BattleGuard.rep`;
if (existsSync(REAL)) describe("the real replay with a race the game does not have", () => {
  it("keeps the race byte, reads Race 69 with nothing named, and the declared name once the data set names it", async () => {
    const replay = await parseReplay(new Uint8Array(readFileSync(REAL)));
    const races = replay.players.map((p) => p.race);
    expect(races).toContain(69);
    const report = analyse(replay);
    const w = report.players.find((p) => p.player.race === 69)!;
    const view = raceView(69, { ...editorSources(editor("old")), units: () => w.build.map((s) => s.id), groupFlags: null });
    expect(labelOf(view, game, unnamed)).toBe("Race 69");
    expect(view.like).toBeNull();
    expect(labelOf(raceView(69, editorSources(editor("new", [ASKOSI]))), game, unnamed)).toBe("Askosi");
    expect(modSigns(replay.players, readChk(replay.chk)).some((s) => s.kind === "race" && s.race === 69)).toBe(true);
  });
});
