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
 * `replay.ts` reads the file, `analysis.ts` makes the per-player reports and the heat
 * grid, `chk.ts` compares maps; all three are pure and tested. This file is the editor
 * side: the panel, the playback clock and the overlay. It never edits the map.
 */
import type { MapView, OverlayHandle, PanelHandle, PluginApi } from "@scm-js/plugin-api";
import { analyse, buildOrderRows, formatTime, FRAMES_PER_MINUTE, heat, TOWN_HALLS, type ClickKind, type HeatGrid, type Placement, type PlayerReport, type ReplayReport } from "./analysis";
import { likeness, plainText, readChk, type ChkInfo } from "./chk";
import { FRAME_MS, parseReplay, ReplayError } from "./replay";

/* ── State ──────────────────────────────────────────────── */

type HeatMode = "off" | "orders" | "move" | "attack" | "buildings" | "ping";

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
}

const DEFAULTS: Settings = { buildings: true, orders: true, heat: "off", wholeGame: false, allReplays: false, speed: 8, docked: false, workers: false };

interface Loaded {
  id: number;
  fileName: string;
  report: ReplayReport;
  map: ChkInfo;
}

/** How long a click stays on the map behind the timeline. */
const TRAIL_FRAMES = 8 * 24;
/** How long a new building is marked as new. */
const NEW_FRAMES = 6 * 24;
/** Terrain shared with the replay's map for the map in front to count as the same one. */
const SAME_MAP = 0.9;

const HEAT_KINDS: Record<Exclude<HeatMode, "off" | "buildings">, ReadonlySet<ClickKind>> = {
  orders: new Set(["move", "attack", "patrol", "ability"]),
  move: new Set(["move"]),
  attack: new Set(["attack", "patrol"]),
  ping: new Set(["ping"]),
};

const RACES = ["Zerg", "Terran", "Protoss"];

const GAME_TYPES: Record<number, string> = {
  2: "Melee", 3: "Free For All", 4: "One on One", 5: "Capture the Flag", 6: "Greed", 7: "Slaughter",
  8: "Sudden Death", 9: "Ladder", 10: "Use Map Settings", 11: "Team Melee", 12: "Team Free For All",
  13: "Team Capture the Flag", 15: "Top vs Bottom",
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
  const t = api.i18n.t;
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
        const replay = await parseReplay(new Uint8Array(await file.arrayBuffer()));
        const entry: Loaded = { id: nextId++, fileName: file.name, report: analyse(replay), map: readChk(replay.chk) };
        loaded.push(entry);
        first ??= entry;
      } catch (err) {
        const detail = err instanceof ReplayError ? err.message : String(err);
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
    const name = plainText(current.report.replay.header.mapName) || "Replay map";
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

  /* ── Heat ── */

  let heatCache: { key: string; grid: HeatGrid; canvas: HTMLCanvasElement } | null = null;

  function heatSources(): { report: ReplayReport; players: PlayerReport[] }[] {
    if (!current) return [];
    if (!settings.allReplays) return [{ report: current.report, players: current.report.players.filter((p) => !hidden.has(p.player.id)) }];
    return loaded
      .filter((l) => l === current || likeness(current!.map, l.map) >= SAME_MAP)
      .map((l) => ({ report: l.report, players: l.report.players }));
  }

  function heatCanvas(): HTMLCanvasElement | null {
    if (!current || settings.heat === "off") return null;
    const whole = settings.wholeGame || settings.allReplays;
    const until = whole ? undefined : Math.floor(frame / 12) * 12;
    const sources = heatSources();
    const key = [settings.heat, until ?? "all", sources.map((s) => `${s.report.replay.header.started?.getTime()}:${s.players.map((p) => p.player.id).join(".")}`).join("|")].join("/");
    if (heatCache?.key === key) return heatCache.canvas;

    const { width, height } = current.map;
    const points = function* () {
      for (const s of sources) {
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
    const grid = heat(points(), width, height, { until, kinds: settings.heat === "buildings" ? undefined : HEAT_KINDS[settings.heat] });
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

    if (settings.buildings) {
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
      title: t("Aftermath"),
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

  function moveDock(): void {
    settings.docked = !settings.docked;
    save();
    const old = panel;
    panel = null;
    old?.close();
    showPanel();
  }

  const w = api.ui.widgets;

  class PanelView {
    readonly root: HTMLElement;
    private slider: HTMLInputElement | null = null;
    private timeLabel: HTMLElement | null = null;
    private playButton: HTMLButtonElement | null = null;
    private apm: HTMLCanvasElement | null = null;
    private steps: { el: HTMLElement; frame: number }[] = [];
    private buildPlayer = -1;

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
        GAME_TYPES[rep.header.gameType] ?? t("Game type {n}", { n: rep.header.gameType }),
        formatTime(current.report.frames),
        rep.header.started ? rep.header.started.toLocaleDateString() : null,
        rep.format === "legacy" ? t("before 1.18") : rep.format === "1.18" ? "1.18–1.20" : "1.21+",
      ].filter(Boolean).join(" · ");
      this.root.append(el("div", { className: "afm-dim" }, facts));

      if (!matches) {
        this.root.append(
          el("div", { className: "afm-warn" }, t("The map in front is not the one this game was played on.")),
          w.row(w.button(t("Open the replay's map"), { primary: true, onClick: () => void openReplayMap().then(() => this.render()) })),
        );
      }
      if (rep.unknownCommands > 0) this.root.append(w.hint(t("{n} commands of a kind Aftermath does not know were skipped.", { n: rep.unknownCommands })));

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
          el("td", {}, RACES[p.player.race] ?? t("Random")),
          el("td", { className: "afm-num", title: t("Actions per minute") }, t("{n} APM", { n: p.apm })),
          el("td", { className: "afm-dim" }, p.leftAt === null ? "" : t("left {time}", { time: formatTime(p.leftAt) })),
        ));
      }
      this.root.append(table);

      // APM over the game.
      this.apm = el("canvas", { className: "afm-apm", title: t("Actions per minute over the game — click to go there") }) as HTMLCanvasElement;
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
      ], { value: settings.heat, onChange: (v) => { settings.heat = v as HeatMode; save(); heatCache = null; overlay.redraw(); this.render(); } });
      const sameMap = loaded.filter((l) => likeness(entry.map, l.map) >= SAME_MAP).length;
      this.root.append(w.group(t("Show"),
        w.row(
          w.checkbox(t("Buildings"), { value: settings.buildings, onChange: (on) => { settings.buildings = on; save(); overlay.redraw(); } }),
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
      const workers = w.checkbox(t("Workers"), { value: settings.workers, title: t("Show SCVs, Drones and Probes"), onChange: (on) => { settings.workers = on; save(); this.render(); } });
      this.root.append(w.group(t("Build order"), w.row(who, workers), list));

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
      let max = 1;
      for (const p of players) for (const n of p.perMinute) max = Math.max(max, n);
      const pad = 4 * dpr;
      const xOf = (f: number) => (f / frames) * cw;
      const yOf = (n: number) => ch - pad - (n / max) * (ch - pad * 2);
      g.strokeStyle = "rgba(128,128,128,0.25)";
      g.lineWidth = 1;
      for (let m = 1; m * FRAMES_PER_MINUTE < frames; m++) {
        if (m % 5) continue;
        g.beginPath(); g.moveTo(xOf(m * FRAMES_PER_MINUTE), 0); g.lineTo(xOf(m * FRAMES_PER_MINUTE), ch); g.stroke();
      }
      for (const p of players) {
        if (hidden.has(p.player.id)) continue;
        g.strokeStyle = p.player.color;
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        p.perMinute.forEach((n, i) => {
          const x = xOf(Math.min(frames, (i + 0.5) * FRAMES_PER_MINUTE));
          if (i === 0) g.moveTo(x, yOf(n)); else g.lineTo(x, yOf(n));
        });
        g.stroke();
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

  api.commands.register({ id: "open-replay", title: t("Open Replay…"), run: () => void pick() });
  api.commands.register({ id: "panel", title: t("Aftermath"), run: () => { showPanel(); view?.render(); } });
  api.menu.add("File", { label: t("Open Replay…"), icon: "plugin", after: "Open Recent", command: "open-replay" });
  api.menu.add("View", { label: t("Aftermath"), icon: "plugin", command: "panel" });

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
