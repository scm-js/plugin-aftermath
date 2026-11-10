import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapViewCamera, MapViewSpec, PluginApi } from "@scm-js/plugin-api";
import { GameView } from "../gameview";
import type { ScmSimService, ScmSimView, ViewCamera, ViewFrame, ViewWheel } from "../vendor/scm-sim";

/** Just enough of an element for the Game view's mount and its hiding class. */
function fakeElement(): HTMLElement {
  const classes = new Set<string>();
  return {
    className: "", hidden: false, style: {}, clientWidth: 1200, clientHeight: 700,
    append() {}, setAttribute() {},
    // (A canvas's context that draws nothing: what is asked to be drawn is the handle's to keep.)
    getContext: () => ({ setTransform() {}, clearRect() {}, save() {}, restore() {} }),
    classList: { contains: (c: string) => classes.has(c), toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); return on; } },
  } as unknown as HTMLElement;
}

describe("the Game view opening a replay", () => {
  let spec: MapViewSpec;
  let element: HTMLElement;
  let cameras: ((c: ViewCamera) => void)[];
  let sent: { x: number; y: number; height?: number }[];
  let finishLoad: () => void;
  let wheels: ((w: ViewWheel) => void)[];
  let handed: ViewWheel[];
  let zooms: number;
  let frames: ((f: ViewFrame) => void)[];
  let told: ViewFrame[];
  let fogs: (boolean | null)[];
  let pointers: ({ x: number; y: number } | null)[];
  let painted: number;
  let pointerListeners: ((p: { x: number; y: number } | null) => void)[];
  let fogAsked: boolean[];
  /** The seeks the page was sent, and whether the replay loaded says a seek back is quick. */
  let seeks: number[];
  let rewinds: boolean;
  let slow: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { document: { createElement: () => fakeElement() }, window: { devicePixelRatio: 1, setInterval, clearInterval } });
    element = fakeElement();
    cameras = [];
    sent = [];
    wheels = [];
    handed = [];
    zooms = 0;
    frames = [];
    told = [];
    fogs = [];
    pointers = [];
    painted = 0;
    pointerListeners = [];
    fogAsked = [];
    seeks = [];
    rewinds = false;
    slow = undefined;
    const none = { dispose() {} };
    const view = {
      load: () => new Promise((resolve) => { finishLoad = () => resolve({ name: "", frames: 100, players: [], map: { width: 128, height: 128 }, rewinds, ...(slow === undefined ? {} : { slow }), looks: {}, follows: false }); }),
      camera: (x: number, y: number, height?: number) => { sent.push({ x, y, height }); },
      play() {}, speed() {}, seek: (f: number) => { seeks.push(f); }, player() {}, follow() {},
      options: () => Promise.resolve({}),
      onFrame: (l: (f: ViewFrame) => void) => { frames.push(l); return none; }, onKey: () => none, onUnits: () => none,
      onCamera: (l: (c: ViewCamera) => void) => { cameras.push(l); return none; },
      onWheel: (l: (w: ViewWheel) => void) => { wheels.push(l); return none; },
      onPointer: (l: (p: { x: number; y: number } | null) => void) => { pointerListeners.push(l); return none; },
    } as unknown as ScmSimView;
    const sim = { present: true, view: () => view, status: () => Promise.resolve({ available: true }) } as unknown as ScmSimService;
    let shown = false;
    const api = {
      view: { flags: () => ({}) },
      ui: {
        mapView: (s: MapViewSpec) => {
          spec = s;
          s.mount(element);
          return {
            offer() {}, onChange: () => none, isShown: () => shown, dispose() {}, setCamera() {}, redrawMinimap() {},
            wheel: (w: ViewWheel) => { handed.push(w); return true; },
            setFog: (on: boolean | null) => { fogs.push(on); },
            setPointer: (p: { x: number; y: number } | null) => { pointers.push(p); },
            paintOver: () => { painted++; },
            // The editor tells the view where its map was looking as it is shown: here, a stale place far out.
            show: (on: boolean) => { shown = on; if (on) spec.onShow?.({ x: 4000, y: 4000, width: 4000, height: 3000 } satisfies MapViewCamera); },
          };
        },
      },
    } as unknown as PluginApi;
    game = new GameView(api, { frame: (_id, f) => { told.push(f); }, movedByUser() {}, zoomed: () => { zooms++; }, shown() {}, state() {}, seeking() {}, hover() {}, fog: (on) => { fogAsked.push(on); } }, "Replay", { loading: (n) => n, failed: (m) => m });
    game.setService(sim);
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as { document?: unknown }).document; delete (globalThis as { window?: unknown }).window; });
  let game: GameView;

  const entry = { id: 1, fileName: "a.rep", bytes: new Uint8Array(1), docId: 7, eyes: null };
  const report = (height: number) => { for (const l of cameras) l({ x: 0, y: 0, width: height * 1.7, height, byUser: false }); };

  it("looks at the start at the game's own scale, not where the editor stood, and hides the game until it does", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    expect(element.classList.contains("afm-settling")).toBe(true);
    finishLoad();
    await held;
    // The game's 480 rows, whatever the frame's height (700 here, which would be the map's own scale).
    expect(sent).toEqual([{ x: 336, y: 1840, height: 480 }]);
    // Until the game says it looks at that scale, it stays hidden.
    report(700);
    expect(element.classList.contains("afm-settling")).toBe(true);
    report(480);
    expect(element.classList.contains("afm-settling")).toBe(false);
  });

  it("zooms the game where the editor asks, and has the camera track made again for the new scale at once", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    finishLoad();
    await held;
    report(480);
    sent.length = 0;
    spec.onZoom?.({ x: 1000, y: 900, width: 2400, height: 1400 });
    expect(sent).toEqual([{ x: 1000, y: 900, height: 1400 }]);
    // Until the game says what it took, the size asked is what a new track is made for.
    expect(game.viewSize).toEqual({ width: 2400, height: 1400 });
    expect(zooms).toBe(1);
  });

  it("hands the wheel over the game to the editor while it is shown", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    finishLoad();
    await held;
    const w: ViewWheel = { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, x: 500, y: 600 };
    for (const l of wheels) l(w);
    expect(handed).toEqual([w]);
  });

  it("carries the editor's grid and overlays, its fog toggle and the pointer over to the game", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    finishLoad();
    await held;
    // Everyone's eyes: the editor's Fog of War shows off, and a press on it is Aftermath's to answer.
    expect(fogs).toEqual([false]);
    spec.onFog?.(true);
    expect(fogAsked).toEqual([true]);
    game.eyes(2);
    expect(fogs).toEqual([false, true]);
    // What the editor draws over a map is drawn under Aftermath's marks each time the game moves, and when asked.
    report(480);
    expect(painted).toBe(1);
    spec.onRepaint?.();
    expect(painted).toBe(2);
    // The pointer's map pixel goes to the status bar while the game is shown.
    for (const l of pointerListeners) l({ x: 100, y: 200 });
    for (const l of pointerListeners) l(null);
    expect(pointers).toEqual([{ x: 100, y: 200 }, null]);
  });

  it("shows the game anyway when it never says it got there", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    finishLoad();
    await held;
    expect(element.classList.contains("afm-settling")).toBe(true);
    vi.advanceTimersByTime(600);
    expect(element.classList.contains("afm-settling")).toBe(false);
  });

  describe("seeking", () => {
    const say = (f: ViewFrame) => { for (const l of frames) l(f); };
    const loaded = async () => {
      await game.offer(entry, true, { x: 336, y: 1840 });
      const held = game.hold(entry, 0, false, 1);
      finishLoad();
      await held;
    };

    it("is over when the game shows the frame it was sent to", async () => {
      await loaded();
      game.seek(5000);
      say({ frame: 1000, playing: false, seeking: 1000 });
      expect(game.seeking).toBe(true);
      say({ frame: 5000, playing: false, seeking: null });
      expect(game.seeking).toBe(false);
      expect(told.at(-1)?.frame).toBe(5000);
    });

    it("is over where the game stopped when it ends short of the frame and the viewer never says so", async () => {
      await loaded();
      game.seek(20000);
      say({ frame: 1000, playing: false, seeking: 1000 });
      vi.advanceTimersByTime(300);
      say({ frame: 1400, playing: false, seeking: 1400 });
      vi.advanceTimersByTime(300);
      say({ frame: 1612, playing: false, seeking: 1612 });
      vi.advanceTimersByTime(3500);
      expect(game.seeking).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(game.seeking).toBe(false);
      expect(told.at(-1)).toEqual({ frame: 1612, playing: false, seeking: null });
    });

    it("waits on a long seek as long as it moves", async () => {
      await loaded();
      game.seek(40000);
      for (let at = 0; at < 20; at++) {
        say({ frame: at * 400, playing: false, seeking: at * 400 });
        vi.advanceTimersByTime(1000);
      }
      expect(game.seeking).toBe(true);
    });

    it("tells a view that cannot rewind a drag once, the last frame, when it ends", async () => {
      await loaded();
      expect(game.rewinds).toBe(false);
      for (const f of [1000, 1400, 2200, 3100]) { game.drag(f); vi.advanceTimersByTime(30); }
      expect(seeks).toEqual([]);
      // The clock is the pointer's meanwhile: the game, playing on, moves nothing.
      expect(game.seeking).toBe(true);
      say({ frame: 600, playing: true, seeking: null });
      expect(told).toEqual([]);
      game.dragEnd();
      expect(seeks).toEqual([3100]);
      // Let go once more (the pointer's capture ends after the press's own end): nothing new.
      game.dragEnd();
      expect(seeks).toEqual([3100]);
    });

    it("tells a view that cannot rewind where the pointer stood still, and not again where it already went", async () => {
      await loaded();
      game.drag(1000);
      vi.advanceTimersByTime(100);
      game.drag(2000);
      vi.advanceTimersByTime(250);
      expect(seeks).toEqual([2000]);
      // Back to where the seek in hand goes, then let go: that seek stands.
      game.drag(2600);
      game.drag(2000);
      game.dragEnd();
      expect(seeks).toEqual([2000]);
      // A key or a click is a seek of its own, at once, and drops a drag not yet sent.
      game.drag(5000);
      game.seek(4000);
      vi.advanceTimersByTime(1000);
      expect(seeks).toEqual([2000, 4000]);
    });

    it("seeks a view that rewinds at every move of a drag, as before", async () => {
      rewinds = true;
      await loaded();
      expect(game.rewinds).toBe(true);
      for (const f of [1000, 1400, 2200]) game.drag(f);
      game.dragEnd();
      expect(seeks).toEqual([1000, 1400, 2200]);
    });

    it("tells a slow view (a mod's plugins run) a drag once, though it rewinds", async () => {
      rewinds = true;
      slow = true;
      await loaded();
      expect(game.rewinds).toBe(true);
      for (const f of [1000, 1400, 2200]) { game.drag(f); vi.advanceTimersByTime(30); }
      expect(seeks).toEqual([]);
      expect(game.seeking).toBe(true);
      game.dragEnd();
      expect(seeks).toEqual([2200]);
      // Standing still a moment sends it too.
      game.drag(3000);
      vi.advanceTimersByTime(250);
      expect(seeks).toEqual([2200, 3000]);
    });

    it("seeks a view that rewinds and says it is not slow at every move of a drag", async () => {
      rewinds = true;
      slow = false;
      await loaded();
      for (const f of [1000, 1400]) game.drag(f);
      expect(seeks).toEqual([1000, 1400]);
    });

    it("holds the clock where it was sent while a view that cannot rewind starts the game again, and says how far it has run", async () => {
      await loaded();
      game.seek(8000);
      // Today's page starting the game again says frame 0, no seek, for a long while.
      for (let i = 0; i < 25; i++) {
        say({ frame: 0, playing: false, seeking: null });
        vi.advanceTimersByTime(1000);
      }
      expect(told).toEqual([]);
      expect(game.seeking).toBe(true);
      expect(game.clockFrame(1)).toBe(null);
      expect(game.runningAhead).toEqual({ at: 0, to: 8000 });
      // Then it runs ahead, saying how far.
      say({ frame: 0, playing: false, seeking: 4200 });
      expect(game.runningAhead).toEqual({ at: 4200, to: 8000 });
      expect(told).toEqual([]);
      say({ frame: 8000, playing: false, seeking: null });
      expect(game.seeking).toBe(false);
      expect(told).toEqual([{ frame: 8000, playing: false, seeking: null }]);
      expect(game.clockFrame(1)).toBe(8000);
    });

    it("holds the clock through a restart that says it is seeking (the page as fixed), even with no progress for long", async () => {
      await loaded();
      game.seek(8000);
      for (let i = 0; i < 20; i++) {
        say({ frame: 0, playing: true, seeking: 0 });
        vi.advanceTimersByTime(1000);
      }
      // A frame 0 with no seek after progress at 0 is not where the seek ended either.
      say({ frame: 0, playing: true, seeking: null });
      vi.advanceTimersByTime(3000);
      expect(told).toEqual([]);
      expect(game.seeking).toBe(true);
    });

    it("takes a seek a view that cannot rewind lost as over where the game is, after a long while", async () => {
      await loaded();
      game.seek(8000);
      for (let i = 0; i < 61; i++) {
        say({ frame: 0, playing: false, seeking: null });
        vi.advanceTimersByTime(1000);
      }
      expect(game.seeking).toBe(false);
      expect(told.at(-1)?.frame).toBe(0);
    });

    it("leaves out what the page says of a seek going elsewhere, where it names the seek's target", async () => {
      await loaded();
      game.seek(8000);
      say({ frame: 3000, playing: false, seeking: 3500, target: 6000 } as ViewFrame);
      expect(game.runningAhead).toBe(null);
      say({ frame: 3000, playing: false, seeking: 3600, target: 8000 } as ViewFrame);
      expect(game.runningAhead).toEqual({ at: 3600, to: 8000 });
      say({ frame: 8000, playing: false, seeking: null, target: 8000 } as ViewFrame);
      expect(told.at(-1)?.frame).toBe(8000);
    });

    it("is over when, playing, it lands and plays on past the frame before the viewer says so", async () => {
      await loaded();
      game.seek(5000);
      say({ frame: 1000, playing: true, seeking: 1000 });
      for (let i = 0; i < 30; i++) {
        say({ frame: 5200 + i * 24, playing: true, seeking: null });
        vi.advanceTimersByTime(100);
      }
      expect(game.seeking).toBe(false);
      expect(told.at(-1)?.seeking).toBe(null);
    });
  });
});

describe("the Game view when the engine cannot play the replay with what it has (plugin-scm-sim 0.19.0)", () => {
  afterEach(() => { delete (globalThis as { document?: unknown }).document; delete (globalThis as { window?: unknown }).window; });

  it("passes on the engine's reason with its sentence (no doubled \"Error:\"), says how far a mod's keeping is, and loads again once forgotten", async () => {
    Object.assign(globalThis, { document: { createElement: () => fakeElement() }, window: { devicePixelRatio: 1, setInterval, clearInterval } });
    const none = { dispose() {} };
    let keeping: ((k: { hash: string; message: string }) => void) | null = null;
    let loads = 0;
    let answer: (() => Promise<unknown>) = () => Promise.reject(Object.assign(new Error("Error: this map is built on terrain that StarCraft has not got, neither 1.16.1 nor Remastered (jungle tile group 3734; Remastered's jungle ends at 2045). It was made for a mod, and plays with that mod's files."), { reason: "mod-terrain" }));
    const view = {
      load: () => { loads++; return answer(); },
      camera() {}, play() {}, speed() {}, seek() {}, player() {}, follow() {},
      options: () => Promise.resolve({}),
      onFrame: () => none, onKey: () => none, onUnits: () => none, onCamera: () => none, onWheel: () => none, onPointer: () => none,
      onKeeping: (l: (k: { hash: string; message: string }) => void) => { keeping = l; return none; },
    } as unknown as ScmSimView;
    const sim = { present: true, view: () => view, status: () => Promise.resolve({ available: true, features: ["replayDoor"] }) } as unknown as ScmSimService;
    const api = { view: { flags: () => ({}) }, ui: { mapView: (s: MapViewSpec) => { s.mount(fakeElement()); return { offer() {}, onChange: () => none, isShown: () => false, show() {}, dispose() {}, setCamera() {}, redrawMinimap() {} }; } } } as unknown as PluginApi;
    const states: (string | null)[] = [];
    const failures: unknown[] = [];
    const game = new GameView(api, { frame() {}, movedByUser() {}, shown() {}, state: (s) => { states.push(s); }, seeking() {}, hover() {}, failure: (id, f) => { failures.push({ id, ...f }); } }, "Replay", { loading: (n) => `loading ${n}`, failed: (m) => `failed: ${m}`, keeping: (m) => `keeping: ${m}` });
    game.setService(sim);
    const entry = { id: 3, fileName: "c.rep", bytes: new Uint8Array(1), docId: 7, eyes: null, dataSet: { hash: "ac3f86533e4b5a31" } };
    expect(await game.hold(entry, 0, false, 1)).toBe(false);
    expect(failures).toEqual([{ id: 3, reason: "mod-terrain", message: "This map is built on terrain that StarCraft has not got, neither 1.16.1 nor Remastered (jungle tile group 3734; Remastered's jungle ends at 2045). It was made for a mod, and plays with that mod's files." }]);
    expect(states.at(-1)).toMatch(/^failed: This map is built/);
    expect(states.at(-1)).not.toMatch(/Error:/);
    // The mod picked: loaded again, the page keeping the mod's files first, then the replay.
    let finish: () => void = () => {};
    answer = () => new Promise((resolve) => { finish = () => resolve({ name: "c.rep", frames: 8073, players: [], map: { width: 128, height: 128 }, rewinds: false, looks: {}, follows: false }); });
    game.forget(3);
    const held = game.hold(entry, 0, false, 1);
    await Promise.resolve();
    keeping!({ hash: "ac3f86533e4b5a31", message: "Keeping the mod's files: 100 of 7,755 (40.0 MB)…" });
    expect(states.at(-1)).toBe("keeping: Keeping the mod's files: 100 of 7,755 (40.0 MB)…");
    finish();
    expect(await held).toBe(true);
    expect(loads).toBe(2);
    expect(failures.at(-1)).toEqual({ id: 3 });
  });
});
