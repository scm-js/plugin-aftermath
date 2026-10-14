/**
 * Aftermath — a plugin for the scmJS map editor (https://github.com/scm-js/scm-js).
 *
 * Opens StarCraft replays (`.rep`) and lays what the players did over the map they
 * played on: where every building went down and when, where units were sent, a heat map
 * of the orders, each player's build order and actions per minute, and the chat — all on
 * a timeline that plays back. Several replays of one map can be loaded and their orders
 * added into one heat map.
 *
 * A replay holds only the commands players gave, not the game's result, so what is shown
 * is what players asked for (see `analysis.ts`). The replay carries the map; when the map
 * in front is not the one the game was played on — its size, tileset and nine tenths of
 * its terrain — the plugin opens the replay's own copy.
 *
 * Where the editor has the site's game engine beside it (the scm-sim plugin), a replay can
 * also be played through: the game is run to its end out of sight, and the panel then
 * shows what happened as well — the units where they stood, the buildings that really
 * stood, what was made and lost, each player's army and economy through the game
 * (`played.ts`), and the fights and who killed what (`fights.ts`).
 *
 * `replay.ts` reads the file, `analysis.ts` makes the per-player reports and the heat
 * grid, `played.ts` reads the engine's timeline, `chk.ts` compares maps; all four are pure
 * and tested. This file is the editor side: the panel, the playback clock and the overlay.
 * It never edits the map.
 */
import type { MapView, OverlayHandle, PanelHandle, PluginApi } from "@scm-js/plugin-api";
import { analyse, buildOrderRows, formatTime, FRAMES_PER_MINUTE, heat, TOWN_HALLS, type ClickKind, type HeatGrid, type Placement, type PlayerReport, type ReplayReport } from "./analysis";
import { likeness, plainText, readChk, type ChkInfo } from "./chk";
import { FRAME_MS, parseReplay, ReplayError } from "./replay";
import { KO } from "./ko";
import { buildings as standingBuildings, isBuilding, losses, lossPoints, madeRows, presencePoints, series, unitIndex, unitsAt, WORKERS, type Metric, type Point, type Standing, type UnitIndex } from "./played";
import { fights as findFights, kills as findKills, topKillers, type Fight, type Kill, type Killer } from "./fights";
import type { ReplayTimeline, ScmSimService } from "./vendor/scm-sim";

/* ── State ──────────────────────────────────────────────── */

/** `presence` and `losses` need the game played through. */
type HeatMode = "off" | "orders" | "move" | "attack" | "buildings" | "ping" | "presence" | "losses";
type Chart = "apm" | Metric;

interface Settings {
  buildings: boolean;
  orders: boolean;
  heat: HeatMode;
  /** Heat from the whole game rather than up to the timeline. */
  wholeGame: boolean;
  /** Add every loaded replay of this map into the heat. */
  allReplays: boolean;
  speed: number;
  /** The panel in the right dock instead of floating over the map. */
  docked: boolean;
  /** SCVs, Drones and Probes in the build order. */
  workers: boolean;
  /** The units where they stood, once the game has been played through. */
  units: boolean;
  /** What the graph draws. */
  chart: Chart;
}

const DEFAULTS: Settings = { buildings: true, orders: true, heat: "off", wholeGame: false, allReplays: false, speed: 8, docked: false, workers: false, units: true, chart: "apm" };

interface Loaded {
  id: number;
  fileName: string;
  report: ReplayReport;
  map: ChkInfo;
  /** The file, for the engine to play. */
  bytes: Uint8Array;
  /** What happened in the game, once it has been played through, and what is read out of that once. */
  played: Played | null;
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
}

/** How long a click stays on the map behind the timeline. */
const TRAIL_FRAMES = 8 * 24;
/** How long a kill's line stays on the map. */
const KILL_FRAMES = 36;
/** How long a new building is marked as new. */
const NEW_FRAMES = 6 * 24;
/** Terrain shared with the replay's map for the map in front to count as the same one. */
const SAME_MAP = 0.9;

const HEAT_KINDS: Record<Exclude<HeatMode, "off" | "buildings" | "presence" | "losses">, ReadonlySet<ClickKind>> = {
  orders: new Set(["move", "attack", "patrol", "ability"]),
  move: new Set(["move"]),
  attack: new Set(["attack", "patrol"]),
  ping: new Set(["ping"]),
};

/** Marks English kept in a table or registered with the editor, for `tests/ko.test.ts` to find; it is translated where shown. */
const msg = (text: string) => text;

const RACES = [msg("Zerg"), msg("Terran"), msg("Protoss")];

const GAME_TYPES: Record<number, string> = {
  2: msg("Melee"), 3: msg("Free For All"), 4: msg("One on One"), 5: msg("Capture the Flag"), 6: msg("Greed"), 7: msg("Slaughter"),
  8: msg("Sudden Death"), 9: msg("Ladder"), 10: msg("Use Map Settings"), 11: msg("Team Melee"), 12: msg("Team Free For All"),
  13: msg("Team Capture the Flag"), 15: msg("Top vs Bottom"),
};

const STYLE = `
.afm { display: flex; flex-direction: column; gap: 8px; font-size: 12px; flex: 1; min-height: 0; overflow: auto; }
.afm > * { flex-shrink: 0; }
.afm .afm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.afm .afm-row select { flex: 1; min-width: 0; }
.afm .afm-title { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afm .afm-dim { color: var(--text-dim, #99a2b3); line-height: 1.35; }
.afm .afm-warn { color: var(--warn, #e6b95c); line-height: 1.35; }
.afm .afm-drop { border: 1px dashed var(--border, #3a4150); border-radius: 6px; padding: 14px 10px; text-align: center; color: var(--text-dim, #99a2b3); }
.afm.afm-dragging .afm-drop, .afm.afm-dragging { outline: 2px dashed var(--accent, #4fd1c5); outline-offset: -2px; }
.afm .afm-time { font-variant-numeric: tabular-nums; min-width: 88px; text-align: right; }
.afm input[type=range] { flex: 1; min-width: 0; margin: 0; }
.afm table { border-collapse: collapse; width: 100%; }
.afm td { padding: 2px 4px; white-space: nowrap; }
.afm td.afm-name { overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
.afm td.afm-num { text-align: right; font-variant-numeric: tabular-nums; }
.afm .afm-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: -1px; }
.afm canvas.afm-apm { width: 100%; height: 72px; display: block; cursor: pointer; }
.afm .afm-step .afm-end { color: var(--text-dim, #99a2b3); font-size: 11px; }
.afm .afm-step.afm-gone > span:nth-child(2) { text-decoration: line-through; text-decoration-color: var(--text-dim, #99a2b3); }
.afm .afm-list { max-height: 240px; overflow: auto; border: 1px solid var(--border, #3a4150); border-radius: 4px; }
.afm .afm-step { display: grid; grid-template-columns: 44px 1fr; gap: 6px; padding: 2px 6px; cursor: pointer; }
.afm .afm-step:hover { background: var(--hover, rgba(255,255,255,0.06)); }
.afm .afm-step.afm-future { opacity: 0.45; }
.afm .afm-step .afm-t { font-variant-numeric: tabular-nums; color: var(--text-dim, #99a2b3); }
.afm .afm-step.afm-hall { font-weight: 600; }
.afm .afm-chat { max-height: 140px; overflow: auto; }
.afm .afm-chat div { padding: 1px 0; }
`;

export function activate(api: PluginApi) {
  api.i18n.register({ ko: KO });
  const t = api.i18n.t;
  /** A string from a table (`msg`) or a `ReplayError`, in the editor's language. */
  const translate = (text: string) => api.i18n.t(text);
  const settings: Settings = { ...DEFAULTS, ...api.storage.get<Partial<Settings>>("settings", {}) };
  const save = () => api.storage.set("settings", settings);

  const loaded: Loaded[] = [];
  let nextId = 1;
  let current: Loaded | null = null;
  let frame = 0;
  let playing = false;
  let raf = 0;
  let lastTick = 0;
  const hidden = new Set<number>();
  /** Whether the map in front is the current replay's map. */
  let matches = false;
  let panel: PanelHandle | null = null;
  let view: PanelView | null = null;

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  /* ── Loading ── */

  async function load(files: File[]): Promise<void> {
    const reps = files.filter((f) => /\.rep$/i.test(f.name));
    if (!reps.length) {
      if (files.length) api.ui.toast({ kind: "warn", title: t("Not a replay"), detail: t("Aftermath opens StarCraft replays, files ending in .rep.") });
      return;
    }
    let first: Loaded | null = null;
    for (const file of reps) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const replay = await parseReplay(bytes);
        const entry: Loaded = { id: nextId++, fileName: file.name, report: analyse(replay), map: readChk(replay.chk), bytes, played: null };
        loaded.push(entry);
        first ??= entry;
      } catch (err) {
        const detail = err instanceof ReplayError ? translate(err.message) : String(err);
        api.ui.toast({ kind: "error", title: t("Could not read {name}", { name: file.name }), detail });
        api.log("Aftermath:", file.name, err);
      }
    }
    if (!first) return;
    void api.data.load();
    void api.graphics.load();
    await select(first, true);
  }

  async function select(entry: Loaded, openMap: boolean): Promise<void> {
    stop();
    current = entry;
    frame = 0;
    hidden.clear();
    heatCache = null;
    checkMap();
    if (!matches && openMap) await openReplayMap();
    for (const p of entry.report.players) for (const pl of p.placements) api.graphics.requestUnit(pl.unit);
    showPanel();
    view?.render();
    overlay.show();
    overlay.redraw();
    if (matches) void api.view.reveal({ x0: 0, y0: 0, x1: entry.map.width, y1: entry.map.height }, { fit: true, animate: false, margin: 0 });
  }

  function remove(entry: Loaded): void {
    const at = loaded.indexOf(entry);
    if (at < 0) return;
    if (running?.entry === entry) running.controller.abort();
    loaded.splice(at, 1);
    if (current === entry) {
      stop();
      current = loaded[Math.min(at, loaded.length - 1)] ?? null;
      frame = 0;
      hidden.clear();
      checkMap();
    }
    heatCache = null;
    view?.render();
    overlay.redraw();
  }

  async function openReplayMap(): Promise<void> {
    if (!current) return;
    const name = plainText(current.report.replay.header.mapName) || t("Replay map");
    const ok = await api.document.open(current.report.replay.chk, `${name.replace(/[\\/:*?"<>|]/g, "_")}.scx`, { into: "new" });
    if (ok) checkMap();
  }

  function checkMap(): void {
    const scn = api.document.scenario();
    const info = api.document.info();
    matches = !!(current && scn && info && likeness(current.map, { width: info.width, height: info.height, tileset: info.era & 7, tiles: scn.tiles }) >= SAME_MAP);
  }

  /* ── Playback ── */

  function seek(f: number): void {
    if (!current) return;
    frame = Math.max(0, Math.min(current.report.frames, Math.round(f)));
    view?.update();
    overlay.redraw();
  }

  function play(): void {
    if (!current || playing) return;
    if (frame >= current.report.frames) frame = 0;
    playing = true;
    lastTick = performance.now();
    const tick = (now: number) => {
      if (!playing || !current) return;
      const dt = now - lastTick;
      lastTick = now;
      frame = Math.min(current.report.frames, frame + (dt / FRAME_MS) * settings.speed);
      if (frame >= current.report.frames) playing = false;
      view?.update();
      overlay.redraw();
      if (playing) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    view?.update();
  }

  function stop(): void {
    playing = false;
    cancelAnimationFrame(raf);
    view?.update();
  }

  /* ── Playing the game through (the scm-sim plugin's engine) ── */

  let sim: ScmSimService | null = null;
  const simWatch = api.services.watch<ScmSimService>("scm-sim.engine", (service) => { sim = service; view?.render(); });
  /** The replay the engine is playing now, and how far it is (0 to 1; -1 while the engine starts). */
  let running: { entry: Loaded; controller: AbortController; fraction: number } | null = null;

  async function playThrough(entry: Loaded): Promise<void> {
    if (!sim?.present || running || entry.played) return;
    const run = { entry, controller: new AbortController(), fraction: -1 };
    running = run;
    view?.render();
    try {
      const state = await sim.status();
      if (!state.available) throw new Error(state.reason ?? t("The game engine cannot run a game here."));
      const timeline = await sim.analyse(entry.bytes, {
        name: entry.fileName,
        signal: run.controller.signal,
        onProgress: (p) => { run.fraction = p.stage === "playing" && p.frames > 0 ? p.frame / p.frames : -1; view?.progress(); },
      });
      // (The costs come from the game's unit table, when the editor has the game's data.)
      await api.data.load();
      const units = api.data.units();
      const cost = (type: number) => (units ? (units.mineralCost[type] ?? 0) + (units.vespeneCost[type] ?? 0) : 0);
      const index = unitIndex(timeline);
      entry.played = { timeline, standing: standingBuildings(timeline), index, lost: lossPoints(timeline), lostBy: losses(timeline, cost), fights: findFights(timeline, cost, index), kills: findKills(timeline), killers: topKillers(timeline, cost) };
      for (const b of entry.played.standing) api.graphics.requestUnit(b.type);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        api.ui.toast({ kind: "error", title: t("Could not play {name} through", { name: entry.fileName }), detail: err instanceof Error ? err.message : String(err) });
        api.log("Aftermath:", entry.fileName, err);
      }
    } finally {
      if (running === run) running = null;
      heatCache = null;
      view?.render();
      overlay.redraw();
    }
  }

  /** Every loaded replay that has not been played through, one after another. Stopping one stops the rest. */
  let queued = 0;
  async function playAll(): Promise<void> {
    if (running || queued) return;
    const todo = loaded.filter((l) => !l.played);
    queued = todo.length;
    for (const entry of todo) {
      if (!loaded.includes(entry)) { queued--; continue; }
      await playThrough(entry);
      queued--;
      if (!entry.played) break;
    }
    queued = 0;
    view?.render();
  }

  /* ── Heat ── */

  let heatCache: { key: string; grid: HeatGrid; canvas: HTMLCanvasElement } | null = null;

  function heatSources(): { report: ReplayReport; players: PlayerReport[] }[] {
    if (!current) return [];
    if (!settings.allReplays) return [{ report: current.report, players: current.report.players.filter((p) => !hidden.has(p.player.id)) }];
    return loaded
      .filter((l) => l === current || likeness(current!.map, l.map) >= SAME_MAP)
      .map((l) => ({ report: l.report, players: l.report.players }));
  }

  const playedOf = (report: ReplayReport): Played | null => loaded.find((l) => l.report === report)?.played ?? null;

  function heatCanvas(): HTMLCanvasElement | null {
    if (!current || settings.heat === "off") return null;
    const whole = settings.wholeGame || settings.allReplays;
    const until = whole ? undefined : Math.floor(frame / 12) * 12;
    const sources = heatSources();
    const played = settings.heat === "presence" || settings.heat === "losses";
    if (played && !sources.some((s) => playedOf(s.report))) return null;
    const key = [settings.heat, until ?? "all", played ? sources.filter((s) => playedOf(s.report)).length : "", sources.map((s) => `${s.report.replay.header.started?.getTime()}:${s.players.map((p) => p.player.id).join(".")}`).join("|")].join("/");
    if (heatCache?.key === key) return heatCache.canvas;

    const { width, height } = current.map;
    const points = function* () {
      for (const s of sources) {
        if (played) {
          const pl = playedOf(s.report);
          if (!pl) continue;
          // The timeline names a player by the game's number; the panel hides one by the id its commands carry.
          const shown = new Set(s.players.map((p) => p.player.index));
          for (const pt of settings.heat === "losses" ? pl.lost : presencePoints(pl.timeline, pl.index)) if (shown.has(pt.player)) yield { ...pt, kind: "move" as ClickKind };
          continue;
        }
        for (const p of s.players) {
          if (settings.heat === "buildings") {
            for (const pl of p.placements) {
              const size = api.palette.unitSize(pl.unit);
              yield { frame: pl.frame, player: pl.player, x: pl.tx * 32 + size.width / 2, y: pl.ty * 32 + size.height / 2, kind: "move" as ClickKind };
            }
          } else yield* p.clicks;
        }
      }
    };
    const grid = heat(points(), width, height, { until, kinds: settings.heat === "buildings" || settings.heat === "presence" || settings.heat === "losses" ? undefined : HEAT_KINDS[settings.heat] });
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

  const standing = (p: Placement) => p.frame <= frame;

  function draw(ctx: CanvasRenderingContext2D, v: MapView): void {
    if (!current || !matches) return;
    const s = v.tilePx / 32;
    const hc = heatCanvas();
    if (hc) {
      const x0 = v.x(0), y0 = v.y(0);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(hc, x0, y0, v.x(current.map.width * 32) - x0, v.y(current.map.height * 32) - y0);
      ctx.restore();
    }
    const players = current.report.players.filter((p) => !hidden.has(p.player.id));

    const done = current.played;
    if (done) {
      const byIndex = new Map(players.map((p) => [p.player.index, p] as const));
      if (settings.buildings) {
        // What stood at this moment: a site is fainter until it is finished.
        for (const b of done.standing) {
          if (b.from > frame || (b.to !== null && b.to <= frame)) continue;
          const p = byIndex.get(b.owner);
          if (!p) continue;
          const size = api.palette.unitSize(b.type);
          const w = size.width * s, h = size.height * s;
          const x = v.x(b.x) - w / 2, y = v.y(b.y) - h / 2;
          const built = b.done !== null && b.done <= frame;
          ctx.fillStyle = withAlpha(p.player.color, built ? 0.22 : 0.1);
          ctx.fillRect(x, y, w, h);
          const img = s >= 0.4 ? api.graphics.unitImage(b.type, { owner: p.player.index }) : null;
          if (img) {
            ctx.globalAlpha = built ? 0.9 : 0.4;
            ctx.drawImage(img.image, x + w / 2 - (img.width * s) / 2, y + h / 2 - (img.height * s) / 2, img.width * s, img.height * s);
            ctx.globalAlpha = 1;
          }
          const age = frame - b.from;
          ctx.strokeStyle = p.player.color;
          ctx.lineWidth = age < NEW_FRAMES ? 3 : 1.5;
          if (!built) ctx.setLineDash([4, 3]);
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          ctx.setLineDash([]);
        }
      }
      if (settings.units) {
        const r = Math.max(1.5, Math.min(5, 4 * s));
        unitsAt(done.timeline, frame, (unit, ux, uy) => {
          const type = done.index.type[unit];
          const p = byIndex.get(done.index.owner[unit]);
          if (!p || type < 0 || isBuilding(type)) return;
          ctx.fillStyle = p.player.color;
          ctx.globalAlpha = WORKERS.has(type) ? 0.55 : 1;
          ctx.beginPath();
          ctx.arc(v.x(ux), v.y(uy), WORKERS.has(type) ? r * 0.7 : r, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      }
      // A kill is a line from the killer to where its victim fell, for a moment, in the killer's colour.
      const shots = done.kills;
      for (let i = firstAfter(shots, frame - KILL_FRAMES); i < shots.length && shots[i].frame <= frame; i++) {
        const k = shots[i], p = byIndex.get(k.by);
        if (!p || !byIndex.has(k.player)) continue;
        ctx.strokeStyle = withAlpha(p.player.color, 0.9 * (1 - (frame - k.frame) / KILL_FRAMES));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(v.x(k.fromX), v.y(k.fromY)); ctx.lineTo(v.x(k.x), v.y(k.y));
        ctx.stroke();
      }
      // Losses flash where they fell.
      const lost = done.lost;
      for (let i = firstAfter(lost, frame - NEW_FRAMES); i < lost.length && lost[i].frame <= frame; i++) {
        const p = byIndex.get(lost[i].player);
        if (!p) continue;
        const k = (frame - lost[i].frame) / NEW_FRAMES;
        ctx.strokeStyle = withAlpha(p.player.color, 1 - k);
        ctx.lineWidth = 1.5;
        const x = v.x(lost[i].x), y = v.y(lost[i].y), d = 3 + k * 6;
        ctx.beginPath();
        ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
        ctx.stroke();
      }
    } else if (settings.buildings) {
      for (const p of players) {
        for (const pl of p.placements) {
          if (!standing(pl)) break;
          const size = api.palette.unitSize(pl.unit);
          const x = v.x(pl.tx * 32), y = v.y(pl.ty * 32);
          const w = size.width * s, h = size.height * s;
          ctx.fillStyle = withAlpha(p.player.color, 0.22);
          ctx.fillRect(x, y, w, h);
          const img = s >= 0.4 ? api.graphics.unitImage(pl.unit, { owner: p.player.index }) : null;
          if (img) {
            ctx.globalAlpha = 0.85;
            ctx.drawImage(img.image, x + w / 2 - (img.width * s) / 2, y + h / 2 - (img.height * s) / 2, img.width * s, img.height * s);
            ctx.globalAlpha = 1;
          }
          const age = frame - pl.frame;
          ctx.strokeStyle = p.player.color;
          ctx.lineWidth = age < NEW_FRAMES ? 3 : 1.5;
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          if (age < NEW_FRAMES) {
            const k = age / NEW_FRAMES;
            ctx.strokeStyle = withAlpha(p.player.color, 1 - k);
            ctx.lineWidth = 2;
            const grow = 4 + k * 18 * Math.max(0.5, s);
            ctx.strokeRect(x - grow, y - grow, w + grow * 2, h + grow * 2);
          }
        }
      }
    }

    if (settings.orders) {
      for (const p of players) {
        const clicks = p.clicks;
        let i = firstAfter(clicks, frame - TRAIL_FRAMES);
        for (; i < clicks.length && clicks[i].frame <= frame; i++) {
          const c = clicks[i];
          const k = 1 - (frame - c.frame) / TRAIL_FRAMES;
          const x = v.x(c.x), y = v.y(c.y);
          const r = Math.max(2.5, 5 * Math.min(1, s * 2));
          ctx.globalAlpha = Math.max(0.1, k);
          ctx.strokeStyle = ctx.fillStyle = p.player.color;
          ctx.lineWidth = 2;
          if (c.kind === "attack" || c.kind === "patrol") {
            ctx.beginPath();
            ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
            ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
            ctx.stroke();
          } else if (c.kind === "ping") {
            ctx.beginPath();
            ctx.arc(x, y, r + (1 - k) * 30, 0, Math.PI * 2);
            ctx.stroke();
          } else if (c.kind === "rally") {
            ctx.fillRect(x - r / 2, y - r * 1.6, r * 1.2, r * 0.9);
            ctx.fillRect(x - r / 2, y - r * 1.6, 1.5, r * 1.8);
          } else if (c.kind === "ability") {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  const overlay: OverlayHandle = api.ui.overlay({
    name: "Aftermath",
    visible: false,
    above: "objects",
    draw,
  });
  const imageListener = api.graphics.onImageLoaded(() => { if (current && overlay.isVisible()) overlay.redraw(); });

  /* ── The panel ── */

  function showPanel(): void {
    if (panel?.isOpen()) return;
    const place = settings.docked
      ? { dock: "right" as const, grow: true }
      : { width: 330, height: Math.min(680, Math.max(360, window.innerHeight - 220)), resizable: true };
    const handle: PanelHandle = api.ui.panel({
      title: "Aftermath",
      ...place,
      mount(body) {
        const v = new PanelView(body);
        view = v;
        v.render();
        return () => { if (view === v) view = null; };
      },
      // Moving between the dock and the float closes one panel and opens another; the old
      // one's close must not take the new one with it.
      onClose: () => { if (panel === handle) { panel = null; view = null; stop(); } },
    });
    panel = handle;
  }

  /** Move the panel to the other side of the dock line; a closed panel opens there next time. */
  function setDocked(docked: boolean): void {
    if (settings.docked === docked) return;
    settings.docked = docked;
    save();
    if (!panel?.isOpen()) return;
    const old = panel;
    panel = null;
    old.close();
    showPanel();
  }
  const moveDock = () => setDocked(!settings.docked);

  /* ── The plugin's page under Edit ▸ Preferences ▸ Plugins: where the panel opens. Written on OK or Apply. ── */

  let dockField: HTMLSelectElement | null = null;
  api.ui.preferencesPage({
    mount(body) {
      const w = api.ui.widgets;
      dockField = w.select([{ value: "float", label: t("Floating over the map") }, { value: "right", label: t("Docked on the right") }], { value: settings.docked ? "right" : "float" });
      body.append(
        w.form([{ label: t("Panel"), field: dockField }]),
        w.hint(t("A floating panel is dragged about and resized from its corner; a docked one sits in the right-hand column beside the map. The Dock and Float button in the panel does the same.")),
      );
      return () => { dockField = null; };
    },
    apply() { if (dockField) setDocked(dockField.value === "right"); },
    reset() { if (dockField) dockField.value = DEFAULTS.docked ? "right" : "float"; },
  });

  const w = api.ui.widgets;

  class PanelView {
    readonly root: HTMLElement;
    private slider: HTMLInputElement | null = null;
    private timeLabel: HTMLElement | null = null;
    private playButton: HTMLButtonElement | null = null;
    private apm: HTMLCanvasElement | null = null;
    private steps: { el: HTMLElement; frame: number }[] = [];
    private buildPlayer = -1;
    private bar: { set(value: number | null, label?: string): void } | null = null;

    constructor(body: HTMLElement) {
      this.root = api.ui.el("div", { className: "afm" });
      body.append(this.root);
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
        void load(files);
      });
    }

    render(): void {
      this.root.replaceChildren();
      this.steps = [];
      const el = api.ui.el;
      const openButton = w.button(t("Open Replay…"), { onClick: () => void pick() });
      const dockButton = w.button(settings.docked ? t("Float") : t("Dock"), {
        ghost: true,
        title: settings.docked ? t("Float the panel over the map") : t("Put the panel in the right dock, beside the map"),
        onClick: moveDock,
      });

      if (!current) {
        this.root.append(
          el("div", { className: "afm-drop" }, t("Drop replays (.rep) here, or")),
          w.row(openButton, dockButton),
          w.hint(t("A replay records the orders players gave, not what happened, so Aftermath shows what was asked for: buildings placed, where units were sent, build orders and actions per minute.")),
        );
        return;
      }
      const rep = current.report.replay;
      const entry = current;

      // Which replay.
      const choices = loaded.map((l) => ({ value: l.id, label: `${plainText(l.report.replay.header.mapName) || l.fileName} — ${l.report.players.map((p) => p.player.name).join(", ")}` }));
      this.root.append(
        loaded.length > 1
          ? w.row(w.select(choices, { value: current.id, onChange: (id) => { const l = loaded.find((x) => x.id === Number(id)); if (l) void select(l, true); } }))
          : el("div", { className: "afm-title", title: current.fileName }, plainText(rep.header.mapName) || current.fileName),
        w.row(openButton, w.button(t("Close"), { ghost: true, title: t("Close this replay"), onClick: () => remove(entry) }), el("span", { style: "flex:1" }), dockButton),
      );

      const facts = [
        (GAME_TYPES[rep.header.gameType] ? translate(GAME_TYPES[rep.header.gameType]) : null) ?? t("Game type {n}", { n: rep.header.gameType }),
        formatTime(current.report.frames),
        rep.header.started ? rep.header.started.toLocaleDateString() : null,
        rep.format === "legacy" ? t("before 1.18") : rep.format === "1.18" ? "1.18–1.20" : "1.21+",
      ].filter(Boolean).join(" · ");
      this.root.append(el("div", { className: "afm-dim" }, facts));

      // Playing the game through, where the site's engine is beside the editor.
      this.bar = null;
      if (entry.played) {
        const tl = entry.played.timeline;
        this.root.append(el("div", { className: "afm-dim" }, tl.frames < tl.total
          ? t("Played through to {time}, where the game stopped. Buildings, units, what was made and the graphs below are what happened.", { time: formatTime(tl.frames) })
          : t("Played through. Buildings, units, what was made and the graphs below are what happened.")));
      } else if (running?.entry === entry) {
        const run = running;
        const bar = w.progressBar({ value: null, label: t("Starting the game…") });
        this.bar = bar;
        this.root.append(bar, w.row(w.button(t("Stop"), { ghost: true, onClick: () => run.controller.abort() })));
        this.progress();
      } else if (sim?.present) {
        const unplayed = loaded.filter((l) => !l.played).length;
        this.root.append(
          w.row(
            w.button(t("Play the game through"), { primary: true, disabled: running !== null, title: running ? t("Another replay is being played through") : undefined, onClick: () => void playThrough(entry) }),
            unplayed > 1 && w.button(t("Play all {n} through", { n: unplayed }), { disabled: running !== null, title: t("One after another; the heat maps can then add every game of this map together"), onClick: () => void playAll() }),
          ),
          w.hint(t("Runs the whole game out of sight in the site's game engine, from your own copy of StarCraft, to show what happened and not only what was ordered. It takes about fifteen seconds for a twenty-minute game.")),
        );
        if (running) this.root.append(el("div", { className: "afm-dim" }, queued > 1 ? t("Playing {name} through; {n} more to go.", { name: running.entry.fileName, n: queued - 1 }) : t("Playing {name} through.", { name: running.entry.fileName })));
      }

      if (!matches) {
        this.root.append(
          el("div", { className: "afm-warn" }, t("The map in front is not the one this game was played on.")),
          w.row(w.button(t("Open the replay's map"), { primary: true, onClick: () => void openReplayMap().then(() => this.render()) })),
        );
      }
      if (rep.unknownCommands > 0) this.root.append(w.hint(t("{n, plural, one {# command of a kind Aftermath does not know was skipped.} other {# commands of a kind Aftermath does not know were skipped.}}", { n: rep.unknownCommands })));

      // Timeline.
      this.playButton = w.button("", { onClick: () => (playing ? stop() : play()) });
      this.slider = el("input", { type: "range", min: "0", max: String(current.report.frames), step: "1", value: String(frame) }) as HTMLInputElement;
      this.slider.addEventListener("input", () => seek(Number(this.slider!.value)));
      this.timeLabel = el("span", { className: "afm-time" });
      const speed = w.select([1, 2, 4, 8, 16, 32].map((n) => ({ value: n, label: `${n}×` })), { value: settings.speed, title: t("Playback speed"), onChange: (v) => { settings.speed = Number(v); save(); } });
      speed.style.flex = "0 0 auto";
      this.root.append(w.row(this.playButton, this.slider), w.row(this.timeLabel, el("span", { style: "flex:1" }), speed));

      // Players.
      const table = el("table");
      for (const p of current.report.players) {
        const tick = w.checkbox("", { value: !hidden.has(p.player.id), title: t("Show this player on the map"), onChange: (on) => { if (on) hidden.delete(p.player.id); else hidden.add(p.player.id); heatCache = null; overlay.redraw(); this.drawApm(); } });
        table.append(el("tr", {},
          el("td", {}, tick),
          el("td", {}, el("span", { className: "afm-swatch", style: `background:${p.player.color}` })),
          el("td", { className: "afm-name", title: p.player.name }, p.player.name),
          el("td", {}, (RACES[p.player.race] ? translate(RACES[p.player.race]) : t("Random"))),
          el("td", { className: "afm-num", title: t("Actions per minute") }, t("{n} APM", { n: p.apm })),
          el("td", { className: "afm-dim" }, p.leftAt === null ? "" : t("left {time}", { time: formatTime(p.leftAt) })),
        ));
        if (entry.played) {
          // What the player lost, on a line of its own: the panel is narrow.
          const lost = entry.played.lostBy.get(p.player.index) ?? { units: 0, value: 0 };
          const text = lost.value > 0 ? t("Lost {n}, worth {value}", { n: lost.units, value: lost.value }) : t("Lost {n}", { n: lost.units });
          table.append(el("tr", {}, el("td"), el("td"), el("td", { className: "afm-dim", colSpan: 4, title: t("Units and buildings lost, and what they cost in minerals and gas") }, text)));
        }
      }
      this.root.append(table);

      // A graph over the game: actions per minute, or one of the engine's numbers once the game is played through.
      const chart: Chart = entry.played ? settings.chart : "apm";
      if (entry.played) {
        this.root.append(w.row(w.select([
          { value: "apm", label: t("Actions per minute") },
          { value: "armyValue", label: t("Army value") },
          { value: "army", label: t("Army size") },
          { value: "workers", label: t("Workers") },
          { value: "supplyUsed", label: t("Supply") },
          { value: "minerals", label: t("Minerals in the bank") },
          { value: "gas", label: t("Gas in the bank") },
          { value: "buildings", label: t("Buildings") },
        ], { value: chart, title: t("What the graph shows"), onChange: (v) => { settings.chart = v as Chart; save(); this.render(); } })));
      }
      this.apm = el("canvas", { className: "afm-apm", title: chart === "apm" ? t("Actions per minute over the game — click to go there") : t("Click to go there") }) as HTMLCanvasElement;
      this.apm.addEventListener("click", (e) => {
        const r = this.apm!.getBoundingClientRect();
        seek(((e.clientX - r.left) / r.width) * current!.report.frames);
      });
      this.root.append(this.apm);

      // What to show.
      const heatSelect = w.select([
        { value: "off", label: t("No heat map") },
        { value: "orders", label: t("Heat: all orders") },
        { value: "move", label: t("Heat: moves") },
        { value: "attack", label: t("Heat: attacks") },
        { value: "buildings", label: t("Heat: buildings") },
        { value: "ping", label: t("Heat: minimap pings") },
        ...(entry.played ? [{ value: "presence", label: t("Heat: where the armies were") }, { value: "losses", label: t("Heat: where units were lost") }] : []),
      ], { value: !entry.played && (settings.heat === "presence" || settings.heat === "losses") ? "off" : settings.heat, onChange: (v) => { settings.heat = v as HeatMode; save(); heatCache = null; overlay.redraw(); this.render(); } });
      const sameMap = loaded.filter((l) => likeness(entry.map, l.map) >= SAME_MAP).length;
      this.root.append(w.group(t("Show"),
        w.row(
          w.checkbox(t("Buildings"), { value: settings.buildings, title: entry.played ? t("The buildings that stood at this moment; a site is drawn fainter until it is finished") : t("Every building ordered so far"), onChange: (on) => { settings.buildings = on; save(); overlay.redraw(); } }),
          entry.played ? w.checkbox(t("Units"), { value: settings.units, title: t("Where every unit stood at this moment; workers are drawn smaller"), onChange: (on) => { settings.units = on; save(); overlay.redraw(); } }) : null,
          w.checkbox(t("Recent orders"), { value: settings.orders, title: t("Where units were sent in the last 8 seconds"), onChange: (on) => { settings.orders = on; save(); overlay.redraw(); } }),
        ),
        w.row(heatSelect),
        settings.heat !== "off" && w.row(
          w.checkbox(t("Whole game"), { value: settings.wholeGame, title: t("Count the whole game rather than up to the timeline"), disabled: settings.allReplays, onChange: (on) => { settings.wholeGame = on; save(); heatCache = null; overlay.redraw(); } }),
          sameMap > 1 && w.checkbox(t("All {n} replays of this map", { n: sameMap }), { value: settings.allReplays, onChange: (on) => { settings.allReplays = on; save(); heatCache = null; overlay.redraw(); this.render(); } }),
        ),
      ));

      // Build order.
      const players = current.report.players;
      if (!players.some((p) => p.player.id === this.buildPlayer)) this.buildPlayer = players[0]?.player.id ?? -1;
      const who = w.select(players.map((p) => ({ value: p.player.id, label: p.player.name })), { value: this.buildPlayer, onChange: (id) => { this.buildPlayer = Number(id); this.render(); } });
      const list = el("div", { className: "afm-list" });
      const pr = players.find((p) => p.player.id === this.buildPlayer);
      const goTo = (frame: number, x: number, y: number, type: number) => {
        seek(frame);
        const size = api.palette.unitSize(type);
        const tw = Math.max(1, Math.ceil(size.width / 32)), th = Math.max(1, Math.ceil(size.height / 32));
        const tx = Math.max(0, Math.floor(x / 32 - tw / 2)), ty = Math.max(0, Math.floor(y / 32 - th / 2));
        api.view.center(Math.floor(x / 32), Math.floor(y / 32));
        api.view.flash({ rect: { x0: tx, y0: ty, x1: tx + tw, y1: ty + th }, kind: "attention" });
      };
      let rowCount = 0;
      if (entry.played && pr) {
        // What happened: every line is something that was really started, with what became of it.
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
          line.addEventListener("click", () => { if (row.kind === "unit") goTo(row.frame, row.x, row.y, row.id); else seek(row.frame); });
          list.append(line);
          this.steps.push({ el: line, frame: row.frame });
          rowCount++;
        }
        if (!rowCount) list.append(el("div", { className: "afm-dim", style: "padding:6px" }, t("Nothing was made.")));
      } else {
      const rows = pr ? buildOrderRows(pr.build, { workers: settings.workers }) : [];
      for (const step of rows) {
        const name = step.kind === "upgrade" ? api.names.upgrade(step.id) : step.kind === "tech" ? api.names.tech(step.id) : api.names.unit(step.id);
        const hall = step.kind === "build" && TOWN_HALLS.has(step.id);
        const row = el("div", { className: "afm-step" + (hall ? " afm-hall" : ""), title: step.placement ? t("Go to the time and place") : t("Go to the time") },
          el("span", { className: "afm-t" }, formatTime(step.frame)),
          el("span", { title: step.count > 1 ? t("Ordered {n} times", { n: step.count }) : undefined }, step.count > 1 ? `${name} ×${step.count}` : name),
        );
        row.addEventListener("click", () => {
          seek(step.frame);
          const pl = step.placement;
          if (pl) {
            const size = api.palette.unitSize(pl.unit);
            const rect = { x0: pl.tx, y0: pl.ty, x1: pl.tx + Math.max(1, Math.ceil(size.width / 32)), y1: pl.ty + Math.max(1, Math.ceil(size.height / 32)) };
            api.view.center(Math.floor((rect.x0 + rect.x1) / 2), Math.floor((rect.y0 + rect.y1) / 2));
            api.view.flash({ rect, kind: "attention" });
          }
        });
        list.append(row);
        this.steps.push({ el: row, frame: step.frame });
      }
      if (!rows.length) list.append(el("div", { className: "afm-dim", style: "padding:6px" }, t("No builds, units or research ordered.")));
      }
      const workers = w.checkbox(t("Workers"), { value: settings.workers, title: t("Show SCVs, Drones and Probes"), onChange: (on) => { settings.workers = on; save(); this.render(); } });
      this.root.append(w.group(entry.played ? t("What was made") : t("Build order"), w.row(who, workers), list));

      // The fights, and the units that killed the most, once the game has been played through.
      if (entry.played) {
        const byIndex = new Map(players.map((p) => [p.player.index, p.player] as const));
        const nameOf = (index: number) => byIndex.get(index)?.name ?? t("Player {n}", { n: index + 1 });
        const amount = (count: number, value: number) => (value > 0 ? `${count} (${value})` : String(count));
        const fightList = el("div", { className: "afm-list" });
        for (const f of entry.played.fights) {
          const sides = f.sides.filter((sd) => byIndex.has(sd.player));
          const line = el("div", { className: "afm-step", title: t("Go to the fight") },
            el("span", { className: "afm-t" }, formatTime(f.from)),
            el("span", {}, ...sides.flatMap((sd, i) => [
              i ? el("span", { className: "afm-end" }, " · ") : null,
              el("span", { style: `color:${byIndex.get(sd.player)!.color};${f.winner === sd.player ? "font-weight:600" : ""}`, title: sd.army ? t("{name}: {army} there when it began, lost {lost}, killed {killed}", { name: nameOf(sd.player), army: amount(sd.army, sd.armyValue), lost: amount(sd.lost, sd.lostValue), killed: amount(sd.killed, sd.killedValue) }) : t("{name}: lost {lost}, killed {killed}", { name: nameOf(sd.player), lost: amount(sd.lost, sd.lostValue), killed: amount(sd.killed, sd.killedValue) }) }, t("{name} lost {lost}", { name: nameOf(sd.player), lost: amount(sd.lost, sd.lostValue) })),
            ])),
          );
          line.addEventListener("click", () => {
            // A moment before the first death, so the fight is seen to begin.
            seek(Math.max(0, f.from - 48));
            const rect = { x0: Math.max(0, Math.floor(f.rect.x0 / 32) - 2), y0: Math.max(0, Math.floor(f.rect.y0 / 32) - 2), x1: Math.ceil(f.rect.x1 / 32) + 2, y1: Math.ceil(f.rect.y1 / 32) + 2 };
            api.view.center(Math.floor(f.x / 32), Math.floor(f.y / 32));
            api.view.flash({ rect, kind: "attention" });
          });
          fightList.append(line);
          this.steps.push({ el: line, frame: f.from });
        }
        if (!entry.played.fights.length) fightList.append(el("div", { className: "afm-dim", style: "padding:6px" }, t("No fights: nothing much was lost in one place at one time.")));
        this.root.append(w.group(t("Fights"), fightList, w.hint(t("Losses close together in time and place. The side that came out ahead is in bold."))));

        if (entry.played.killers.length) {
          const top = el("div", { className: "afm-list" });
          for (const k of entry.played.killers) {
            const owner = byIndex.get(k.player);
            const line = el("div", { className: "afm-step", title: t("Go to its first kill") },
              el("span", { className: "afm-t" }, formatTime(k.frame)),
              el("span", {}, el("span", { style: owner ? `color:${owner.color}` : "" }, api.names.unit(k.type)), el("span", { className: "afm-end" }, " · " + (k.value > 0 ? t("{n, plural, one {# kill} other {# kills}}, worth {value}", { n: k.kills, value: k.value }) : t("{n, plural, one {# kill} other {# kills}}", { n: k.kills })))),
            );
            line.addEventListener("click", () => { seek(Math.max(0, k.frame - 24)); api.view.center(Math.floor(k.x / 32), Math.floor(k.y / 32)); });
            top.append(line);
          }
          this.root.append(w.group(t("Most kills"), top));
        }
      }

      // Chat.
      if (current.report.chat.length) {
        const byId = new Map(players.map((p) => [p.player.id, p.player] as const));
        const bySlot = new Map(rep.players.map((p) => [p.slot, p] as const));
        const chat = el("div", { className: "afm-chat" });
        for (const line of current.report.chat) {
          const p = bySlot.get(line.player) ?? byId.get(line.player);
          const row = el("div", {}, el("span", { className: "afm-dim" }, formatTime(line.frame) + " "), el("b", { style: p ? `color:${p.color}` : "" }, (p?.name ?? "?") + ": "), line.text);
          row.style.cursor = "pointer";
          row.addEventListener("click", () => seek(line.frame));
          chat.append(row);
        }
        this.root.append(w.group(t("Chat"), chat));
      }

      this.update();
      requestAnimationFrame(() => this.drawApm());
    }

    /** What moves with the clock: the slider, the time, the build list's past and future, the APM cursor. */
    update(): void {
      if (!current || !this.slider) return;
      this.slider.value = String(Math.round(frame));
      this.timeLabel!.textContent = `${formatTime(frame)} / ${formatTime(current.report.frames)}`;
      this.playButton!.textContent = playing ? t("Pause") : t("Play");
      for (const s of this.steps) s.el.classList.toggle("afm-future", s.frame > frame);
      this.drawApm();
    }

    /** How far the engine is with the replay it is playing. */
    progress(): void {
      if (!this.bar || !running || running.entry !== current) return;
      if (running.fraction < 0) this.bar.set(null, t("Starting the game…"));
      else this.bar.set(running.fraction, t("Playing the game: {time} of {total}", { time: formatTime(running.fraction * current.report.frames), total: formatTime(current.report.frames) }));
    }

    drawApm(): void {
      const c = this.apm;
      if (!c || !current || !c.isConnected) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, cw, ch);
      const frames = current.report.frames || 1;
      const players = current.report.players;
      // Each player's line: the points along the game and their values, whichever numbers are asked for.
      const tl = current.played?.timeline ?? null;
      const metric = tl && settings.chart !== "apm" ? settings.chart : null;
      const lines = players.map((p) => {
        const values = metric ? series(tl!, p.player.index, metric) ?? [] : p.perMinute;
        const at = metric ? (i: number) => tl!.samples.frame[i] : (i: number) => Math.min(frames, (i + 0.5) * FRAMES_PER_MINUTE);
        return { p, values, at };
      });
      let max = 1;
      for (const l of lines) for (const n of l.values) max = Math.max(max, n);
      const pad = 4 * dpr;
      const xOf = (f: number) => (f / frames) * cw;
      const yOf = (n: number) => ch - pad - (n / max) * (ch - pad * 2);
      g.strokeStyle = "rgba(128,128,128,0.25)";
      g.lineWidth = 1;
      for (let m = 1; m * FRAMES_PER_MINUTE < frames; m++) {
        if (m % 5) continue;
        g.beginPath(); g.moveTo(xOf(m * FRAMES_PER_MINUTE), 0); g.lineTo(xOf(m * FRAMES_PER_MINUTE), ch); g.stroke();
      }
      for (const { p, values, at } of lines) {
        if (hidden.has(p.player.id)) continue;
        g.strokeStyle = p.player.color;
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        values.forEach((n, i) => {
          const x = xOf(Math.min(frames, at(i)));
          if (i === 0) g.moveTo(x, yOf(n)); else g.lineTo(x, yOf(n));
        });
        g.stroke();
      }
      // The scale's top, so a line can be read as a number.
      g.fillStyle = "rgba(160,168,184,0.9)";
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      g.textBaseline = "top";
      g.fillText(String(Math.round(max)), 3 * dpr, 2 * dpr);
      // The fights, as marks along the bottom: as wide as each lasted, at least a pixel or two.
      if (current.played) {
        g.fillStyle = "rgba(240,80,60,0.9)";
        for (const f of current.played.fights) g.fillRect(xOf(f.from), ch - 3 * dpr, Math.max(2 * dpr, xOf(f.to) - xOf(f.from)), 3 * dpr);
      }
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.lineWidth = 1 * dpr;
      g.beginPath(); g.moveTo(xOf(frame), 0); g.lineTo(xOf(frame), ch); g.stroke();
    }
  }

  async function pick(): Promise<void> {
    const files = await api.ui.pickFiles({ accept: ".rep", multiple: true });
    if (files.length) await load(files);
  }

  /* ── Menus, commands, events ── */

  // Titles and menu labels go to the editor in English; it shows them in the user's language from this plugin's catalogue.
  api.commands.register({ id: "open-replay", title: msg("Open Replay…"), run: () => void pick() });
  api.commands.register({ id: "panel", title: "Aftermath", run: () => { showPanel(); view?.render(); } });
  api.menu.add("File", { label: msg("Open Replay…"), icon: "plugin", after: "Open Recent", command: "open-replay" });
  api.menu.add("View", { label: "Aftermath", icon: "plugin", command: "panel" });

  api.events.on("document", () => {
    checkMap();
    heatCache = null;
    view?.render();
    overlay.redraw();
  });
  api.events.on("terrain", () => {
    // An edit to the map can make it the replay's map or stop it being one.
    if (!current) return;
    const was = matches;
    checkMap();
    if (was !== matches) { view?.render(); overlay.redraw(); }
  });
  api.events.on("language", () => view?.render());

  return () => {
    stop();
    running?.controller.abort();
    simWatch.dispose();
    imageListener.dispose();
    style.remove();
  };
}

/* ── Helpers ────────────────────────────────────────────── */

/** The index of the first click after `frame` (binary search; the list is in frame order). */
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
