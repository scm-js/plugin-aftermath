import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendModTag, parseReplay, type ModTag } from "@scm-js/replay";
import { chk, cmds, le16, writeReplay } from "@scm-js/replay/write";
import { dataSetHash, folderHashes, gameName, handedReplay, hashLines, isReplaysMod, modAnalysis, modFolder, modRoot, liveLifter, playsModReplays, pluginNames, replayDataSet, safeLink, sha256 } from "../modreplay";

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
    const handed = handedReplay(bytes, "Exodus.rep", tag());
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
    const handed = handedReplay(bytes, "game.rep", null);
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
    const handed = handedReplay(new Uint8Array(0), "x.rep", tag({ dataSet: { hash: "ac3f86533e4b5a31", name: "release", url: "https://www.fraudsclub.com/cosmonarchy-bw/" }, engine: { lifter: "m10r2.1", build: "dev" } }));
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
