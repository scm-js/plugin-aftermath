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
 */
import type { ModTag } from "@scm-js/replay";
import type { ReplayDataSet } from "./vendor/scm-sim";

/** A file of a picked folder, as `api.ui.pickFiles({ directory: true })` gives them: the path from the folder's parent. */
export interface PickedFile {
  path: string;
  file: Blob;
}

/** The game's folders, by which the root of a mod's files is found (core's `GAME_FOLDERS`). */
const GAME_FOLDERS = ["arr", "rez", "scripts", "unit", "tileset", "sound", "game", "font", "dlgs", "glue", "triggers", "portrait", "music", "cursor", "local", "parallax", "smk", "maps", "anim", "hd2", "sd", "templates", "staredit", "campaign", "datreq", "samase", "lua", "config"];

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
}

/**
 * A picked folder's files that are the mod's, as the play page reads a folder: under its root, not beside the game's
 * folders (a read-me), not under a `plugins` or `firegraft` folder there, and not a plugin, a FireGraft file, an
 * archive, a program or a library. A dot file counts; a dot folder (git's, an editor's) does not. The plugins and the
 * FireGraft project are kept beside, wherever they are. The folder's own name, first in every path, is not part of it.
 */
export function modFolder(picked: readonly PickedFile[]): ModFolder {
  const inside = picked.map((f) => ({ ...f, path: f.path.split("/").slice(1).join("/") })).filter((f) => f.path && !f.path.split("/").slice(0, -1).some((part) => part.startsWith(".")));
  const unread: string[] = [];
  const plugins = new Map<string, PickedFile>(), firegraft = new Map<string, PickedFile>();
  const loose = inside.filter((f) => {
    const leaf = f.path.split("/").pop()!, lower = leaf.toLowerCase();
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
  return { files, plugins, firegraft, unread };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/** The hash of lines `name<TAB>sha256` in any order: sorted by name, joined with "\n", SHA-256, sixteen hex digits. */
export async function hashLines(lines: readonly string[]): Promise<string> {
  const name = (l: string) => l.slice(0, l.indexOf("\t"));
  const sorted = [...lines].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
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
  return { hash: await hashLines([...game, ...code, ...plugins]), withoutPlugins: await hashLines([...game, ...code]), all: await hashLines(game), changed: await hashLines(changed) };
}

/** Whether a folder is the replay's mod: by its hash, without its plugins, or by an older form. */
export const isReplaysMod = (tag: ModTag, hashes: FolderHashes) => [hashes.hash, hashes.withoutPlugins, hashes.all, hashes.changed].includes(tag.dataSet.hash);

/** The plugins and FireGraft patch a tag names, for a line: "gptp.qdp, aise.qdp"; "" for none. */
export const pluginNames = (tag: ModTag): string => (tag.noplugins ? "" : [...tag.plugins.map((p) => p.name), ...(tag.firegraft ? [tag.firegraft.name] : [])].join(", "));

/** A link that is safe to put in an `href`: http or https, else null. */
export function safeLink(url: string | null): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
}

/**
 * The mod a replay was played with, as Play From Here hands it to the play page beside the replay (scm-sim 0.16.0's
 * `ReplayDataSet`): the tag's hash, the mod's name and its makers' page (a safe link only). Never its files: a mod is
 * hundreds of megabytes, and the page plays the replay with the copy it keeps under that hash, or asks for the mod's
 * folder with the link. Undefined for a replay of the game itself, which hands nothing more than before.
 */
export function replayDataSet(tag: ModTag | null): ReplayDataSet | undefined {
  if (!tag) return undefined;
  const url = safeLink(tag.dataSet.url);
  return { hash: tag.dataSet.hash, ...(tag.dataSet.name ? { name: tag.dataSet.name } : {}), ...(url ? { url } : {}) };
}

/** The replay as `playReplay` takes it: the whole file, its name, and the mod it was played with when the tag says one. */
export function handedReplay(bytes: Uint8Array, name: string, tag: ModTag | null): { bytes: Uint8Array; name: string; dataSet?: ReplayDataSet } {
  const dataSet = replayDataSet(tag);
  return { bytes, name, ...(dataSet ? { dataSet } : {}) };
}

/**
 * Whether the mod's plugins ran in the game the replay records: the play page then plays it only with them running,
 * which it does when opened with `?lift=live` (scm-sim's replay door refuses it otherwise, naming the address).
 */
export const pluginsRan = (tag: ModTag): boolean => !tag.noplugins && tag.plugins.length > 0;
