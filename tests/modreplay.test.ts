import { createHash } from "node:crypto";
import { existsSync, openAsBlob, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readChk } from "../chk";
import { describe, expect, it } from "vitest";
import type { DialogSpec } from "@scm-js/plugin-api";
import { hashLines, ModReadError, PatcherError, readMod, say } from "@scm-js/mod";
import { Creator } from "mopaq";
import { appendModTag, parseReplay, type ModTag } from "@scm-js/replay";
import { chk, cmds, le16, writeReplay } from "@scm-js/replay/write";
import { ask, assumedDataSet, assumedTag, engineReason, engineSentence, folderHashes, folderMod, handedReplay, holdsMod, isReplaysMod, modAnalysis, modErrorText, modFolder, MOD_WORDS, modHashPending, modSigns, liveLifter, openModOf, pickedModFiles, pickedTree, playsModReplays, pluginNames, REMASTERED_TERRAIN_GROUPS, replayDataSet, safeLink, type PickedFile } from "../modreplay";
import { KO } from "../ko";

const blob = (s: string | Uint8Array) => new Blob([typeof s === "string" ? new TextEncoder().encode(s) : s]);
const tag = (more: Partial<ModTag> = {}): ModTag => ({
  v: 1, dataSet: { hash: "0123456789abcdef", name: "Test Mod", url: "https://example.org/mod" }, plugins: [{ name: "a.qdp", sha256: "a".repeat(64) }],
  firegraft: { name: "b.fgp", sha256: "b".repeat(64) }, noplugins: false, engine: null, madeBy: "test", ...more,
});
const named = (hash: string) => tag({ dataSet: { hash, name: "", url: null } });
const none = async () => null;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** A folder of `files` (paths under it, contents), as the folder picker hands it over. */
const picked = (files: Record<string, string | Uint8Array>, top = "Made"): PickedFile[] => Object.entries(files).map(([path, data]) => ({ path: `${top}/${path}`, file: blob(data) }));

describe("a picked folder read as a mod (@scm-js/mod)", () => {
  it("finds the game's paths a folder down, and leaves out what is not the game's", async () => {
    const folder = await modFolder(picked({
      "mpq/arr/units.dat": "units", "mpq/rez/stat_txt.tbl": "stat", "mpq/notes.txt": "notes", "README.md": "readme",
      "plugins/gptp.qdp": "plugin", "Test Mod.fgp": "fg", "Test Mod.fgd": "db", "mpq/lua/.gitignore": "x", "mpq/.git/config": "x",
    }, "release"), none);
    const d = folder.description;
    // A dot file is the mod's; a dot folder, a read-me beside the game's folders and FireGraft's database are not.
    expect(d.files.map((f) => f.name)).toEqual(["arr\\units.dat", "lua\\.gitignore", "rez\\stat_txt.tbl"]);
    expect(Object.keys(d.identity.plugins)).toEqual(["gptp.qdp"]);
    expect(d.identity.lines.map((l) => l.slice(0, l.indexOf("\t")))).toEqual(["arr\\units.dat", "lua\\.gitignore", "rez\\stat_txt.tbl", "test mod.fgp"]);
    expect(new TextDecoder().decode((await folder.file("arr\\units.dat"))!)).toBe("units");
    expect(await folder.file("arr\\weapons.dat")).toBeNull();
    expect(holdsMod(d)).toBe(true);
  });

  it("reads the mod's archive in the folder, which a replay names it by too", async () => {
    const mpq = new Creator({ listfile: true });
    mpq.addFile("arr\\units.dat", new TextEncoder().encode("units in the archive"));
    mpq.addFile("unit\\terran\\marine.grp", new TextEncoder().encode("a picture"));
    const folder = await modFolder(picked({ "Mod.mpq": mpq.write(), "Read Me.txt": "notes" }), none);
    expect(folder.description.files.map((f) => f.name)).toEqual(["arr\\units.dat", "unit\\terran\\marine.grp"]);
    expect(folder.hashes.hash).toBe(await hashLines([`arr\\units.dat\t${digest("units in the archive")}`, `unit\\terran\\marine.grp\t${digest("a picture")}`]));
    expect(new TextDecoder().decode((await folder.file("unit\\terran\\marine.grp"))!)).toBe("a picture");
    expect(isReplaysMod(named(folder.hashes.hash), folder.hashes)).toBe(true);
    // Let go of, the archive is opened again by a later read.
    folder.close();
    expect(new TextDecoder().decode((await folder.file("arr\\units.dat"))!)).toBe("units in the archive");
  });

  it("refuses an archive it cannot open with the reader's own error, and its reason", async () => {
    const broken = new Uint8Array(96);
    broken.set([0x4d, 0x50, 0x51, 0x1a]);
    const err = await modFolder(picked({ "Mod.mpq": broken }), none).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ModReadError);
    expect((err as ModReadError).detail.key).toBe("archive-unopenable");
    expect(((err as ModReadError).detail.params as { reason?: { key: string } }).reason?.key).toMatch(/^mpq-/);
  });

  it("reads a file only when the reader asks for it, and hands a dot folder's files to no one", async () => {
    const asked: string[] = [];
    const files = picked({ "arr/units.dat": "u", ".git/objects/pack.pack": "a large pack" });
    const tree = pickedTree(files);
    const read = tree.read;
    tree.read = (path) => { asked.push(path); return read(path); };
    expect(tree.name).toBe("Made");
    expect((await tree.list()).map((e) => e.path)).toEqual(["Made/arr/units.dat", "Made/.git/objects/pack.pack"]);
    await readMod(tree);
    expect(asked).toEqual(["Made/arr/units.dat"]);
    await expect(tree.read("Made/nothing")).rejects.toBeInstanceOf(ModReadError);
    expect(pickedModFiles(files).map((f) => f.path)).toEqual(["Made/arr/units.dat"]);
  });

  it("is no mod with neither game files nor code, and a mod of code alone", async () => {
    expect(holdsMod((await modFolder(picked({ "Read Me.txt": "notes" }), none)).description)).toBe(false);
    expect(holdsMod((await modFolder(picked({ "plugins/x.qdp": "a plugin's bytes" }), none)).description)).toBe(true);
  });

  it("says why it cannot read a folder in the package's words, translated by their English template", () => {
    const fill = (text: string, params: Record<string, string | number>) => text.replace(/\{(\w+)(?:\|[^}]*)?\}/g, (_, n: string) => String(params[n] ?? ""));
    const t = (text: string, params: Record<string, string | number> = {}) => fill(KO[text] ?? text, params);
    const english = (text: string, params: Record<string, string | number> = {}) => fill(text, params);
    // The library's English text is `why`; its reason, hidden in English, is what Korean shows.
    const archive = new ModReadError(say("archive-unopenable", { path: "Mod.mpq", why: "Invalid MPQ header", reason: say("mpq-damaged", { detail: "Invalid MPQ header" }) }));
    expect(modErrorText(archive, english)).toBe("Mod.mpq could not be opened as an archive: Invalid MPQ header");
    expect(modErrorText(archive, t)).toBe("Mod.mpq 아카이브로 열지 못했습니다: 손상되었습니다(Invalid MPQ header)");
    // (made without the reason, Korean shows the library's text)
    expect(modErrorText(new ModReadError(say("archive-unopenable", { path: "Mod.mpq", why: "Invalid MPQ header" } as never)), t)).toBe("Mod.mpq 아카이브로 열지 못했습니다: Invalid MPQ header");
    // The progress the reader can say includes a copy of the game it leaves out.
    expect(MOD_WORDS).toContain("game-copy");
    const err = new ModReadError(say("exe-unreadable", { path: "Mod.exe", why: new PatcherError(say("overlay-form", { at: 1024, form: 2, known: 1 })).detail }));
    const text = modErrorText(err, t);
    expect(text).toContain("Mod.exe");
    expect(text).toContain("1024");
    expect(text).toContain("모드로 읽을 수 없습니다");
    expect(text).toContain("패처 오버레이");
    expect(modErrorText(new Error("plain"), t)).toBe("plain");
  });
});

describe("the hashes a replay may name the mod by", () => {
  it("is the play page's for a made mod: game files, the plugin and the project, never the .fgd", async () => {
    // The page's own buildMod over this folder (scm-sim lift-ts 0215c82), 2026-11-08.
    const page = { hash: "963daa4f7aecfe5d", withoutPlugins: "998ef33385c9e844" };
    const folder = await modFolder(picked({
      "arr/units.dat": "a made units.dat", "lua/.gitignore": "*.bak", "rez/stat_txt.tbl": "made strings", "sound/made/new.wav": "RIFF made sound",
      "plugins/x.qdp": "a plugin's bytes", "y.fgp": "a FireGraft project's bytes", "y.fgd": "FireGraft's database", "README.md": "notes",
    }), none);
    const h = folder.hashes;
    expect({ hash: h.hash, withoutPlugins: h.withoutPlugins }).toEqual(page);
    expect(h.older).toEqual([]);
    expect(isReplaysMod(named(page.hash), h)).toBe(true);
    expect(isReplaysMod(named(page.withoutPlugins), h)).toBe(true);
  });

  it("keeps the older forms for replays tagged before: the game files alone, and those that differ from the data set underneath", async () => {
    const under = async (member: string) => (member === "arr\\weapons.dat" ? new TextEncoder().encode("same") : null);
    const h = (await modFolder(picked({ "arr/units.dat": "mine", "arr/weapons.dat": "same" }, "m"), under)).hashes;
    expect(h.changed).toBe(await hashLines([`arr\\units.dat\t${digest("mine")}`]));
    expect(h.all).toBe(await hashLines([`arr\\units.dat\t${digest("mine")}`, `arr\\weapons.dat\t${digest("same")}`]));
    // No code or project: the mod's hash is the game files'.
    expect(h.hash).toBe(h.all);
    expect(h.withoutPlugins).toBe(h.all);
    expect(isReplaysMod(named(h.all), h)).toBe(true);
    expect(isReplaysMod(named(h.changed), h)).toBe(true);
    expect(isReplaysMod(tag(), h)).toBe(false);
  });

  it("takes the hash by the rule before every module of the code had a line (2026-11-11)", async () => {
    // A library the plugins load has a line now and had none then.
    const folder = await modFolder(picked({ "arr/units.dat": "units", "plugins/x.qdp": "a plugin's bytes", "plugins/lib.dll": "a library's bytes" }), none);
    const id = folder.description.identity, h = folder.hashes;
    expect(Object.keys(id.plugins).sort()).toEqual(["lib.dll", "x.qdp"]);
    const before = await hashLines([`arr\\units.dat\t${digest("units")}`, `plugins\\x.qdp\t${digest("a plugin's bytes")}`]);
    expect(id.beforeCode).toBe(before);
    expect(h.older).toEqual([before]);
    expect(isReplaysMod(named(before), h)).toBe(true);
    // (and the hash now, which the engine's next release names it by)
    expect(isReplaysMod(named(id.hash), h)).toBe(true);
  });
});

describe("an operating system's files are not a mod's", () => {
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
  const names = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, d]) => [p.replace(/\//g, "\\").toLowerCase(), d]));
  const now = (h: { hash: string; withoutPlugins: string; all: string; changed: string }) => ({ hash: h.hash, withoutPlugins: h.withoutPlugins, all: h.all, changed: h.changed });

  it("a picked folder hashes alike with each of them and without, and other with a file that only holds the name", async () => {
    const plain = await modFolder(picked(MOD), none);
    expect(plain.hashes.older).toEqual([]);
    for (const [path, data] of Object.entries(SYSTEM)) {
      const folder = await modFolder(picked({ ...MOD, [path]: data }), none);
      expect(folder.description.files.map((f) => f.name), path).toEqual(plain.description.files.map((f) => f.name));
      expect(now(folder.hashes), path).toEqual(now(plain.hashes));
    }
    for (const path of NOT_SYSTEM) {
      const h = (await modFolder(picked({ ...MOD, [path]: "x" }), none)).hashes;
      expect(h.hash, path).not.toBe(plain.hashes.hash);
      expect(h.older, path).toEqual([]);
    }
    // macOS's half of a plugin or of a project is neither, and the zip folder's files are no files of the mod
    const forked = await modFolder(picked({ ...MOD, "plugins/._x.qdp": "fork", "._y.fgp": "fork", "__MACOSX/arr/._units.dat": "fork" }), none);
    expect(Object.keys(forked.description.identity.plugins)).toEqual(["x.qdp"]);
    expect(forked.hashes.hash).toBe(plain.hashes.hash);
  });

  it("a replay tagged while they had lines still names the folder, when the folder shows them", async () => {
    const seen = { ...MOD, "sound/desktop.ini": "[ViewState]", "sound/cm/desktop.ini": "[ViewState]" };
    const game = names({ "arr/units.dat": MOD["arr/units.dat"], "sound/made/new.wav": MOD["sound/made/new.wav"], "lua/.gitignore": MOD["lua/.gitignore"], "sound/desktop.ini": "[ViewState]", "sound/cm/desktop.ini": "[ViewState]" });
    const under = async (member: string) => (member === "arr\\units.dat" ? new TextEncoder().encode(MOD["arr/units.dat"]) : null);
    const h = (await modFolder(picked(seen), under)).hashes;
    const plain = (await modFolder(picked(MOD), under)).hashes;
    expect(now(h)).toEqual(now(plain));
    // the four forms as they were, every line written out: with the plugins, without, the game files alone, those that differ
    const { "arr\\units.dat": _same, ...differ } = game;
    const were = [ruleAsWas({ ...game, "y.fgp": MOD["y.fgp"], "plugins\\x.qdp": MOD["plugins/x.qdp"] }), ruleAsWas({ ...game, "y.fgp": MOD["y.fgp"] }), ruleAsWas(game), ruleAsWas(differ)];
    expect([...h.older].sort()).toEqual([...were].sort());
    for (const hash of were) {
      expect(isReplaysMod(named(hash), h), hash).toBe(true);
      // a folder picked through the browser's folder picker does not show the files: it cannot be told by that hash
      expect(isReplaysMod(named(hash), plain), hash).toBe(false);
    }
    expect(isReplaysMod(named(h.hash), plain)).toBe(true);
  });

  it("is matched in the mod's archive too, where the folder picker cannot hide it", async () => {
    const mpq = new Creator({ listfile: true });
    mpq.addFile("arr\\units.dat", new TextEncoder().encode("units"));
    mpq.addFile("glue\\battle.net\\backgrounds\\Thumbs.db", new TextEncoder().encode("thumbnails"));
    const folder = await modFolder(picked({ "Mod.mpq": mpq.write() }), none);
    const was = ruleAsWas({ "arr\\units.dat": "units", "glue\\battle.net\\backgrounds\\thumbs.db": "thumbnails" });
    expect(folder.description.identity.older?.hash).toBe(was);
    expect(folder.hashes.older).toContain(was);
    expect(isReplaysMod(named(was), folder.hashes)).toBe(true);
  });

  it("folderHashes over a description: the forms in one list, none repeated, none equal to the hash", async () => {
    const d = (await modFolder(picked({ "arr/units.dat": "u" }), none)).description;
    const h = await folderHashes(d, { changed: ["arr\\units.dat"] });
    expect(h.changed).toBe(h.all);
    expect(h.older).toEqual([]);
  });
});

describe("the mod a picked folder holds, for replays that name none", () => {
  it("goes by the name, link and races its mod.json gives", async () => {
    const json = (o: object) => JSON.stringify(o);
    const d = (await modFolder(picked({ "arr/units.dat": "u", "mod.json": json({ name: "Made Mod", link: "https://example.org/made", races: [{ id: 69, name: "Seventh" }] }) }), none)).description;
    expect(folderMod(d, "0123456789abcdef", "Made")).toEqual({ hash: "0123456789abcdef", name: "Made Mod", url: "https://example.org/made", races: [{ id: 69, name: "Seventh" }] });
    // races: [] declares none, which a page that kept names from before must drop; no races says nothing
    const none_ = (await modFolder(picked({ "arr/units.dat": "u", "mod.json": json({ races: [] }) }), none)).description;
    expect(folderMod(none_, "0123456789abcdef", "Made")).toEqual({ hash: "0123456789abcdef", name: "Made", url: null, races: [] });
    const silent = (await modFolder(picked({ "arr/units.dat": "u" }), none)).description;
    expect(folderMod(silent, "0123456789abcdef", "Made")).toEqual({ hash: "0123456789abcdef", name: "Made", url: null });
    expect(assumedDataSet(folderMod(d, "0123456789abcdef", "Made")).races).toEqual([{ id: 69, name: "Seventh" }]);
  });
});

// Mods at hand, never committed: SCM_MOD_FOLDERS="<folder>=<hash>[,<hash>…];<folder>=…" — each folder read as the folder
// picker hands it over, its first hash the one it goes by now, the rest forms an earlier rule gave it.
const MOD_FOLDERS = (process.env.SCM_MOD_FOLDERS ?? "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
  const at = s.lastIndexOf("=");
  return { dir: s.slice(0, at), hashes: s.slice(at + 1).split(",").map((h) => h.trim()) };
});
if (MOD_FOLDERS.length) describe("mods at hand, as the folder picker hands them over", () => {
  const pickFolder = async (dir: string): Promise<PickedFile[]> => {
    const out: PickedFile[] = [];
    const walk = async (d: string, rel: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name), `${rel}/${e.name}`);
        else if (e.isFile()) out.push({ path: `${rel}/${e.name}`, file: await openAsBlob(join(d, e.name)) });
      }
    };
    await walk(dir, basename(dir));
    return out;
  };
  for (const { dir, hashes } of MOD_FOLDERS) {
    it(`${basename(dir)} goes by ${hashes[0]} and is found by every hash it went by`, async () => {
      if (!existsSync(dir)) return;
      const folder = await modFolder(await pickFolder(dir), none);
      expect(folder.hashes.hash).toBe(hashes[0]);
      for (const hash of hashes) expect(isReplaysMod(named(hash), folder.hashes), hash).toBe(true);
    }, 900_000);
  }
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

describe("a question whose default is either answer (the replay that names no mod)", () => {
  /** A dialog that is answered: `press` a button by its label, or null for Escape (the cleanup alone). */
  const answered = (press: string | null) => {
    let spec: DialogSpec | null = null;
    const ui = {
      dialog: (s: DialogSpec) => { spec = s; return {} as never; },
      el: () => ({}) as never,
    };
    const body = { append() {} } as unknown as HTMLElement;
    return {
      ui,
      answer: async (promise: Promise<boolean>) => {
        const s = spec as unknown as DialogSpec;
        const cleanup = s.mount(body, {} as never) as () => void;
        const button = press === null ? null : s.buttons!.find((b) => b.label === press)!;
        await button?.run?.({} as never);
        cleanup();
        return { yes: await promise, primary: s.buttons!.filter((b) => b.primary).map((b) => b.label) };
      },
    };
  };
  const o = (prefer: "yes" | "no") => ({ title: "A replay that names no mod", yes: "Watch With Mod", no: "Watch Without", prefer });

  it("makes Watch Without the default where asked, and answers by the button pressed", async () => {
    let d = answered("Watch Without");
    expect(await d.answer(ask(d.ui, "?", o("no")))).toEqual({ yes: false, primary: ["Watch Without"] });
    d = answered("Watch With Mod");
    expect(await d.answer(ask(d.ui, "?", o("no")))).toEqual({ yes: true, primary: ["Watch Without"] });
  });

  it("answers no to Escape whichever is the default", async () => {
    let d = answered(null);
    expect(await d.answer(ask(d.ui, "?", o("no")))).toEqual({ yes: false, primary: ["Watch Without"] });
    d = answered(null);
    expect(await d.answer(ask(d.ui, "?", o("yes")))).toEqual({ yes: false, primary: ["Watch With Mod"] });
  });
});
