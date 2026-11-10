/**
 * A replay of a mod. A replay records commands, not the files the game read, so scm-sim and scmJS's tools add an
 * `SCMJ` section naming the mod (`@scm-js/replay`'s `Replay.mod`): its data set's hash, name and link, and the
 * plugins that ran. Played back with the game's own files the same commands make another game, and a mod's unit 7 is
 * not an SCV: the plugin shows the mod, takes names only from the mod's own data set, and lets the person attach the
 * mod's folder, known for the mod by the same hash.
 *
 * Here, pure: which files of a picked folder are the mod's (the game's paths at the folder's root or in a folder under
 * it, as the play page and `scmjs mod` read a folder), and the mod's hash by the rule the play page, `scmjs` and the
 * editor share — SHA-256 over the sorted lines `name<TAB>sha256 of the bytes`, one for every game file the mod lays over
 * the game (its game name, lower case with backslashes), one for each plugin it carries (`plugins\<file>.qdp`, lower
 * case) and one for its FireGraft project (`<file>.fgp`, lower case); the first sixteen hex digits — and the same
 * without the plugins' lines. The folder's loose files only: an archive in it (an `.mpq`, a mod's `.exe`) is not read,
 * so a mod that keeps files in one hashes otherwise here than on the play page.
 *
 * An operating system's files (`SYSTEM_FILES`: `desktop.ini`, `Thumbs.db`, `.DS_Store`, …) are not the mod's and have
 * no line, so a folder is named alike however it was picked: the browser's folder picker does not hand `desktop.ini`
 * over, the older folder input does. Until 2026-11-09 they had lines; a replay tagged then names the mod by a hash
 * with them, which is matched as an older form when the picked folder shows the files (`FolderHashes.older`).
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { ModTag } from "@scm-js/replay";
import type { AnalysedMod, ReplayDataSet } from "./vendor/scm-sim";

/** A file of a picked folder, as `api.ui.pickFiles({ directory: true })` gives them: the path from the folder's parent. */
export interface PickedFile {
  path: string;
  file: Blob;
}

/** The game's folders, by which the root of a mod's files is found (core's `GAME_FOLDERS`). */
const GAME_FOLDERS = ["arr", "rez", "scripts", "unit", "tileset", "sound", "game", "font", "dlgs", "glue", "triggers", "portrait", "music", "cursor", "local", "parallax", "smk", "maps", "anim", "hd2", "sd", "templates", "staredit", "campaign", "datreq", "samase", "lua", "config"];

/**
 * Files an operating system or its file manager leaves in folders, never the game's and so never a mod's (scm-js
 * core's `SYSTEM_FILES` and scm-sim's, the same list): told by name alone, any case. `desktop.ini` (Windows Explorer's
 * settings for a folder), `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db` (its caches of thumbnails), `.DS_Store` and
 * `Icon\r` (the macOS Finder's), `._<name>` (the AppleDouble half of a file) and everything under `__MACOSX/` (the
 * folder macOS's zips keep those in), `.directory` (KDE's). A browser's folder handle never hands over `desktop.ini`
 * or `Thumbs.db` (Chromium refuses the names); a folder input and a drop read through its entries do.
 */
export const SYSTEM_FILES = {
  names: ["desktop.ini", "thumbs.db", "ehthumbs.db", "ehthumbs_vista.db", ".ds_store", "icon\r", ".directory"],
  prefixes: ["._"],
  folders: ["__macosx"],
} as const;

/** Whether a path (either slash, any case) is one of `SYSTEM_FILES`: by its file name, or by a folder it is under. */
export function isSystemFile(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]/).filter(Boolean);
  const leaf = parts.pop() ?? "";
  return (SYSTEM_FILES.names as readonly string[]).includes(leaf)
    || SYSTEM_FILES.prefixes.some((p) => leaf.startsWith(p))
    || parts.some((folder) => (SYSTEM_FILES.folders as readonly string[]).includes(folder));
}

/** A path as the game names it: backslashes, lower case (`arr\units.dat`). */
export const gameName = (path: string): string => path.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();

/** The folder the game's paths start in: the one holding `arr/`, else the one holding most files under the game's folders (the shallower on a tie), at any depth. */
export function modRoot(paths: readonly string[]): string {
  const score = new Map<string, number>(), hasArr = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const folder = parts[i].toLowerCase();
      if (!GAME_FOLDERS.includes(folder) || folder === "maps") continue;
      const root = parts.slice(0, i).join("/");
      score.set(root, (score.get(root) ?? 0) + 1);
      if (folder === "arr") hasArr.add(root);
    }
  }
  const best = (list: string[]) => list.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.split("/").length - b.split("/").length)[0];
  return best([...hasArr]) ?? best([...score.keys()]) ?? "";
}

export interface ModFolder {
  /** The mod's game files by the game's name. */
  files: Map<string, PickedFile>;
  /** The plugins it carries (`.qdp`, `.bwl`, anywhere in the folder), by file name; the first of a name. */
  plugins: Map<string, PickedFile>;
  /** Its FireGraft projects (`.fgp`), by file name; the first of a name. FireGraft's `.fgd` database is not hashed. */
  firegraft: Map<string, PickedFile>;
  /** Archives and programs in the folder, which are not read here (an `.mpq`, a mod's `.exe`, a `.zip`). */
  unread: string[];
  /**
   * An operating system's files where a game file would be (`isSystemFile`), by the game's name: not the mod's, and
   * read only for the hashes the mod had while such files had lines (`FolderHashes.older`).
   */
  system: Map<string, PickedFile>;
}

/**
 * A picked folder's files that are the mod's, as the play page reads a folder: under its root, not beside the game's
 * folders (a read-me), not under a `plugins` or `firegraft` folder there, and not a plugin, a FireGraft file, an
 * archive, a program or a library. A dot file counts; a dot folder (git's, an editor's) does not. The plugins and the
 * FireGraft project are kept beside, wherever they are. The folder's own name, first in every path, is not part of it.
 * An operating system's file (`isSystemFile`) is none of these, whatever its name ends in.
 */
export function modFolder(picked: readonly PickedFile[]): ModFolder {
  const inside = picked.map((f) => ({ ...f, path: f.path.split("/").slice(1).join("/") })).filter((f) => f.path && !f.path.split("/").slice(0, -1).some((part) => part.startsWith(".")));
  const unread: string[] = [];
  const plugins = new Map<string, PickedFile>(), firegraft = new Map<string, PickedFile>();
  const systemLoose: PickedFile[] = [];
  const loose = inside.filter((f) => {
    const leaf = f.path.split("/").pop()!, lower = leaf.toLowerCase();
    if (isSystemFile(f.path)) { systemLoose.push(f); return false; }
    if (/\.(qdp|bwl)$/.test(lower)) { if (!plugins.has(lower)) plugins.set(lower, f); return false; }
    if (/\.fgp$/.test(lower)) { if (!firegraft.has(lower)) firegraft.set(lower, f); return false; }
    if (/\.(fgd|dll)$/.test(lower)) return false;
    if (/\.(mpq|exe|zip)$/.test(lower)) { unread.push(f.path); return false; }
    return true;
  });
  const root = modRoot(loose.map((f) => f.path));
  const files = new Map<string, PickedFile>();
  for (const f of loose) {
    if (root && !f.path.startsWith(root + "/")) continue;
    const rel = root ? f.path.slice(root.length + 1) : f.path;
    const top = rel.split("/")[0].toLowerCase();
    if (!rel.includes("/") || top === "plugins" || top === "firegraft") continue;
    files.set(gameName(rel), { path: rel, file: f.file });
  }
  const system = new Map<string, PickedFile>();
  for (const f of systemLoose) {
    // (macOS's half of a plugin or of a project was taken for a plugin or a project then: that hash is not worked out again)
    if (/\.(qdp|bwl|fgp|fgd|dll|mpq|exe|zip)$/i.test(f.path) || (root && !f.path.startsWith(root + "/"))) continue;
    const rel = root ? f.path.slice(root.length + 1) : f.path;
    const top = rel.split("/")[0].toLowerCase();
    if (!rel.includes("/") || top === "plugins" || top === "firegraft") continue;
    system.set(gameName(rel), { path: rel, file: f.file });
  }
  return { files, plugins, firegraft, unread, system };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

const lineName = (l: string) => l.slice(0, l.indexOf("\t"));

/**
 * The hash of lines `name<TAB>sha256` in any order: sorted by name, joined with "\n", SHA-256, sixteen hex digits. A
 * line of an operating system's file (`isSystemFile`) is dropped first, so the hash is the same whatever list it is given.
 */
export async function hashLines(lines: readonly string[]): Promise<string> {
  return hashLinesAsWere(lines.filter((l) => !isSystemFile(lineName(l))));
}

/** `hashLines` as it was until 2026-11-09: every line given. For matching a hash made then, never for naming a mod now. */
export async function hashLinesAsWere(lines: readonly string[]): Promise<string> {
  const sorted = [...lines].sort((a, b) => (lineName(a) < lineName(b) ? -1 : lineName(a) > lineName(b) ? 1 : 0));
  return (await sha256(new TextEncoder().encode(sorted.join("\n")))).slice(0, 16);
}

/** A plugin's line (`plugins\<file name>`, lower case) and the FireGraft project's (`<file name>`, lower case). */
export const pluginLine = (name: string, sha: string): string => `plugins\\${name.split(/[\\/]/).pop()!.toLowerCase()}\t${sha}`;
export const firegraftLine = (name: string, sha: string): string => `${name.split(/[\\/]/).pop()!.toLowerCase()}\t${sha}`;

/** The hash of game files alone, given as their game names and SHA-256s (what a replay tagged before the plugins had lines names). */
export async function dataSetHash(files: readonly { name: string; sha256: string }[]): Promise<string> {
  return hashLines(files.map((f) => `${gameName(f.name)}\t${f.sha256}`));
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The hashes a replay may name the mod by. */
export interface FolderHashes {
  /** The mod's hash: its game files, its plugins and its FireGraft project. */
  hash: string;
  /** The same without the plugins' lines: what a page that ran none of them names. */
  withoutPlugins: string;
  /** Older forms, for replays tagged before the plugins and the project had lines: the game files alone, and those that differ from the data set underneath. */
  all: string;
  changed: string;
  /**
   * Each of those four as it was while an operating system's files had lines (until 2026-11-09): there only when the
   * picked folder shows such files where a game file would be. A folder read through the browser's folder picker
   * never shows `desktop.ini` or `Thumbs.db`, so it has none for those.
   */
  older: string[];
}

/**
 * The folder's hashes (`under` reads the data set underneath by game name, null when it has none of that name, for
 * the older "changed" form). A file at a time, the bytes let go after each.
 */
export async function folderHashes(folder: ModFolder, under: (member: string) => Promise<Uint8Array | null>, progress?: (done: number, of: number) => void): Promise<FolderHashes> {
  const changed: string[] = [], game: string[] = [], code: string[] = [], plugins: string[] = [];
  let done = 0;
  const of = folder.files.size + folder.plugins.size + folder.firegraft.size;
  for (const [member, f] of folder.files) {
    const bytes = new Uint8Array(await f.file.arrayBuffer());
    const line = `${member}\t${await sha256(bytes)}`;
    game.push(line);
    const theirs = await under(member);
    if (!theirs || !same(theirs, bytes)) changed.push(line);
    progress?.(++done, of);
  }
  for (const [name, f] of folder.firegraft) { code.push(firegraftLine(name, await sha256(new Uint8Array(await f.file.arrayBuffer())))); progress?.(++done, of); }
  for (const [name, f] of folder.plugins) { plugins.push(pluginLine(name, await sha256(new Uint8Array(await f.file.arrayBuffer())))); progress?.(++done, of); }
  // The same four as they were while an operating system's files had lines (such a file is in no game, so it differed).
  const system: string[] = [];
  for (const [member, f] of folder.system ?? []) system.push(`${member}\t${await sha256(new Uint8Array(await f.file.arrayBuffer()))}`);
  const older = system.length
    ? [await hashLinesAsWere([...game, ...system, ...code, ...plugins]), await hashLinesAsWere([...game, ...system, ...code]), await hashLinesAsWere([...game, ...system]), await hashLinesAsWere([...changed, ...system])]
    : [];
  return { hash: await hashLines([...game, ...code, ...plugins]), withoutPlugins: await hashLines([...game, ...code]), all: await hashLines(game), changed: await hashLines(changed), older: [...new Set(older)] };
}

/** Whether a folder is the replay's mod: by its hash, without its plugins, or by an older form. */
export const isReplaysMod = (tag: ModTag, hashes: FolderHashes) => [hashes.hash, hashes.withoutPlugins, hashes.all, hashes.changed, ...(hashes.older ?? [])].includes(tag.dataSet.hash);

/** The plugins and FireGraft patch a tag names, for a line: "gptp.qdp, aise.qdp"; "" for none. */
export const pluginNames = (tag: ModTag): string => (tag.noplugins ? "" : [...tag.plugins.map((p) => p.name), ...(tag.firegraft ? [tag.firegraft.name] : [])].join(", "));

/** A link that is safe to put in an `href`: http or https, else null. */
export function safeLink(url: string | null): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
}

/**
 * Whether the mod's code ran in the game the replay records, which the play page runs only with its live lifter
 * (`?lift=live`): its plugins ran, or its FireGraft project's exe edits were written — the tag names the project and an
 * engine that was a lifter, not the shipped module. scm-sim's replay door goes by the same rule (`replayLift` in its
 * `src/replay/door.ts`): a project whose engine the tag does not name is left to the page as it is.
 */
export const liveLifter = (tag: ModTag): boolean => tag.plugins.length > 0 || (tag.firegraft !== null && tag.engine !== null && tag.engine.lifter !== "shipped");

/**
 * The mod a replay was played with, as Play From Here and the Replay view hand it to scm-sim (its `ReplayDataSet`):
 * the tag's hash, the mod's name, its makers' page (a safe link only), and `live` when the mod's code ran
 * (`liveLifter`, 0.17.0: the page is opened with `?lift=live`). Never its files: a mod is hundreds of megabytes, and the
 * page plays the replay with the copy it keeps under that hash, or asks for the mod's folder with the link. Undefined
 * for a replay of the game itself, which hands nothing more than before.
 */
export function replayDataSet(tag: ModTag | null): ReplayDataSet | undefined {
  if (!tag) return undefined;
  const url = safeLink(tag.dataSet.url);
  return { hash: tag.dataSet.hash, ...(tag.dataSet.name ? { name: tag.dataSet.name } : {}), ...(url ? { url } : {}), ...(liveLifter(tag) ? { live: true } : {}) };
}

/** The mod the editor has open (`api.gameData.source()`), as an untagged replay may be watched with it. */
export interface OpenMod { hash: string; name: string; url: string | null }

/**
 * The mod the editor draws with, when it is one: a data set with a mod's hash (sixteen hex digits) that is not the
 * game's own (`starcraft`). Null for the game itself, a set with no hash yet (a large mod's is worked out after it
 * opens), or no data at all.
 */
export function openModOf(source: { hash?: string; profile: { id: string; name: string; url?: string } } | null | undefined): OpenMod | null {
  if (!source || source.profile.id === "starcraft" || !source.hash || !/^[0-9a-f]{16}$/.test(source.hash)) return null;
  return { hash: source.hash, name: source.profile.name, url: safeLink(source.profile.url ?? null) };
}

/**
 * A replay that names no mod, watched with the mod open in the editor because the person said so: the tag it would
 * have carried had the game written one. Its plugins are not known (the replay does not say, and the editor's data set
 * does not either), so the tag names none.
 */
export function assumedTag(mod: OpenMod): ModTag {
  return { v: 1, dataSet: { hash: mod.hash, name: mod.name, url: mod.url }, plugins: [], firegraft: null, noplugins: false, engine: null, madeBy: "Aftermath" };
}

/**
 * That mod as scm-sim is handed it. `live` always: whether the mod's code ran is not known, and a replay played with a
 * mod's own release ran its plugins. The live lifter plays a mod without code the same, only slower to start.
 */
export function assumedDataSet(mod: OpenMod): ReplayDataSet {
  return { hash: mod.hash, ...(mod.name ? { name: mod.name } : {}), ...(mod.url ? { url: mod.url } : {}), live: true };
}

/**
 * The replay as `playReplay` takes it: the whole file, its name, and the mod it is played with when it has one — the
 * tag's (`replayDataSet`), or the mod open in the editor for a replay that names none (`assumedDataSet`).
 */
export function handedReplay(bytes: Uint8Array, name: string, dataSet: ReplayDataSet | undefined): { bytes: Uint8Array; name: string; dataSet?: ReplayDataSet } {
  return { bytes, name, ...(dataSet ? { dataSet } : {}) };
}

/**
 * Whether the engine's page plays a replay of a mod with its mod (scm-sim's R4, plugin-scm-sim 0.18.0: its `features`
 * has "modAnalysis", and `analyse` and `fights` are given the replay's `dataSet`). An older page plays every replay with
 * the game's own files, which for a mod's replay is another game: it is not asked.
 */
export const playsModReplays = (features: readonly string[] | null | undefined): boolean => !!features?.includes("modAnalysis");

/** What the analysis did with a replay of a mod, for the mod panel's sentence. */
export type ModAnalysis =
  /** Played it with the mod: the timeline's `mod`. */
  | { kind: "played"; mod: AnalysedMod }
  /** No engine, or one from before R4: it plays replays with the game's own files, so it does not play this one. */
  | { kind: "older" }
  /** The engine's sentence: the mod not kept in this browser (its hash and the makers' link), another version of it. */
  | { kind: "failed"; reason: string }
  /** Not yet: it will be played with the mod this browser keeps. */
  | { kind: "waiting" };

/** `played`: the timeline's mod; `engine`: an engine is beside the editor; `features`: what its page said (null: not asked yet). */
export function modAnalysis(o: { played: AnalysedMod | null | undefined; engine: boolean; features: readonly string[] | null; failed: string | null }): ModAnalysis {
  if (o.played) return { kind: "played", mod: o.played };
  if (!o.engine || (o.features !== null && !playsModReplays(o.features))) return { kind: "older" };
  if (o.failed) return { kind: "failed", reason: o.failed };
  return { kind: "waiting" };
}

/* ── An untagged replay that was played with a mod: the signs, from the replay itself ── */

/**
 * Tile groups in StarCraft: Remastered's `tileset\<name>.cv5`, by tileset number in the map's ERA order (measured;
 * scm-sim's `REMASTERED_TERRAIN_GROUPS`, scm-js `src/data/remasteredTiles.ts`). Remastered's tables are the longest the
 * game has: a map on a group past its tileset's was made with a mod's longer table.
 */
export const REMASTERED_TERRAIN_GROUPS = [1979, 2046, 1265, 1418, 2046, 2046, 2039, 2047] as const;
/** The race bytes the game writes for a player (0 Zerg, 1 Terran, 2 Protoss, 3 to 5 the game's others, 6 Random, 7 none). */
const GAME_RACES = 8;

/**
 * A sign, read from the replay itself, that its game was played with a mod. Each is certain: StarCraft cannot make it.
 * - `terrain`: the map uses tile group `group` of `tileset`, past the last Remastered has (`last`).
 * - `race`: a player's race byte is none of the game's.
 */
export type ModSign =
  | { kind: "terrain"; tileset: number; group: number; last: number }
  | { kind: "race"; player: string; race: number };

/**
 * The signs that a replay was played with a mod (none: nothing says so, which does not say it was not). `players`: the
 * replay's players (those who took part); `map`: the replay's map, its tileset and tiles (the raw 12-bit group is
 * `tile >> 4`). Nothing is guessed from names.
 */
export function modSigns(players: readonly { name: string; race: number }[], map: { tileset: number; tiles: Uint16Array }): ModSign[] {
  const signs: ModSign[] = [];
  let highest = -1;
  for (let i = 0; i < map.tiles.length; i++) { const g = map.tiles[i] >> 4; if (g > highest) highest = g; }
  const ts = map.tileset & 7, last = REMASTERED_TERRAIN_GROUPS[ts] - 1;
  if (highest > last) signs.push({ kind: "terrain", tileset: ts, group: highest, last });
  for (const p of players) if (!(p.race >= 0 && p.race < GAME_RACES)) signs.push({ kind: "race", player: p.name, race: p.race });
  return signs;
}

/**
 * Whether the editor draws with a mod whose hash is not worked out yet (a large mod's comes after it opens): a data set
 * in memory (`kind: "reader"`, what a mod open in the editor is) that is not the game's own, with no hash of sixteen hex
 * digits. Its hash is to be waited for, not the question skipped. An installed data set (`stored`, as StarCraft:
 * Remastered is, or `bundled`) is given no hash later, so there is nothing to wait for: waiting would never end.
 */
export function modHashPending(source: { kind?: string; hash?: string; profile: { id: string } } | null | undefined): boolean {
  return !!source && source.kind === "reader" && source.profile.id !== "starcraft" && !(source.hash && /^[0-9a-f]{16}$/.test(source.hash));
}

/**
 * A picked folder's files as scm-sim's page takes a mod's (`ModSourceFile`): every file under the folder by its path from
 * the folder's parent, as a dropped folder gives them (the page reads the folder's layout as it reads a drop: its game
 * files, its archives and its program, its plugins and FireGraft project), dot folders left out.
 */
export function pickedModFiles(picked: readonly PickedFile[]): { path: string; file: File }[] {
  return picked
    .filter((f) => f.path && !f.path.split("/").slice(0, -1).some((part) => part.startsWith(".")))
    .map((f) => ({ path: f.path, file: f.file instanceof File ? f.file : new File([f.file], f.path.split("/").pop() || "file") }));
}

/** The engine's reasons a replay could not be played with what it had (plugin-scm-sim 0.19.0's `ScmSimError.reason`). */
export type EngineReason = "mod-missing" | "mod-terrain" | "remastered-terrain";

/** The reason an error from the engine carries, if any. */
export function engineReason(err: unknown): EngineReason | null {
  const r = (err as { reason?: unknown } | null)?.reason;
  return r === "mod-missing" || r === "mod-terrain" || r === "remastered-terrain" ? r : null;
}

/** An error's sentence as the person reads it: the engine's own, without the "Error: " a worker puts before it. */
export const engineSentence = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err);
  const plain = text.replace(/^(Error: )+/, "");
  return plain ? plain[0].toUpperCase() + plain.slice(1) : plain;
};

/**
 * A yes-or-no question whose default (the highlighted button) is either answer: `api.ui.confirm` always makes it yes.
 * Escape, the × and the backdrop answer no whichever is the default. The buttons stand no then yes, left to right, as
 * the editor's own confirm has them.
 */
export function ask(ui: Pick<PluginApi["ui"], "dialog" | "el">, text: string, o: { title: string; yes: string; no: string; prefer: "yes" | "no" }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false, settle = () => resolve(answer);
    ui.dialog({
      title: o.title,
      size: "sm",
      mount: (body) => {
        body.append(ui.el("div", { style: "white-space:pre-wrap;max-width:52ch" }, text));
        // (However the dialog goes, its cleanup runs once: that settles the answer.)
        return () => { settle(); settle = () => {}; };
      },
      buttons: [
        { label: o.no, primary: o.prefer === "no" },
        { label: o.yes, primary: o.prefer === "yes", run: () => { answer = true; } },
      ],
    });
  });
}
