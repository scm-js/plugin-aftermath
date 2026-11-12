/**
 * A replay of a mod. A replay records commands, not the files the game read, so scm-sim and scmJS's tools add an
 * `SCMJ` section naming the mod (`@scm-js/replay`'s `Replay.mod`): its data set's hash, name and link, and the
 * plugins that ran. Played back with the game's own files the same commands make another game, and a mod's unit 7 is
 * not an SCV: the plugin shows the mod, takes names only from the mod's own data set, and lets the person attach the
 * mod's folder, known for the mod by the same hash.
 *
 * Which files of a picked folder are the mod's, and its hash, are `@scm-js/mod`'s (`readMod`), the reader the play
 * page, `scmjs` and the editor share: the folder's loose files, and the archives in it (an `.mpq`, a mod's patcher or
 * self-executing `.exe`, a `.zip`), its plugins and the libraries they load, its FireGraft project. Here, what a replay
 * may name the mod by (`FolderHashes`): the hash and the hash without the code's lines, and the forms earlier rules
 * gave, which a replay tagged then carries — before every module of the code had a line (2026-11-11), while an
 * operating system's files had lines (until 2026-11-09), and before the plugins and the project had lines at all
 * (the game files alone, and those that differ from the data set underneath).
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { ModTag } from "@scm-js/replay";
import type { Archive } from "mopaq";
import {
  fileReaders, hashLines, hashLinesAsWere, inDotFolder, MOD_MESSAGE_GROUPS, MOD_MESSAGES, ModError, ModReadError, readMod, renderMessage, say,
  type ModDescription, type ModFiles, type ModMessage,
} from "@scm-js/mod";
import type { AnalysedMod, ReplayDataSet } from "./vendor/scm-sim";
import { GAME_RACES, raceRows, type DataSetRace } from "./races";

/** A file of a picked folder, as `api.ui.pickFiles({ directory: true })` gives them: the path from the folder's parent. */
export interface PickedFile {
  path: string;
  file: Blob;
}

/**
 * A picked folder as `readMod` takes a mod's files: every file by its path from the folder's parent (the folder's own
 * name first), each read only when the reader asks for it. Dot folders and an operating system's files are listed
 * too: the reader leaves them out itself.
 */
export function pickedTree(picked: readonly PickedFile[]): ModFiles {
  const byPath = new Map(picked.map((f) => [f.path, f.file]));
  const name = picked[0]?.path.split("/")[0] || "mod";
  const listed = [...byPath].map(([path, file]) => ({ path, size: file.size }));
  return {
    name,
    list: async () => listed,
    read: async (path) => {
      const file = byPath.get(path);
      if (!file) throw new ModReadError(say("not-in-tree", { path, name }));
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

/** The hashes a replay may name the mod by. */
export interface FolderHashes {
  /** The mod's hash: its game files, its FireGraft project and every module of its code (`identity.hash`). */
  hash: string;
  /** The same without the code's lines: what a game that ran none of it names. */
  withoutPlugins: string;
  /** Older forms, for replays tagged before the plugins and the project had lines: the game files alone, and those that differ from the data set underneath. */
  all: string;
  changed: string;
  /**
   * The hashes by the other earlier rules, matched as the four above are and never shown: every one the package names
   * (`identity.earlier`, each with its form without the code's lines: before every module of the code had a line,
   * before a FireGraft project found only through FireGraft's own list had one, while an operating system's files had
   * lines, the game files alone then), and the files that differ from the data set underneath with those operating
   * system's files' lines (`identity.older.lines`). Those last are there only when the folder shows such files where a
   * game file would be, or the mod's archive holds them; a folder read through the browser's folder picker never shows
   * `desktop.ini` or `Thumbs.db`.
   */
  older: string[];
}

const lineName = (l: string) => l.slice(0, l.indexOf("\t"));
const isProjectLine = (l: string) => /\.fgp\t/i.test(l);

/**
 * The hashes a replay may name the mod `d` by. `changed`: the game names of its files that differ from the data set
 * underneath (or that it has not got), the one form the package cannot work out, as it needs the person's game.
 */
export async function folderHashes(d: ModDescription, o: { changed?: Iterable<string> } = {}): Promise<FolderHashes> {
  const id = d.identity;
  const game = id.lines.filter((l) => !isProjectLine(l));
  const differ = new Set(o.changed ?? []);
  const changedLines = game.filter((l) => differ.has(lineName(l)));
  const earlier = id.earlier ?? [];
  const system = id.older?.lines ?? [];
  const older = [
    ...earlier.flatMap((e) => [e.hash, ...(e.withoutPlugins ? [e.withoutPlugins] : [])]),
    ...(system.length ? [await hashLinesAsWere([...changedLines, ...system])] : []),
  ];
  const hashes = {
    hash: id.hash, withoutPlugins: id.withoutPlugins,
    all: earlier.find((e) => e.rule === "game-files")?.hash ?? await hashLines(game),
    changed: await hashLines(changedLines),
  };
  const taken = new Set(Object.values(hashes));
  return { ...hashes, older: [...new Set(older)].filter((h) => !taken.has(h)) };
}

/** A picked folder read as a mod: what it is, its hashes, and its game files by the game's name. */
export interface ModFolder {
  tree: ModFiles;
  description: ModDescription;
  hashes: FolderHashes;
  /** A game file of the mod by the game's name (lower case, backslashes), read from its folder or its archive; null when the mod has none. */
  file(member: string): Promise<Uint8Array | null>;
  /** Lets go of the archives the reading opened and `file` reads from; a later `file` opens them again. */
  close(): void;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether a description holds a mod: game files to lay, or code to run. */
export const holdsMod = (d: ModDescription): boolean => d.files.length > 0 || d.identity.code;

/**
 * A picked folder read as a mod by `@scm-js/mod`, with the hashes a replay may name it by. `under` reads the data set
 * underneath by game name (null when it has none of that name), for the older "changed" form; `progress` hears the
 * reader's sentences. A file is read when the reader asks for it; an archive is read whole, as `mopaq` opens one, once:
 * the archives the reading opened are the ones `file` reads from, until `close`.
 */
export async function modFolder(picked: readonly PickedFile[], under: (member: string) => Promise<Uint8Array | null>, progress?: (said: ModMessage) => void): Promise<ModFolder> {
  const tree = pickedTree(picked);
  const changed = new Set<string>();
  const archives = new Map<string, Archive>();
  const description = await readMod(tree, {
    ...(progress ? { progress } : {}),
    archives,
    onFile: async (f, bytes) => {
      const theirs = await under(f.name.replace(/^\\+/, ""));
      if (!theirs || !same(theirs, bytes)) changed.add(f.name);
    },
  });
  const hashes = await folderHashes(description, { changed });
  const reader = fileReaders(tree, description, { archives });
  const byName = new Map(description.files.map((f) => [f.name.replace(/^\\+/, ""), f]));
  return {
    tree, description, hashes,
    file: async (member) => {
      const f = byName.get(member);
      if (!f) return null;
      try { return await reader(f)(); } catch { return null; }
    },
    close: () => reader.close(),
  };
}

/** Whether a folder is the replay's mod: by its hash, without its code, or by a form an earlier rule gave. */
export const isReplaysMod = (tag: ModTag, hashes: FolderHashes) => [hashes.hash, hashes.withoutPlugins, hashes.all, hashes.changed, ...(hashes.older ?? [])].includes(tag.dataSet.hash);

/**
 * `@scm-js/mod`'s sentences that Aftermath shows, by key: what stops a folder being read as a mod and the reasons
 * inside it, and how far the reading is (`MOD_MESSAGE_GROUPS`' error, reason and progress). Each is translated by its
 * English template, as the editor's catalogues hold them.
 */
export const MOD_WORDS = [...new Set([...MOD_MESSAGE_GROUPS.error, ...MOD_MESSAGE_GROUPS.reason, ...MOD_MESSAGE_GROUPS.progress])];
/** Their English templates: the keys of the catalogue. */
export const MOD_WORD_TEXTS: readonly string[] = MOD_WORDS.map((key) => MOD_MESSAGES[key].text);

/**
 * One of the package's sentences in the editor's language (`t`: `api.i18n.t`), a reason inside it too. A parameter the
 * English text does not show (`hidden`: an archive's `reason`, the library's error as a message beside its English
 * `why`) is handed to the catalogue too, so a translation shows it; where a message was made without it, the `why`.
 */
export const modText = (said: ModMessage, t: (text: string, params?: Record<string, string | number>) => string): string =>
  renderMessage(said, (template, params, message) => {
    const hidden = (MOD_MESSAGES[message.key] as { hidden?: readonly string[] }).hidden ?? [];
    return t(template, hidden.includes("reason") && params.reason === undefined && params.why !== undefined ? { ...params, reason: params.why } : { ...params });
  });

/** An error as the person reads it: a mod's that could not be read in the package's words, translated; any other its own. */
export const modErrorText = (err: unknown, t: (text: string, params?: Record<string, string | number>) => string): string =>
  err instanceof ModError ? modText(err.detail, t) : err instanceof Error ? err.message : String(err);

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
 *
 * `races` follows the tag: its rows when it has a list (an empty one says the mod adds none, which a page that kept
 * names from before must drop), nothing when it has none (it says nothing about races).
 */
export function replayDataSet(tag: ModTag | null): ReplayDataSet | undefined {
  if (!tag) return undefined;
  const url = safeLink(tag.dataSet.url);
  const said = Array.isArray(tag.dataSet.races);
  return { hash: tag.dataSet.hash, ...(tag.dataSet.name ? { name: tag.dataSet.name } : {}), ...(url ? { url } : {}), ...(liveLifter(tag) ? { live: true } : {}), ...(said ? { races: raceRows(tag.dataSet.races) } : {}) };
}

/**
 * The mod the editor has open (`api.gameData.source()`), as an untagged replay may be watched with it; `races`, the
 * ones it declares: an empty list when it keeps race names and has none, absent when it cannot say.
 */
export interface OpenMod { hash: string; name: string; url: string | null; races?: DataSetRace[] }

/**
 * The mod a picked folder holds, as replays that name no mod are watched with it: named by `hash`, by the name and link
 * it gives itself (its `mod.json`, else the one program at its top that holds it, else the folder's own name; `name`
 * when it gives none), and with the races its `mod.json` declares (an empty list when it declares none; nothing when it
 * says nothing of races).
 */
export function folderMod(d: Pick<ModDescription, "name" | "link" | "races">, hash: string, name: string): OpenMod {
  return { hash, name: d.name || name, url: safeLink(d.link ?? null), ...(d.races !== undefined ? { races: raceRows(d.races) } : {}) };
}

/**
 * The mod the editor draws with, when it is one: a data set with a mod's hash (sixteen hex digits) that is not the
 * game's own (`starcraft`). Null for the game itself, a set with no hash yet (a large mod's is worked out after it
 * opens), or no data at all.
 *
 * `kept`: the races the editor keeps for it (`api.gameData.races()`, `keptRaces` in `races.ts`), or null for an editor
 * without the call, which cannot keep race names. With the call its list goes as it is, empty or not (empty: the person
 * cleared the names, and the page must not keep the old ones); without it, the profile's races when it has any, else
 * none at all.
 */
export function openModOf(source: { hash?: string; profile: { id: string; name: string; url?: string; races?: unknown } } | null | undefined, kept: readonly unknown[] | null = null): OpenMod | null {
  if (!source || source.profile.id === "starcraft" || !source.hash || !/^[0-9a-f]{16}$/.test(source.hash)) return null;
  const races = raceRows(kept ?? source.profile.races);
  return { hash: source.hash, name: source.profile.name, url: safeLink(source.profile.url ?? null), ...(kept || races.length ? { races } : {}) };
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
  return { hash: mod.hash, ...(mod.name ? { name: mod.name } : {}), ...(mod.url ? { url: mod.url } : {}), live: true, ...(mod.races ? { races: mod.races } : {}) };
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

/**
 * A sign, read from the replay itself, that its game was played with a mod. Each is certain: StarCraft cannot make it.
 * - `terrain`: the map uses tile group `group` of `tileset`, past the last Remastered has (`last`).
 * - `race`: a player's race byte is none of the game's eight (0 Zerg, 1 Terran, 2 Protoss, 3 to 5 the game's others,
 *   6 Random, 7 none): a race the mod adds. Its name, where one is known, is the plugin's to say (`races.ts`).
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
    .filter((f) => f.path && !inDotFolder(f.path.slice(f.path.indexOf("/") + 1)))
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
