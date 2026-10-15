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
 */
import type { Disposable, MapViewCamera, MapViewHandle, MinimapView, PluginApi } from "@scm-js/plugin-api";
import type { ScmSimService, ScmSimView, ViewFrame, ViewTrack, ViewUnits } from "./vendor/scm-sim";
import { FRAME_MS } from "./replay";

/** The editor's minimap follows the game's camera at most this often (each move redraws it). */
const MINIMAP_MS = 66;

/** What the Game view needs of a replay. */
export interface Held {
  id: number;
  fileName: string;
  bytes: Uint8Array;
  docId: number | null;
}

export interface GameViewHooks {
  /** The frame the viewer shows, for the replay it holds. */
  frame(id: number, f: ViewFrame): void;
  /** The person moved the game's camera (the arrows, or the editor's minimap). */
  movedByUser(): void;
  /** The tab in front changed between the map and the game. */
  shown(shown: boolean): void;
  /** A replay is being loaded into the viewer, or failed to (null when neither). */
  state(text: string | null): void;
  /** A jump runs on towards where it was sent (`GameView.seekProgress`). */
  seeking(): void;
}

export class GameView {
  private readonly api: PluginApi;
  private readonly hooks: GameViewHooks;
  private readonly handle: MapViewHandle;
  private readonly words: { loading: (name: string) => string; failed: (message: string) => string };
  private element: HTMLElement | null = null;
  private view: ScmSimView | null = null;
  private subs: Disposable[] = [];
  /** The replay loaded in the viewer, and the one being loaded. */
  private holding: number | null = null;
  private wanted: number | null = null;
  /** Whether the engine can play here: unknown until asked, then kept. */
  private canPlay: boolean | null = null;
  private asking: Promise<boolean> | null = null;
  private sim: ScmSimService | null = null;
  private readonly changed: Disposable;
  /**
   * A seek asked for and not yet arrived: until the viewer shows a frame there, what it says it shows is the moment
   * it is leaving (it reports the frame on screen while it runs ahead), which is not the clock any more.
   */
  private aiming: { frame: number; sawSeeking: boolean; from: number | null; at: number | null } | null = null;
  /** Where the game is to look once it holds the replay (the map's place when the switch came), in pixels. */
  private look: MapViewCamera | null = null;
  /** The squares of the game's minimap, for the editor's, while it holds a replay. */
  private units: ViewUnits | null = null;
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

  constructor(api: PluginApi, hooks: GameViewHooks, title: string, words: GameView["words"]) {
    this.api = api;
    this.hooks = hooks;
    this.words = words;
    this.handle = api.ui.mapView({
      title,
      mount: (el) => {
        this.element = el;
        const box = document.createElement("div"), spin = document.createElement("span"), line = document.createElement("span");
        box.className = "afm-busy";
        box.hidden = true;
        box.setAttribute("role", "status");
        spin.className = "afm-spin";
        box.append(spin, line);
        el.append(box);
        this.busyBox = box;
        this.busyLine = line;
      },
      onShow: (look) => this.lookAt(look),
      minimap: {
        draw: (ctx, m) => this.drawUnits(ctx, m),
        press: (x, y) => { if (this.view && this.loaded) { this.view.camera(x, y); hooks.movedByUser(); } },
      },
    });
    this.changed = this.handle.onChange((on) => hooks.shown(on));
  }

  /** A replay is loaded in the viewer and no other is on its way. */
  private get loaded(): boolean { return this.holding !== null && this.wanted === null; }
  /** A replay is on its way into the viewer. */
  get loading(): boolean { return this.wanted !== null; }

  /**
   * The spinner over the game, with `text` beside it; null takes it away. It shows only once the wait has gone on a
   * moment, so a quick jump does not flash it.
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
    if (!box.hidden || this.busyTimer) return;
    this.busyTimer = setTimeout(() => { this.busyTimer = null; box.hidden = false; }, 200);
  }

  /** Look where `look` says, at its scale (the viewer keeps to what the game allows): now, or once the replay is in. */
  private lookAt(look: MapViewCamera): void {
    if (this.view && this.loaded) { this.view.camera(look.x, look.y, look.height); this.sent = null; this.look = null; }
    else this.look = look;
  }

  /** The game's minimap squares on the editor's minimap. */
  private drawUnits(ctx: CanvasRenderingContext2D, m: MinimapView): void {
    const u = this.units;
    if (!u || !this.loaded) return;
    const { boxes, colours } = u;
    for (let i = 0; i < colours.length; i++) {
      const w = Math.max(2, boxes[i * 4 + 2] * m.scale), h = Math.max(2, boxes[i * 4 + 3] * m.scale);
      ctx.fillStyle = `#${colours[i].toString(16).padStart(6, "0")}`;
      ctx.fillRect(m.x(boxes[i * 4]) - w / 2, m.y(boxes[i * 4 + 1]) - h / 2, w, h);
    }
  }

  setService(sim: ScmSimService | null): void {
    if (sim === this.sim) return;
    this.sim = sim;
    this.canPlay = null;
    this.asking = null;
  }

  /** Whether the Game view can be offered: the scm-sim plugin has one, and the browser has the game's files. */
  async available(): Promise<boolean> {
    const sim = this.sim;
    if (!sim?.present || typeof sim.view !== "function") return false;
    if (this.canPlay !== null) return this.canPlay;
    this.asking ??= sim.status().then((s) => (this.canPlay = s.available), () => (this.canPlay = false));
    return this.asking;
  }

  /** Offer the Game view on a replay's tab, and show it there when `show`. */
  async offer(entry: Held, show: boolean): Promise<boolean> {
    if (entry.docId === null || !(await this.available())) return false;
    this.handle.offer(true, entry.docId);
    if (show) this.handle.show(true, entry.docId);
    return true;
  }

  /** The tab in front shows the game. */
  get shown(): boolean { return this.handle.isShown(); }
  /** Show the map (or the game again) on a replay's tab. */
  show(on: boolean, docId?: number): void { this.handle.show(on, docId); }
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
        const a = this.aiming;
        if (a) {
          // (On its way the viewer says how far the engine has run: `seeking` is that frame.)
          if (f.seeking !== null) { a.sawSeeking = true; a.from ??= f.seeking; a.at = f.seeking; this.hooks.seeking(); return; }
          // There (within two seconds: the game moves on while the answer comes), or a seek that ended elsewhere: past
          // the end, short of where it was sent and no nearer the start than the engine had run. A frame that says the
          // seek is over while it still shows where the seek began is not the end of it.
          const near = Math.abs(f.frame - a.frame) <= 48;
          const ended = a.sawSeeking && a.at !== null && f.frame >= a.at && f.frame <= a.frame + 48;
          if (!near && !ended) return;
          this.aiming = null;
        }
        this.said = { frame: f.frame, at: performance.now(), playing: f.playing };
        this.hooks.frame(this.holding, f);
      }),
      view.onCamera((c) => {
        if (!this.loaded) return;
        if (c.width > 0 && c.height > 0) {
          this.shows = { width: c.width, height: c.height };
          this.tellMinimap({ x: c.x, y: c.y, width: c.width, height: c.height }, c.byUser);
        }
        // (The game lets go of a track itself when the person moves its view.)
        if (c.byUser) { this.sent = null; this.hooks.movedByUser(); }
      }),
    ];
    // (scm-sim before 0.6.0 sends no squares: the editor's minimap then shows the ground alone.)
    if (typeof view.onUnits === "function") this.subs.push(view.onUnits((u) => { if (!this.loaded) return; this.units = u; this.handle.redrawMinimap?.(); }));
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
      this.wanted = entry.id;
      this.units = null;
      this.handle.redrawMinimap?.();
      this.hooks.state(this.words.loading(entry.fileName));
      this.sent = null;
      this.said = null;
      try {
        const viewed = await view.load(entry.bytes, entry.fileName);
        this.tracks = viewed.follows === true && typeof view.follow === "function";
      } catch (err) {
        // A load replaced by another is that one's to finish.
        if (this.wanted !== entry.id) return false;
        this.wanted = null;
        this.holding = null;
        this.hooks.state(this.words.failed(err instanceof Error ? err.message : String(err)));
        return false;
      }
      if (this.wanted !== entry.id) return false;
      this.wanted = null;
      this.holding = entry.id;
      this.hooks.state(null);
      this.remastered = null;
    }
    this.graphics();
    // Where the map was looking when the switch came, rather than where the viewer opens a replay.
    if (this.look) this.lookAt(this.look);
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

  play(on: boolean): void { this.view?.play(on); }
  speed(multiplier: number): void { this.view?.speed(multiplier); }
  seek(frame: number): void {
    if (!this.view) return;
    this.aiming = { frame: Math.round(frame), sawSeeking: false, from: null, at: null };
    this.view.seek(Math.round(frame));
  }
  /** A seek is on its way: the clock is where it was sent, not where the game still shows. */
  get seeking(): boolean { return this.aiming !== null; }
  /** How far a jump has run, 0 to 1, once the viewer has said; null before (or for a jump with no way to go). */
  get seekProgress(): number | null {
    const a = this.aiming;
    if (!a || a.from === null || a.at === null || a.frame <= a.from) return null;
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
    if (this.busyTimer) clearTimeout(this.busyTimer);
    if (this.telling) clearTimeout(this.telling);
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.changed.dispose();
    this.view?.dispose();
    this.view = null;
    this.handle.dispose();
  }
}
