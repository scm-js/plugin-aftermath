import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appendModTag, parseReplay, type ModTag } from "@scm-js/replay";
import { chk, cmds, le16, writeReplay } from "@scm-js/replay/write";
import { dataSetHash, folderHashes, gameName, isReplaysMod, modFolder, modRoot, pluginNames, safeLink, sha256 } from "../modreplay";

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
      { path: "release/plugins/gptp.qdp", file: blob("plugin") },
      { path: "release/Test Mod.fgp", file: blob("fg") },
      { path: "release/mpq/lua/.gitignore", file: blob("x") },
      { path: "release/mpq/.git/config", file: blob("x") },
    ]);
    expect([...folder.files.keys()]).toEqual(["arr\\units.dat", "rez\\stat_txt.tbl"]);
    expect(folder.unread).toEqual(["Test Mod.exe"]);
  });

  it("takes a folder whose root is the game's paths", () => {
    expect([...modFolder([{ path: "mymod/arr/units.dat", file: blob("u") }, { path: "mymod/unit/terran/marine.grp", file: blob("g") }]).files.keys()]).toEqual(["arr\\units.dat", "unit\\terran\\marine.grp"]);
    expect(modRoot(["mpq/arr/units.dat", "mpq/unit/terran/unit/x.grp"])).toBe("mpq");
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

  it("is worked out over the files that differ from the data set underneath, and over all of them", async () => {
    const folder = modFolder([{ path: "m/arr/units.dat", file: blob("mine") }, { path: "m/arr/weapons.dat", file: blob("same") }]);
    const under = async (member: string) => (member === "arr\\weapons.dat" ? new TextEncoder().encode("same") : null);
    const seen: number[] = [];
    const h = await folderHashes(folder, under, (done) => seen.push(done));
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(h.changed).toBe(await dataSetHash([{ name: "arr\\units.dat", sha256: digest("mine") }]));
    expect(h.all).toBe(await dataSetHash([{ name: "arr\\units.dat", sha256: digest("mine") }, { name: "arr\\weapons.dat", sha256: digest("same") }]));
    expect(seen).toEqual([1, 2]);
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
