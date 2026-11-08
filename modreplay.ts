/**
 * A replay of a mod. A replay records commands, not the files the game read, so scm-sim and scmJS's tools add an
 * `SCMJ` section naming the mod (`@scm-js/replay`'s `Replay.mod`): its data set's hash, name and link, and the
 * plugins that ran. Played back with the game's own files the same commands make another game, and a mod's unit 7 is
 * not an SCV: the plugin shows the mod, takes names only from the mod's own data set, and lets the person attach the
 * mod's folder, known for the mod by the same hash.
 *
 * Here, pure: which files of a picked folder are the mod's (the game's paths at the folder's root or one folder down,
 * as `scmjs mod` reads a folder), and the data set's hash by the shared rule — SHA-256 over the sorted
 * `name<TAB>sha256` lines of the files, the game's names in lower case with backslashes; its first sixteen hex
 * digits — over the files that differ from the data set underneath, and over all of them.
 */
import type { ModTag } from "@scm-js/replay";

/** A file of a picked folder, as `api.ui.pickFiles({ directory: true })` gives them: the path from the folder's parent. */
export interface PickedFile {
  path: string;
  file: Blob;
}

/** The game's folders, by which the root of a mod's files is found (core's `GAME_FOLDERS`). */
const GAME_FOLDERS = ["arr", "rez", "scripts", "unit", "tileset", "sound", "game", "font", "dlgs", "glue", "triggers", "portrait", "music", "cursor", "local", "parallax", "smk", "maps", "anim", "hd2", "sd", "templates", "staredit", "campaign", "datreq", "samase", "lua", "config"];

/** A path as the game names it: backslashes, lower case (`arr\units.dat`). */
export const gameName = (path: string): string => path.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();

/** The folder the game's paths start in: the one holding `arr/`, else the one holding most files under the game's folders, at the root or a folder down. */
export function modRoot(paths: readonly string[]): string {
  const score = new Map<string, number>(), hasArr = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
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
  /** The mod's files by the game's name. */
  files: Map<string, PickedFile>;
  /** Archives and programs in the folder, which are not read here (an `.mpq`, a mod's `.exe`, a `.zip`). */
  unread: string[];
}

/**
 * A picked folder's files that are the mod's: under its root, not beside the game's folders (a read-me), not a dot
 * file, and not a plugin, a FireGraft file, an archive or a program — the files `scmjs mod` counts in a folder. The folder's own name, first in every path, is not part of it.
 */
export function modFolder(picked: readonly PickedFile[]): ModFolder {
  // (A dot file or folder is a tool's own — git's, an editor's — never the game's.)
  const inside = picked.map((f) => ({ ...f, path: f.path.split("/").slice(1).join("/") })).filter((f) => f.path && !f.path.split("/").some((part) => part.startsWith(".")));
  const unread: string[] = [];
  const loose = inside.filter((f) => {
    const leaf = f.path.split("/").pop()!.toLowerCase();
    if (/\.(qdp|bwl|fgp|fgd)$/.test(leaf) || leaf === "mod.json") return false;
    if (/\.(mpq|exe|zip)$/.test(leaf)) { unread.push(f.path); return false; }
    return true;
  });
  const root = modRoot(loose.map((f) => f.path));
  const files = new Map<string, PickedFile>();
  for (const f of loose) {
    if (root && !f.path.startsWith(root + "/")) continue;
    const rel = root ? f.path.slice(root.length + 1) : f.path;
    if (!rel.includes("/")) continue;
    files.set(gameName(rel), { path: rel, file: f.file });
  }
  return { files, unread };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/** The data-set hash of files given as their game names and SHA-256s. */
export async function dataSetHash(files: readonly { name: string; sha256: string }[]): Promise<string> {
  const lines = files.map((f) => ({ name: gameName(f.name), sha256: f.sha256 })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => `${f.name}\t${f.sha256}`);
  return (await sha256(new TextEncoder().encode(lines.join("\n")))).slice(0, 16);
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The folder's hash over the files that differ from the data set underneath (`under`, by game name; null when it has
 * none of that name), and over all of its files. A file at a time, the bytes let go after each.
 */
export async function folderHashes(folder: ModFolder, under: (member: string) => Promise<Uint8Array | null>, progress?: (done: number, of: number) => void): Promise<{ changed: string; all: string }> {
  const changed: { name: string; sha256: string }[] = [], all: { name: string; sha256: string }[] = [];
  let done = 0;
  for (const [member, f] of folder.files) {
    const bytes = new Uint8Array(await f.file.arrayBuffer());
    const digest = { name: member, sha256: await sha256(bytes) };
    all.push(digest);
    const theirs = await under(member);
    if (!theirs || !same(theirs, bytes)) changed.push(digest);
    progress?.(++done, folder.files.size);
  }
  return { changed: await dataSetHash(changed), all: await dataSetHash(all) };
}

/** Whether a folder's hashes are the replay's data set: either counts, as the play page and the command line may hash with or without a copy of the game beneath. */
export const isReplaysMod = (tag: ModTag, hashes: { changed: string; all: string }) => tag.dataSet.hash === hashes.changed || tag.dataSet.hash === hashes.all;

/** The plugins and FireGraft patch a tag names, for a line: "gptp.qdp, aise.qdp"; "" for none. */
export const pluginNames = (tag: ModTag): string => (tag.noplugins ? "" : [...tag.plugins.map((p) => p.name), ...(tag.firegraft ? [tag.firegraft.name] : [])].join(", "));

/** A link that is safe to put in an `href`: http or https, else null. */
export function safeLink(url: string | null): string | null {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
}
