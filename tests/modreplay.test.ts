import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readChk } from "../chk";
import { describe, expect, it } from "vitest";
import { appendModTag, parseReplay, type ModTag } from "@scm-js/replay";
import { chk, cmds, le16, writeReplay } from "@scm-js/replay/write";
import { assumedDataSet, assumedTag, dataSetHash, engineReason, engineSentence, folderHashes, gameName, handedReplay, hashLines, hashLinesAsWere, isReplaysMod, isSystemFile, SYSTEM_FILES, modAnalysis, modFolder, modHashPending, modRoot, modSigns, liveLifter, openModOf, pickedModFiles, playsModReplays, pluginNames, REMASTERED_TERRAIN_GROUPS, replayDataSet, safeLink, sha256 } from "../modreplay";

const blob = (s: string) => new Blob([new TextEncoder().encode(s)]);
const tag = (more: Partial<ModTag> = {}): ModTag => ({
  v: 1, dataSet: { hash: "0123456789abcdef", name: "Test Mod", url: "https://example.org/mod" }, plugins: [{ name: "a.qdp", sha256: "a".repeat(64) }],
  firegraft: { name: "b.fgp", sha256: "b".repeat(64) }, noplugins: false, engine: null, madeBy: "test", ...more,
});

describe("a picked folder read as a mod", () => {
  it("finds the game's paths a folder down, and leaves out what is not the game's", () => {
    const folder = modFolder([
      { path: "release/mpq/arr/units.dat", file: blob("units") },
      { path: "release/mpq/rez/stat_txt.tbl", file: blob("stat") },
      { path: "release/mpq/notes.txt", file: blob("notes") },
      { path: "release/README.md", file: blob("readme") },
      { path: "release/Test Mod.exe", file: blob("MZ") },
      { path: "release/discord.dll", file: blob("MZ") },
      { path: "release/plugins/gptp.qdp", file: blob("plugin") },
      { path: "release/Test Mod.fgp", file: blob("fg") },
      { path: "release/Test Mod.fgd", file: blob("db") },
      { path: "release/mpq/plugins/gptp.ini", file: blob("a plugin's own") },
      { path: "release/mpq/lua/.gitignore", file: blob("x") },
      { path: "release/mpq/.git/config", file: blob("x") },
    ]);
    // A dot file is the mod's; a dot folder, a plugin's own folder and a library are not.
    expect([...folder.files.keys()]).toEqual(["arr\\units.dat", "rez\\stat_txt.tbl", "lua\\.gitignore"]);
    expect([...folder.plugins.keys()]).toEqual(["gptp.qdp"]);
    expect([...folder.firegraft.keys()]).toEqual(["test mod.fgp"]);
    expect(folder.unread).toEqual(["Test Mod.exe"]);
  });

  it("takes a folder whose root is the game's paths", () => {
    expect([...modFolder([{ path: "mymod/arr/units.dat", file: blob("u") }, { path: "mymod/unit/terran/marine.grp", file: blob("g") }]).files.keys()]).toEqual(["arr\\units.dat", "unit\\terran\\marine.grp"]);
    expect(modRoot(["mpq/arr/units.dat", "mpq/unit/terran/unit/x.grp"])).toBe("mpq");
    // At any depth, as the play page looks: a zip unpacked into a folder of its own.
    expect(modRoot(["Mod 1.2/mpq/arr/units.dat", "Mod 1.2/mpq/unit/x.grp", "Mod 1.2/README.md"])).toBe("Mod 1.2/mpq");
    expect(gameName("Arr/Units.DAT")).toBe("arr\\units.dat");
  });
});

describe("the data set's hash", () => {
  it("is the shared rule: SHA-256 over the sorted name<TAB>sha256 lines, sixteen hex digits", async () => {
    const files = [{ name: "rez\\stat_txt.tbl", sha256: "2".repeat(64) }, { name: "arr\\units.dat", sha256: "1".repeat(64) }];
    const want = createHash("sha256").update(`arr\\units.dat\t${"1".repeat(64)}\nrez\\stat_txt.tbl\t${"2".repeat(64)}`).digest("hex").slice(0, 16);
    expect(await dataSetHash(files)).toBe(want);
    expect(await sha256(new TextEncoder().encode("abc"))).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("is the play page's for a made mod: game files, the plugin and the project, never the .fgd", async () => {
    // The page's own buildMod over this folder (scm-sim lift-ts 0215c82), 2026-11-08.
    const page = { hash: "963daa4f7aecfe5d", withoutPlugins: "998ef33385c9e844" };
    const folder = modFolder([
      { path: "Made/arr/units.dat", file: blob("a made units.dat") },
      { path: "Made/lua/.gitignore", file: blob("*.bak") },
      { path: "Made/rez/stat_txt.tbl", file: blob("made strings") },
      { path: "Made/sound/made/new.wav", file: blob("RIFF made sound") },
      { path: "Made/plugins/x.qdp", file: blob("a plugin's bytes") },
      { path: "Made/y.fgp", file: blob("a FireGraft project's bytes") },
      { path: "Made/y.fgd", file: blob("FireGraft's database") },
      { path: "Made/README.md", file: blob("notes") },
    ]);
    const seen: number[] = [];
    const h = await folderHashes(folder, async () => null, (done) => seen.push(done));
    expect({ hash: h.hash, withoutPlugins: h.withoutPlugins }).toEqual(page);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(isReplaysMod(tag({ dataSet: { hash: page.hash, name: "", url: null } }), h)).toBe(true);
    expect(isReplaysMod(tag({ dataSet: { hash: page.withoutPlugins, name: "", url: null } }), h)).toBe(true);
  });

  it("keeps the older forms for replays tagged before: the game files alone, and those that differ from the data set underneath", async () => {
    const folder = modFolder([{ path: "m/arr/units.dat", file: blob("mine") }, { path: "m/arr/weapons.dat", file: blob("same") }]);
    const under = async (member: string) => (member === "arr\\weapons.dat" ? new TextEncoder().encode("same") : null);
    const h = await folderHashes(folder, under);
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(h.changed).toBe(await dataSetHash([{ name: "arr\\units.dat", sha256: digest("mine") }]));
    expect(h.all).toBe(await dataSetHash([{ name: "arr\\units.dat", sha256: digest("mine") }, { name: "arr\\weapons.dat", sha256: digest("same") }]));
    // No plugins or project: the mod's hash is the game files'.
    expect(h.hash).toBe(h.all);
    expect(h.withoutPlugins).toBe(h.all);
    expect(await hashLines([`b\t${"2".repeat(64)}`, `a\t${"1".repeat(64)}`])).toBe(createHash("sha256").update(`a\t${"1".repeat(64)}\nb\t${"2".repeat(64)}`).digest("hex").slice(0, 16));
    expect(isReplaysMod(tag({ dataSet: { hash: h.all, name: "", url: null } }), h)).toBe(true);
    expect(isReplaysMod(tag({ dataSet: { hash: h.changed, name: "", url: null } }), h)).toBe(true);
    expect(isReplaysMod(tag(), h)).toBe(false);
  });
});

describe("an operating system's files are not a mod's", () => {
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  /** The rule as it was until 2026-11-09, written out: every line, sorted by name, SHA-256, sixteen hex digits. */
  const ruleAsWas = (files: Record<string, string>) => createHash("sha256").update(Object.keys(files).sort().map((n) => `${n}\t${digest(files[n])}`).join("\n")).digest("hex").slice(0, 16);
  const MOD: Record<string, string> = { "arr/units.dat": "a made units.dat", "sound/made/new.wav": "RIFF made sound", "lua/.gitignore": "*.bak", "plugins/x.qdp": "a plugin's bytes", "y.fgp": "a project" };
  /** One file of each kind the list names, under a game folder (and the zip folder macOS makes). */
  const SYSTEM: Record<string, string> = {
    "sound/desktop.ini": "[ViewState]", "sound/made/Desktop.INI": "[ViewState]", "unit/Thumbs.db": "t", "unit/ehthumbs.db": "t", "unit/ehthumbs_vista.db": "t",
    "arr/.DS_Store": "Bud1", "arr/._units.dat": "fork", "arr/Icon\r": "", "lua/.directory": "[Dolphin]", "arr/__MACOSX/units.dat": "anything under that folder",
  };
  /** Names that only hold one of the list's: files of the mod like any other. */
  const NOT_SYSTEM = ["sound/mydesktop.ini", "sound/desktop.ini.bak", "sound/desktop.ini/voice.wav", "unit/thumbs.db.txt", "unit/xthumbs.db", "arr/.ds_store2", "arr/a._b", "arr/_.units.dat", "lua/x.directory", "arr/icon", "my__macosx/units.dat", "samase/config.ini"];
  const picked = (files: Record<string, string>) => modFolder(Object.entries(files).map(([path, data]) => ({ path: `Made/${path}`, file: blob(data) })));
  const names = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, d]) => [p.replace(/\//g, "\\").toLowerCase(), d]));

  it("is told by name alone, any case and either slash; a name that only holds one is a file like any other", () => {
    for (const path of Object.keys(SYSTEM)) {
      expect(isSystemFile(path), path).toBe(true);
      expect(isSystemFile(path.toUpperCase().replace(/\//g, "\\")), path).toBe(true);
    }
    expect(isSystemFile("__MACOSX/arr/._units.dat")).toBe(true);
    for (const path of NOT_SYSTEM) expect(isSystemFile(path), path).toBe(false);
    for (const name of SYSTEM_FILES.names) expect(Object.keys(SYSTEM).some((p) => p.toLowerCase().endsWith(`/${name}`)), JSON.stringify(name)).toBe(true);
  });

  it("a picked folder hashes alike with each of them and without, and other with a file that only holds the name", async () => {
    const plain = await folderHashes(picked(MOD), async () => null);
    expect(plain.older).toEqual([]);
    for (const [path, data] of Object.entries(SYSTEM)) {
      const folder = picked({ ...MOD, [path]: data });
      expect([...folder.files.keys()], path).toEqual([...picked(MOD).files.keys()]);
      const h = await folderHashes(folder, async () => null);
      expect({ ...h, older: [] }, path).toEqual(plain);
    }
    for (const path of NOT_SYSTEM) {
      const h = await folderHashes(picked({ ...MOD, [path]: "x" }), async () => null);
      expect(h.hash, path).not.toBe(plain.hash);
      expect(h.older, path).toEqual([]);
    }
    // macOS's half of a plugin or of a project is neither, and the zip folder's files are no files of the mod
    const forked = picked({ ...MOD, "plugins/._x.qdp": "fork", "._y.fgp": "fork", "__MACOSX/arr/._units.dat": "fork" });
    expect([...forked.plugins.keys()]).toEqual(["x.qdp"]);
    expect([...forked.firegraft.keys()]).toEqual(["y.fgp"]);
    expect((await folderHashes(forked, async () => null)).hash).toBe(plain.hash);
    // the rule itself drops such a line, whatever list it is given
    expect(await hashLines([`arr\\units.dat\t${"1".repeat(64)}`, `sound\\desktop.ini\t${"2".repeat(64)}`])).toBe(await hashLines([`arr\\units.dat\t${"1".repeat(64)}`]));
    expect(await hashLinesAsWere([`arr\\units.dat\t${"1".repeat(64)}`, `sound\\desktop.ini\t${"2".repeat(64)}`])).not.toBe(await hashLines([`arr\\units.dat\t${"1".repeat(64)}`]));
  });

  it("a replay tagged while they had lines still names the folder, when the folder shows them", async () => {
    const seen = { ...MOD, "sound/desktop.ini": "[ViewState]", "sound/cm/desktop.ini": "[ViewState]" };
    const game = names({ "arr/units.dat": MOD["arr/units.dat"], "sound/made/new.wav": MOD["sound/made/new.wav"], "lua/.gitignore": MOD["lua/.gitignore"], "sound/desktop.ini": "[ViewState]", "sound/cm/desktop.ini": "[ViewState]" });
    const under = async (member: string) => (member === "arr\\units.dat" ? new TextEncoder().encode(MOD["arr/units.dat"]) : null);
    const h = await folderHashes(picked(seen), under);
    const plain = await folderHashes(picked(MOD), under);
    expect({ ...h, older: [] }).toEqual(plain);
    // the four forms as they were, every line written out: with the plugins, without, the game files alone, those that differ
    const { "arr\\units.dat": _same, ...differ } = game;
    const were = [ruleAsWas({ ...game, "y.fgp": MOD["y.fgp"], "plugins\\x.qdp": MOD["plugins/x.qdp"] }), ruleAsWas({ ...game, "y.fgp": MOD["y.fgp"] }), ruleAsWas(game), ruleAsWas(differ)];
    expect(h.older).toEqual(were);
    for (const hash of were) {
      expect(isReplaysMod(tag({ dataSet: { hash, name: "", url: null } }), h), hash).toBe(true);
      // a folder picked through the browser's folder picker does not show the files: it cannot be told by that hash
      expect(isReplaysMod(tag({ dataSet: { hash, name: "", url: null } }), plain), hash).toBe(false);
    }
    expect(isReplaysMod(tag({ dataSet: { hash: h.hash, name: "", url: null } }), plain)).toBe(true);
  });
});

describe("what is said of a mod's replay", () => {
  it("names the plugins and the FireGraft patch, and none for a game without them", () => {
    expect(pluginNames(tag())).toBe("a.qdp, b.fgp");
    expect(pluginNames(tag({ noplugins: true }))).toBe("");
  });

  it("links only to a web address", () => {
    expect(safeLink("https://example.org/mod")).toBe("https://example.org/mod");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });

  it("reads the mod from a replay that carries one, and none from one that does not", async () => {
    const bytes = writeReplay({ format: "legacy", players: [{ index: 0, id: 0, name: "Alpha" }], commands: cmds([[10, 0, 0x1f, ...le16(7)]]), chk: chk(64, 64) });
    expect((await parseReplay(bytes)).mod).toBeNull();
    expect((await parseReplay(await appendModTag(bytes, tag()))).mod).toEqual(tag());
  });
});

describe("Play From Here with a mod's replay", () => {
  it("hands the play page the tag's hash, name and link, never the mod's files", () => {
    expect(replayDataSet(tag())).toEqual({ hash: "0123456789abcdef", name: "Test Mod", url: "https://example.org/mod", live: true });
    expect(replayDataSet(tag({ plugins: [], firegraft: null }))).toEqual({ hash: "0123456789abcdef", name: "Test Mod", url: "https://example.org/mod" });
    // No name, no link, a link that is not a web address: only what is there and safe.
    expect(replayDataSet(tag({ dataSet: { hash: "fedcba9876543210", name: "", url: null }, plugins: [] }))).toEqual({ hash: "fedcba9876543210" });
    expect(replayDataSet(tag({ dataSet: { hash: "fedcba9876543210", name: "M", url: "javascript:alert(1)" } }))).toEqual({ hash: "fedcba9876543210", name: "M", live: true });
    const bytes = new Uint8Array([1, 2, 3]);
    const handed = handedReplay(bytes, "Exodus.rep", replayDataSet(tag()));
    expect(handed).toEqual({ bytes, name: "Exodus.rep", dataSet: { hash: "0123456789abcdef", name: "Test Mod", url: "https://example.org/mod", live: true } });
    expect(handed.dataSet).not.toHaveProperty("files");
  });

  it("knows when the mod's code ran, which the page runs only with ?lift=live (scm-sim's replayLift)", () => {
    const lifter = { lifter: "m10r2.1", build: "dev" }, shipped = { lifter: "shipped", build: "dev" };
    // plugins ran (only ever with the live lifter)
    expect(liveLifter(tag())).toBe(true);
    expect(liveLifter(tag({ engine: shipped }))).toBe(true);
    // none ran: the FireGraft project's exe edits, written only by a lifter
    expect(liveLifter(tag({ plugins: [], noplugins: true, engine: lifter }))).toBe(true);
    expect(liveLifter(tag({ plugins: [], noplugins: true, engine: shipped }))).toBe(false);
    expect(liveLifter(tag({ plugins: [], noplugins: true, engine: null }))).toBe(false);
    expect(liveLifter(tag({ plugins: [], firegraft: null, engine: lifter }))).toBe(false);
    expect(replayDataSet(tag({ plugins: [], noplugins: true, engine: lifter }))).toMatchObject({ live: true });
    expect(replayDataSet(tag({ plugins: [], noplugins: true, engine: shipped }))).not.toHaveProperty("live");
  });

  it("hands nothing more than before for a replay of the game itself", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(replayDataSet(null)).toBeUndefined();
    const handed = handedReplay(bytes, "game.rep", replayDataSet(null));
    expect(handed).toEqual({ bytes, name: "game.rep" });
    expect("dataSet" in handed).toBe(false);
  });

  it("is what the play page takes: its own check keeps the data set as handed", () => {
    // plugin-scm-sim 0.17.0's validReplayDataSet (src/play.ts, view-mod 57058af), copied: a hash of 16 hex digits, or
    // files; a name and an http(s) link when they are text; `live` when it is true.
    const validReplayDataSet = (set: unknown) => {
      if (!set || typeof set !== "object") return null;
      const { hash, name, url, files, live } = set as Record<string, unknown>;
      const good = typeof hash === "string" && /^[0-9a-f]{16}$/.test(hash) ? hash : "";
      const kept = Array.isArray(files) ? files : [];
      if (!good && !kept.length) return null;
      return { hash: good, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}), ...(typeof url === "string" && /^https?:\/\/\S+$/i.test(url) ? { url } : {}), ...(kept.length ? { files: kept } : {}), ...(live === true ? { live: true } : {}) };
    };
    // The saved Cosmonarchy replay's tag (scm-sim docs/mods-replays.md): four plugins ran.
    const handed = handedReplay(new Uint8Array(0), "x.rep", replayDataSet(tag({ dataSet: { hash: "ac3f86533e4b5a31", name: "release", url: "https://www.fraudsclub.com/cosmonarchy-bw/" }, engine: { lifter: "m10r2.1", build: "dev" } })));
    expect(validReplayDataSet(handed.dataSet)).toEqual(handed.dataSet);
    expect(handed.dataSet).toEqual({ hash: "ac3f86533e4b5a31", name: "release", url: "https://www.fraudsclub.com/cosmonarchy-bw/", live: true });
  });
});

describe("a mod's own commands", () => {
  it("count as unknown in a 1.16.1 replay (0x60 to 0x65), the rest of their block left out", async () => {
    // Cosmonarchy sends 0x63 with a body of its own in every game.
    const bytes = writeReplay({ format: "legacy", players: [{ index: 0, id: 0, name: "Alpha" }], commands: cmds([[10, 0, 0x63, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], [20, 0, 0x1f, ...le16(7)]]), chk: chk(64, 64) });
    const replay = await parseReplay(await appendModTag(bytes, tag()));
    expect(replay.unknownCommands).toBe(1);
    expect(replay.mod?.dataSet.hash).toBe("0123456789abcdef");
  });
});

describe("the analysis of a mod's replay (scm-sim's R4)", () => {
  const mod = { hash: "ac3f86533e4b5a31", name: "Cosmonarchy BW", plugins: ["aise.qdp", "gptp.qdp", "isdbg.qdp", "mtl.qdp"], lifter: "lift-5" };
  it("is asked of an engine page that says modAnalysis, not of an older one", () => {
    expect(playsModReplays(["replayDoor", "liveSwitch", "modAnalysis"])).toBe(true);
    expect(playsModReplays(["replayDoor", "liveSwitch"])).toBe(false);
    expect(playsModReplays(undefined)).toBe(false);
  });
  it("says it played with the mod, could not (the engine's words), will, or does not on an older page", () => {
    expect(modAnalysis({ played: mod, engine: true, features: ["modAnalysis"], failed: null })).toEqual({ kind: "played", mod });
    const why = "This replay was played with Cosmonarchy BW (ac3f86533e4b5a31), which this browser has not got.";
    expect(modAnalysis({ played: null, engine: true, features: ["modAnalysis"], failed: why })).toEqual({ kind: "failed", reason: why });
    expect(modAnalysis({ played: null, engine: true, features: null, failed: null })).toEqual({ kind: "waiting" });
    expect(modAnalysis({ played: null, engine: true, features: ["replayDoor"], failed: "older" })).toEqual({ kind: "older" });
    expect(modAnalysis({ played: undefined, engine: false, features: null, failed: null })).toEqual({ kind: "older" });
  });
});

describe("an untagged replay watched with the mod open in the editor", () => {
  const source = (more: object = {}) => ({ hash: "1c41a2d7701fe842", profile: { id: "mod-cosmonarchy", name: "Cosmonarchy BW", url: "https://example.org/cosmo" }, ...more });

  it("is offered only for a mod's data set with its hash", () => {
    expect(openModOf(source())).toEqual({ hash: "1c41a2d7701fe842", name: "Cosmonarchy BW", url: "https://example.org/cosmo" });
    expect(openModOf(source({ profile: { id: "starcraft", name: "StarCraft: Brood War" } }))).toBeNull();
    expect(openModOf(source({ hash: undefined }))).toBeNull();
    expect(openModOf(source({ hash: "not-a-hash" }))).toBeNull();
    expect(openModOf(null)).toBeNull();
    expect(openModOf(source({ profile: { id: "m", name: "M", url: "javascript:alert(1)" } }))?.url).toBeNull();
  });

  it("is tagged and handed over as that mod, with its code run", () => {
    const mod = openModOf(source())!;
    const tag = assumedTag(mod);
    expect(tag.dataSet).toEqual({ hash: "1c41a2d7701fe842", name: "Cosmonarchy BW", url: "https://example.org/cosmo" });
    expect(tag.plugins).toEqual([]);
    expect(pluginNames(tag)).toBe("");
    expect(assumedDataSet(mod)).toEqual({ hash: "1c41a2d7701fe842", name: "Cosmonarchy BW", url: "https://example.org/cosmo", live: true });
    expect(assumedDataSet({ hash: "1c41a2d7701fe842", name: "", url: null })).toEqual({ hash: "1c41a2d7701fe842", live: true });
  });
});

describe("signs that an untagged replay was played with a mod (from the replay itself)", () => {
  const players = (...races: number[]) => races.map((race, i) => ({ name: `P${i + 1}`, race }));
  const map = (tileset: number, ...groups: number[]) => ({ tileset, tiles: Uint16Array.from(groups.map((g) => (g << 4) | 3)) });

  it("is a tile group past Remastered's table for its tileset, compared as the raw 12-bit group", () => {
    expect([...REMASTERED_TERRAIN_GROUPS]).toEqual([1979, 2046, 1265, 1418, 2046, 2046, 2039, 2047]);
    // Jungle: Remastered's last group is 2045; Cosmonarchy's table has 4,095.
    expect(modSigns(players(0, 1), map(4, 1, 2045))).toEqual([]);
    expect(modSigns(players(0, 1), map(4, 1, 3734, 2046))).toEqual([{ kind: "terrain", tileset: 4, group: 3734, last: 2045 }]);
    // (the subtile in the low four bits is not the group)
    expect(modSigns(players(0), { tileset: 4, tiles: Uint16Array.from([(2045 << 4) | 15]) })).toEqual([]);
    // Installation is as long in 1.16.1 as in Remastered; the era's high bits are not the tileset.
    expect(modSigns(players(0), map(2 | 8, 1265))).toEqual([{ kind: "terrain", tileset: 2, group: 1265, last: 1264 }]);
    // A map with no terrain says nothing.
    expect(modSigns(players(0), { tileset: 0, tiles: new Uint16Array(0) })).toEqual([]);
  });

  it("is a player's race byte that is none of the game's (0 to 7), never a name", () => {
    expect(modSigns(players(0, 1, 2, 6, 7), map(0, 1))).toEqual([]);
    expect(modSigns([{ name: "IAMtheWHEATofGOD", race: 69 }, { name: "Cosmonarchy", race: 0 }], map(0, 1))).toEqual([{ kind: "race", player: "IAMtheWHEATofGOD", race: 69 }]);
    expect(modSigns(players(8, 255), map(4, 3734)).map((s) => s.kind)).toEqual(["terrain", "race", "race"]);
  });

  it("waits for the hash of a mod in memory still being worked out, not for the game's own data, an installed set or none", () => {
    expect(modHashPending({ kind: "reader", profile: { id: "cosmonarchy" } })).toBe(true);
    expect(modHashPending({ kind: "reader", hash: "", profile: { id: "cosmonarchy" } })).toBe(true);
    expect(modHashPending({ kind: "reader", hash: "ac3f86533e4b5a31", profile: { id: "cosmonarchy" } })).toBe(false);
    expect(modHashPending({ kind: "copy", profile: { id: "starcraft" } })).toBe(false);
    expect(modHashPending({ kind: "none", profile: { id: "x" } })).toBe(false);
    // An installed data set never gets a hash: StarCraft: Remastered in use must not hold a replay back for ever.
    expect(modHashPending({ kind: "stored", profile: { id: "remastered" } })).toBe(false);
    expect(modHashPending({ kind: "bundled", profile: { id: "a-mod-installed" } })).toBe(false);
    expect(modHashPending({ profile: { id: "cosmonarchy" } })).toBe(false);
    expect(modHashPending(null)).toBe(false);
  });

  it("hands a picked folder to the engine's page as a drop gives it: every file by its path, dot folders left out", () => {
    const blob = new Blob(["x"]);
    const files = pickedModFiles([
      { path: "Release/mpq/arr/units.dat", file: blob },
      { path: "Release/plugins/gptp.qdp", file: new File(["y"], "gptp.qdp") },
      { path: "Release/Cosmonarchy BW.exe", file: blob },
      { path: "Release/.git/config", file: blob },
    ]);
    expect(files.map((f) => f.path)).toEqual(["Release/mpq/arr/units.dat", "Release/plugins/gptp.qdp", "Release/Cosmonarchy BW.exe"]);
    expect(files.every((f) => f.file instanceof File)).toBe(true);
    expect(files[0].file.name).toBe("units.dat");
  });

  it("reads the engine's reason, and its sentence without the worker's \"Error: \"", () => {
    const e = Object.assign(new Error("Error: this map is built on terrain that StarCraft has not got"), { reason: "mod-terrain" });
    expect(engineReason(e)).toBe("mod-terrain");
    expect(engineSentence(e)).toBe("This map is built on terrain that StarCraft has not got");
    expect(engineReason(new Error("x"))).toBeNull();
    expect(engineReason({ reason: "made-up" })).toBeNull();
    expect(engineSentence("Error: Error: twice")).toBe("Twice");
    expect(engineSentence(new Error("The replay could not be started."))).toBe("The replay could not be started.");
  });
});

// A replay a mod's own release recorded (untagged), where one is at hand: SCM_MOD_REPLAY=<path to .rep>. Never committed.
const MOD_REPLAY = process.env.SCM_MOD_REPLAY;
if (MOD_REPLAY && existsSync(MOD_REPLAY)) describe("a replay a mod's own release recorded", () => {
  it("names no mod, and says it was played with one", async () => {
    const replay = await parseReplay(new Uint8Array(readFileSync(MOD_REPLAY)));
    expect(replay.mod).toBeNull();
    const signs = modSigns(replay.players, readChk(replay.chk));
    console.log(JSON.stringify(signs));
    expect(signs.length).toBeGreaterThan(0);
  });
});
