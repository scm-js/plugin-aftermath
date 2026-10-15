/**
 * The Game view: the replay played out by the game's own code, with its own graphics, in the map's place
 * (`api.ui.mapView`), through the scm-sim plugin's `view` (the site's play page as a replay viewer).
 *
 * One viewer for every replay tab: the engine is a gigabyte of memory, so the replay in front is loaded into it when
 * its tab shows the Game view, and the next one's replaces it. While a tab shows the game the viewer is the clock —
 * Aftermath plays, pauses, seeks and changes speed through it and follows the frame it says — and Spectate's camera
 * moves the game's view instead of the map. Shown the map again, the clock is Aftermath's own, from where the game was.
 *
 * The view is offered only where it can play: the scm-sim plugin is there with a `view`, and the person's browser has
 * the game's files (the engine's page says so). Otherwise nothing changes: the tab has the map alone.
 */
import type { Disposable, MapViewHandle, PluginApi } from "@scm-js/plugin-api";
import type { ScmSimService, ScmSimView, ViewCamera, ViewFrame } from "./vendor/scm-sim";

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
  /** Where the game's camera looks, whenever it moved: its middle and what it shows, in pixels. */
  camera(c: ViewCamera): void;
  /** The person moved the game's camera (the arrows). */
  movedByUser(): void;
  /** The tab in front changed between the map and the game. */
  shown(shown: boolean): void;
  /** A replay is being loaded into the viewer, or failed to (null when neither). */
  state(text: string | null): void;
}

export class GameView {
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
  private aiming: { frame: number; sawSeeking: boolean } | null = null;

  constructor(api: PluginApi, hooks: GameViewHooks, title: string, words: GameView["words"]) {
    this.hooks = hooks;
    this.words = words;
    this.handle = api.ui.mapView({ title, mount: (el) => { this.element = el; } });
    this.changed = this.handle.onChange((on) => hooks.shown(on));
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
          if (f.seeking !== null) { a.sawSeeking = true; return; }
          // There (within two seconds: the game moves on while the answer comes), or a seek that ended elsewhere (past the end).
          if (Math.abs(f.frame - a.frame) > 48 && !a.sawSeeking) return;
          this.aiming = null;
        }
        this.hooks.frame(this.holding, f);
      }),
      view.onCamera((c) => { this.hooks.camera(c); if (c.byUser) this.hooks.movedByUser(); }),
    ];
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
      this.hooks.state(this.words.loading(entry.fileName));
      try {
        await view.load(entry.bytes, entry.fileName);
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
    }
    view.speed(speed);
    if (Math.round(frame) > 0) this.seek(frame);
    view.play(playing);
    return true;
  }

  play(on: boolean): void { this.view?.play(on); }
  speed(multiplier: number): void { this.view?.speed(multiplier); }
  seek(frame: number): void {
    if (!this.view) return;
    this.aiming = { frame: Math.round(frame), sawSeeking: false };
    this.view.seek(Math.round(frame));
  }
  /** A seek is on its way: the clock is where it was sent, not where the game still shows. */
  get seeking(): boolean { return this.aiming !== null; }
  /** Look at a point of the map, in pixels. */
  camera(x: number, y: number): void { this.view?.camera(x, y); }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.changed.dispose();
    this.view?.dispose();
    this.view = null;
    this.handle.dispose();
  }
}
