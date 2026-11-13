/**
 * The Game view: the replay played out by the game's own code, with its own graphics, in the map's place
 * (`api.ui.mapView`), through the scm-sim plugin's `view` (the site's play page as a replay viewer).
 *
 * One viewer for every replay tab: the engine is a gigabyte of memory, so the replay in front is loaded into it when
 * its tab shows the Game view, and the next one's replaces it. While a tab shows the game the viewer is the clock —
 * Aftermath plays, pauses, seeks and changes speed through it and follows the frame it says — and Spectate's camera
 * moves the game's view instead of the map. Shown the map again, the clock is Aftermath's own, from where the game was.
 *
 * The editor's minimap is the game's while it is shown: the game's units as its own minimap has them, its box where the
 * game looks, and a press there moves the game. The switch keeps the place: the game opens where the map was looking, at
 * the map's scale as near as the game allows, and the map where the game was.
 *
 * Spectate's camera is handed to the game as a whole track (`follow`), which the game moves along as it draws: smooth
 * however fast it plays, and in step with what it shows. A game page from before tracks is moved instead, a little at
 * a time, from the frame it last said, carried on to the moment (`frameNow`).
 *
 * The view is offered only where it can play: the scm-sim plugin is there with a `view`, and the person's browser has
 * the game's files (the engine's page says so). Otherwise nothing changes: the tab has the map alone.
 *
 * The game's own screen (a play page whose looks say `ownScreen`, through a plugin-scm-sim that passes them on): the
 * game draws its whole screen itself — its console, minimap and replay panel, and a mod's own interface — and the
 * pointer and the wheel over it are the game's. While it is on, what the editor and Aftermath would add over the game
 * or do to it is left alone: the editor's zoom (the game keeps its own scale), its Fog of War (a replay's own screen
 * sees with every player's vision; the toggle is greyed), the tooltip and the pointer's place (the page says none),
 * and the editor's grid, locations and overlays over the game (what the game shows of the map is the game's, at a
 * scale a mod may choose, so nothing can be put at a map position over it). The minimap, the camera, Spectate's
 * tracks, play, speed, seeks and sounds work as before. The choice is offered (`setOwnScreen`) where the page says it
 * can show it; a page or a plugin-scm-sim from before says nothing of it, and nothing changes.
 */
import type { Disposable, MapView, MapViewCamera, MapViewHandle, MinimapView, PluginApi } from "@scm-js/plugin-api";
import type { ReplayDataSet, ScmSimService, ScmSimView, ViewFrame, ViewHover, ViewLooks, ViewTrack, ViewUnits } from "./vendor/scm-sim";
import { FRAME_MS } from "@scm-js/replay";
import { engineReason, engineSentence, type EngineReason } from "./modreplay";

/** A seek the viewer says is over but that has shown no frame near where it went is settled after this long. */
const SEEK_GIVE_UP_MS = 2500;
/** A seek whose progress has not moved for this long is taken as over where it stopped (a game that ended short of it). */
const SEEK_STALL_MS = 4000;
/**
 * A view that cannot rewind starts the game again from frame 0 for a seek back (a mod's plugins: about 13 seconds for
 * Cosmonarchy before it runs ahead), saying frame 0 meanwhile; that is waited on this long before the seek is taken as
 * lost and the clock goes where the game is.
 */
const SEEK_RESTART_MS = 60000;
/** Frames either side of where a seek was sent that count as there (two seconds: the game moves on while the answer comes). */
const SEEK_NEAR = 48;
/** A drag of the timeline over a view that cannot rewind is sent to the game once the pointer has stood still this long. */
const DRAG_STILL_MS = 250;

/**
 * The frame a seek reported by the view is going to, where the page says it (an addition to `scmjs.view.frame` whose
 * name was not settled when this was written, so each likely name is read); null when it does not say.
 */
export function seekTargetOf(f: ViewFrame): number | null {
  const o = f as unknown as Record<string, unknown>;
  for (const name of ["target", "seekTarget", "seekingTo", "toward", "to"]) {
    const v = o[name];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** The editor's minimap follows the game's camera at most this often (each move redraws it). */
const MINIMAP_MS = 66;
/** A game that has not said it looks where it was sent is shown anyway after this long (a look the game cannot take). */
const SETTLE_MS = 600;
/** The rows of the map the game shows top to bottom (its 640 by 480 screen): the scale a replay opens at. */
const GAME_ROWS = 480;

/** The game's own screen for the replay loaded: whether the page can show it, and whether it does. */
export interface OwnScreen {
  offered: boolean;
  on: boolean;
}
/** The game's own screen as the page's looks say it: neither offered nor on where they do not say (a page from before). */
export const ownScreenOf = (looks: ViewLooks | null | undefined): OwnScreen => {
  const offered = looks?.ownScreen === true;
  return { offered, on: offered && looks?.ownScreenOn === true };
};
const NO_OWN_SCREEN: OwnScreen = { offered: false, on: false };

/** What the Game view needs of a replay. */
export interface Held {
  id: number;
  fileName: string;
  bytes: Uint8Array;
  docId: number | null;
  /** Whose eyes the game is seen through, a replay player's slot (with the fog of war); null for everyone's, no fog. */
  eyes: number | null;
  /** The mod it was played with (`replayDataSet` of its tag), for the view to be loaded at the address that plays it; none for the game itself. */
  dataSet?: ReplayDataSet;
}

export interface GameViewHooks {
  /** The frame the viewer shows, for the replay it holds. */
  frame(id: number, f: ViewFrame): void;
  /** New squares for the minimap came (the cinematic view draws its own). */
  units?(): void;
  /** The person moved the game's camera (the arrows, or the editor's minimap). */
  movedByUser(): void;
  /** The person zoomed the game (the editor's zoom, or the wheel over it): a track made for the old scale is to be made again. */
  zoomed?(): void;
  /** The tab in front changed between the map and the game. */
  shown(shown: boolean): void;
  /** A replay is being loaded into the viewer, or failed to (null when neither). */
  state(text: string | null): void;
  /**
   * A replay could not be loaded: the engine's sentence, and its reason where it gave one (plugin-scm-sim 0.19.0:
   * "mod-missing", "mod-terrain", "remastered-terrain"), so the panel can say what to do; null once one loaded.
   */
  failure?(id: number, failed: { reason: EngineReason | null; message: string } | null): void;
  /** A jump runs on towards where it was sent (`GameView.seekProgress`). */
  seeking(): void;
  /** What the pointer is on over the game (null: nothing, or the game is not shown), for `tip`. */
  hover(hover: ViewHover | null): void;
  /** View ▸ Fog of War over the game: see it through a player's eyes (`eyes`), or everyone's. */
  fog?(on: boolean): void;
  /** The game's own screen was offered or taken away, or went on or off (`GameView.ownScreen`). */
  ownScreen?(own: OwnScreen): void;
}

export class GameView {
  private readonly api: PluginApi;
  private readonly hooks: GameViewHooks;
  private readonly handle: MapViewHandle;
  private readonly words: { loading: (name: string) => string; failed: (message: string) => string; keeping?: (message: string) => string };
  private element: HTMLElement | null = null;
  private view: ScmSimView | null = null;
  private subs: Disposable[] = [];
  /** The replay loaded in the viewer, and the one being loaded. */
  private holding: number | null = null;
  private wanted: number | null = null;
  /** Whether the engine can play here: unknown until asked, then kept. */
  private canPlay: boolean | null = null;
  private asking: Promise<boolean> | null = null;
  /**
   * Whether the view plays a mod's replay with its mod: the scm-sim plugin's view takes the mod (0.17.0) and the play
   * page reads it (its `features` say "replayDoor"). Known once `available` has asked; false until then.
   */
  playsMods = false;
  private sim: ScmSimService | null = null;
  private readonly changed: Disposable;
  /**
   * A seek asked for and not yet arrived: until the viewer shows a frame there, what it says it shows is the moment
   * it is leaving (it reports the frame on screen while it runs ahead), which is not the clock any more.
   */
  private aiming: { frame: number; sawSeeking: boolean; from: number | null; at: number | null; sent: number; moved: number; timer: number; shown: number | null } | null = null;
  /**
   * A drag of the timeline not yet sent to a view that cannot rewind or is slow (`drag`): the frame the pointer stands at, sent
   * once the drag ends or stands still. Until then nothing the view says moves the clock.
   */
  private pending: { frame: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A seek back is quick (the replay loaded said so; a page from before it said is taken as one that rewinds). */
  private quickBack = true;
  /**
   * The replay runs ahead slowly (a mod's plugins run, about 60 frames a second): even a seek back to a kept moment
   * takes a while, so a drag is sent once, as to a view that cannot rewind. False for a page from before it said.
   */
  private slow = false;
  /** The viewer's last word on the frame, and when (performance.now): what a seek that never arrives settles for. */
  private heard: { f: ViewFrame; at: number } | null = null;
  /**
   * Where the game is to look once it holds the replay (the map's place when the switch came), in pixels. A height of
   * 0 is the map's own scale: as much of the map top to bottom as the frame is tall.
   */
  private look: MapViewCamera | null = null;
  /**
   * The game is hidden while a replay loads and until it says it looks at the height it was sent (or a moment has
   * passed): it opens at its own scale, and the look sent after would show as a jump.
   */
  private settling: { height: number | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** The squares of the game's minimap, for the editor's, while it holds a replay. */
  private units: ViewUnits | null = null;
  /** Its fog as a picture of the map a pixel a tile (black never seen, half black seen before), made once per squares. */
  private fogImage: { of: ViewUnits; canvas: HTMLCanvasElement } | null = null;
  /** The page plays camera tracks (the replay loaded said so), and the track it was last given, if it still follows it. */
  private tracks = false;
  private sent: ViewTrack | null = null;
  /** The frame the game last said it shows, when, and whether it was playing (`frameNow`). */
  private said: { frame: number; at: number; playing: boolean } | null = null;
  /** How much of the map the game shows, pixels, as it last said. */
  private shows: { width: number; height: number } | null = null;
  /** The editor's minimap is told where the game looks at most this often (it redraws for each). */
  private told = 0;
  private telling: ReturnType<typeof setTimeout> | null = null;
  /** Over the game while it starts or a jump runs: a spinner and a line (`busy`). */
  private busyBox: HTMLElement | null = null;
  private busyLine: HTMLElement | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  /** View ▸ Remastered Graphics as the game was last told it (null: not yet, for the replay loaded). */
  private remastered: boolean | null = null;
  /** Whose eyes the game was last told, for the replay loaded (undefined: not yet; the page opens a replay on its own). */
  private eyesTold: number | null | undefined = undefined;
  /** The race whose music is wanted (null none), and what the game was last told (undefined: not yet, for the replay loaded). */
  private musicWanted: number | null = null;
  private musicTold: number | null | undefined = undefined;
  /** How far the game's sounds and music are wanted turned down, and what the game was last told. */
  private duckWanted = 1;
  private duckTold: number | undefined = undefined;
  /**
   * Over the game, under the spinner: what the plugin draws there (`setOverlay`), in the game's place — the map's
   * pixels where the game shows them, from where the game last said it looks.
   */
  private over: HTMLCanvasElement | null = null;
  private drawOver: ((ctx: CanvasRenderingContext2D, v: MapView) => void) | null = null;
  private looking: { x: number; y: number; width: number; height: number } | null = null;
  /** The tooltip by the pointer over the game (`tip`), in the editor's own style. */
  private tipBox: HTMLElement | null = null;
  /** The game's own screen for the replay loaded, as the page last said. */
  private own: OwnScreen = NO_OWN_SCREEN;
  /** Whose eyes were last asked for (`eyes`), for the editor's Fog of War once the game's own screen is off again. */
  private eyesAsked: number | null = null;

  constructor(api: PluginApi, hooks: GameViewHooks, title: string, words: GameView["words"]) {
    this.api = api;
    this.hooks = hooks;
    this.words = words;
    this.handle = api.ui.mapView({
      title,
      mount: (el) => {
        this.element = el;
        const over = document.createElement("canvas");
        over.className = "afm-over";
        el.append(over);
        this.over = over;
        const box = document.createElement("div"), spin = document.createElement("span"), line = document.createElement("span");
        box.className = "afm-busy";
        box.hidden = true;
        box.setAttribute("role", "status");
        spin.className = "afm-spin";
        box.append(spin, line);
        const tip = document.createElement("div");
        tip.className = "tooltip afm-tip";
        tip.hidden = true;
        el.append(box, tip);
        this.tipBox = tip;
        this.busyBox = box;
        this.busyLine = line;
      },
      onShow: (look) => this.lookAt(look),
      onZoom: (look) => this.zoomTo(look),
      // The editor's grid, locations and the other plugins' overlays, over the game (`redrawOver`).
      onRepaint: () => this.redrawOver(),
      // (Greyed while the game's own screen is on, which no fog changes: a press is nobody's.)
      onFog: (on) => { if (!this.ownScreenOn) hooks.fog?.(on); },
      minimap: {
        draw: (ctx, m) => this.drawUnits(ctx, m),
        press: (x, y) => { if (this.view && this.loaded) { this.view.camera(x, y); hooks.movedByUser(); } },
      },
    });
    this.changed = this.handle.onChange((on) => { hooks.shown(on); this.redrawOver(); if (!on) { this.hooks.hover(null); this.handle.setPointer?.(null); } });
  }

  /**
   * The editor's zoom while the game is shown: look at `look`'s scale (the viewer keeps to what the game allows, and
   * says what it took on its camera). It lets go of a camera track, so the hook makes one for the new scale at once —
   * in the same moment, so Spectate goes on without a jump; until the viewer says, the size asked stands for it.
   */
  private zoomTo(look: MapViewCamera): void {
    // (The game's own screen keeps the game's own scale: the zoom would only stop Spectate's track.)
    if (this.ownScreenOn) return;
    if (!this.view || !this.loaded) { this.look = look; return; }
    this.view.camera(look.x, look.y, look.height);
    this.sent = null;
    this.shows = { width: look.width, height: look.height };
    this.hooks.zoomed?.();
  }

  /** A replay is loaded in the viewer and no other is on its way. */
  private get loaded(): boolean { return this.holding !== null && this.wanted === null; }
  /** A replay is on its way into the viewer. */
  get loading(): boolean { return this.wanted !== null; }

  /**
   * The spinner over the game, with `text` beside it ("" for the spinner alone); null takes it away. It shows only
   * once the wait has gone on a moment, so a quick jump does not flash it.
   */
  busy(text: string | null): void {
    const box = this.busyBox;
    if (!box || !this.busyLine) return;
    if (text === null) {
      if (this.busyTimer) clearTimeout(this.busyTimer);
      this.busyTimer = null;
      box.hidden = true;
      return;
    }
    this.busyLine.textContent = text;
    // (No words: the spinner alone, the line beside it out of the way.)
    this.busyLine.hidden = text === "";
    if (!box.hidden || this.busyTimer) return;
    this.busyTimer = setTimeout(() => { this.busyTimer = null; box.hidden = false; }, 200);
  }

  /**
   * Look where `look` says, at its scale (the viewer keeps to what the game allows): now, or once the replay is in.
   * The height sent, when it was sent now.
   */
  private lookAt(look: MapViewCamera): number | null {
    if (!this.view || !this.loaded) { this.look = look; return null; }
    const height = look.height > 0 ? look.height : this.element?.clientHeight ?? 0;
    this.view.camera(look.x, look.y, height > 0 ? height : undefined);
    this.sent = null;
    this.look = null;
    return height > 0 ? height : null;
  }

  /** Hide the game until it settles (`settling`), or show it. */
  private settle(on: boolean): void {
    if (this.settling?.timer) clearTimeout(this.settling.timer);
    this.settling = on ? { height: null, timer: null } : null;
    this.element?.classList.toggle("afm-settling", on);
  }
  /** The game is in: show it once it says it looks at `height` (the game keeps to 240–960), or after a moment. */
  private settleAt(height: number | null): void {
    if (!this.settling) return;
    if (height === null) { this.settle(false); return; }
    this.settling.height = Math.max(240, Math.min(960, Math.round(height)));
    this.settling.timer = setTimeout(() => this.settle(false), SETTLE_MS);
  }

  /** The game's minimap on the editor's: its fog over the ground, as the game darkens it, then its squares. */
  private drawUnits(ctx: CanvasRenderingContext2D, m: MinimapView): void {
    const u = this.units;
    if (!u || !this.loaded) return;
    const fog = this.fogOf(u);
    if (fog) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(fog, m.x(0), m.y(0), fog.width * 32 * m.scale, fog.height * 32 * m.scale);
      ctx.restore();
    }
    const { boxes, colours } = u;
    for (let i = 0; i < colours.length; i++) {
      const w = Math.max(2, boxes[i * 4 + 2] * m.scale), h = Math.max(2, boxes[i * 4 + 3] * m.scale);
      ctx.fillStyle = `#${colours[i].toString(16).padStart(6, "0")}`;
      ctx.fillRect(m.x(boxes[i * 4]) - w / 2, m.y(boxes[i * 4 + 1]) - h / 2, w, h);
    }
  }

  /**
   * The game's minimap in a square of `ctx` (CSS pixels, from `x`, `y`, `size` a side), for the cinematic view: the
   * ground given (the map's picture), the game's fog and squares over it, and a box where the game looks. `map` is the
   * map's size in pixels. The map is centred in the square, as the editor's minimap has it.
   */
  drawMinimap(ctx: CanvasRenderingContext2D, at: { x: number; y: number; size: number }, map: { width: number; height: number }, ground: CanvasImageSource | null): void {
    const scale = at.size / Math.max(map.width, map.height, 1);
    const ox = at.x + (at.size - map.width * scale) / 2, oy = at.y + (at.size - map.height * scale) / 2;
    const m: MinimapView = { scale, size: at.size, x: (px) => ox + px * scale, y: (py) => oy + py * scale };
    ctx.save();
    ctx.fillStyle = "rgba(6,8,12,0.9)";
    ctx.fillRect(at.x - 3, at.y - 3, at.size + 6, at.size + 6);
    ctx.beginPath(); ctx.rect(ox, oy, map.width * scale, map.height * scale); ctx.clip();
    if (ground) { ctx.imageSmoothingEnabled = true; ctx.drawImage(ground, ox, oy, map.width * scale, map.height * scale); }
    this.drawUnits(ctx, m);
    const look = this.looking;
    if (look && this.loaded) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(m.x(look.x - look.width / 2)) + 0.5, Math.round(m.y(look.y - look.height / 2)) + 0.5, look.width * scale, look.height * scale);
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
    ctx.strokeRect(at.x - 3.5, at.y - 3.5, at.size + 7, at.size + 7);
  }

  /** The map pixel under a point of a minimap drawn by `drawMinimap` with the same square and map, or null outside it. */
  static minimapAt(px: number, py: number, at: { x: number; y: number; size: number }, map: { width: number; height: number }): { x: number; y: number } | null {
    const scale = at.size / Math.max(map.width, map.height, 1);
    const ox = at.x + (at.size - map.width * scale) / 2, oy = at.y + (at.size - map.height * scale) / 2;
    const x = (px - ox) / scale, y = (py - oy) / scale;
    return x >= 0 && y >= 0 && x <= map.width && y <= map.height ? { x, y } : null;
  }

  /** The fog of these squares as a picture a pixel a tile; null when there is none (the fog off, or an older game page). */
  private fogOf(u: ViewUnits): HTMLCanvasElement | null {
    if (!u.fog || !u.wide) return null;
    if (this.fogImage?.of === u) return this.fogImage.canvas;
    const wide = u.wide, high = u.fog.length / wide;
    const canvas = this.fogImage?.canvas ?? document.createElement("canvas");
    if (canvas.width !== wide || canvas.height !== high) { canvas.width = wide; canvas.height = high; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(wide, high), px = image.data;
    for (let i = 0; i < u.fog.length; i++) px[i * 4 + 3] = u.fog[i] === 2 ? 0 : u.fog[i] === 1 ? 128 : 255;
    ctx.putImageData(image, 0, 0);
    this.fogImage = { of: u, canvas };
    return canvas;
  }

  setService(sim: ScmSimService | null): void {
    if (sim === this.sim) return;
    this.sim = sim;
    this.canPlay = null;
    this.asking = null;
    this.playsMods = false;
  }

  /** Whether the Game view can be offered: the scm-sim plugin has one, and the browser has the game's files. */
  async available(): Promise<boolean> {
    const sim = this.sim;
    if (!sim?.present || typeof sim.view !== "function") return false;
    if (this.canPlay !== null) return this.canPlay;
    this.asking ??= sim.status().then((s) => { this.playsMods = s.available && (s.features ?? []).includes("replayDoor"); return (this.canPlay = s.available); }, () => (this.canPlay = false));
    return this.asking;
  }

  /**
   * Offer the Game view on a replay's tab, and show it there when `show`: looking at `start` (map pixels) at the game's
   * own scale (`GAME_ROWS` across the frame's height), rather than where the editor's view stood when the tab came in.
   */
  async offer(entry: Held, show: boolean, start?: { x: number; y: number }): Promise<boolean> {
    if (entry.docId === null || !(await this.available())) return false;
    if (entry.dataSet && !this.playsMods) return false;
    this.handle.offer(true, entry.docId);
    if (show) this.handle.show(true, entry.docId);
    // (After the show: the editor's `onShow` comes in during it.)
    if (show && start && !this.holds(entry.id)) this.look = { x: start.x, y: start.y, width: 0, height: GAME_ROWS };
    return true;
  }

  /** The tab in front shows the game. */
  get shown(): boolean { return this.handle.isShown(); }
  /** Show the map (or the game again) on a replay's tab. */
  show(on: boolean, docId?: number): void { this.handle.show(on, docId); }
  /** The replay is to be loaded again the next time it is held (it is to be played with other data now: a mod picked). */
  forget(id: number): void {
    if (this.holding === id) this.holding = null;
  }

  /** The viewer holds this replay, loaded and ready to be driven. */
  holds(id: number | null): boolean { return id !== null && this.holding === id && this.wanted === null; }

  private make(): ScmSimView | null {
    if (this.view) return this.view;
    const sim = this.sim;
    if (!sim?.view || !this.element) return null;
    const view = sim.view(this.element);
    this.view = view;
    this.subs = [
      view.onFrame((f) => {
        if (this.holding === null || this.wanted !== null) return;
        this.heard = { f, at: performance.now() };
        // (A drag not yet sent: the clock is the pointer's.)
        if (this.pending) return;
        const a = this.aiming;
        if (a) {
          // (A page that says where its seek goes: one going elsewhere is an older seek, nothing of this one's.)
          const target = seekTargetOf(f);
          if (target !== null && Math.abs(target - a.frame) > 1) { this.hooks.seeking(); return; }
          // (On its way the viewer says how far the engine has run: `seeking` is that frame.)
          if (f.seeking !== null) { if (f.seeking !== a.at) a.moved = performance.now(); a.sawSeeking = true; a.from ??= f.seeking; a.at = f.seeking; a.shown = f.seeking; this.hooks.seeking(); return; }
          // There (within two seconds: the game moves on while the answer comes), or a seek that ended elsewhere: past
          // the end, short of where it was sent and no nearer the start than the engine had run. A frame that says the
          // seek is over while it still shows where the seek began is not the end of it, and neither is the first frame
          // while the seek went further: a view that cannot rewind says it while it starts the game again.
          const near = Math.abs(f.frame - a.frame) <= SEEK_NEAR;
          const ended = a.sawSeeking && a.at !== null && f.frame >= a.at && f.frame <= a.frame + SEEK_NEAR && !this.atStart(f.frame, a.frame);
          if (!near && !ended) { a.shown = f.frame; this.hooks.seeking(); return; }
          this.arrived();
        }
        this.said = { frame: f.frame, at: performance.now(), playing: f.playing };
        this.hooks.frame(this.holding, f);
      }),
      view.onCamera((c) => {
        if (!this.loaded) return;
        const s = this.settling;
        if (s && s.height !== null && Math.abs(c.height - s.height) <= 2) this.settle(false);
        if (c.width > 0 && c.height > 0) {
          this.shows = { width: c.width, height: c.height };
          this.looking = { x: c.x, y: c.y, width: c.width, height: c.height };
          this.redrawOver();
          this.tellMinimap({ x: c.x, y: c.y, width: c.width, height: c.height }, c.byUser);
        }
        // (The game lets go of a track itself when the person moves its view.)
        if (c.byUser) { this.sent = null; this.hooks.movedByUser(); }
      }),
    ];
    // (scm-sim before 0.6.0 sends no squares: the editor's minimap then shows the ground alone.)
    // (scm-sim before 0.6.0 says nothing of the pointer: there is no tooltip.)
    // (On the game's own screen the page says nothing is under the pointer, and the game shows its own tooltips.)
    if (typeof view.onHover === "function") this.subs.push(view.onHover((h) => this.hooks.hover(this.loaded && this.shown && !this.own.on ? h : null)));
    // (scm-sim before 0.10.0 says the pointer only over a unit, and an editor before 1.54 has no status bar to give it to.)
    if (typeof view.onPointer === "function") this.subs.push(view.onPointer((p) => this.handle.setPointer?.(this.loaded && this.shown && !this.own.on ? p : null)));
    // (plugin-scm-sim from before the game's own screen says no looks but a load's, whose looks it leaves it out of: never on.)
    if (typeof view.onLooks === "function") this.subs.push(view.onLooks((l) => { if (this.loaded) this.ownSaid(ownScreenOf(l)); }));
    // (scm-sim before 0.9.0 keeps the wheel; an editor before map views zoomed has no wheel to hand it to.)
    if (typeof view.onWheel === "function") this.subs.push(view.onWheel((w) => { if (this.loaded && this.shown && typeof this.handle.wheel === "function") this.handle.wheel(w); }));
    // (plugin-scm-sim 0.19.0: the page keeps a mod's files handed over with the replay first, a minute or two for a large one.)
    if (typeof view.onKeeping === "function") this.subs.push(view.onKeeping((k) => { if (this.wanted !== null) this.hooks.state(this.words.keeping ? this.words.keeping(k.message) : k.message); }));
    if (typeof view.onUnits === "function") this.subs.push(view.onUnits((u) => { if (!this.loaded) return; this.units = u; this.handle.redrawMinimap?.(); this.hooks.units?.(); }));
    return view;
  }

  /**
   * Load `entry` into the viewer when it holds another, then put it at `frame`, playing or paused at `speed`. Resolves
   * false when it could not be (the viewer is gone, or the replay did not play), with the reason on `state`.
   */
  async hold(entry: Held, frame: number, playing: boolean, speed: number): Promise<boolean> {
    const view = this.make();
    if (!view) return false;
    if (this.holding !== entry.id || this.wanted !== null) {
      if (this.wanted === entry.id) return false;
      let loadedLooks: ViewLooks | null = null;
      this.wanted = entry.id;
      this.units = null;
      this.looking = null;
      this.redrawOver();
      this.hooks.hover(null);
      this.handle.redrawMinimap?.();
      this.hooks.state(this.words.loading(entry.fileName));
      // (Whether the next replay has the game's own screen is its looks' to say.)
      this.ownSaid(NO_OWN_SCREEN);
      this.dropDrag();
      this.arrived();
      this.sent = null;
      this.said = null;
      this.settle(true);
      try {
        // (A mod's replay with its mod: the view loads at the address that plays it, `?view&mod=…`, first.)
        const viewed = await view.load(entry.bytes, entry.fileName, entry.dataSet ?? null);
        loadedLooks = viewed.looks;
        this.tracks = viewed.follows === true && typeof view.follow === "function";
        this.quickBack = viewed.rewinds !== false;
        this.slow = viewed.slow === true;
      } catch (err) {
        // A load replaced by another is that one's to finish.
        if (this.wanted !== entry.id) return false;
        this.wanted = null;
        this.holding = null;
        this.settle(false);
        // (The engine's own sentence, without the "Error: " its worker puts before it.)
        const message = engineSentence(err);
        this.hooks.failure?.(entry.id, { reason: engineReason(err), message });
        this.hooks.state(this.words.failed(message));
        return false;
      }
      if (this.wanted !== entry.id) return false;
      this.wanted = null;
      this.holding = entry.id;
      this.ownSaid(ownScreenOf(loadedLooks));
      this.hooks.failure?.(entry.id, null);
      this.hooks.state(null);
      this.remastered = null;
      this.eyesTold = undefined;
      this.musicTold = undefined;
      this.duckTold = undefined;
    }
    this.graphics();
    this.eyes(entry.eyes);
    this.music(this.musicWanted);
    this.duck(this.duckWanted);
    // Where the map was looking when the switch came, rather than where the viewer opens a replay.
    this.settleAt(this.look ? this.lookAt(this.look) : null);
    view.speed(speed);
    if (Math.round(frame) > 0) this.seek(frame);
    view.play(playing);
    return true;
  }

  /**
   * The game drawn with Remastered's pictures or the classic ones as View ▸ Remastered Graphics says, at once when the
   * tick moves. (The game has its own choice, the play page's; the editor's is the one the person sees here.)
   */
  graphics(): void {
    const view = this.view, on = this.api.view.flags().hdGraphics === true;
    if (!view || !this.loaded || on === this.remastered) return;
    this.remastered = on;
    view.options({ remastered: on }).catch(() => {});
  }

  /** See the game through a player's eyes, with the fog of war (their slot), or everyone's with none (null). */
  eyes(slot: number | null): void {
    this.eyesAsked = slot;
    // (The editor's Fog of War toggle shows the game's fog: on through a player's eyes; greyed on the game's own screen.)
    this.handle.setFog?.(this.ownScreenOn ? null : slot !== null);
    const view = this.view;
    if (!view || !this.loaded || slot === this.eyesTold) return;
    this.eyesTold = slot;
    view.options({ fog: slot !== null }).catch(() => {});
    if (slot !== null) view.player(slot);
  }

  /**
   * The music of a race in the game (0 zerg, 1 terran, 2 protoss), or none (null): the game's own tracks, as the play
   * page plays them. Kept for the next replay loaded. A page from before music plays none.
   */
  music(race: number | null): void {
    this.musicWanted = race;
    const view = this.view;
    if (!view || !this.loaded || race === this.musicTold) return;
    this.musicTold = race;
    view.options({ music: race }).catch(() => {});
  }

  /** The game's sounds and music turned down to `fraction` (1: all of it), under a voice of Aftermath's own. */
  duck(fraction: number): void {
    this.duckWanted = fraction;
    const view = this.view;
    if (!view || !this.loaded || fraction === this.duckTold) return;
    this.duckTold = fraction;
    view.options({ duck: fraction }).catch(() => {});
  }

  /**
   * The game's own screen for the replay loaded: offered where the page can show it, and whether it does (neither
   * while a replay loads, or with a page or a plugin-scm-sim from before it).
   */
  get ownScreen(): OwnScreen { return this.loaded ? this.own : NO_OWN_SCREEN; }
  /** The game's own screen is what the game view shows now. */
  get ownScreenOn(): boolean { return this.loaded && this.own.on; }
  /**
   * Have the page show the game's own screen (true), its own drawing (false), or as it chooses (null: on for a replay
   * of a mod whose code ran). The page keeps the choice for the replays loaded after this one. Nothing where it is not
   * offered.
   */
  setOwnScreen(on: boolean | null): void {
    const view = this.view;
    if (!view || !this.loaded || !this.own.offered) return;
    view.options({ ownScreen: on }).then((l) => { if (this.loaded) this.ownSaid(ownScreenOf(l)); }, () => {});
  }
  /** What the page said of the game's own screen: what the editor's controls do over the game follows it. */
  private ownSaid(own: OwnScreen): void {
    if (own.offered === this.own.offered && own.on === this.own.on) return;
    const was = this.own.on;
    this.own = own;
    if (own.on !== was) {
      this.handle.setFog?.(own.on ? null : this.eyesAsked !== null);
      if (own.on) { this.hooks.hover(null); this.handle.setPointer?.(null); }
      this.redrawOver();
    }
    this.hooks.ownScreen?.(this.ownScreen);
  }

  /**
   * Show `content` in the tooltip by the pointer, at `x`, `y` in the game's CSS pixels (below and right of it, or the
   * other side where it would leave the game); null hides it.
   */
  tip(content: HTMLElement | null, x = 0, y = 0): void {
    const box = this.tipBox, el = this.element;
    if (!box || !el) return;
    if (!content) { box.hidden = true; box.replaceChildren(); return; }
    box.replaceChildren(content);
    box.hidden = false;
    const w = box.offsetWidth, h = box.offsetHeight, room = { w: el.clientWidth, h: el.clientHeight };
    const left = x + 16 + w <= room.w ? x + 16 : Math.max(4, x - 12 - w);
    const top = y + 20 + h <= room.h ? y + 20 : Math.max(4, y - 10 - h);
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  }

  /** What to draw over the game, given the map's pixels where the game shows them. */
  setOverlay(draw: ((ctx: CanvasRenderingContext2D, v: MapView) => void) | null): void {
    this.drawOver = draw;
    this.redrawOver();
  }

  /** Draw over the game again: when what is drawn changed (the game's own moves redraw it as it says them). */
  redrawOver(): void {
    const c = this.over, el = this.element;
    if (!c || !el) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(el.clientWidth * dpr)), ch = Math.max(1, Math.round(el.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const at = this.looking;
    if (!at || !this.loaded || !this.shown) return;
    // (The game fills its frame: what it shows of the map, left to right and top to bottom, is the frame's width and height.)
    const w = el.clientWidth, h = el.clientHeight, kx = w / at.width, ky = h / at.height;
    const x0 = at.x - at.width / 2, y0 = at.y - at.height / 2;
    const view: MapView = {
      zoom: kx,
      tilePx: 32 * kx,
      x: (px) => (px - x0) * kx,
      y: (py) => (py - y0) * ky,
      visible: { x0: Math.floor(x0 / 32), y0: Math.floor(y0 / 32), x1: Math.ceil((x0 + at.width) / 32), y1: Math.ceil((y0 + at.height) / 32) },
    };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The editor's grid, locations and the other plugins' overlays on the game, under Aftermath's own marks; not in the
    // cinematic view, which is the game full screen without the editor. (An editor from before map views drew them has
    // no paintOver.)
    const cinematic = typeof document !== "undefined" && document.fullscreenElement === el;
    // (Nor over the game's own screen: what it shows of the map, and at what scale, is the game's.)
    if (!cinematic && !this.own.on && typeof this.handle.paintOver === "function") { ctx.save(); this.handle.paintOver(ctx, view); ctx.restore(); }
    this.drawOver?.(ctx, view);
  }

  play(on: boolean): void { this.view?.play(on); }
  /** The element the game and what is drawn over it live in: what the cinematic view takes full screen. */
  get root(): HTMLElement | null { return this.element ?? null; }
  speed(multiplier: number): void { this.view?.speed(multiplier); }
  /**
   * Whether a seek back is quick: the engine keeps moments of the game as it goes. One that cannot (a mod's plugins
   * run) starts the game again from its first frame and runs ahead to the frame, at about the game's own pace.
   */
  get rewinds(): boolean { return this.quickBack; }

  /** A frame near the start, said while a seek went further: a view that cannot rewind starting the game again. */
  private atStart(f: number, target: number): boolean { return f <= SEEK_NEAR && target > SEEK_NEAR; }

  /**
   * Where a drag of the timeline stands. A view that rewinds goes there at once, as `seek`. One that cannot, or whose
   * replay is slow (a mod's plugins run), is told once, the last frame, when the drag ends (`dragEnd`) or the pointer
   * has stood still a moment: each seek of its runs the game ahead (and a seek back starts it again, or goes back to a
   * kept moment and runs ahead from there slowly), so one for every move of the pointer would never arrive.
   */
  drag(frame: number): void {
    if (!this.view) return;
    if (this.quickBack && !this.slow) { this.seek(frame); return; }
    const f = Math.round(frame);
    if (this.pending) clearTimeout(this.pending.timer);
    // (Back where the seek in hand goes: nothing new to send.)
    else if (this.aiming?.frame === f) return;
    this.pending = { frame: f, timer: setTimeout(() => this.dragEnd(), DRAG_STILL_MS) };
  }
  /** The drag of the timeline ended: the frame it stood at goes to the game, unless it was sent already. */
  dragEnd(): void {
    const p = this.pending;
    if (!p) return;
    this.dropDrag();
    if (this.aiming?.frame === p.frame) return;
    this.seek(p.frame);
  }
  private dropDrag(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  seek(frame: number): void {
    if (!this.view) return;
    this.dropDrag();
    this.arrived();
    const sent = performance.now();
    const a = { frame: Math.round(frame), sawSeeking: false, from: null, at: null, sent, moved: sent, timer: 0, shown: null };
    // A seek is never waited on for good. Taken as over at the frame the game shows:
    // - one the viewer says is over without showing a frame near where it was sent: a play page from before
    //   2026-10-16 showed an old frame for a seek that took no step (to 0:00, or to where the game stood), and paused,
    //   nothing came after. Playing, the frames keep coming, so the latest is taken once the seek has had its time
    //   (one that lands and plays on past the mark before the viewer says so);
    // - one still said to be on its way whose progress has stopped: the game ended short of where it was sent (the
    //   engine stops where the replay goes wrong for it), and a play page from before 2026-10-17 never said that seek
    //   was over.
    a.timer = window.setInterval(() => {
      const h = this.heard, now = performance.now();
      if (this.aiming !== a || this.pending || !h || h.at < a.sent || now - a.sent < SEEK_GIVE_UP_MS) return;
      // (A page that says its seek goes elsewhere has not taken this one yet.)
      const target = seekTargetOf(h.f);
      const elsewhere = target !== null && Math.abs(target - a.frame) > 1;
      // A view that cannot rewind starting the game again says the first frame (or a seek at it) for a long while.
      const restarting = !this.quickBack && (elsewhere || this.atStart(h.f.seeking ?? h.f.frame, a.frame));
      if (restarting) { if (now - a.moved < SEEK_RESTART_MS) return; }
      else if (h.f.seeking !== null ? now - a.moved < SEEK_STALL_MS : !h.f.playing && now - h.at < 1000) return;
      this.arrived();
      const f = { ...h.f, seeking: null };
      this.said = { frame: f.frame, at: now, playing: f.playing };
      if (this.holding !== null && this.wanted === null) this.hooks.frame(this.holding, f);
    }, 500);
    this.aiming = a;
    this.view.seek(Math.round(frame));
  }
  /** The seek in hand is over (or another replaces it). */
  private arrived(): void {
    if (this.aiming) clearInterval(this.aiming.timer);
    this.aiming = null;
  }
  /** A seek is on its way (or a drag waits to be sent): the clock is where it was sent, not where the game still shows. */
  get seeking(): boolean { return this.aiming !== null || this.pending !== null; }
  /**
   * The play page says a seek of this replay itself, in a line over the game ("Running ahead to 2:56: 40%"): one that
   * cannot rewind, or one that is slow (a play page of 2026-11-09 and after). It counts from the moment the engine went
   * back to, which the view is not told, so nothing here gives a percentage beside it.
   */
  get saysSeeks(): boolean { return !this.quickBack || this.slow; }
  /**
   * A seek the page says itself (`saysSeeks`), once the view has said where it is: the frame it has got to (the frame
   * it shows, or how far the engine has run) and the one it was sent to. Null otherwise.
   */
  get runningAhead(): { at: number; to: number } | null {
    const a = this.aiming;
    // (Past where it goes: the moment a seek back is leaving, before the game starts again or goes back.)
    if (!this.saysSeeks || this.pending || !a || a.shown === null || a.shown > a.frame) return null;
    return { at: a.shown, to: a.frame };
  }
  /** How far a jump has run, 0 to 1, once the viewer has said; null before (or for a jump with no way to go). */
  get seekProgress(): number | null {
    const a = this.aiming;
    if (!a || this.pending || a.from === null || a.at === null || a.frame <= a.from) return null;
    return Math.max(0, Math.min(1, (a.at - a.from) / (a.frame - a.from)));
  }
  /** Look at a point of the map, in pixels. (The game lets go of a track for it.) */
  camera(x: number, y: number): void { if (this.view) { this.view.camera(x, y); this.sent = null; } }

  /** The game moves its camera along tracks itself (`follow`); otherwise `camera` it is, frame by frame. */
  get follows(): boolean { return this.loaded && this.tracks; }
  /** Have the game follow `track`, or stop (null). The same track again is not sent again while the game follows it. */
  follow(track: ViewTrack | null): void {
    if (!this.view || !this.follows) { this.sent = null; return; }
    if (track === this.sent) return;
    this.sent = track;
    this.view.follow(track);
  }
  /**
   * The frame the game shows now: the one it last said, carried on at `speed` since while it plays (it says one ten
   * times a second), no further than a fifth of a second's worth.
   */
  frameNow(speed: number): number | null {
    const s = this.said;
    if (!s) return null;
    if (!s.playing) return s.frame;
    return s.frame + (Math.min(200, performance.now() - s.at) / FRAME_MS) * speed;
  }
  /**
   * The frame the game is at for the clock: `frameNow`, or null while a seek is on its way (or a drag waits), when the
   * clock is where it was sent and what the game still shows is the moment it is leaving, or the first frame of a
   * restart.
   */
  clockFrame(speed: number): number | null { return this.seeking ? null : this.frameNow(speed); }
  /** How much of the map the game shows, pixels, once it has said. */
  get viewSize(): { width: number; height: number } | null { return this.loaded ? this.shows : null; }

  /** Where the game looks, on the editor's minimap: at once when the person moved it, else at most every `MINIMAP_MS`. */
  private tellMinimap(camera: MapViewCamera, now: boolean): void {
    // (An editor from before map views' minimaps has no setCamera: its minimap shows the map.)
    const tell = () => { this.telling = null; this.told = performance.now(); this.handle.setCamera?.(camera); };
    if (this.telling) clearTimeout(this.telling);
    this.telling = null;
    const wait = MINIMAP_MS - (performance.now() - this.told);
    if (now || wait <= 0) tell();
    else this.telling = setTimeout(tell, wait);
  }

  dispose(): void {
    this.dropDrag();
    this.arrived();
    if (this.busyTimer) clearTimeout(this.busyTimer);
    if (this.telling) clearTimeout(this.telling);
    this.settle(false);
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.changed.dispose();
    this.view?.dispose();
    this.view = null;
    this.handle.dispose();
  }
}
