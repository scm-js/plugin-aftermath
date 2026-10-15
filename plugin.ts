/**
 * Aftermath — a plugin for the scmJS map editor (https://github.com/scm-js/scm-js).
 *
 * Opens StarCraft replays (`.rep`) and lays what the players did over the map they
 * played on: where every building went down and when, where units were sent, a heat map
 * of the orders, each player's build order and actions per minute, and the chat — all on
 * a timeline that plays back. Several replays can be open at once, and Map stats takes every
 * replay open of one map together: where players start, the bases taken, where they fight.
 *
 * Each replay opens its map in a tab of its own, view only: nothing about the map can be
 * changed from there, and switching tabs switches replays. While a replay's tab is in
 * front, a panel in the right dock shows the players and, a tab at a time, the game, the build
 * order, the fights, the chat and Map stats; a strip under the map holds
 * the playback controls and the timeline, with the fights, the chat and the players who
 * left marked along it and a graph over the game underneath. A replay dropped anywhere on
 * the editor, or picked in File ▸ Open, comes here. Replays can also go into a map's Map stats
 * without a tab of their own: several of one map dropped at once, or added from Map stats.
 *
 * A replay holds only the commands players gave, not the game's result, so what is shown
 * is what players asked for (see `analysis.ts`). Where the editor has the site's game
 * engine beside it (the scm-sim plugin), every replay opened is also played through: the
 * game is run to its end out of sight, and the panels then show what happened as well —
 * the units where they stood, the buildings that really stood, what was made and lost,
 * each player's army and economy through the game (`played.ts`), the fights and who killed
 * what (`fights.ts`), and what all the games played through on a map say about the map
 * itself (`report.ts`, shown as Map stats).
 *
 * `replay.ts` reads the file, `analysis.ts` makes the per-player reports and the heat
 * grid, `played.ts` reads the engine's timeline, `chk.ts` compares maps; all four are pure
 * and tested. This file is the editor side: the tabs, the panels, the playback clock and
 * the overlay. It never edits a map.
 */
import type { Disposable, MapView, OverlayHandle, PanelHandle, PluginApi, PluginImage } from "@scm-js/plugin-api";
import { analyse, buildOrderRows, formatTime, FRAMES_PER_MINUTE, heat, TOWN_HALLS, type ClickKind, type HeatGrid, type PlayerReport, type ReplayReport } from "./analysis";
import { likeness, plainText, readChk, type ChkInfo } from "./chk";
import { FRAME_MS, parseReplay, ReplayError } from "./replay";
import { KO } from "./ko";
import { buildings as standingBuildings, isBuilding, losses, lossPoints, madeRows, mineralLines, presencePoints, series, unitIndex, unitsAt, WORKERS, type Metric, type Point, type Standing, type UnitIndex } from "./played";
import { fights as findFights, kills as findKills, topKillers, type Fight, type FightKind, type Kill, type Killer } from "./fights";
import { clockOf, mapReport, winnerOf, type MapReport } from "./report";
import { direct, lookAt, shotAt, type Shot } from "./director";
import { cameraTrack, trackAt, type CameraTrack } from "./camera";
import { advantage, bases as takenBases, hardestHit, leads, story, totals, type Advantage, type Base, type PlayerTotals } from "./story";
import type { ReplayTimeline, ScmSimService } from "./vendor/scm-sim";
import { GameView } from "./gameview";

/* ── State ──────────────────────────────────────────────── */

/** `presence`, `losses` and `unvisited` need the game played through. */
type HeatMode = "off" | "orders" | "buildings" | "presence" | "losses" | "unvisited";
/** What the map shows: the game at this moment, the same with what the players ordered, or Map stats: every game of the map together. */
type Lens = "watch" | "orders" | "map";
type Chart = "apm" | "lead" | Metric;
type Tab = "summary" | "build" | "fights" | "chat" | "map";

interface Settings {
  /** The recent orders drawn over the game (with the units faint). */
  orders: boolean;
  /** The key to the marks, in the map's corner. */
  legend: boolean;
  /** The heat map drawn while Map stats is open, of every game it counts. */
  heat: HeatMode;
  speed: number;
  /** SCVs, Drones and Probes in the build order. */
  workers: boolean;
  /** What the graph draws. */
  chart: Chart;
  /** The side panel's tab. */
  tab: Tab;
  /**
   * 2 from 0.8, when the army lead and the summary came; 3 when the map's marks went into views; 4 when the views became
   * switches; 5 when Map stats came, its heat counting the same games as its marks, always whole.
   */
  version: number;
}

const DEFAULTS: Settings = { orders: false, legend: true, heat: "losses", speed: 8, workers: false, chart: "lead", tab: "summary", version: 5 };

interface Loaded {
  id: number;
  fileName: string;
  report: ReplayReport;
  map: ChkInfo;
  /** The file, for the engine to play. */
  bytes: Uint8Array;
  /** The editor's tab its map is open in; null while it opens, and for a replay only in its map's Map stats. */
  docId: number | null;
  /** The replays of one map share this, the id of the first of them loaded. */
  group: number;
  /** Taken out of Map stats by the user. */
  excluded: boolean;
  /** Where this replay's clock stands; each tab keeps its own. */
  frame: number;
  /** Players taken off the map and the graph, by their command id. */
  hidden: Set<number>;
  /** What happened in the game, once it has been played through, and what is read out of that once. */
  played: Played | null;
  /** Why playing it through failed, for the timeline to say and offer again. */
  failed: string | null;
  /** In the Replay view, whose eyes the game is seen through (a player's slot, with the fog of war); null: everyone's. */
  eyes: number | null;
}

interface Played {
  timeline: ReplayTimeline;
  standing: Standing[];
  index: UnitIndex;
  lost: Point[];
  lostBy: Map<number, { units: number; value: number }>;
  fights: Fight[];
  kills: Kill[];
  killers: Killer[];
  /** One army against the other, in a game of two; null in any other. */
  adv: Advantage | null;
  bases: Base[];
  totals: PlayerTotals[];
  /** Where Spectate's camera looks, shot by shot. */
  shots: Shot[];
  /** Spectate's shots of one player's game, for watching through their eyes (`shotsOf`), made when first asked. */
  shotsFor: Map<number, Shot[]>;
  direct: (only: number) => Shot[];
}

/** What fell this recently is where a fight is now: five seconds. */
const FRONT_FRAMES = 120;
/** How long before a fight's first death going to it lands: two seconds. */
const FIGHT_LEAD = 48;
/** Zergling and Scourge: two from one egg. */
const TWINS = new Set([37, 47]);
/** How long a click stays on the map behind the timeline. */
const TRAIL_FRAMES = 8 * 24;
/** How long a kill's line stays on the map. */
const KILL_FRAMES = 36;
/** How long a new building is marked as new. */
const NEW_FRAMES = 6 * 24;
/** Terrain shared between two replays' maps for them to count as the same map. */
const SAME_MAP = 0.9;
/** The timeline's lane of marks above the graph, in CSS pixels. */
const LANE = 16;

/** The orders a heat map of where units were sent counts. */
const SENT: ReadonlySet<ClickKind> = new Set(["move", "attack", "patrol", "ability"]);


/** Marks English kept in a table or registered with the editor, for `tests/ko.test.ts` to find; it is translated where shown. */
const msg = (text: string) => text;

const RACES = [msg("Zerg"), msg("Terran"), msg("Protoss")];

const GAME_TYPES: Record<number, string> = {
  2: msg("Melee"), 3: msg("Free For All"), 4: msg("One on One"), 5: msg("Capture the Flag"), 6: msg("Greed"), 7: msg("Slaughter"),
  8: msg("Sudden Death"), 9: msg("Ladder"), 10: msg("Use Map Settings"), 11: msg("Team Melee"), 12: msg("Team Free For All"),
  13: msg("Team Capture the Flag"), 15: msg("Top vs Bottom"),
};

const TABS: { id: Tab; label: string }[] = [
  { id: "summary", label: msg("Game") },
  { id: "build", label: msg("Build") },
  { id: "fights", label: msg("Fights") },
  { id: "chat", label: msg("Chat") },
  { id: "map", label: msg("Map stats") },
];

const HEAT_LABELS: Record<Exclude<HeatMode, "off">, string> = {
  losses: msg("Heat: where units were lost"),
  presence: msg("Heat: where the armies were"),
  orders: msg("Heat: where units were sent"),
  buildings: msg("Heat: where buildings went"),
  unvisited: msg("Ground never entered"),
};

/** The legend's title for what the map shows. */
const LEGEND_TITLES: Record<Lens, string> = { watch: msg("The game"), orders: msg("The game and its orders"), map: msg("Map stats") };

const FIGHT_KINDS: Record<FightKind, string> = { battle: msg("Battle"), workers: msg("Workers killed"), buildings: msg("Buildings destroyed") };

/** Why a fight that mattered matters, as a mark in front of it: it turned the game, it decided a lot, or it was a big even trade. */
function fightMark(f: Fight): { id: string; label: string; why: string } | null {
  if (f.turning) return { id: "turn", label: msg("Turning point"), why: msg("After this fight the player ahead in army stayed ahead to the end") };
  if (f.tier === "decisive") return { id: "decisive", label: msg("Decisive"), why: msg("One side lost much of everything it had, and the other came out clearly ahead") };
  if (f.tier === "major" && f.winner === null) return { id: "even", label: msg("Even trade"), why: msg("Both sides lost about as much") };
  return null;
}

const STYLE = `
.afm-busy { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 8px; background: rgba(10, 12, 16, 0.8); color: #e8ecf2; font-size: 13px; pointer-events: none; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4); white-space: nowrap; }
.afm-busy[hidden] { display: none; }
.afm-over { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
.afm-busy .afm-spin { width: 16px; height: 16px; flex: none; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.22); border-top-color: var(--accent, #4fd1c5); animation: afm-spin 0.8s linear infinite; }
@keyframes afm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .afm-busy .afm-spin { animation-duration: 2.4s; } }
.afm { display: flex; flex-direction: column; gap: 8px; font-size: 12px; flex: 1; min-height: 0; }
.afm > * { flex-shrink: 0; }
.afm .afm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.afm .afm-title { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm .afm-dim { color: var(--text-dim, #99a2b3); line-height: 1.35; }
.afm .afm-warn { color: var(--warn, #e6b95c); line-height: 1.35; }
.afm .afm-drop { border: 1px dashed var(--border, #3a4150); border-radius: 6px; padding: 14px 10px; text-align: center; color: var(--text-dim, #99a2b3); }
.afm.afm-dragging .afm-drop, .afm.afm-dragging { outline: 2px dashed var(--accent, #4fd1c5); outline-offset: -2px; }
.afm .afm-players { display: flex; flex-direction: column; gap: 1px; }
.afm .afm-player { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 4px; cursor: pointer; }
.afm .afm-player:hover { background: var(--hover, rgba(255,255,255,0.06)); }
.afm .afm-player.afm-off { opacity: 0.4; }
.afm .afm-player .afm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm .afm-player .afm-race { color: var(--text-dim, #99a2b3); margin-left: 4px; }
.afm .afm-player .afm-live { font-variant-numeric: tabular-nums; color: var(--text-dim, #99a2b3); white-space: nowrap; }
.afm .afm-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.afm .afm-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border, #3a4150); }
.afm .afm-tabs button { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--text-dim, #99a2b3); padding: 4px 3px; cursor: pointer; font: inherit; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm .afm-tabs button:hover { color: var(--text, #e4e8ef); }
.afm .afm-tabs button.afm-on { color: var(--text, #e4e8ef); border-bottom-color: var(--accent, #4fd1c5); }
.afm .afm-tabs button:disabled { opacity: 0.4; cursor: default; }
.afm .afm-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
.afm .afm-body > * { flex-shrink: 0; }
.afm .afm-step .afm-end { color: var(--text-dim, #99a2b3); font-size: 11px; }
.afm .afm-step.afm-gone > span:nth-child(2) { text-decoration: line-through; text-decoration-color: var(--text-dim, #99a2b3); }
.afm .afm-step { display: grid; grid-template-columns: 44px 1fr; gap: 6px; padding: 2px 6px; cursor: pointer; }
.afm .afm-step:hover { background: var(--hover, rgba(255,255,255,0.06)); }
.afm .afm-step.afm-future { opacity: 0.45; }
.afm .afm-step .afm-t { font-variant-numeric: tabular-nums; color: var(--text-dim, #99a2b3); }
.afm .afm-step.afm-hall { font-weight: 600; }
.afm .afm-fight { padding-top: 3px; padding-bottom: 3px; }
.afm .afm-fight .afm-sides, .afm .afm-fold .afm-step { font-size: 11px; color: var(--text-dim, #99a2b3); }
.afm .afm-result { font-size: 13px; font-weight: 600; }
.afm .afm-result .afm-end { font-weight: 400; }
.afm .afm-leadbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: rgba(128,128,128,0.25); margin: 2px 0 4px; }
.afm .afm-leadbar > span { display: block; min-width: 0; }
.afm .afm-line { padding: 2px 0; cursor: pointer; line-height: 1.35; }
.afm .afm-line:hover { color: var(--text, #e4e8ef); background: var(--hover, rgba(255,255,255,0.06)); }
.afm .afm-table { display: grid; gap: 2px 8px; font-variant-numeric: tabular-nums; }
.afm .afm-table > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm .afm-table .afm-th { text-align: right; }
.afm .afm-table > span:not(.afm-dim):not(:first-child) { text-align: right; }
.afm .afm-step.afm-quiet { color: var(--text-dim, #99a2b3); }
.afm-toggles { display: inline-flex; gap: 4px; flex: 0 0 auto; }
.afm-toggle { background: none; border: 1px solid var(--border, #3a4150); border-radius: 5px; color: var(--text-dim, #99a2b3); font: inherit; padding: 2px 8px; cursor: pointer; }
.afm-toggle:hover:not(:disabled) { color: var(--text, #e4e8ef); }
.afm-toggle:disabled { opacity: 0.45; cursor: default; }
.afm-toggle.afm-on { background: var(--accent, #4fd1c5); border-color: var(--accent, #4fd1c5); color: #10131a; }
.afm .afm-ahead { color: var(--text, #e4e8ef); font-weight: 600; }
.afm .afm-mark { display: inline-block; font-size: 10px; font-weight: 600; line-height: 14px; padding: 0 5px; border-radius: 7px; margin-right: 5px; vertical-align: 1px; }
.afm .afm-mark.afm-turn { background: #f0c64a; color: #1b1d22; }
.afm .afm-mark.afm-decisive { background: rgba(240,80,60,0.9); color: #fff; }
.afm .afm-mark.afm-even { background: rgba(160,168,184,0.25); color: var(--text, #e4e8ef); }
.afm .afm-fold > summary { cursor: pointer; color: var(--text-dim, #99a2b3); padding: 2px 6px; }
.afm .afm-fold > summary:hover { color: var(--text, #e4e8ef); }
.afm .afm-chat div { padding: 1px 0; cursor: pointer; }
.afm .afm-chat div.afm-future { opacity: 0.45; }
.afm-tl { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; font-size: 12px; }
.afm-tl > .afm-row { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.afm-tl .afm-time { font-variant-numeric: tabular-nums; min-width: 92px; }
.afm-tl .afm-dim { color: var(--text-dim, #99a2b3); }
.afm-tl .afm-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm-tl select, .afm-tl button { flex: 0 0 auto; width: auto; }
.afm-tl > .afm-row > button:first-child { min-width: 64px; }
.afm-tl canvas { flex: 1; min-height: 40px; width: 100%; display: block; cursor: pointer; touch-action: none; }
.afm-tl canvas.afm-faded { opacity: 0.3; }
.afm .afm-game { padding: 2px 0; }
.afm .afm-game > label { display: flex; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.afm .afm-game.afm-out { opacity: 0.55; }
.afm .afm-game .afm-sub { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; padding-left: 22px; font-size: 11px; color: var(--text-dim, #99a2b3); }
.afm .afm-game .afm-names { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm .afm-link { background: none; border: 0; padding: 0; font: inherit; color: var(--accent, #4fd1c5); cursor: pointer; }
.afm .afm-link:hover { text-decoration: underline; }
`;

export function activate(api: PluginApi) {
  api.i18n.register({ ko: KO });
  const t = api.i18n.t;
  /** A string from a table (`msg`) or a `ReplayError`, in the editor's language. */
  const translate = (text: string) => api.i18n.t(text);
  /** Where on the map a fight was, as players say it. */
  const placeOf = (x: number, y: number, map: { width: number; height: number }) => {
    const clock = clockOf(x, y, map.width * 32, map.height * 32);
    return clock ? t("{n} o'clock", { n: clock }) : t("the middle");
  };
  const stored = api.storage.get<Partial<Settings> & Partial<Record<"docked" | "buildings" | "units" | "marks" | "lens" | "wholeGame" | "allReplays", unknown>>>("settings", {});
  const version = stored.version ?? 0, oldLens = stored.lens;
  // 0.7's panel placement (the panels have one place now) and its switches for each kind of mark, 0.8's views, and the
  // heat's own choice of games and of how much of each (Map stats counts its games, whole, for everything it shows).
  for (const old of ["docked", "buildings", "units", "marks", "lens", "wholeGame", "allReplays"] as const) delete stored[old];
  // (Before settings 4, `orders` was 0.7's switch for the recent orders, on by default; it is the Orders switch now.)
  if (version < 4) delete stored.orders;
  const settings: Settings = { ...DEFAULTS, ...stored };
  // Settings from before 0.8 open on the army lead and the summary once, whatever they had.
  if (version < 2) { settings.chart = DEFAULTS.chart; settings.tab = DEFAULTS.tab; }
  if (version < 4) settings.orders = oldLens === "orders";
  if (version < 3) {
    // The heat maps of moves, attacks and pings are one now, of where units were sent; and the Map view opens on one.
    const old = stored.heat as string | undefined;
    settings.heat = old === "move" || old === "attack" || old === "ping" ? "orders" : old === undefined || old === "off" ? DEFAULTS.heat : settings.heat;
  }
  settings.version = DEFAULTS.version;
  const save = () => api.storage.set("settings", settings);
  const w = api.ui.widgets;
  const el = api.ui.el;

  const loaded: Loaded[] = [];
  let nextId = 1;
  /** The replay whose tab is in front, or null. */
  let current: Loaded | null = null;
  let playing = false;
  let raf = 0;
  let lastTick = 0;

  /* ── The Game view (gameview.ts): the replay played out in the map's place, and then the clock ── */

  /** What the Game view is doing with the replay in front, for the timeline's line; null when nothing. */
  let gameState: string | null = null;
  /** Map stats put the map in front of the game: it goes back to the game when Map stats closes. */
  let statsHidGame = false;
  /** Replays whose tab has been offered the Replay view. */
  const offered = new Set<number>();
  const game = new GameView(api, {
    frame: (id, f) => {
      if (!current || current.id !== id || !gameClock()) return;
      current.frame = f.frame;
      // (The game stops by itself at the replay's end.)
      if (playing && !f.playing && f.seeking === null && f.frame >= current.report.frames - 1) stop();
      tick();
      showBusy();
    },
    movedByUser: () => letGo(),
    shown: (on) => handOver(on),
    state: (text) => { gameState = text; strip?.update(); showBusy(); },
    seeking: () => { strip?.update(); showBusy(); },
  }, "Replay", {
    loading: (name) => t("Starting the game of {name}…", { name }),
    failed: (message) => t("The game could not be shown: {message}", { message }),
  });
  /** The spinner over the game while it starts or a jump runs, with the line the timeline has for it. */
  function showBusy(): void {
    const entry = current;
    if (!entry || !game.shown) { game.busy(null); return; }
    if (game.loading) { game.busy(gameState); return; }
    if (game.seeking) {
      const done = game.seekProgress;
      game.busy(done === null || done < 0.05 ? t("Going to {time}…", { time: formatTime(entry.frame) }) : t("Going to {time}… {percent}%", { time: formatTime(entry.frame), percent: Math.floor(done * 100) }));
      return;
    }
    game.busy(null);
  }

  /** Spectate's camera lets go: the person moved the view. */
  function letGo(): void {
    if (!cam.following || lensOf() === "map") return;
    cam.following = false;
    cam.asked = [];
    strip?.update();
  }

  /** The Game view is the clock: it shows the replay in front, loaded. */
  const gameClock = () => current !== null && game.shown && game.holds(current.id);

  /** The tab in front went from the map to the game or back: the clock goes with it, from where it stood. */
  function handOver(on: boolean): void {
    const entry = current;
    if (!entry) return;
    if (on) {
      cancelAnimationFrame(raf);
      const asked = entry.frame;
      void game.hold(entry, asked, playing, settings.speed).then((ok) => {
        // (A jump made while the game was starting is where the clock is now: the game goes there too.)
        if (ok && current === entry && Math.round(entry.frame) !== Math.round(asked)) game.seek(entry.frame);
        if (!ok && playing && current === entry) runClock();
        strip?.update();
      });
    } else {
      game.play(false);
      if (playing) runClock();
    }
    tick();
    showBusy();
  }

  /** Offer a replay's tab the Game view the first time it comes to the front, showing it there; and load it when shown. */
  function gameFor(entry: Loaded): void {
    if (entry.docId === null) return;
    if (!offered.has(entry.id)) {
      offered.add(entry.id);
      void game.offer(entry, true).then((ok) => { if (!ok) offered.delete(entry.id); });
      return;
    }
    if (game.shown && !game.holds(entry.id)) handOver(true);
  }

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  /* ── Loading: a replay, its map in a view-only tab ── */

  /**
   * Read replays and open them. With `into`, the ones of its map go into its Map stats without a tab and any other
   * opens in a tab of its own; without, each opens in a tab, unless several of one map came together and the user
   * chooses to have one tab of the map and the rest in its Map stats.
   */
  async function load(files: File[], into: Loaded | null = null): Promise<void> {
    const reps = files.filter((f) => /\.rep$/i.test(f.name));
    if (!reps.length) {
      if (files.length) api.ui.toast({ kind: "warn", title: t("Not a replay"), detail: t("Aftermath opens StarCraft replays, files ending in .rep.") });
      return;
    }
    void api.data.load();
    void api.graphics.load();
    const batch: Loaded[] = [];
    for (const file of reps) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const replay = await parseReplay(bytes);
        const id = nextId++, map = readChk(replay.chk);
        const group = [...loaded, ...batch].find((l) => likeness(map, l.map) >= SAME_MAP)?.group ?? id;
        batch.push({ id, fileName: file.name, report: analyse(replay), map, bytes, docId: null, group, excluded: false, frame: 0, hidden: new Set(), played: null, failed: null, eyes: null });
      } catch (err) {
        const detail = err instanceof ReplayError ? translate(err.message) : String(err);
        api.ui.toast({ kind: "error", title: t("Could not read {name}", { name: file.name }), detail });
        api.log("Aftermath:", file.name, err);
      }
    }
    if (!batch.length) return;

    const tabbed: Loaded[] = [], quiet: Loaded[] = [];
    if (into) {
      for (const e of batch) (e.group === into.group ? quiet : tabbed).push(e);
    } else {
      const groups = new Map<number, Loaded[]>();
      for (const e of batch) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
      const shared = [...groups.values()].filter((g) => g.length > 1);
      const together = shared.length > 0 && await api.ui.confirm(
        t("{n} of these replays share a map with another of them. Open one replay of each map in a tab and put the others in that map's Map stats, where the games of a map are taken together? Or open every replay in a tab of its own?", { n: shared.reduce((n, g) => n + g.length, 0) }),
        { title: t("Several replays of one map"), confirmLabel: t("Use Map stats"), cancelLabel: t("A tab each") },
      );
      for (const g of groups.values()) {
        if (!together || g.length < 2) tabbed.push(...g);
        // A map with a tab already: all of them go into its Map stats.
        else if (hasTab(g[0].group)) quiet.push(...g);
        else { tabbed.push(g[0]); quiet.push(...g.slice(1)); }
      }
    }
    for (const entry of tabbed) {
      for (const p of entry.report.players) for (const pl of p.placements) api.graphics.requestUnit(pl.unit);
      loaded.push(entry);
      if (!await openTab(entry)) {
        loaded.splice(loaded.indexOf(entry), 1);
        continue;
      }
      queue.push(entry);
    }
    // (A replay for Map stats belongs to a tab of its map; one whose map would not open goes with it.)
    const added = quiet.filter((e) => hasTab(e.group));
    for (const entry of added) { loaded.push(entry); queue.push(entry); }
    if (added.length) {
      reportCache = null;
      heatCache = null;
      side?.render();
      strip?.update();
      redraw();
      if (!into) api.ui.toast({ kind: "ok", title: t("{n, plural, one {# replay} other {# replays}} added to Map stats", { n: added.length }), detail: t("Each is analysed in the background, after the replays open in tabs. Map stats is under the map.") });
    }
    pump();
  }

  /** Some replay of the map has a tab. */
  const hasTab = (group: number) => loaded.some((l) => l.group === group && l.docId !== null);

  /** Bring a replay's tab to the front, opening its map in one first if it has none (a replay only in Map stats). */
  async function openTab(entry: Loaded): Promise<boolean> {
    if (entry.docId !== null) { api.document.activate(entry.docId); return true; }
    // The tab is added before the map opens, so the "document" event that follows finds it.
    const base = entry.fileName.replace(/\.rep$/i, "").replace(/[\\/:*?"<>|]/g, "_") || t("Replay map");
    opening = entry;
    const ok = await api.document.open(entry.report.replay.chk, `${base}.scx`, { viewOnly: { label: t("Replay") } });
    opening = null;
    if (!ok) {
      api.ui.toast({ kind: "error", title: t("Could not open the map of {name}", { name: entry.fileName }) });
      return false;
    }
    entry.docId ??= api.document.id();
    // A tab opening comes in on its game.
    if (settings.tab === "map") settings.tab = gameTab;
    sync();
    if (current === entry) startView(entry);
    return true;
  }
  /**
   * Where the game starts a replay's screen: at its own scale, on the first player's start
   * location (or where they first built, on a map without one for them).
   */
  function startView(entry: Loaded): void {
    const first = entry.report.players[0];
    const start = first ? api.query.startLocations().find((s) => s.owner === first.player.index) : undefined;
    const built = first?.placements[0];
    api.view.setZoom(1);
    if (start) api.view.center(start.tx, start.ty);
    else if (built) api.view.center(built.tx, built.ty);
    else api.view.center(Math.floor(entry.map.width / 2), Math.floor(entry.map.height / 2));
  }

  /** The replay whose map is being opened: the tab that appears is its. */
  let opening: Loaded | null = null;

  function remove(entry: Loaded): void {
    const at = loaded.indexOf(entry);
    if (at < 0) return;
    if (running?.entry === entry) running.controller.abort();
    const q = queue.indexOf(entry);
    if (q >= 0) queue.splice(q, 1);
    loaded.splice(at, 1);
    if (current === entry) { stop(); current = null; }
    heatCache = null;
    reportCache = null;
  }

  /**
   * Follow the editor's tabs: a replay whose tab went is forgotten, and the one whose tab is
   * in front becomes the current one — its panels open, every other map's close.
   */
  function sync(): void {
    const open = new Set(api.document.list().map((d) => d.id));
    for (const l of [...loaded]) if (l.docId !== null && !open.has(l.docId)) remove(l);
    // A replay only in Map stats goes with the last tab of its map.
    for (const l of [...loaded]) if (l.docId === null && l !== opening && !hasTab(l.group)) remove(l);
    const id = api.document.id();
    // The editor says a map opened before `document.open` answers: the new tab is the replay being opened.
    if (opening && opening.docId === null && id !== null && !loaded.some((l) => l.docId === id)) opening.docId = id;
    const next = loaded.find((l) => l.docId !== null && l.docId === id) ?? null;
    if (next !== current) {
      stop();
      current = next;
      heatCache = null;
      sideHidden = false;
      stripHidden = false;
    }
    bindKeys(current !== null);
    if (current) {
      showSide();
      showStrip();
      overlay.show();
      gameFor(current);
    } else {
      closeStrip();
      if (!sideAsked) closeSide();
    }
    side?.render();
    strip?.render();
    redraw();
  }

  /* ── Playback ── */

  function seek(f: number): void {
    if (!current) return;
    // The clock is one game's: moving it brings that game back from Map stats.
    if (lensOf() === "map") showStats(false);
    current.frame = Math.max(0, Math.min(current.report.frames, Math.round(f)));
    if (gameClock()) game.seek(current.frame);
    tick();
    showBusy();
  }

  /* ── Spectate's camera ── */

  /**
   * The camera follows the shots (`director.ts`) while Spectate is shown and the user has not taken the view, along one
   * track for the whole game (`camera.ts`): still while what it shows stays near the middle, panning to what is near and
   * cutting to what is far, eased forward and back in time. On the map it is read at Aftermath's clock every time that
   * moves; the Game view is handed the track and moves along it itself as it draws. Where it last put the map's view is
   * kept, so a view somewhere else means the user moved it, and it lets go.
   */
  const cam = { following: true, asked: [] as { x: number; y: number }[], made: null as { shots: Shot[]; speed: number; width: number; height: number; track: CameraTrack } | null, raf: 0 };

  /**
   * The camera's track for a replay, for the view as big as it is now and the speed it plays at: kept until either
   * changes (the view by a tenth or more), as its pans are timed in the person's seconds and its dead zone is a share of
   * the view.
   */
  function trackOf(entry: Loaded): CameraTrack | null {
    const shots = shotsOf(entry);
    if (!shots?.length) return null;
    let view = game.shown ? game.viewSize : null;
    if (!view) { const v = api.view.visible(); view = { width: (v.x1 - v.x0) * 32, height: (v.y1 - v.y0) * 32 }; }
    const m = cam.made, near = (a: number, b: number) => Math.abs(a - b) <= b * 0.1;
    if (m && m.shots === shots && m.speed === settings.speed && near(view.width, m.width) && near(view.height, m.height)) return m.track;
    const track = cameraTrack(shots, {
      view, map: { width: entry.map.width * 32, height: entry.map.height * 32 },
      frames: Math.max(entry.report.frames, entry.played!.timeline.frames), rate: (1000 / FRAME_MS) * settings.speed,
    });
    if (!track) return null;
    cam.made = { shots, speed: settings.speed, width: view.width, height: view.height, track };
    return track;
  }

  /** Spectate's shots for a replay: the whole game's, or in the Replay view through a player's eyes, that player's. */
  function shotsOf(entry: Loaded): Shot[] {
    const done = entry.played;
    if (!done) return [];
    const eyes = game.shown && game.holds(entry.id) ? entry.eyes : null;
    const player = eyes === null ? undefined : entry.report.players.find((p) => p.player.slot === eyes)?.player.index;
    if (player === undefined) return done.shots;
    let shots = done.shotsFor.get(player);
    if (!shots) { shots = done.direct(player); done.shotsFor.set(player, shots); }
    // (A player with nothing to follow, as one who left at once, is the whole game's.)
    return shots.length ? shots : done.shots;
  }

  function follow(): void {
    const entry = current;
    const on = !!entry?.played?.shots.length && lensOf() !== "map" && cam.following && entry.docId !== null && api.document.id() === entry.docId;
    if (game.shown) {
      const track = on && entry && game.holds(entry.id) ? trackOf(entry) : null;
      if (!track || game.follows) { game.follow(track); return; }
      // A game page from before tracks: moved to the track at the frame it shows, carried on to now, every drawing while it plays.
      const f = game.frameNow(settings.speed);
      if (f === null) return;
      const at = trackAt(track, f);
      game.camera(at.x, at.y);
      if (playing && !cam.raf) cam.raf = requestAnimationFrame(() => { cam.raf = 0; follow(); });
      return;
    }
    if (!on || !entry) return;
    if (movedByUser()) { cam.following = false; cam.asked = []; return; }
    const track = trackOf(entry);
    if (!track) return;
    const at = trackAt(track, entry.frame);
    lookTo(at.x / 32, at.y / 32);
  }

  /** What the map shows: Map stats while its tab is open, else the game, with its orders when asked. */
  function lensOf(): Lens {
    if (settings.tab === "map" && sidePanel?.isOpen()) return "map";
    return settings.orders ? "orders" : "watch";
  }

  /** The side panel's tab before Map stats, to go back to. A replay opens on the game, never on Map stats. */
  let gameTab: Tab = settings.tab === "map" ? "summary" : settings.tab;
  settings.tab = gameTab;

  /** Show Map stats (its tab, and on the map), or go back to the game and the tab it was on. */
  function showStats(on: boolean): void {
    if (!current || on === (lensOf() === "map")) return;
    if (on) {
      if (settings.tab !== "map") gameTab = settings.tab;
      settings.tab = "map";
      sideHidden = false;
      showSide(true);
      // Map stats is drawn on the map: the game steps aside while it is open.
      if (game.shown) { statsHidGame = true; game.show(false); }
    } else {
      if (settings.tab === "map") settings.tab = gameTab;
      if (statsHidGame) { statsHidGame = false; game.show(true); }
    }
    save();
    heatCache = null;
    side?.render();
    tick();
  }

  /** Every replay loaded of a map, with or without a tab, in the order loaded. */
  const mapGames = (of: Loaded) => loaded.filter((l) => l.group === of.group);
  /** Where the game the engine played left the replay's (a unit ordered that had not been made), or null. */
  const partedAt = (l: Loaded) => l.played?.timeline.check?.parted ?? null;

  /**
   * The games Map stats takes together, for its marks and its heat alike: the map's replays not taken out, and of those,
   * where the site's engine is, the ones analysed whose game kept to the replay (one that left it says nothing true of
   * the map after that). With no engine there is only what was ordered, and every replay counts.
   */
  function counted(of: Loaded): Loaded[] {
    const games = mapGames(of).filter((l) => !l.excluded);
    return sim?.present ? games.filter((l) => l.played && partedAt(l) === null) : games;
  }

  /** The map's replays still to be analysed, not taken out. */
  const waitingOf = (of: Loaded) => (sim?.present ? mapGames(of).filter((l) => !l.excluded && !l.played && !l.failed).length : 0);

  /** Centre the view on a tile, and remember it as the camera's own doing. */
  function lookTo(tx: number, ty: number): void {
    // In the Game view the camera is the game's, in pixels; the person moving it is said by the view itself.
    if (game.shown) { game.camera(tx * 32, ty * 32); return; }
    api.view.center(tx, ty);
    cam.asked.push({ x: tx, y: ty });
    if (cam.asked.length > 8) cam.asked.shift();
  }

  /** The view's middle is not where the camera put it lately, allowing for the map's edge and whole tiles. */
  function movedByUser(): boolean {
    if (game.shown || !current || !cam.asked.length) return false;
    const v = api.view.visible(), hw = (v.x1 - v.x0) / 2, hh = (v.y1 - v.y0) / 2;
    const cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
    const clamp = (n: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, n)));
    return !cam.asked.some((a) => Math.abs(clamp(a.x, hw, current!.map.width - hw) - cx) <= 2.5 && Math.abs(clamp(a.y, hh, current!.map.height - hh) - cy) <= 2.5);
  }

  /** Follow again (F, or the Spectate button when Spectate is shown), or let the camera go. */
  function setFollowing(on: boolean): void {
    cam.following = on;
    cam.asked = [];
    if (on) follow();
    redraw();
    strip?.update();
  }

  /** What the camera shows, in words, for the line at the top of the map. */
  function captionOf(entry: Loaded, shot: Shot): string {
    const map = entry.played!.timeline.map;
    const nameOf = (index: number) => entry.report.players.find((p) => p.player.index === index)?.player.name ?? t("Player {n}", { n: index + 1 });
    const at = shot.path[0];
    if (shot.kind === "fight" && shot.fight) {
      const f = shot.fight, mark = fightMark(f);
      return [mark ? translate(mark.label) : null, translate(FIGHT_KINDS[f.kind]), placeOf(f.x, f.y, map)].filter(Boolean).join(" · ");
    }
    if (shot.kind === "meeting") return `${t("{a} and {b}, about to meet", { a: nameOf(shot.players[0]), b: nameOf(shot.players[1]) })} · ${placeOf(at.x, at.y, map)}`;
    if (shot.kind === "base") return `${t("{name} takes a base", { name: nameOf(shot.players[0]) })} · ${placeOf(at.x, at.y, map)}`;
    if (shot.kind === "home") return t("{name}'s main base", { name: nameOf(shot.players[0]) });
    const here = lookAt(shot, entry.frame);
    return `${t("{name}'s army", { name: nameOf(shot.players[0]) })} · ${placeOf(here.x, here.y, map)}`;
  }

  /** What moves with the clock. */
  function tick(): void {
    follow();
    side?.update();
    strip?.update();
    // (The map is under the game: only what is drawn over the game.)
    if (!game.shown) overlay.redraw();
    else game.redrawOver();
  }

  function play(): void {
    if (!current || playing) return;
    if (lensOf() === "map") showStats(false);
    if (current.frame >= current.report.frames) current.frame = 0;
    playing = true;
    if (gameClock()) { game.play(true); strip?.update(); return; }
    runClock();
    strip?.update();
  }

  /** Aftermath's own clock, moving the replay in front at the chosen speed; it gives way to the game's when that one takes over. */
  function runClock(): void {
    cancelAnimationFrame(raf);
    lastTick = performance.now();
    const step = (now: number) => {
      if (!playing || !current || gameClock()) return;
      const dt = now - lastTick;
      lastTick = now;
      current.frame = Math.min(current.report.frames, current.frame + (dt / FRAME_MS) * settings.speed);
      if (current.frame >= current.report.frames) playing = false;
      tick();
      if (playing) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function stop(): void {
    playing = false;
    cancelAnimationFrame(raf);
    game.play(false);
    strip?.update();
  }

  /** The player's keys, taken only while a replay's tab is in front: elsewhere they are the editor's. */
  let keys: Disposable[] = [];
  function bindKeys(on: boolean): void {
    if (on === keys.length > 0) return;
    for (const k of keys) k.dispose();
    keys = [];
    if (!on) return;
    const by = (seconds: number) => () => { if (current) seek(current.frame + (seconds * FRAMES_PER_MINUTE) / 60); };
    keys = [
      api.hotkeys.add("Space", () => (playing ? stop() : play())),
      api.hotkeys.add("ArrowLeft", by(-10)),
      api.hotkeys.add("ArrowRight", by(10)),
      api.hotkeys.add("Shift+ArrowLeft", by(-60)),
      api.hotkeys.add("Shift+ArrowRight", by(60)),
      api.hotkeys.add("Home", () => seek(0)),
      api.hotkeys.add("End", () => { if (current) seek(current.report.frames); }),
      api.hotkeys.add("F", () => spectate()),
      api.hotkeys.add("O", () => showOrders(!settings.orders)),
      api.hotkeys.add("N", () => keyMoment(1)),
      api.hotkeys.add("Shift+N", () => keyMoment(-1)),
    ];
  }

  /** To the next key moment after the clock, or the one before it, as a click on it in the list goes. */
  function keyMoment(step: 1 | -1): void {
    const entry = current;
    if (!entry?.played) return;
    const list = entry.played.fights.filter((f) => f.key);
    const f = step > 0 ? list.find((x) => x.from - FIGHT_LEAD > entry.frame + 1) : [...list].reverse().find((x) => x.from - FIGHT_LEAD < entry.frame - 24);
    if (f) goToFight(f);
  }

  /* ── Playing the game through (the scm-sim plugin's engine), one replay after another ── */

  let sim: ScmSimService | null = null;
  /** The replay the engine is playing now, and how far it is (0 to 1; -1 while the engine starts). */
  let running: { entry: Loaded; controller: AbortController; fraction: number } | null = null;
  /** Replays waiting their turn: every one opened, in the order they were. */
  const queue: Loaded[] = [];

  /** Start the next replay waiting, if the engine is here and free: the one in front first, then the others with a tab. */
  function pump(): void {
    if (running || !sim?.present || !queue.length) return;
    let i = queue.findIndex((l) => l === current);
    if (i < 0) i = queue.findIndex((l) => l.docId !== null);
    const [next] = queue.splice(Math.max(0, i), 1);
    void playThrough(next).then(pump);
  }

  /** Map stats has been seen to be worth a look, once a map: when a second of its games is counted. */
  const announced = new Set<number>();

  async function playThrough(entry: Loaded): Promise<void> {
    if (!sim?.present || running || entry.played || !loaded.includes(entry)) return;
    const run = { entry, controller: new AbortController(), fraction: -1 };
    running = run;
    entry.failed = null;
    strip?.render();
    try {
      const state = await sim.status();
      if (!state.available) throw new Error(state.reason ?? t("The game engine cannot run a game here."));
      // An engine from before timeline 3 reads only the file 1.16.1 wrote.
      if (entry.report.replay.format !== "legacy" && (state.timeline ?? 0) < 3) throw new Error(t("The game engine on this site is an older one that plays replays from StarCraft 1.16.1 and earlier only."));
      const timeline = await sim.analyse(entry.bytes, {
        name: entry.fileName,
        signal: run.controller.signal,
        onProgress: (p) => {
          run.fraction = p.stage === "playing" && p.frames > 0 ? p.frame / p.frames : -1;
          if (entry === current) strip?.update();
          else if (current?.group === entry.group && lensOf() === "map") side?.update();
        },
      });
      // (The costs come from the game's unit table, when the editor has the game's data.)
      await api.data.load();
      const units = api.data.units();
      // A Zergling or a Scourge is half of what units.dat asks, which is the price of the pair from one egg.
      const cost = (type: number) => (units ? ((units.mineralCost[type] ?? 0) + (units.vespeneCost[type] ?? 0)) / (TWINS.has(type) ? 2 : 1) : 0);
      const index = unitIndex(timeline);
      // A Command Center flown to a base comes down where its Land order put it (the engine's timeline does not follow a building in the air).
      const landings = entry.report.players.flatMap((p) => p.placements.filter((pl) => pl.landed && TOWN_HALLS.has(pl.unit)).map((pl) => {
        const size = api.palette.unitSize(pl.unit);
        return { player: p.player.index, frame: pl.frame, x: pl.tx * 32 + size.width / 2, y: pl.ty * 32 + size.height / 2 };
      }));
      const standing = standingBuildings(timeline), fights = findFights(timeline, cost, index), taken = takenBases(standing, mineralLines(timeline), landings);
      entry.played = {
        timeline, standing, index, lost: lossPoints(timeline), lostBy: losses(timeline, cost), fights, kills: findKills(timeline), killers: topKillers(timeline, cost),
        adv: advantage(timeline), bases: taken, totals: totals(timeline, taken, cost), shots: direct(timeline, index, fights, taken, cost),
        shotsFor: new Map(), direct: (only) => direct(timeline, index, fights, taken, cost, only),
      };
      for (const b of entry.played.standing) api.graphics.requestUnit(b.type);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        entry.failed = err instanceof Error ? err.message : String(err);
        api.log("Aftermath:", entry.fileName, err);
      }
    } finally {
      if (running === run) running = null;
      heatCache = null;
      reportCache = null;
      if (current && current.group === entry.group) { side?.render(); strip?.render(); redraw(); }
      announce(entry);
    }
  }

  /** The second game of a map counted, while the game is shown: say once that Map stats now has something to compare. */
  function announce(entry: Loaded): void {
    if (!current || current.group !== entry.group || announced.has(entry.group) || lensOf() === "map" || counted(entry).length < 2) return;
    announced.add(entry.group);
    api.ui.toast({ title: t("Map stats: {n} games of this map", { n: counted(entry).length }), detail: t("The replays of this map you have open can now be seen together: where players start, the bases they take, where they fight. Press Map stats under the map.") });
  }

  /* ── Map stats: the games it counts (`counted`), taken together ── */

  let reportCache: { key: string; report: MapReport } | null = null;
  function currentReport(): MapReport | null {
    if (!current) return null;
    const map = current.map;
    const games = counted(current).filter((l) => l.played);
    if (!games.length) return null;
    const key = games.map((l) => l.id).join(",");
    if (reportCache?.key === key) return reportCache.report;
    const report = mapReport(games.map((l) => ({
      timeline: l.played!.timeline, standing: l.played!.standing, fights: l.played!.fights, bases: l.played!.bases,
      winner: winnerOf(l.report.players.map((p) => ({ index: p.player.index, left: p.leftAt !== null })), l.played!.standing),
    })), map);
    reportCache = { key, report };
    return report;
  }

  /* ── Heat ── */

  let heatCache: { key: string; grid: HeatGrid; canvas: HTMLCanvasElement } | null = null;

  /** The heat counts the same games as Map stats' marks, every player, the whole of each game. */
  function heatSources(): { report: ReplayReport; players: PlayerReport[] }[] {
    return current ? counted(current).map((l) => ({ report: l.report, players: l.report.players })) : [];
  }

  const playedOf = (report: ReplayReport): Played | null => loaded.find((l) => l.report === report)?.played ?? null;

  /** The heat map drawn: only in Map stats, and one of what was ordered while no game it counts is analysed. */
  function heatMode(): HeatMode {
    if (!current || lensOf() !== "map") return "off";
    const h = settings.heat;
    return !counted(current).some((l) => l.played) && (h === "presence" || h === "losses" || h === "unvisited") ? "orders" : h;
  }

  function heatCanvas(): HTMLCanvasElement | null {
    const mode = heatMode();
    if (!current || mode === "off") return null;
    if (mode === "unvisited") {
      // Not a heat of anything counted: the ground no unit stood on in any game played through, shaded.
      const report = currentReport();
      if (!report) return null;
      const key = `unvisited/${reportCache!.key}`;
      if (heatCache?.key === key) return heatCache.canvas;
      const canvas = heatCache?.canvas ?? document.createElement("canvas");
      const { width: cw, height: ch, games } = report.visited;
      canvas.width = cw; canvas.height = ch;
      const g = canvas.getContext("2d")!;
      const img = g.createImageData(cw, ch);
      for (let i = 0; i < games.length; i++) if (!games[i]) { img.data[i * 4] = 235; img.data[i * 4 + 1] = 70; img.data[i * 4 + 2] = 60; img.data[i * 4 + 3] = 105; }
      g.putImageData(img, 0, 0);
      heatCache = { key, grid: { width: cw, height: ch, cell: 0, values: new Float32Array(0), max: 0 }, canvas };
      return canvas;
    }
    const sources = heatSources();
    const played = mode === "presence" || mode === "losses";
    if (played && !sources.some((s) => playedOf(s.report))) return null;
    const key = [mode, counted(current).map((l) => l.id).join(".")].join("/");
    if (heatCache?.key === key) return heatCache.canvas;

    const { width, height } = current.map;
    const points = function* () {
      for (const s of sources) {
        if (played) {
          const pl = playedOf(s.report);
          if (!pl) continue;
          // The timeline names a player by the game's number; the panel hides one by the id its commands carry.
          const shown = new Set(s.players.map((p) => p.player.index));
          for (const pt of mode === "losses" ? pl.lost : presencePoints(pl.timeline, pl.index)) if (shown.has(pt.player)) yield { ...pt, kind: "move" as ClickKind };
          continue;
        }
        for (const p of s.players) {
          if (mode === "buildings") {
            for (const pl of p.placements) {
              const size = api.palette.unitSize(pl.unit);
              yield { frame: pl.frame, player: pl.player, x: pl.tx * 32 + size.width / 2, y: pl.ty * 32 + size.height / 2, kind: "move" as ClickKind };
            }
          } else yield* p.clicks;
        }
      }
    };
    const grid = heat(points(), width, height, { kinds: mode === "orders" ? SENT : undefined });
    const canvas = heatCache?.canvas ?? document.createElement("canvas");
    canvas.width = grid.width;
    canvas.height = grid.height;
    const g = canvas.getContext("2d")!;
    const img = g.createImageData(grid.width, grid.height);
    for (let i = 0; i < grid.values.length; i++) {
      if (grid.max <= 0 || grid.values[i] <= 0) continue;
      const v = Math.sqrt(grid.values[i] / grid.max);
      if (v < 0.1) continue;
      const [r, gr, b] = ramp(v);
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = gr;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = Math.round(Math.min(0.78, 0.2 + v * 0.7) * 255);
    }
    g.putImageData(img, 0, 0);
    heatCache = { key, grid, canvas };
    return canvas;
  }

  /* ── Overlay ── */

  function draw(ctx: CanvasRenderingContext2D, v: MapView): void {
    if (!current || current.docId === null || api.document.id() !== current.docId) return;
    const cur = current;
    const frame = cur.frame;
    const s = v.tilePx / 32;
    const lens = lensOf();
    const players = cur.report.players.filter((p) => !cur.hidden.has(p.player.id));
    const byIndex = new Map(players.map((p) => [p.player.index, p] as const));
    const done = cur.played;

    if (lens === "map") {
      // Map stats: the games of this map together; a heat map, and the starts, the bases and where the fighting is.
      const hc = heatCanvas();
      if (hc) {
        const x0 = v.x(0), y0 = v.y(0);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(hc, x0, y0, v.x(cur.map.width * 32) - x0, v.y(cur.map.height * 32) - y0);
        ctx.restore();
      }
      const report = currentReport();
      if (report) {
        for (const spot of report.spots) {
          const x = v.x(spot.x), y = v.y(spot.y);
          markSpot(ctx, x, y, Math.max(10, (64 + Math.min(8, spot.fights) * 16) * s));
          label(ctx, t("{n, plural, one {# fight} other {# fights}}", { n: spot.fights }), x, y, "#ff9a8a");
        }
        for (const site of report.sites) {
          const x = v.x(site.x), y = v.y(site.y), r = Math.max(8, 80 * s);
          markSite(ctx, x, y, r, site.starts > 0);
          // A start says how its players fared; a base says in how many games it was taken.
          const text = site.starts ? (site.startDecided ? t("won {wins} of {games}", { wins: site.startWins, games: site.startDecided }) : "") : t("taken {n} of {games}", { n: site.taken, games: report.games });
          if (text) label(ctx, text, x, y - r - 8, site.starts ? "#ffffff" : "#8fe0b0");
        }
      }
      if (settings.legend) legend(ctx, lens, done !== null);
      // Which view this is, and of how many games: nothing of it is the one game's.
      const n = counted(cur).length, waiting = waitingOf(cur);
      pill(ctx, [
        t("Map stats"),
        plainText(cur.report.replay.header.mapName) || null,
        t("{n, plural, one {# game} other {# games}} together", { n }),
        waiting ? t("{n} being analysed", { n: waiting }) : null,
      ].filter(Boolean).join(" · "), []);
      return;
    }

    // Watch and Orders: the game at this moment. The buildings first, as they stood (or as ordered, before the analysis).
    if (done) {
      for (const b of done.standing) {
        if (b.from > frame || (b.to !== null && b.to <= frame)) continue;
        const p = byIndex.get(b.owner);
        if (!p) continue;
        const size = api.palette.unitSize(b.type);
        const w = size.width * s, h = size.height * s;
        const built = b.done !== null && b.done <= frame;
        markBuilding(ctx, v.x(b.x) - w / 2, v.y(b.y) - h / 2, w, h, p.player.color, !built ? "site" : frame - b.from < NEW_FRAMES ? "new" : "built", s >= 0.4 ? api.graphics.unitImage(b.type, { owner: p.player.index }) : null, s);
      }
    } else {
      for (const p of players) {
        for (const pl of p.placements) {
          if (pl.frame > frame) break;
          const size = api.palette.unitSize(pl.unit);
          const w = size.width * s, h = size.height * s;
          markBuilding(ctx, v.x(pl.tx * 32), v.y(pl.ty * 32), w, h, p.player.color, frame - pl.frame < NEW_FRAMES ? "new" : "built", s >= 0.4 ? api.graphics.unitImage(pl.unit, { owner: p.player.index }) : null, s);
        }
      }
    }
    // The units where they stood; faint under the orders, so the orders stand out.
    if (done) {
      const r = Math.max(1.5, Math.min(5, 4 * s));
      ctx.globalAlpha = lens === "orders" ? 0.35 : 1;
      unitsAt(done.timeline, frame, (unit, ux, uy) => {
        const type = done.index.type[unit];
        const p = byIndex.get(done.index.owner[unit]);
        if (!p || type < 0 || isBuilding(type)) return;
        markUnit(ctx, v.x(ux), v.y(uy), r, p.player.color, WORKERS.has(type));
      });
      ctx.globalAlpha = 1;
    }

    if (lens === "watch" && done) {
      // A fight that mattered, while it lasts: a box round what fell in the last few seconds, so it follows the fight.
      for (const f of done.fights) {
        if (f.tier === "minor" || frame < f.from - 24 || frame > f.to + FRONT_FRAMES) continue;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const pt of f.points) {
          if (pt.frame > frame + 24) break;
          if (pt.frame < frame - FRONT_FRAMES) continue;
          bx0 = Math.min(bx0, pt.x); by0 = Math.min(by0, pt.y); bx1 = Math.max(bx1, pt.x); by1 = Math.max(by1, pt.y);
        }
        if (bx0 === Infinity) continue;
        const pad = 64, x0 = v.x(bx0 - pad), y0 = v.y(by0 - pad);
        markFightBox(ctx, x0, y0, v.x(bx1 + pad) - x0, v.y(by1 + pad) - y0, f.turning, f.key);
        const mark = fightMark(f);
        ctx.textAlign = "left";
        label(ctx, mark ? `${translate(mark.label)} · ${translate(FIGHT_KINDS[f.kind])}` : translate(FIGHT_KINDS[f.kind]), x0, y0 - 9, f.turning ? "#f0c64a" : "#ff9a8a");
      }
      // A kill is a line from the killer to where its victim fell, for a moment, in the killer's colour.
      const shots = done.kills;
      for (let i = firstAfter(shots, frame - KILL_FRAMES); i < shots.length && shots[i].frame <= frame; i++) {
        const k = shots[i], p = byIndex.get(k.by);
        if (!p || !byIndex.has(k.player)) continue;
        markKill(ctx, v.x(k.fromX), v.y(k.fromY), v.x(k.x), v.y(k.y), withAlpha(p.player.color, 0.9 * (1 - (frame - k.frame) / KILL_FRAMES)));
      }
      // Losses flash where they fell.
      const lost = done.lost;
      for (let i = firstAfter(lost, frame - NEW_FRAMES); i < lost.length && lost[i].frame <= frame; i++) {
        const p = byIndex.get(lost[i].player);
        if (!p) continue;
        const k = (frame - lost[i].frame) / NEW_FRAMES;
        markLoss(ctx, v.x(lost[i].x), v.y(lost[i].y), 3 + k * 6, withAlpha(p.player.color, 1 - k));
      }
    }

    // The orders of the last few seconds: in Orders, and in Watch until the game is analysed (they are all there is then).
    if (lens === "orders" || !done) drawOrders(ctx, v, players, frame);
    if (settings.legend) legend(ctx, lens, done !== null);
    caption(ctx, cur);
  }

  /** The orders of the last few seconds, each fading as it gets older. */
  function drawOrders(ctx: CanvasRenderingContext2D, v: MapView, players: PlayerReport[], frame: number): void {
    const r = Math.max(2.5, 5 * Math.min(1, (v.tilePx / 32) * 2));
    for (const p of players) {
      const clicks = p.clicks;
      for (let i = firstAfter(clicks, frame - TRAIL_FRAMES); i < clicks.length && clicks[i].frame <= frame; i++) {
        const c = clicks[i];
        const k = 1 - (frame - c.frame) / TRAIL_FRAMES;
        ctx.globalAlpha = Math.max(0.1, k);
        markOrder(ctx, c.kind, v.x(c.x), v.y(c.y), r, p.player.color, k);
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Over the Replay view, where the game draws the units and buildings itself: the orders when asked, their legend,
   * and Spectate's line.
   */
  function drawOverGame(ctx: CanvasRenderingContext2D, v: MapView): void {
    const cur = current;
    if (!cur || !game.holds(cur.id) || lensOf() === "map") return;
    const players = cur.report.players.filter((p) => !cur.hidden.has(p.player.id));
    if (settings.orders) {
      drawOrders(ctx, v, players, game.frameNow(settings.speed) ?? cur.frame);
      if (settings.legend) legend(ctx, "orders", cur.played !== null, true);
    }
    caption(ctx, cur);
  }

  /** Spectate's line at the top of the map: what the camera shows, while it follows. */
  function caption(ctx: CanvasRenderingContext2D, entry: Loaded): void {
    const shots = shotsOf(entry);
    const i = cam.following && shots.length ? shotAt(shots, entry.frame) : -1;
    if (i < 0) return;
    pill(ctx, captionOf(entry, shots[i]), shots[i].players.map((pl) => entry.report.players.find((p) => p.player.index === pl)?.player.color ?? "#888"));
  }

  /** A line at the top middle of the map, after a swatch for each colour given. */
  function pill(ctx: CanvasRenderingContext2D, text: string, colours: string[]): void {
    const viewW = ctx.canvas.width / (window.devicePixelRatio || 1);
    ctx.font = "600 12px system-ui, sans-serif";
    const tw = ctx.measureText(text).width, sw = colours.length * 12, w = tw + sw + 20, h = 24;
    const x0 = Math.round(viewW / 2 - w / 2), y0 = 10;
    ctx.fillStyle = "rgba(14,16,22,0.82)";
    ctx.fillRect(x0, y0, w, h);
    colours.forEach((colour, n) => {
      ctx.fillStyle = colour;
      ctx.fillRect(x0 + 10 + n * 12, y0 + 8, 8, 8);
    });
    ctx.fillStyle = "#e4e8ef";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(text, x0 + 10 + sw, y0 + h / 2 + 0.5);
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  }

  /** A key to what the view draws, in the map's bottom-left corner, made with the same marks. */
  function legend(ctx: CanvasRenderingContext2D, lens: Lens, analysed: boolean, inGame = false): void {
    const grey = "#c8cdd7";
    type Item = [(x: number, y: number) => void, string];
    const items: Item[] = [];
    if (lens === "map") {
      items.push(
        [(x, y) => markSite(ctx, x, y, 6, true), t("A start: how the players who started there did")],
        [(x, y) => markSite(ctx, x, y, 6, false), t("A base: in how many games it was taken")],
        [(x, y) => markSpot(ctx, x, y, 6), t("Where fights that mattered happen, over all the games")],
      );
      const mode = heatMode();
      if (mode !== "off") items.push([(x, y) => { const g = ctx.createLinearGradient(x - 7, 0, x + 7, 0); g.addColorStop(0, "rgb(40,80,220)"); g.addColorStop(0.5, "rgb(250,220,60)"); g.addColorStop(1, "rgb(240,50,40)"); ctx.fillStyle = g; ctx.fillRect(x - 7, y - 3, 14, 6); }, translate(HEAT_LABELS[mode])]);
    } else {
      // (Over the Replay view the game draws the units and buildings itself: only the orders are keyed there.)
      if (!inGame) items.push([(x, y) => markBuilding(ctx, x - 6, y - 4, 12, 8, grey, "built", null, 1), analysed ? t("A building; dashed while it goes up") : t("A building ordered")]);
      if (analysed && !inGame) items.push([(x, y) => { markUnit(ctx, x - 3, y, 3.5, grey, false); markUnit(ctx, x + 4, y, 3.5, grey, true); }, t("A unit, and a worker")]);
      if (lens === "watch" && analysed && !inGame) {
        items.push(
          [(x, y) => markKill(ctx, x - 7, y + 3, x + 7, y - 3, grey), t("A kill, from the killer")],
          [(x, y) => markLoss(ctx, x, y, 4, grey), t("A loss")],
          [(x, y) => markFightBox(ctx, x - 7, y - 5, 14, 10, false, true), t("A fight that matters, while it goes on")],
        );
      }
      if (lens === "orders" || !analysed) {
        items.push(
          [(x, y) => markOrder(ctx, "move", x, y, 4, grey, 1), t("Move")],
          [(x, y) => markOrder(ctx, "attack", x, y, 4, grey, 1), t("Attack or patrol")],
          [(x, y) => markOrder(ctx, "ability", x, y, 4, grey, 1), t("Ability or spell")],
          [(x, y) => markOrder(ctx, "rally", x + 1, y + 2, 4, grey, 1), t("Rally point")],
          [(x, y) => markOrder(ctx, "ping", x, y, 4, grey, 1), t("Minimap ping")],
        );
      }
    }
    const title = inGame ? t("Orders") : translate(LEGEND_TITLES[lens]);
    const note = lens === "map" ? null : t("In the player's colour");
    ctx.font = "11px system-ui, sans-serif";
    const widest = Math.max(...items.map(([, text]) => ctx.measureText(text).width), note ? ctx.measureText(note).width : 0);
    const lineH = 17, padX = 8, width = Math.ceil(widest) + 34 + padX * 2;
    const height = (items.length + 1 + (note ? 1 : 0)) * lineH + 8;
    const viewH = ctx.canvas.height / (window.devicePixelRatio || 1);
    const x0 = 10, y0 = viewH - height - 10;
    ctx.fillStyle = "rgba(14,16,22,0.82)";
    ctx.fillRect(x0, y0, width, height);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillStyle = "#e4e8ef";
    ctx.fillText(title, x0 + padX, y0 + 4 + lineH / 2);
    ctx.font = "11px system-ui, sans-serif";
    items.forEach(([mark, text], i) => {
      const y = y0 + 4 + (i + 1.5) * lineH;
      ctx.save(); mark(x0 + padX + 12, y); ctx.restore();
      ctx.fillStyle = "#c8cdd7";
      ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(text, x0 + padX + 30, y);
    });
    if (note) {
      ctx.fillStyle = "#99a2b3";
      ctx.fillText(note, x0 + padX, y0 + 4 + (items.length + 1.5) * lineH);
    }
  }

  /** A word on the map with a dark edge, so it reads over any ground; centred unless the caller set otherwise. */
  function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string): void {
    ctx.font = "600 11px system-ui, sans-serif";
    if (ctx.textAlign === "start") ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  }

  const overlay: OverlayHandle = api.ui.overlay({
    name: "Aftermath",
    visible: false,
    above: "objects",
    draw,
  });
  game.setOverlay(drawOverGame);
  /** Draw again what Aftermath draws, over the map and over the game. */
  function redraw(): void {
    overlay.redraw();
    game.redrawOver();
  }
  const imageListener = api.graphics.onImageLoaded(() => { if (current && overlay.isVisible()) overlay.redraw(); });

  /** A switch for the strip: a button that stays pressed while it is on. */
  function toggle(label: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", { type: "button", className: "afm-toggle" }, label) as HTMLButtonElement;
    // (The button gives the focus back, so Space and the arrows stay the player's.)
    b.addEventListener("click", () => { b.blur(); onClick(); });
    return b;
  }

  /** Spectate: follow the action, or let the camera go; from Map stats, back to the game, following. */
  function spectate(): void {
    if (lensOf() === "map") { showStats(false); setFollowing(true); return; }
    setFollowing(!cam.following);
  }

  function showOrders(on: boolean): void {
    settings.orders = on;
    save();
    redraw();
    strip?.update();
  }

  /** What the graph draws for a replay: the chart chosen where the replay has it, else the nearest it has. */
  function chartOf(entry: Loaded): Chart {
    if (!entry.played) return "apm";
    if (settings.chart === "lead" && !entry.played.adv) return "armyValue";
    return settings.chart;
  }

  /** What the graph says at a moment, as short words for the readout under the pointer; and the fight there, if any. */
  function readout(entry: Loaded, chart: Chart, frame: number, slack: number): string[] {
    const out: string[] = [];
    const shown = entry.report.players.filter((p) => !entry.hidden.has(p.player.id));
    const nameOf = (index: number) => entry.report.players.find((p) => p.player.index === index)?.player.name ?? "";
    const tl = entry.played?.timeline ?? null;
    const adv = entry.played?.adv ?? null;
    if (chart === "lead" && adv) {
      const i = sampleIndex(adv.frames, frame);
      const n = i >= 0 ? Math.round(adv.lead[i]) : 0;
      out.push(n === 0 ? t("even") : t("{name} ahead by {n}", { name: nameOf(n > 0 ? adv.a : adv.b), n: Math.abs(n) }));
    } else if (chart === "apm") {
      const m = Math.floor(frame / FRAMES_PER_MINUTE);
      for (const p of shown) out.push(`${p.player.name} ${p.perMinute[m] ?? 0}`);
    } else if (tl && chart !== "lead") {
      const i = sampleIndex(tl.samples.frame, frame);
      for (const p of shown) { const v = i >= 0 ? series(tl, p.player.index, chart)?.[i] : undefined; if (v !== undefined) out.push(`${p.player.name} ${v}`); }
    }
    // The fight that mattered most at that moment.
    const here = (entry.played?.fights ?? []).filter((f) => frame >= f.from - slack && frame <= f.to + slack).sort((a, b) => b.importance - a.importance)[0];
    if (here && entry.played) {
      const mark = fightMark(here);
      out.push(`${mark ? `${translate(mark.label)}: ` : ""}${translate(FIGHT_KINDS[here.kind])}, ${placeOf(here.x, here.y, entry.played.timeline.map)}`);
    }
    return out;
  }

  /** To a fight: a moment before its first death, so it is seen to begin, with a flash round where things fell. */
  function goToFight(f: Fight): void {
    // A fight shows with the game, where Spectate's camera is at it already; Map stats draws none of one game's.
    if (lensOf() === "map") { gameTab = "fights"; showStats(false); }
    if (current?.played?.shots.length) {
      seek(Math.max(0, f.from - FIGHT_LEAD));
      setFollowing(true);
      if (!game.shown) api.view.flash({ rect: { x0: Math.max(0, Math.floor(f.rect.x0 / 32) - 2), y0: Math.max(0, Math.floor(f.rect.y0 / 32) - 2), x1: Math.ceil(f.rect.x1 / 32) + 2, y1: Math.ceil(f.rect.y1 / 32) + 2 }, kind: "attention" });
      return;
    }
    const rect = { x0: Math.max(0, Math.floor(f.rect.x0 / 32) - 2), y0: Math.max(0, Math.floor(f.rect.y0 / 32) - 2), x1: Math.ceil(f.rect.x1 / 32) + 2, y1: Math.ceil(f.rect.y1 / 32) + 2 };
    goTo(Math.max(0, f.from - FIGHT_LEAD), f.x, f.y, rect);
  }

  /** Go to a moment, and to a place on the map with a flash round it. */
  function goTo(frame: number, x: number, y: number, rect?: { x0: number; y0: number; x1: number; y1: number }): void {
    // A place asked for: the camera lets go of the view (F follows again).
    cam.following = false;
    seek(frame);
    if (game.shown) { game.camera(x, y); return; }
    api.view.center(Math.floor(x / 32), Math.floor(y / 32));
    if (rect) api.view.flash({ rect, kind: "attention" });
  }

  /* ── The panels: the side panel in the right dock, the timeline strip under the map ── */

  let sidePanel: PanelHandle | null = null;
  let side: SideView | null = null;
  let stripPanel: PanelHandle | null = null;
  let strip: StripView | null = null;
  /** The user hid a panel while this replay is in front; it stays hidden until another comes forward. */
  let sideHidden = false;
  let stripHidden = false;
  /** View ▸ Aftermath opened the side panel with no replay in front: it stays until closed. */
  let sideAsked = false;
  /** A panel being closed by the plugin, not the user. */
  let closing = false;

  function showSide(force = false): void {
    if (sidePanel?.isOpen() || (sideHidden && !force)) return;
    const handle: PanelHandle = api.ui.panel({
      title: "Aftermath",
      dock: "right",
      grow: true,
      mount(body) {
        const v = new SideView(body);
        side = v;
        v.render();
        return () => { if (side === v) side = null; };
      },
      onClose: () => {
        if (sidePanel !== handle) return;
        sidePanel = null;
        side = null;
        sideAsked = false;
        if (!closing) sideHidden = true;
        // With Map stats gone, the map shows the game again.
        heatCache = null;
        redraw();
        strip?.update();
      },
    });
    sidePanel = handle;
    redraw();
  }
  function closeSide(): void { closing = true; sidePanel?.close(); closing = false; }

  // An editor from before the strip under the map (which came with `ui.fileType`) floats the timeline instead.
  const bottomDock = typeof api.ui.fileType === "function";

  function showStrip(): void {
    if (stripPanel?.isOpen() || stripHidden) return;
    const handle: PanelHandle = api.ui.panel({
      title: t("Replay timeline"),
      ...(bottomDock ? { dock: "bottom" as const, height: 170 } : { width: 640, height: 200, resizable: true }),
      mount(body) {
        const v = new StripView(body);
        strip = v;
        v.render();
        return () => { if (strip === v) strip = null; };
      },
      onClose: () => {
        if (stripPanel !== handle) return;
        stripPanel = null;
        strip = null;
        stop();
        if (!closing) stripHidden = true;
      },
    });
    stripPanel = handle;
  }
  function closeStrip(): void { closing = true; stripPanel?.close(); closing = false; }

  /** The sample at or before `frame` (the samples are in frame order), or -1 before the first. */
  function sampleIndex(frames: number[], frame: number): number {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid] <= frame) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  class SideView {
    readonly root: HTMLElement;
    /** The players' live readouts, refreshed with the clock. */
    private live: { el: HTMLElement; p: PlayerReport }[] = [];
    /** The list rows that belong to a moment, greyed while it is still to come. */
    private steps: { el: HTMLElement; frame: number }[] = [];
    private buildPlayer = -1;
    /** Map stats' line for the game the engine is playing, refreshed with its progress. */
    private running: { el: HTMLElement; entry: Loaded } | null = null;

    constructor(body: HTMLElement) {
      this.root = el("div", { className: "afm" });
      body.append(this.root);
      // Replays dropped on the panel open here (the editor sends one dropped anywhere else here too).
      body.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        this.root.classList.add("afm-dragging");
      });
      body.addEventListener("dragleave", () => this.root.classList.remove("afm-dragging"));
      body.addEventListener("drop", (e) => {
        this.root.classList.remove("afm-dragging");
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        // Dropped on Map stats, they are added to it.
        void load(files, current && lensOf() === "map" ? current : null);
      });
    }

    render(): void {
      this.root.replaceChildren();
      this.live = [];
      this.steps = [];
      this.running = null;
      const entry = current;
      if (!entry) { this.renderEmpty(); return; }
      const rep = entry.report.replay;

      // Which game.
      const facts = [
        (GAME_TYPES[rep.header.gameType] ? translate(GAME_TYPES[rep.header.gameType]) : null) ?? t("Game type {n}", { n: rep.header.gameType }),
        formatTime(entry.report.frames),
        rep.header.started ? rep.header.started.toLocaleDateString() : null,
        rep.format === "legacy" ? t("before 1.18") : rep.format === "1.18" ? "1.18–1.20" : "1.21+",
      ].filter(Boolean).join(" · ");
      this.root.append(
        el("div", { className: "afm-title", title: entry.fileName }, plainText(rep.header.mapName) || entry.fileName),
        el("div", { className: "afm-dim" }, facts),
      );
      const parted = entry.played?.timeline.check?.parted ?? null;
      if (parted !== null) this.root.append(el("div", { className: "afm-warn" }, t("From {time} the game played here is not the game in the replay: a player gave an order to a unit that had not been made. What is shown after that moment is not what happened, and this game is left out of Map stats.", { time: formatTime(parted) })));
      if (rep.unknownCommands > 0) this.root.append(w.hint(t("{n, plural, one {# command of a kind Aftermath does not know was skipped.} other {# commands of a kind Aftermath does not know were skipped.}}", { n: rep.unknownCommands })));

      // The players, a line each; a click takes one off the map and the graph, or puts them back.
      const list = el("div", { className: "afm-players" });
      for (const p of entry.report.players) {
        const readout = el("span", { className: "afm-live" });
        const line = el("div", { className: "afm-player" + (entry.hidden.has(p.player.id) ? " afm-off" : ""), title: entry.hidden.has(p.player.id) ? t("Show {name} on the map", { name: p.player.name }) : t("Hide {name} on the map", { name: p.player.name }) },
          el("span", { className: "afm-swatch", style: `background:${p.player.color}` }),
          el("span", { className: "afm-name" }, p.player.name, el("span", { className: "afm-race" }, RACES[p.player.race] ? translate(RACES[p.player.race]) : t("Random"))),
          readout,
        );
        line.addEventListener("click", () => {
          if (entry.hidden.has(p.player.id)) entry.hidden.delete(p.player.id); else entry.hidden.add(p.player.id);
          heatCache = null;
          redraw();
          this.render();
          strip?.update();
        });
        list.append(line);
        this.live.push({ el: readout, p });
      }
      this.root.append(list);

      // One thing at a time below: the game, the build order, the fights, the chat, Map stats.
      const tabs = el("div", { className: "afm-tabs", role: "tablist" });
      for (const tab of TABS) {
        const empty = tab.id === "chat" && entry.report.chat.length === 0;
        const title = empty ? t("Nobody wrote anything") : tab.id === "map" ? t("Map stats: every replay of this map you have open, taken together. Shown on the map while this tab is open.") : undefined;
        const b = el("button", { className: settings.tab === tab.id ? "afm-on" : "", role: "tab", type: "button", disabled: empty, title }, translate(tab.label)) as HTMLButtonElement;
        b.addEventListener("click", () => {
          if (tab.id === "map") { showStats(true); return; }
          gameTab = tab.id;
          // Leaving Map stats brings the game back.
          if (lensOf() === "map") { showStats(false); return; }
          settings.tab = tab.id;
          save();
          this.render();
        });
        tabs.append(b);
      }
      const body = el("div", { className: "afm-body" });
      this.root.append(tabs, body);
      const tab = settings.tab === "chat" && entry.report.chat.length === 0 ? "build" : settings.tab;
      if (tab === "summary") this.renderSummary(body, entry);
      else if (tab === "build") this.renderBuild(body, entry);
      else if (tab === "fights") this.renderFights(body, entry);
      else if (tab === "chat") this.renderChat(body, entry);
      else this.renderMap(body, entry);
      this.update();
    }

    private renderEmpty(): void {
      const open = loaded.filter((l) => l.docId !== null);
      this.root.append(
        el("div", { className: "afm-drop" }, t("Drop replays (.rep) here, or anywhere on the editor")),
        w.row(w.button(t("Open Replay…"), { primary: true, onClick: () => void pick() })),
        w.hint(t("Each replay opens its map in a tab of its own, to look at and not to change. A replay records the orders players gave; where the site's game engine is beside the editor, each game is also analysed: the engine plays it through in the background to show what really happened.")),
      );
      if (open.length) {
        const rows = el("div");
        for (const l of open) {
          const line = el("div", { className: "afm-step", title: t("Go to this replay's tab") }, el("span", { className: "afm-t" }, formatTime(l.report.frames)), el("span", {}, l.fileName));
          line.addEventListener("click", () => { if (l.docId !== null) api.document.activate(l.docId); });
          rows.append(line);
        }
        this.root.append(w.group(t("Open replays"), rows));
      }
    }

    private renderBuild(body: HTMLElement, entry: Loaded): void {
      const players = entry.report.players;
      if (!players.some((p) => p.player.id === this.buildPlayer)) this.buildPlayer = players[0]?.player.id ?? -1;
      const who = w.select(players.map((p) => ({ value: p.player.id, label: p.player.name })), { value: this.buildPlayer, onChange: (id) => { this.buildPlayer = Number(id); this.render(); } });
      const workers = w.checkbox(t("Workers"), { value: settings.workers, title: t("Show SCVs, Drones and Probes"), onChange: (on) => { settings.workers = on; save(); this.render(); } });
      body.append(w.row(who, workers));
      const list = el("div");
      const pr = players.find((p) => p.player.id === this.buildPlayer);
      const toBuilding = (frame: number, x: number, y: number, type: number) => {
        const size = api.palette.unitSize(type);
        const tw = Math.max(1, Math.ceil(size.width / 32)), th = Math.max(1, Math.ceil(size.height / 32));
        const tx = Math.max(0, Math.floor(x / 32 - tw / 2)), ty = Math.max(0, Math.floor(y / 32 - th / 2));
        goTo(frame, x, y, { x0: tx, y0: ty, x1: tx + tw, y1: ty + th });
      };
      if (entry.played && pr) {
        // What happened: every line is something that was really started, with what became of it.
        let count = 0;
        for (const row of madeRows(entry.played.timeline, pr.player.index, { workers: settings.workers })) {
          const name = row.kind === "upgrade" ? `${api.names.upgrade(row.id)} ${row.level ?? ""}`.trim() : row.kind === "tech" ? api.names.tech(row.id) : api.names.unit(row.id);
          const hall = row.kind === "unit" && TOWN_HALLS.has(row.id);
          const end = row.kind !== "unit" ? t("researched")
            : row.done === null ? (row.lost === null ? t("not finished") : row.building ? t("cancelled or destroyed {time}", { time: formatTime(row.lost) }) : t("lost {time}", { time: formatTime(row.lost) }))
            : row.lost !== null ? t("lost {time}", { time: formatTime(row.lost) })
            : row.building ? t("done {time}", { time: formatTime(row.done) }) : "";
          const line = el("div", { className: "afm-step" + (hall ? " afm-hall" : "") + (row.kind === "unit" && row.done === null && row.lost !== null ? " afm-gone" : ""), title: row.kind === "unit" ? t("Go to the time and place") : t("Go to the time") },
            el("span", { className: "afm-t" }, formatTime(row.frame)),
            el("span", {}, row.count > 1 ? `${name} ×${row.count}` : name, end ? el("span", { className: "afm-end" }, ` · ${end}`) : null),
          );
          line.addEventListener("click", () => { if (row.kind === "unit") toBuilding(row.frame, row.x, row.y, row.id); else seek(row.frame); });
          list.append(line);
          this.steps.push({ el: line, frame: row.frame });
          count++;
        }
        if (!count) list.append(el("div", { className: "afm-dim" }, t("Nothing was made.")));
      } else {
        const rows = pr ? buildOrderRows(pr.build, { workers: settings.workers }) : [];
        for (const step of rows) {
          const name = step.kind === "upgrade" ? api.names.upgrade(step.id) : step.kind === "tech" ? api.names.tech(step.id) : api.names.unit(step.id);
          const hall = step.kind === "build" && TOWN_HALLS.has(step.id);
          const line = el("div", { className: "afm-step" + (hall ? " afm-hall" : ""), title: step.placement ? t("Go to the time and place") : t("Go to the time") },
            el("span", { className: "afm-t" }, formatTime(step.frame)),
            el("span", { title: step.count > 1 ? t("Ordered {n} times", { n: step.count }) : undefined }, step.count > 1 ? `${name} ×${step.count}` : name),
          );
          line.addEventListener("click", () => {
            const pl = step.placement;
            if (!pl) { seek(step.frame); return; }
            const size = api.palette.unitSize(pl.unit);
            const rect = { x0: pl.tx, y0: pl.ty, x1: pl.tx + Math.max(1, Math.ceil(size.width / 32)), y1: pl.ty + Math.max(1, Math.ceil(size.height / 32)) };
            goTo(step.frame, ((rect.x0 + rect.x1) / 2) * 32, ((rect.y0 + rect.y1) / 2) * 32, rect);
          });
          list.append(line);
          this.steps.push({ el: line, frame: step.frame });
        }
        if (!rows.length) list.append(el("div", { className: "afm-dim" }, t("No builds, units or research ordered.")));
        // Until the game is played through this is what was ordered, which is not always what was made.
        if (rows.length) body.append(w.hint(t("What was ordered. Once the game has been analysed, this shows what was really made.")));
      }
      body.append(list);
    }

    /** Who lost what in a fight, a swatch and a number a side, the side that came out ahead in bold. */
    private sides(entry: Loaded, f: Fight): (HTMLElement | null)[] {
      const byIndex = new Map(entry.report.players.map((p) => [p.player.index, p.player] as const));
      const nameOf = (index: number) => byIndex.get(index)?.name ?? t("Player {n}", { n: index + 1 });
      const amount = (count: number, value: number) => (value > 0 ? `${count} (${value})` : String(count));
      return f.sides.filter((sd) => byIndex.has(sd.player)).flatMap((sd, i) => [
        i ? el("span", { className: "afm-end" }, " · ") : null,
        el("span", { className: f.winner === sd.player ? "afm-ahead" : "", title: sd.army ? t("{name}: {army} there when it began, lost {lost}, killed {killed}", { name: nameOf(sd.player), army: amount(sd.army, sd.armyValue), lost: amount(sd.lost, sd.lostValue), killed: amount(sd.killed, sd.killedValue) }) : t("{name}: lost {lost}, killed {killed}", { name: nameOf(sd.player), lost: amount(sd.lost, sd.lostValue), killed: amount(sd.killed, sd.killedValue) }) },
          el("span", { className: "afm-swatch", style: `background:${byIndex.get(sd.player)!.color}` }), ` ${t("lost {lost}", { lost: amount(sd.lost, sd.lostValue) })}`),
      ]);
    }

    private renderSummary(body: HTMLElement, entry: Loaded): void {
      if (!entry.played) {
        body.append(w.hint(running?.entry === entry ? t("The summary shows once the game has been analysed, which is under way.") : t("The summary shows once the game has been analysed.")));
        return;
      }
      const played = entry.played;
      const players = entry.report.players;
      const byIndex = new Map(players.map((p) => [p.player.index, p] as const));
      const nameOf = (index: number) => byIndex.get(index)?.player.name ?? t("Player {n}", { n: index + 1 });
      const swatch = (index: number) => el("span", { className: "afm-swatch", style: `background:${byIndex.get(index)?.player.color ?? "#888"}` });
      const map = played.timeline.map;
      const minutes = (frames: number) => (frames < FRAMES_PER_MINUTE ? t("less than a minute") : t("{n, plural, one {# minute} other {# minutes}}", { n: Math.round(frames / FRAMES_PER_MINUTE) }));

      // Who won, and how it ended.
      const winner = winnerOf(players.map((p) => ({ index: p.player.index, left: p.leftAt !== null })), played.standing);
      const gone = players.filter((p) => p.leftAt !== null && p.player.index !== winner).sort((a, b) => a.leftAt! - b.leftAt!);
      body.append(el("div", { className: "afm-result" },
        ...(winner !== null ? [swatch(winner), ` ${t("{name} won", { name: nameOf(winner) })}`] : [t("Who won cannot be told from the replay")]),
        winner !== null && gone.length ? el("span", { className: "afm-end" }, ` · ${t("{name} left at {time}", { name: gone[gone.length - 1].player.name, time: formatTime(gone[gone.length - 1].leftAt!) })}`) : null,
      ));

      // Who led in army, and for how long: a bar the length of the game, then a line each.
      const adv = played.adv;
      if (adv) {
        const l = leads(played.timeline, adv);
        const all = Math.max(1, l.a.frames + l.b.frames + l.even);
        const bar = el("div", { className: "afm-leadbar", title: t("How long each player was ahead in army, and how long neither was far ahead") },
          el("span", { style: `flex:${l.a.frames / all};background:${byIndex.get(adv.a)?.player.color ?? "#888"}` }),
          el("span", { style: `flex:${l.even / all}` }),
          el("span", { style: `flex:${l.b.frames / all};background:${byIndex.get(adv.b)?.player.color ?? "#888"}` }),
        );
        const lines = [l.a, l.b].filter((side) => side.frames > 0).map((side) => {
          const line = el("div", { className: "afm-line", title: t("Go to when the lead was largest") }, swatch(side.player), ` ${adv.byCount
            ? t("{name} was ahead in army for {duration}, by up to {most} units at {time}", { name: nameOf(side.player), duration: minutes(side.frames), most: Math.round(side.most), time: formatTime(side.at) })
            : t("{name} was ahead in army for {duration}, by up to {most} at {time}", { name: nameOf(side.player), duration: minutes(side.frames), most: Math.round(side.most), time: formatTime(side.at) })}`);
          line.addEventListener("click", () => seek(side.at));
          return line;
        });
        body.append(w.group(t("Who led"), bar, ...lines, l.even > 0 ? el("div", { className: "afm-dim" }, t("Neither far ahead for {duration}", { duration: minutes(l.even) })) : null));
      }

      // The game in numbers, a column a player under their colour (the panel is narrow; the name is on hover).
      const rows = played.totals.filter((r) => byIndex.has(r.player));
      if (rows.length) {
        const costed = rows.some((r) => r.lost > 0 || r.killed > 0);
        const byCount = adv?.byCount ?? false;
        const table = el("div", { className: "afm-table", style: `grid-template-columns: minmax(0, 1fr) repeat(${rows.length}, minmax(0, max-content))` });
        table.append(el("span", {}), ...rows.map((r) => el("span", { className: "afm-th", title: nameOf(r.player) }, swatch(r.player))));
        const row = (label: string, value: (r: PlayerTotals) => string, title?: (r: PlayerTotals) => string) => {
          table.append(el("span", { className: "afm-dim" }, label), ...rows.map((r) => el("span", { title: title?.(r) }, value(r))));
        };
        row(t("Largest army"), (r) => String(Math.round(r.armyMost)), (r) => (byCount ? t("{n} units at {time}", { n: r.armyMost, time: formatTime(r.armyAt) }) : t("Worth {n} at {time}", { n: r.armyMost, time: formatTime(r.armyAt) })));
        row(t("Most workers"), (r) => String(r.workersMost));
        row(t("Bases"), (r) => String(r.bases), () => t("The most bases at once, the start among them"));
        row(t("Lost"), (r) => String(costed ? r.lost : r.lostUnits), (r) => t("{n, plural, one {# unit or building} other {# units and buildings}}", { n: r.lostUnits }));
        row(t("Killed"), (r) => String(costed ? r.killed : r.killedUnits), (r) => t("{n, plural, one {# unit or building} other {# units and buildings}}", { n: r.killedUnits }));
        row(t("APM"), (r) => String(byIndex.get(r.player)?.apm ?? 0), () => t("Actions per minute over the game"));
        body.append(w.group(t("In numbers"), table));
      }

      // What happened, in order: the key fights, the bases taken, who left.
      const list = el("div");
      const left = players.filter((p) => p.leftAt !== null).map((p) => ({ player: p.player.index, frame: p.leftAt! }));
      for (const line of story(played.fights, played.bases, left)) {
        let row: HTMLElement;
        if (line.kind === "fight") {
          const f = line.fight, mark = fightMark(f);
          const who = f.kind === "battle" ? f.winner : hardestHit(f);
          const what = f.kind === "workers" ? t("{name} lost workers", { name: nameOf(who!) })
            : f.kind === "buildings" ? t("{name} lost buildings", { name: nameOf(who!) })
            : who !== null ? t("{name} won a battle", { name: nameOf(who) }) : t("An even battle");
          row = el("div", { className: "afm-step afm-fight", title: t("Go to the fight") },
            el("span", { className: "afm-t" }, formatTime(f.from)),
            el("span", {},
              el("div", {}, mark ? el("span", { className: `afm-mark afm-${mark.id}`, title: translate(mark.why) }, translate(mark.label)) : null, who !== null ? swatch(who) : null, ` ${what}`, el("span", { className: "afm-end" }, ` · ${placeOf(f.x, f.y, map)}`)),
              el("div", { className: "afm-sides" }, ...this.sides(entry, f)),
            ));
          row.addEventListener("click", () => goToFight(f));
        } else if (line.kind === "base") {
          const b = line.base;
          row = el("div", { className: "afm-step afm-quiet", title: t("Go to the time and place") },
            el("span", { className: "afm-t" }, formatTime(b.frame)),
            el("span", {}, swatch(b.player), ` ${t("{name} took base {n}", { name: nameOf(b.player), n: b.nth })}`, el("span", { className: "afm-end" }, ` · ${placeOf(b.x, b.y, map)}`)));
          row.addEventListener("click", () => goTo(b.frame, b.x, b.y));
        } else {
          row = el("div", { className: "afm-step afm-quiet", title: t("Go to the time") },
            el("span", { className: "afm-t" }, formatTime(line.frame)), el("span", {}, swatch(line.player), ` ${t("{name} left", { name: nameOf(line.player) })}`));
          const at = line.frame;
          row.addEventListener("click", () => seek(at));
        }
        list.append(row);
        this.steps.push({ el: row, frame: line.frame });
      }
      body.append(w.group(t("How it went"), list));
    }

    private renderFights(body: HTMLElement, entry: Loaded): void {
      if (!entry.played) {
        body.append(w.hint(running?.entry === entry ? t("The fights show once the game has been analysed, which is under way.") : t("The fights show once the game has been analysed.")));
        return;
      }
      const byIndex = new Map(entry.report.players.map((p) => [p.player.index, p.player] as const));
      const map = entry.played.timeline.map;
      const sidesOf = (f: Fight) => this.sides(entry, f);
      // A fight that mattered: what it was and where on one line, with a mark for why it matters; who lost what below.
      const bigLine = (f: Fight) => {
        const mark = fightMark(f);
        const line = el("div", { className: "afm-step afm-fight", title: `${t("Go to the fight")}\n${t("What fell was {percent}% of everything the players in it had", { percent: Math.max(1, Math.round(f.share * 100)) })}` },
          el("span", { className: "afm-t" }, formatTime(f.from)),
          el("span", {},
            el("div", {}, mark ? el("span", { className: `afm-mark afm-${mark.id}`, title: translate(mark.why) }, translate(mark.label)) : null, translate(FIGHT_KINDS[f.kind]), el("span", { className: "afm-end" }, ` · ${placeOf(f.x, f.y, map)}`)),
            el("div", { className: "afm-sides" }, ...sidesOf(f)),
          ),
        );
        line.addEventListener("click", () => goToFight(f));
        this.steps.push({ el: line, frame: f.from });
        return line;
      };
      const fights = entry.played.fights;
      const key = fights.filter((f) => f.key), other = fights.filter((f) => !f.key && f.tier !== "minor"), minor = fights.filter((f) => f.tier === "minor");
      if (!fights.length) body.append(el("div", { className: "afm-dim" }, t("No fights: nothing much was lost in one place at one time.")));
      if (key.length) body.append(w.group(t("Key moments"), ...key.map(bigLine)));
      if (other.length) body.append(w.group(t("Other fights"), ...other.map(bigLine)));
      if (minor.length) {
        // Skirmishes folded away: a line each, no more.
        const fold = el("details", { className: "afm-fold" }, el("summary", {}, t("{n, plural, one {# skirmish} other {# skirmishes}}", { n: minor.length })));
        for (const f of minor) {
          const line = el("div", { className: "afm-step", title: t("Go to the fight") }, el("span", { className: "afm-t" }, formatTime(f.from)), el("span", {}, ...sidesOf(f)));
          line.addEventListener("click", () => goToFight(f));
          this.steps.push({ el: line, frame: f.from });
          fold.append(line);
        }
        body.append(fold);
      }
      if (fights.length) body.append(w.hint(t("Each fight is weighed against everything the players had at the time, armies and workers. The key moments are the ones that mattered most; the side that came out ahead is in bold. N and Shift+N go to the next and the previous.")));

      if (entry.played.killers.length) {
        const top = el("div");
        for (const k of entry.played.killers) {
          const owner = byIndex.get(k.player);
          const line = el("div", { className: "afm-step", title: t("Go to its first kill") },
            el("span", { className: "afm-t" }, formatTime(k.frame)),
            el("span", {}, el("span", { style: owner ? `color:${owner.color}` : "" }, api.names.unit(k.type)), el("span", { className: "afm-end" }, " · " + (k.value > 0 ? t("{n, plural, one {# kill} other {# kills}}, worth {value}", { n: k.kills, value: k.value }) : t("{n, plural, one {# kill} other {# kills}}", { n: k.kills })))),
          );
          line.addEventListener("click", () => goTo(Math.max(0, k.frame - 24), k.x, k.y));
          top.append(line);
        }
        body.append(w.group(t("Most kills"), top));
      }
    }

    private renderChat(body: HTMLElement, entry: Loaded): void {
      const players = entry.report.players;
      const byId = new Map(players.map((p) => [p.player.id, p.player] as const));
      const bySlot = new Map(entry.report.replay.players.map((p) => [p.slot, p] as const));
      const chat = el("div", { className: "afm-chat" });
      for (const line of entry.report.chat) {
        const p = bySlot.get(line.player) ?? byId.get(line.player);
        const row = el("div", {}, el("span", { className: "afm-dim" }, formatTime(line.frame) + " "), el("b", { style: p ? `color:${p.color}` : "" }, (p?.name ?? "?") + ": "), line.text);
        row.addEventListener("click", () => seek(line.frame));
        chat.append(row);
        this.steps.push({ el: row, frame: line.frame });
      }
      body.append(chat);
    }

    private renderMap(body: HTMLElement, entry: Loaded): void {
      const games = mapGames(entry), inStats = new Set(counted(entry));
      const report = currentReport();
      const mapName = plainText(entry.report.replay.header.mapName) || t("this map");
      body.append(el("div", { className: "afm-dim" }, t("Every replay of {map} you have open, taken together, and shown on the map while this tab is open.", { map: mapName })));

      // The games it takes together, each with a box to take it out, and the way to add more.
      const rows = el("div", { className: "afm-games" });
      this.running = null;
      for (const l of games) {
        const status = el("span", { className: "afm-status" }, this.statusOf(l));
        if (running?.entry === l) this.running = { el: status, entry: l };
        if (l.failed) status.title = l.failed;
        const names = l.report.players.map((p) => p.player.name).join(", ");
        const open = l === entry
          ? el("span", { className: "afm-dim" }, t("this replay"))
          : el("button", { className: "afm-link", type: "button", title: t("Watch this game in a tab of its own") }, t("Watch"));
        if (l !== entry) open.addEventListener("click", () => void openTab(l));
        rows.append(el("div", { className: "afm-game" + (inStats.has(l) ? "" : " afm-out"), title: names },
          w.checkbox(l.fileName, {
            value: !l.excluded,
            title: l.excluded ? t("Put this game back into Map stats") : t("Leave this game out of Map stats"),
            onChange: (on) => { l.excluded = !on; reportCache = null; heatCache = null; overlay.redraw(); this.render(); strip?.update(); },
          }),
          el("div", { className: "afm-sub" }, el("span", { className: "afm-names" }, `${formatTime(l.report.frames)} · ${names}`), status, open),
        ));
      }
      body.append(w.group(t("Games"),
        rows,
        w.row(w.button(t("Add replays of this map…"), { primary: games.length < 2, className: "sm", title: t("Replays added here are analysed in the background and counted, without a tab each. Replays of another map open in tabs of their own."), onClick: () => void pick(entry) })),
        !sim?.present ? w.hint(t("Here only the orders can be counted. On scmjs.dev each game is also analysed, and the starts, the bases and the fights are shown.")) : null,
      ));

      // The heat map, of the same games.
      const mode = heatMode();
      const anyPlayed = [...inStats].some((l) => l.played);
      const heatSelect = w.select([
        { value: "off", label: t("No heat map") },
        ...(anyPlayed ? (["losses", "presence"] as const).map((h) => ({ value: h, label: translate(HEAT_LABELS[h]) })) : []),
        ...(["orders", "buildings"] as const).map((h) => ({ value: h, label: translate(HEAT_LABELS[h]) })),
        ...(anyPlayed ? [{ value: "unvisited", label: translate(HEAT_LABELS.unvisited) }] : []),
      ], { value: mode === "off" && settings.heat !== "off" ? settings.heat : mode, onChange: (v) => { settings.heat = v as HeatMode; save(); heatCache = null; overlay.redraw(); this.render(); } });
      body.append(w.group(t("Heat map"), w.row(heatSelect)));

      // What the games say.
      if (!report) {
        const waiting = waitingOf(entry);
        if (sim?.present) body.append(w.hint(waiting ? t("Nothing counted yet: the games are still being analysed.") : t("Nothing to say about the map yet.")));
        return;
      }
      const place = (clock: number) => (clock ? t("{n} o'clock", { n: clock }) : t("the middle"));
      const go = (x: number, y: number, radius: number) => {
        const tx = Math.floor(x / 32), ty = Math.floor(y / 32);
        api.view.center(tx, ty);
        api.view.flash({ rect: { x0: Math.max(0, tx - radius), y0: Math.max(0, ty - radius), x1: tx + radius, y1: ty + radius }, kind: "attention" });
      };
      // Several places share an hour of the clock (a start, its natural, its third): each line ends with its tile.
      const rowOf = (head: string, text: string, title: string, click: () => void, x = -1, y = -1) => {
        const line = el("div", { className: "afm-step", title }, el("span", { className: "afm-t" }, head), el("span", {}, text, x < 0 ? null : el("span", { className: "afm-end" }, ` · ${Math.floor(x / 32)}, ${Math.floor(y / 32)}`)));
        line.style.gridTemplateColumns = "70px 1fr";
        line.addEventListener("click", click);
        return line;
      };
      const list = el("div");
      for (const site of report.sites.filter((x) => x.starts > 0)) {
        list.append(rowOf(place(site.clock),
          site.startDecided ? t("Start: {n, plural, one {# player} other {# players}}, won {wins} of {decided}", { n: site.starts, wins: site.startWins, decided: site.startDecided }) : t("Start: {n, plural, one {# player} other {# players}}", { n: site.starts }),
          t("Go to this start location"), () => go(site.x, site.y, 4), site.x, site.y));
      }
      for (const site of report.sites.filter((x) => !x.starts && x.taken > 0)) {
        list.append(rowOf(place(site.clock),
          t("Base: taken in {taken} of {games}, about {time}, usually base {order}", { taken: site.taken, games: report.games, time: formatTime(site.medianFrame ?? 0), order: site.medianOrder ?? 2 }),
          t("Go to this base"), () => go(site.x, site.y, 4), site.x, site.y));
      }
      for (const spot of report.spots.slice(0, 8)) {
        list.append(rowOf(place(spot.clock),
          spot.decided ? t("Fights: {fights} in {games, plural, one {# game} other {# games}}; the nearer player ahead in {won} of {decided}", { fights: spot.fights, games: spot.games, won: spot.nearerWon, decided: spot.decided }) : t("Fights: {fights} in {games, plural, one {# game} other {# games}}", { fights: spot.fights, games: spot.games }),
          t("Go to where the fighting was"), () => go(spot.x, spot.y, 8), spot.x, spot.y));
      }
      const facts = [
        t("{n, plural, one {# game} other {# games}} together", { n: report.games }),
        t("usual length {time}", { time: formatTime(report.medianFrames) }),
        report.medianFirstFight !== null ? t("first fight about {time}", { time: formatTime(report.medianFirstFight) }) : null,
      ].filter(Boolean).join(" · ");
      body.append(w.group(t("What the games show"),
        el("div", { className: "afm-dim" }, facts),
        el("div", { className: "afm-dim" }, t("On the map: a white ring at each start, a green ring at each base taken, a red circle where the fights that mattered were.")),
        list,
        w.hint(report.games < 3
          ? t("From few games this says little. Add more replays of this map.")
          : t("{percent}% of the map's ground was never entered by any unit, water and cliffs included. Choose Ground never entered as the heat map to see it.", { percent: Math.round(report.neverEntered * 100) })),
      ));
    }

    /** Where a game of Map stats stands, in a word or two. */
    private statusOf(l: Loaded): string {
      const parted = partedAt(l);
      if (running?.entry === l) return running.fraction < 0 ? t("analysing…") : t("analysing {percent}%", { percent: Math.floor(running.fraction * 100) });
      if (l.excluded) return t("left out");
      if (parted !== null) return t("left out: differs from {time}", { time: formatTime(parted) });
      if (l.failed) return t("could not be analysed");
      if (l.played) return t("counted");
      if (queue.includes(l)) return t("waiting");
      return sim?.present ? "" : t("counted");
    }

    /** What moves with the clock: the players' numbers, and which rows are still to come. */
    update(): void {
      const entry = current;
      if (!entry) return;
      const frame = entry.frame;
      const tl = entry.played?.timeline ?? null;
      const at = tl ? sampleIndex(tl.samples.frame, frame) : -1;
      for (const { el: readout, p } of this.live) {
        const left = p.leftAt !== null && p.leftAt <= frame;
        const series = tl ? tl.samples.players.find((s) => s.slot === p.player.index) : undefined;
        // Short, so the name keeps its room: supply once the game is played through, then actions per minute.
        const supply = series && at >= 0 ? { used: series.supplyUsed[at] ?? 0, max: series.supplyMax[at] ?? 0 } : null;
        readout.textContent = left ? t("left {time}", { time: formatTime(p.leftAt!) }) : supply ? `${supply.used}/${supply.max} · ${p.apm}` : t("{n} APM", { n: p.apm });
        readout.title = supply ? t("Supply {used} of {max} · {n} actions per minute over the game", { used: supply.used, max: supply.max, n: p.apm }) : t("Actions per minute over the game");
      }
      for (const s of this.steps) s.el.classList.toggle("afm-future", s.frame > frame);
      if (this.running?.el.isConnected) this.running.el.textContent = this.statusOf(this.running.entry);
    }
  }

  class StripView {
    readonly root: HTMLElement;
    private playButton: HTMLButtonElement | null = null;
    private timeLabel: HTMLElement | null = null;
    private status: HTMLElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private resize: ResizeObserver | null = null;
    private spectateButton: HTMLButtonElement | null = null;
    private ordersButton: HTMLButtonElement | null = null;
    private legendButton: HTMLButtonElement | null = null;
    private statsButton: HTMLButtonElement | null = null;
    private eyesSelect: HTMLSelectElement | null = null;
    /** Where the pointer is over the graph, in CSS pixels from its left; null when it is not. */
    private hover: number | null = null;
    private get canvasTitle(): string {
      return t("Fights in red, taller the more they mattered; the turning point in gold; chat in grey; a player leaving in their colour. Point at the graph to read it; press or drag to go there.");
    }

    constructor(body: HTMLElement) {
      this.root = el("div", { className: "afm-tl" });
      body.append(this.root);
    }

    render(): void {
      this.root.replaceChildren();
      this.resize?.disconnect();
      const entry = current;
      if (!entry) return;
      this.playButton = w.button("", { primary: true, className: "sm", title: t("Space plays and pauses. ← and → go 10 seconds back or on, a minute with Shift; N and Shift+N go to the next and the previous key moment; F follows the action or lets the camera go; O shows the orders; Home and End go to the start and the end."), onClick: () => (playing ? stop() : play()) });
      this.timeLabel = el("span", { className: "afm-time" });
      // A menu keeps the focus, and Space and the arrows with it: each gives it back once chosen.
      const speed = w.select([1, 2, 4, 8, 16, 32].map((n) => ({ value: n, label: `${n}×` })), { value: settings.speed, title: t("Playback speed"), onChange: (v) => { settings.speed = Number(v); save(); if (gameClock()) game.speed(settings.speed); speed.blur(); } });
      const chart = chartOf(entry);
      const chartSelect = w.select([
        ...(entry.played?.adv ? [{ value: "lead", label: t("Army lead") }] : []),
        { value: "apm", label: t("Actions per minute") },
        ...(entry.played ? [
          { value: "armyValue", label: t("Army value") },
          { value: "army", label: t("Army size") },
          { value: "workers", label: t("Workers") },
          { value: "supplyUsed", label: t("Supply") },
          { value: "minerals", label: t("Minerals in the bank") },
          { value: "gas", label: t("Gas in the bank") },
          { value: "buildings", label: t("Buildings") },
        ] : []),
      ], { value: chart, title: t("What the graph shows"), onChange: (v) => { settings.chart = v as Chart; save(); chartSelect.blur(); this.draw(); } });
      this.status = el("span", { className: "afm-dim afm-grow" });
      const retry = entry.failed && sim?.present && !running
        ? w.button(t("Try again"), { ghost: true, className: "sm", title: entry.failed, onClick: () => { queue.unshift(entry); pump(); } })
        : null;
      // The switches: the camera, the orders, Map stats, the legend.
      this.spectateButton = toggle(t("Spectate"), () => spectate());
      this.ordersButton = toggle(t("Orders"), () => showOrders(!settings.orders));
      this.legendButton = toggle(t("Legend"), () => { settings.legend = !settings.legend; save(); redraw(); this.update(); });
      this.statsButton = toggle(t("Map stats"), () => showStats(lensOf() !== "map"));
      // In the Replay view: the game as everyone sees it, or through one player's eyes, with the fog of war.
      const eyes = w.select([
        { value: -1, label: t("Vision: everyone") },
        ...entry.report.players.map((p) => ({ value: p.player.slot, label: t("Vision: {name}", { name: p.player.name }) })),
      ], { value: entry.eyes ?? -1, title: t("Whose eyes the game is seen through: one player's shows only what they could see, with the fog of war"), onChange: (v) => {
        const slot = Number(v);
        entry.eyes = slot < 0 ? null : slot;
        if (game.holds(entry.id)) game.eyes(entry.eyes);
        // (Spectate follows the player whose eyes these are.)
        follow();
        redraw();
        eyes.blur();
      } });
      this.eyesSelect = eyes;
      this.root.append(el("div", { className: "afm-row" }, this.playButton, this.timeLabel, speed,
        el("span", { className: "afm-toggles" }, this.spectateButton, this.ordersButton, this.statsButton, this.legendButton), eyes,
        this.status, retry, chartSelect));

      // The lane of marks and the graph, one canvas: press or drag anywhere on it to go there.
      const canvas = el("canvas", { title: this.canvasTitle }) as HTMLCanvasElement;
      this.canvas = canvas;
      const seekTo = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        if (current) seek(((e.clientX - r.left) / Math.max(1, r.width)) * current.report.frames);
      };
      canvas.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; canvas.setPointerCapture(e.pointerId); seekTo(e); });
      canvas.addEventListener("pointermove", (e) => {
        if (canvas.hasPointerCapture(e.pointerId)) seekTo(e);
        this.hover = e.clientX - canvas.getBoundingClientRect().left;
        this.draw();
      });
      canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
      this.root.append(canvas);
      this.resize = new ResizeObserver(() => this.draw());
      this.resize.observe(canvas);
      this.update();
    }

    /** What moves with the clock, and the engine's progress. */
    update(): void {
      const entry = current;
      if (!entry || !this.playButton) return;
      this.playButton.textContent = playing ? t("Pause") : t("Play");
      this.timeLabel!.textContent = `${formatTime(entry.frame)} / ${formatTime(entry.report.frames)}`;
      let line = "";
      let why = "";
      if (gameState && game.shown) {
        line = gameState;
      } else if (game.shown && game.seeking) {
        // (A jump starts from the nearest moment kept, the analysis's or the viewer's own, and plays on from there: a
        // long one before the analysis has been that far shows how far it has got.)
        const done = game.seekProgress;
        line = done === null || done < 0.05 ? t("Going to {time}…", { time: formatTime(entry.frame) }) : t("Going to {time}… {percent}%", { time: formatTime(entry.frame), percent: Math.floor(done * 100) });
      } else if (running?.entry === entry) {
        line = running.fraction < 0 ? t("Analysing the game…") : t("Analysing the game: {percent}%", { percent: Math.floor(running.fraction * 100) });
        why = t("The game engine plays the replay through in the background to see what really happened: the armies, the fights, what was lost. You can watch the replay meanwhile.");
      } else if (entry.played) {
        const tl = entry.played.timeline;
        line = tl.frames < tl.total ? t("Analysed up to {time}, where the game stopped.", { time: formatTime(tl.frames) }) : t("Analysed: the armies, fights and losses are shown.");
      } else if (entry.failed) {
        line = t("Could not analyse the game: {reason}", { reason: entry.failed });
      } else if (!sim?.present) {
        line = t("Showing the orders given. On scmjs.dev the game is also analysed, to show what happened.");
      } else if (queue.includes(entry)) {
        line = t("Waiting to be analysed.");
        why = t("Replays are analysed one at a time: the one in front first, then the others with a tab, then the ones only in Map stats.");
      }
      const onMap = lensOf() === "map";
      if (onMap) {
        // Map stats is no one game's: the line says what it holds, and the timeline is faded.
        const n = counted(entry).length, waiting = waitingOf(entry);
        line = [t("Map stats: {n, plural, one {# game} other {# games}} of this map together", { n }), waiting ? t("{n} still being analysed", { n: waiting }) : null].filter(Boolean).join(" · ");
        why = t("The timeline is one game's. Press it, Play or Map stats to go back to the game.");
      }
      this.status!.textContent = line;
      this.status!.title = why || line;
      // The switches as they stand: the camera lets go when the map is moved, and follows nothing until the game is analysed.
      const shots = (entry.played?.shots.length ?? 0) > 0;
      const following = shots && cam.following && !onMap;
      this.spectateButton!.classList.toggle("afm-on", following);
      this.spectateButton!.setAttribute("aria-pressed", String(following));
      this.spectateButton!.disabled = !shots;
      this.spectateButton!.title = !shots ? t("The camera follows the game once it has been analysed")
        : onMap ? t("Back to the game, with the camera following the action")
        : following ? t("F: the camera follows the action as an observer would; scroll the map, or press here, to look around yourself")
        : t("F: follow the action as an observer would: the fights that matter, armies about to meet, new bases, the armies on the move");
      this.ordersButton!.classList.toggle("afm-on", settings.orders);
      this.ordersButton!.setAttribute("aria-pressed", String(settings.orders));
      this.ordersButton!.title = game.shown ? t("O: what the players told their units to do in the last eight seconds, over the game")
        : t("O: what the players told their units to do in the last eight seconds, over the units drawn faintly");
      this.legendButton!.classList.toggle("afm-on", settings.legend);
      this.legendButton!.setAttribute("aria-pressed", String(settings.legend));
      // (Over the game only the orders have marks of Aftermath's own: there the legend keys them, and waits for them.)
      const keyless = game.shown && !onMap && !settings.orders;
      this.legendButton!.disabled = keyless;
      this.legendButton!.title = keyless ? t("Over the game the legend keys the orders: turn Orders on to see it") : t("A key to the marks, in the map's corner");
      this.eyesSelect!.hidden = !game.shown || onMap;
      const games = mapGames(entry).length;
      this.statsButton!.textContent = games > 1 ? t("Map stats · {n}", { n: games }) : t("Map stats");
      this.statsButton!.classList.toggle("afm-on", onMap);
      this.statsButton!.setAttribute("aria-pressed", String(onMap));
      this.statsButton!.title = onMap ? t("Back to the game")
        : games > 1 ? t("Every replay of this map you have open, taken together: where players start, the bases they take, where they fight ({n} replays)", { n: games })
        : t("Every replay of this map you have open, taken together: where players start, the bases they take, where they fight. Add more replays of the map there.");
      this.canvas?.classList.toggle("afm-faded", onMap);
      if (this.canvas) this.canvas.title = onMap ? t("The timeline is one game's: press it to go back to that game") : this.canvasTitle;
      this.draw();
    }

    draw(): void {
      const c = this.canvas;
      const entry = current;
      if (!c || !entry || !c.isConnected) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, cw, ch);
      const frames = entry.report.frames || 1;
      const xOf = (f: number) => (Math.min(frames, Math.max(0, f)) / frames) * cw;
      const lane = LANE * dpr;
      const graphTop = lane + 2 * dpr;
      const graphH = Math.max(1, ch - graphTop);

      // The lane: how far the engine has played it, then the marks.
      g.fillStyle = "rgba(128,128,128,0.12)";
      g.fillRect(0, 0, cw, lane);
      if (running?.entry === entry && running.fraction > 0) {
        g.fillStyle = "rgba(79,209,197,0.22)";
        g.fillRect(0, 0, cw * running.fraction, lane);
      }
      for (const line of entry.report.chat) {
        g.fillStyle = "rgba(200,205,215,0.7)";
        g.fillRect(Math.round(xOf(line.frame)), lane * 0.15, Math.max(1, dpr), lane * 0.3);
      }
      if (entry.played) {
        // A fight's mark is as tall as it mattered: a skirmish a faint sliver, a key moment the full height.
        for (const f of entry.played.fights) {
          const [top, alpha] = f.key ? [0.45, 1] : f.tier !== "minor" ? [0.65, 0.75] : [0.85, 0.4];
          g.fillStyle = `rgba(240,80,60,${alpha})`;
          g.fillRect(xOf(f.from), lane * top, Math.max(2 * dpr, xOf(f.to) - xOf(f.from)), lane * (0.97 - top));
          if (!f.turning) continue;
          // The turning point: a gold mark over it.
          const x = xOf(f.from);
          g.fillStyle = "#f0c64a";
          g.beginPath(); g.moveTo(x - 4 * dpr, 0); g.lineTo(x + 4 * dpr, 0); g.lineTo(x, lane * 0.42); g.closePath(); g.fill();
        }
      }
      for (const p of entry.report.players) {
        if (p.leftAt === null) continue;
        const x = xOf(p.leftAt);
        g.fillStyle = p.player.color;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 4 * dpr, lane * 0.5); g.lineTo(x, lane); g.closePath(); g.fill();
      }

      // The minutes, under whatever the graph shows.
      const pad = 3 * dpr;
      g.strokeStyle = "rgba(128,128,128,0.25)";
      g.lineWidth = 1;
      g.fillStyle = "rgba(160,168,184,0.9)";
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      g.textBaseline = "bottom";
      for (let m = 5; m * FRAMES_PER_MINUTE < frames; m += 5) {
        const x = Math.round(xOf(m * FRAMES_PER_MINUTE)) + 0.5;
        g.beginPath(); g.moveTo(x, graphTop); g.lineTo(x, ch); g.stroke();
        g.fillText(`${m}:00`, x + 3 * dpr, ch - 1 * dpr);
      }

      const chart = chartOf(entry);
      const adv = entry.played?.adv ?? null;
      if (chart === "lead" && adv && entry.played) {
        // The army lead: one line about the middle, filled in the colour of whoever is ahead. The key fights are
        // shaded behind it, so what each did to the lead can be seen.
        for (const f of entry.played.fights) {
          if (!f.key) continue;
          g.fillStyle = f.turning ? "rgba(240,198,74,0.16)" : "rgba(240,80,60,0.1)";
          g.fillRect(xOf(f.from), graphTop, Math.max(2 * dpr, xOf(f.to) - xOf(f.from)), graphH);
        }
        let max = 1;
        for (const n of adv.lead) max = Math.max(max, Math.abs(n));
        const mid = graphTop + graphH / 2, half = graphH / 2 - pad;
        const yOf = (n: number) => mid - (n / max) * half;
        const colourOf = (index: number) => entry.report.players.find((p) => p.player.index === index)?.player.color ?? "#a0a8b8";
        const shape = () => {
          g.beginPath();
          g.moveTo(xOf(adv.frames[0]), mid);
          adv.lead.forEach((n, i) => g.lineTo(xOf(adv.frames[i]), yOf(n)));
          g.lineTo(xOf(adv.frames[adv.frames.length - 1]), mid);
          g.closePath();
        };
        for (const [side, y0, y1] of [[adv.a, graphTop, mid], [adv.b, mid, ch]] as const) {
          g.save();
          g.beginPath(); g.rect(0, y0, cw, y1 - y0); g.clip();
          shape();
          g.fillStyle = withAlpha(colourOf(side), 0.45);
          g.fill();
          g.restore();
        }
        g.strokeStyle = "rgba(128,128,128,0.5)";
        g.beginPath(); g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(cw, Math.round(mid) + 0.5); g.stroke();
        g.strokeStyle = "rgba(230,233,240,0.85)";
        g.lineWidth = 1.25 * dpr;
        g.beginPath();
        adv.lead.forEach((n, i) => { const x = xOf(adv.frames[i]); if (i === 0) g.moveTo(x, yOf(n)); else g.lineTo(x, yOf(n)); });
        g.stroke();
        // Whose side is whose, and the scale.
        const nameOf = (index: number) => entry.report.players.find((p) => p.player.index === index)?.player.name ?? "";
        g.font = `600 ${10 * dpr}px system-ui, sans-serif`;
        g.textBaseline = "top";
        g.fillStyle = colourOf(adv.a);
        g.fillText(`${t("{name} ahead", { name: nameOf(adv.a) })} · ${Math.round(max)}`, 3 * dpr, graphTop + 1 * dpr);
        g.textBaseline = "bottom";
        g.fillStyle = colourOf(adv.b);
        g.fillText(t("{name} ahead", { name: nameOf(adv.b) }), 3 * dpr, ch - 12 * dpr);
      } else {
        // Actions per minute, or one of the engine's numbers once the game is played through.
        const tl = entry.played?.timeline ?? null;
        const metric = tl && chart !== "apm" && chart !== "lead" ? chart : null;
        const lines = entry.report.players.map((p) => {
          const values = metric ? series(tl!, p.player.index, metric) ?? [] : p.perMinute;
          const at = metric ? (i: number) => tl!.samples.frame[i] : (i: number) => Math.min(frames, (i + 0.5) * FRAMES_PER_MINUTE);
          return { p, values, at };
        });
        let max = 1;
        for (const l of lines) if (!entry.hidden.has(l.p.player.id)) for (const n of l.values) max = Math.max(max, n);
        const yOf = (n: number) => graphTop + graphH - pad - (n / max) * (graphH - pad * 2);
        for (const { p, values, at } of lines) {
          if (entry.hidden.has(p.player.id)) continue;
          g.strokeStyle = p.player.color;
          g.lineWidth = 1.5 * dpr;
          g.beginPath();
          values.forEach((n, i) => {
            const x = xOf(at(i));
            if (i === 0) g.moveTo(x, yOf(n)); else g.lineTo(x, yOf(n));
          });
          g.stroke();
        }
        // The scale's top, so a line can be read as a number.
        g.fillStyle = "rgba(160,168,184,0.9)";
        g.textBaseline = "top";
        g.fillText(String(Math.round(max)), 3 * dpr, graphTop + 1 * dpr);
      }

      // Now.
      const x = Math.round(xOf(entry.frame)) + 0.5;
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.lineWidth = 1 * dpr;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();

      // Under the pointer: the moment, what the graph says there, and the fight there if any.
      if (this.hover !== null) {
        const hx = this.hover * dpr, frame = (this.hover * dpr / cw) * frames;
        g.strokeStyle = "rgba(255,255,255,0.35)";
        g.beginPath(); g.moveTo(Math.round(hx) + 0.5, 0); g.lineTo(Math.round(hx) + 0.5, ch); g.stroke();
        const text = [formatTime(frame), ...readout(entry, chart, frame, (2 * dpr / cw) * frames)].join(" · ");
        g.font = `${11 * dpr}px system-ui, sans-serif`;
        g.textBaseline = "middle";
        const tw = g.measureText(text).width, bw = tw + 10 * dpr, bh = 18 * dpr;
        const bx = hx + 8 * dpr + bw > cw ? hx - 8 * dpr - bw : hx + 8 * dpr, by = graphTop + 2 * dpr;
        g.fillStyle = "rgba(20,22,28,0.9)";
        g.fillRect(bx, by, bw, bh);
        g.fillStyle = "#e4e8ef";
        g.fillText(text, bx + 5 * dpr, by + bh / 2);
      }
    }
  }

  /** Pick replays to open; with `into`, to add to its Map stats. */
  async function pick(into: Loaded | null = null): Promise<void> {
    const files = await api.ui.pickFiles({ accept: ".rep", multiple: true });
    if (files.length) await load(files, into);
  }

  /* ── Menus, commands, file type, events ── */

  // Titles and menu labels go to the editor in English; it shows them in the user's language from this plugin's catalogue.
  api.commands.register({ id: "open-replay", title: msg("Open Replay…"), run: () => void pick() });
  api.commands.register({
    id: "panel",
    title: "Aftermath",
    run: () => {
      if (current) { sideHidden = false; stripHidden = false; showSide(); showStrip(); return; }
      if (sidePanel?.isOpen()) { closeSide(); return; }
      sideAsked = true;
      showSide(true);
    },
  });
  api.menu.add("File", { label: msg("Open Replay…"), icon: "plugin", after: "Open Recent", command: "open-replay" });
  api.menu.add("View", { label: "Aftermath", icon: "plugin", command: "panel" });
  // A replay dropped anywhere on the editor, or picked in File ▸ Open, comes here rather than being read as a map.
  if (bottomDock) api.ui.fileType({ name: msg("StarCraft replay"), extensions: [".rep"], open: (files) => void load(files) });

  // Last: a service already there is announced at once, and the answer reaches the panels.
  const simWatch = api.services.watch<ScmSimService>("scm-sim.engine", (service) => { sim = service; game.setService(service); if (current) gameFor(current); pump(); strip?.render(); });

  api.events.on("document", () => sync());
  // The view moved by the user, even with the clock still: Spectate's camera lets go.
  api.events.on("view", () => {
    game.graphics();
    // (The game shown, the map's view is hidden and still: the minimap moves the game, and the game says so itself.)
    if (game.shown) return;
    if (!cam.following || !current?.played?.shots.length || lensOf() === "map" || api.document.id() !== current.docId || !movedByUser()) return;
    cam.following = false;
    cam.asked = [];
    redraw();
    strip?.update();
  });
  api.events.on("language", () => { side?.render(); strip?.render(); });

  return () => {
    stop();
    cancelAnimationFrame(cam.raf);
    bindKeys(false);
    running?.controller.abort();
    game.dispose();
    simWatch.dispose();
    imageListener.dispose();
    style.remove();
  };
}

/* ── Marks: each thing the overlay draws, drawn the same on the map and in its legend ── */

/** A building: its footprint in the owner's colour; dashed while it goes up, a thick edge while it is new. */
function markBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string, state: "built" | "site" | "new", img: PluginImage | null, scale: number): void {
  ctx.fillStyle = withAlpha(colour, state === "site" ? 0.1 : 0.22);
  ctx.fillRect(x, y, w, h);
  if (img) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * (state === "site" ? 0.4 : 0.9);
    ctx.drawImage(img.image, x + w / 2 - (img.width * scale) / 2, y + h / 2 - (img.height * scale) / 2, img.width * scale, img.height * scale);
    ctx.globalAlpha = a;
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = state === "new" ? 3 : 1.5;
  if (state === "site") ctx.setLineDash([4, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([]);
}

/** A unit: a dot; a worker a smaller, fainter one. */
function markUnit(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string, worker: boolean): void {
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * (worker ? 0.55 : 1);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, worker ? r * 0.7 : r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = a;
}

/** A kill: a thin line from the killer to its victim. */
function markKill(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}

/** A loss: a cross where it fell. */
function markLoss(ctx: CanvasRenderingContext2D, x: number, y: number, d: number, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
  ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
  ctx.stroke();
}

/** A fight that matters, as it goes on: a dashed box, gold for the turning point. */
function markFightBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, turning: boolean, key: boolean): void {
  ctx.strokeStyle = turning ? "rgba(240,198,74,0.9)" : "rgba(240,80,60,0.85)";
  ctx.lineWidth = key ? 2 : 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);
}

/**
 * An order: a diamond where units were sent (not a dot, which is a unit), a cross for an attack or a patrol, a ring
 * for an ability, a flag for a rally point, a widening ring for a minimap ping (and a smaller one inside). `k` is how fresh it is, 1 to 0.
 */
function markOrder(ctx: CanvasRenderingContext2D, kind: ClickKind, x: number, y: number, r: number, colour: string, k: number): void {
  ctx.strokeStyle = ctx.fillStyle = colour;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (kind === "attack" || kind === "patrol") {
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    ctx.stroke();
  } else if (kind === "ping") {
    // Two rings, the outer widening: told apart from an ability's one.
    ctx.lineWidth = 1.5;
    ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctx.moveTo(x + r + 3 + (1 - k) * 30, y);
    ctx.arc(x, y, r + 3 + (1 - k) * 30, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "rally") {
    ctx.fillRect(x - r / 2, y - r * 1.6, r * 1.2, r * 0.9);
    ctx.fillRect(x - r / 2, y - r * 1.6, 1.5, r * 1.8);
  } else if (kind === "ability") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.8, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.8, y); ctx.closePath();
    ctx.fill();
  }
}

/** Where fights happen over the map's games: a red circle, larger the more there were. */
function markSpot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = "rgba(235,70,60,0.14)";
  ctx.strokeStyle = "rgba(235,70,60,0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

/** A start (white) or a base taken (green): a dashed ring. */
function markSite(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, start: boolean): void {
  ctx.strokeStyle = start ? "rgba(255,255,255,0.9)" : "rgba(120,220,160,0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}

/* ── Helpers ────────────────────────────────────────────── */

/** The index of the first item after `frame` (binary search; the list is in frame order). */
function firstAfter(list: { frame: number }[], frame: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].frame <= frame) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Cold to hot: blue, cyan, yellow, red. */
function ramp(v: number): [number, number, number] {
  const stops: [number, number, number, number][] = [[0, 40, 80, 220], [0.35, 40, 200, 220], [0.65, 250, 220, 60], [1, 240, 50, 40]];
  for (let i = 1; i < stops.length; i++) {
    const [p1, r1, g1, b1] = stops[i];
    const [p0, r0, g0, b0] = stops[i - 1];
    if (v <= p1) {
      const k = (v - p0) / (p1 - p0);
      return [Math.round(r0 + (r1 - r0) * k), Math.round(g0 + (g1 - g0) * k), Math.round(b0 + (b1 - b0) * k)];
    }
  }
  return [240, 50, 40];
}
