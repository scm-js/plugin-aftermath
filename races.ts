/**
 * A player's race. The game has eight race bytes (0 Zerg, 1 Terran, 2 Protoss, then its others: 3 Independent,
 * 4 Neutral, 5 User Selectable, 6 Random, 7 Inactive); any other value is a race the data set in use adds, and no
 * file of the game says what it is called. Its name comes from the replay's own tag (`dataSet.races`), else from the
 * editor's data set (`api.gameData.races()`, `GameDataProfile.races`, `api.names.race`), else it reads `Race 12`.
 *
 * What a race plays as (`like`: 0, 1 or 2) is what a view that knows only the game's three races goes by: declared
 * beside the data set's name, or worked out from the Zerg, Terran and Protoss flags of the player's units. Without
 * either it is not known, and a view says so rather than guessing.
 *
 * Pure: the plugin hands in what it read from the editor.
 */

/** A race a data set adds to the game's own (the shared contract's `DataSetRace`). */
export interface DataSetRace {
  /** The race byte: 8–255. */
  id: number;
  /** What it is called: 40 characters at most, trimmed, not empty. */
  name: string;
  /** The lower-case letter its per-race files go by (`game\<letter>console.pcx`), when it has them. */
  letter?: string;
  /** The game's race it plays as: 0, 1 or 2. */
  like?: 0 | 1 | 2;
}

/** The game's race bytes. */
export const GAME_RACES = 8;
/** The longest name a race may have. */
export const RACE_NAME_MAX = 40;

/** Whether a value is one of the three races the game plays: 0 Zerg, 1 Terran, 2 Protoss. */
export const isPlayed = (race: number): race is 0 | 1 | 2 => race === 0 || race === 1 || race === 2;

/**
 * The race a table of the game's own unit ids by race (tiers, answers to a threat) is read for: the race itself for
 * 0–2, else null. Never `like`: a race a data set adds has units and buildings of its own, and that it plays as Terran
 * to the engine (supply, a worker's cost, the console) does not make Terran's lists its own.
 */
export const tableRace = (race: number | undefined): 0 | 1 | 2 | null => (race !== undefined && isPlayed(race) ? race : null);

/**
 * The races a carrier declares, as the contract keeps them: rows with an id of 8–255 and a name of 1–40 characters,
 * sorted by id, the first of an id kept. A row that is not one is dropped, never thrown on. `value` is what the
 * carrier holds, of any shape (a replay's tag keeps fields it does not know).
 */
export function raceRows(value: unknown): DataSetRace[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<number, DataSetRace>();
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = r.id, name = typeof r.name === "string" ? r.name.trim() : "";
    if (typeof id !== "number" || !Number.isInteger(id) || id < GAME_RACES || id > 255 || out.has(id)) continue;
    if (!name || name.length > RACE_NAME_MAX) continue;
    const letter = typeof r.letter === "string" && /^[a-z]$/.test(r.letter) ? r.letter : undefined;
    const like = r.like === 0 || r.like === 1 || r.like === 2 ? r.like : undefined;
    out.set(id, { id, name, ...(letter ? { letter } : {}), ...(like !== undefined ? { like } : {}) });
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/** How a race is known to a view. */
export interface RaceView {
  /** The race byte, unchanged. */
  id: number;
  /** Its name: the game's own (English, translated where shown) for 0–7, a declared one, or null (shown as `Race {n}`). */
  name: string | null;
  /** What it plays as, or null when that is not known. */
  like: 0 | 1 | 2 | null;
  /** Where `like` came from: the race itself, the data set's declaration, the player's units, or nowhere. */
  from: "game" | "declared" | "units" | null;
}

/** A race as a view shows it. */
export interface NamedRace extends RaceView {
  /** Its name as shown: the game's translated, a declared one as it is, or `Race 12`. */
  label: string;
}

/** The game's names for its eight race bytes, in English. */
export const GAME_RACE_NAMES: readonly string[] = ["Zerg", "Terran", "Protoss", "Independent", "Neutral", "User Selectable", "Random", "Inactive"];

/** What a race is named and plays as, from what each source says. */
export interface RaceSources {
  /** The replay's own tag's races (`replay.mod.dataSet.races`, read loosely). */
  tag?: unknown;
  /** The races the editor's data set declares (`api.gameData.races()`, else `source().profile.races`), when it is the replay's. */
  editor?: readonly DataSetRace[];
  /** The editor's name for a race byte (`api.names.race`): a declared race's name in an editor that knows them, `Race 12` otherwise. */
  editorName?: (id: number) => string | null | undefined;
  /** The units the player built, trained or owned, by units.dat id: what `like` is worked out from. */
  units?: () => Iterable<number>;
  /** The units table's StarEdit group flags (bit 0 Zerg, 1 Terran, 2 Protoss), when the editor has the replay's table. */
  groupFlags?: ArrayLike<number> | null;
}

/** An editor's placeholder for a race it cannot name. */
const UNNAMED = /^Race \d+$/;

/**
 * A race as a view knows it. The name: the game's own for 0–7; else the tag's row, the editor's row, the editor's name
 * (not its `Race 12`), or none. What it plays as: itself for 0–2; else the tag's declared `like`, the editor's, what
 * the player's units say (`workedOutLike`), or not known.
 */
export function raceView(id: number, sources: RaceSources = {}): RaceView {
  if (isPlayed(id)) return { id, name: GAME_RACE_NAMES[id], like: id, from: "game" };
  const tagRow = raceRows(sources.tag).find((r) => r.id === id) ?? null;
  const editorRow = sources.editor?.find((r) => r.id === id) ?? null;
  let name: string | null = id >= 0 && id < GAME_RACES ? GAME_RACE_NAMES[id] : tagRow?.name ?? editorRow?.name ?? null;
  if (name === null) {
    const said = sources.editorName?.(id)?.trim();
    if (said && !UNNAMED.test(said)) name = said;
  }
  const declared = tagRow?.like ?? editorRow?.like;
  if (declared !== undefined) return { id, name, like: declared, from: "declared" };
  const worked = sources.units ? workedOutLike(sources.units(), sources.groupFlags) : null;
  return worked === null ? { id, name, like: null, from: null } : { id, name, like: worked, from: "units" };
}

/**
 * What a race plays as, from its units: the one of the Zerg, Terran and Protoss group flags most of `units` carry
 * (each unit counted as often as it appears). Null with no table, no unit carrying any of them, or a tie.
 */
export function workedOutLike(units: Iterable<number>, groupFlags: ArrayLike<number> | null | undefined): 0 | 1 | 2 | null {
  if (!groupFlags) return null;
  const n = [0, 0, 0];
  for (const type of units) {
    if (!Number.isInteger(type) || type < 0 || type >= groupFlags.length) continue;
    const f = groupFlags[type];
    for (let k = 0; k < 3; k++) if (f & (1 << k)) n[k]++;
  }
  const best = Math.max(...n);
  if (best === 0) return null;
  const at = [0, 1, 2].filter((k) => n[k] === best);
  return at.length === 1 ? (at[0] as 0 | 1 | 2) : null;
}

/* ── Naming a race: hints from the data set's files ── */

/** The strings of a `.tbl` file (a count, that many offsets, then the strings, each ending in a zero), or null for none. */
export function tblStrings(bytes: Uint8Array | null | undefined): string[] | null {
  if (!bytes || bytes.length < 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0, true);
  if (2 + count * 2 > bytes.length) return null;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = view.getUint16(2 + i * 2, true);
    let s = "";
    for (let j = at; j < bytes.length && bytes[j] !== 0; j++) s += String.fromCharCode(bytes[j]);
    out.push(s);
  }
  return out;
}

/**
 * Names a person may pick for a race: the strings the data set's `rez\network.tbl` has past the length of the game's
 * own (a mod that adds races names them there, past the game's). Colour and control codes taken out, trimmed, 1–40
 * characters, each once, and none already given to another race (`taken`, any case). None when either table cannot be
 * read. Hints, never facts: nothing is named by them unless a person picks one.
 */
export function nameCandidates(mod: Uint8Array | null | undefined, game: Uint8Array | null | undefined, taken: readonly string[] = []): string[] {
  const ours = tblStrings(mod), theirs = tblStrings(game);
  if (!ours || !theirs) return [];
  const used = new Set(taken.map((s) => s.toLowerCase()));
  const out: string[] = [];
  for (const raw of ours.slice(theirs.length)) {
    const s = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!s || s.length > RACE_NAME_MAX || used.has(s.toLowerCase())) continue;
    used.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** The letters a race's own files may go by: any but the game's z, t, p and n. */
export const RACE_LETTERS: readonly string[] = [..."abcdefghijklmoqrsuvwxy"];

/** The files that say a data set has a race of `letter`, as the game's archives name them. */
export const letterFiles = (letter: string): string[] => [`game\\${letter}console.pcx`, `rez\\statbtn${letter}.bin`];

/** The declared races with `row` in place of any of its id: what `gameData.setRaces` is handed to add or rename one. */
export function withRace<T extends { id: number }>(rows: readonly T[], row: T): T[] {
  return [...rows.filter((r) => r.id !== row.id), row].sort((a, b) => a.id - b.id);
}

/** Hints for naming a race: names and letters a person may pick. */
export interface RaceHints {
  names: string[];
  letters: string[];
}

/**
 * The editor's answer to `gameData.raceCandidates()` as hints: names of 1–40 characters once trimmed, letters that are
 * one of `RACE_LETTERS` (a to y, not t, p or n), each once. Anything else in it is dropped; an answer of another shape
 * is no hints.
 */
export function hintsFrom(answer: unknown): RaceHints {
  const out: RaceHints = { names: [], letters: [] };
  if (!answer || typeof answer !== "object") return out;
  const { names, letters } = answer as { names?: unknown; letters?: unknown };
  if (Array.isArray(names)) for (const n of names) {
    const s = typeof n === "string" ? n.trim() : "";
    if (s && s.length <= RACE_NAME_MAX && !out.names.includes(s)) out.names.push(s);
  }
  if (Array.isArray(letters)) for (const l of letters) if (typeof l === "string" && RACE_LETTERS.includes(l) && !out.letters.includes(l)) out.letters.push(l);
  return out;
}

/**
 * The hints the editor offers for naming a race (`gameData.raceCandidates`), or null when it has not got the call and
 * the plugin is to read the data set's files itself. A call that fails, or answers something else, is no hints.
 */
export async function editorHints(editor: RaceEditor): Promise<RaceHints | null> {
  const gd = editor.gameData;
  if (typeof gd?.raceCandidates !== "function") return null;
  try { return hintsFrom(await gd.raceCandidates()); } catch { return { names: [], letters: [] }; }
}

/* ── The editor's side ── */

/** What of the editor's plugin API a race is named by: loose, since an editor from before November 2026 has not got the race calls. */
export interface RaceEditor {
  gameData?: {
    races?: () => unknown;
    setRaces?: (races: readonly DataSetRace[], id?: string) => unknown;
    source?: () => { profile?: { id?: string; races?: unknown } } | null;
    /** What the data set suggests for naming its races (names and letters, those declared left out): an editor from November 2026 on. */
    raceCandidates?: () => Promise<unknown>;
  };
  names?: { race?: (value: number) => string };
}

/** The rows the editor's data set declares, as it keeps them (fields this plugin does not know kept): `gameData.races()`, else the profile's. */
export function declaredRows(editor: RaceEditor): { id: number }[] {
  try {
    const gd = editor.gameData;
    const rows = typeof gd?.races === "function" ? gd.races() : gd?.source?.()?.profile?.races;
    return Array.isArray(rows) ? rows.filter((r): r is { id: number } => !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "number") : [];
  } catch { return []; }
}

/** What the editor says of races, for `raceView`: its declared rows and its names (an older editor's `Race 12` is not a name). */
export function editorSources(editor: RaceEditor): Pick<RaceSources, "editor" | "editorName"> {
  const names = editor.names;
  return {
    editor: raceRows(declaredRows(editor)),
    editorName: (id) => { try { return typeof names?.race === "function" ? names.race(id) : null; } catch { return null; } },
  };
}

/**
 * Whether a person may be offered to name a race: it has no name, it is one a data set adds (8–255), the editor draws
 * with the replay's own data set and it is not the game's own, and the editor can keep a name (`gameData.setRaces`).
 */
export function canName(view: RaceView, editor: RaceEditor, own: boolean): boolean {
  const profile = editor.gameData?.source?.()?.profile;
  return view.name === null && view.id >= GAME_RACES && view.id <= 255 && own && typeof editor.gameData?.setRaces === "function" && !!profile && profile.id !== "starcraft";
}

/**
 * The row a person's answers make, or what is wrong with them: `"name"` (none, once trimmed), `"long"` (longer than
 * 40 characters once trimmed) or `"letter"` (not one lower-case letter, or one of the game's z, t, p and n). `like` is
 * "" for not known.
 */
export function namedRow(id: number, name: string, letter: string, like: string): DataSetRace | "name" | "long" | "letter" {
  const n = name.trim(), l = letter.trim().toLowerCase();
  if (!n) return "name";
  if (n.length > RACE_NAME_MAX) return "long";
  if (l && (!/^[a-z]$/.test(l) || "ztpn".includes(l))) return "letter";
  return { id, name: n, ...(l ? { letter: l } : {}), ...(like === "0" || like === "1" || like === "2" ? { like: Number(like) as 0 | 1 | 2 } : {}) };
}

/** Declare `row` with the editor's data set, beside the rows it has. What `setRaces` answered (null: it kept nothing, or the editor cannot). */
export function declare(editor: RaceEditor, row: DataSetRace): unknown {
  const gd = editor.gameData;
  if (typeof gd?.setRaces !== "function") return null;
  return gd.setRaces(withRace(declaredRows(editor), row) as DataSetRace[]) ?? null;
}

/**
 * A race as shown: one of the game's eight by its name through `game` (the plugin translates it), a declared race by
 * its name as it is, and one with none through `unnamed` (`Race 12`). Never another race's name.
 */
export function labelOf(view: RaceView, game: (english: string) => string, unnamed: (id: number) => string): string {
  if (view.name === null) return unnamed(view.id);
  return view.id >= 0 && view.id < GAME_RACES ? game(view.name) : view.name;
}
