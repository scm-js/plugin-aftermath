import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapViewCamera, MapViewSpec, PluginApi } from "@scm-js/plugin-api";
import { GameView } from "../gameview";
import type { ScmSimService, ScmSimView, ViewCamera, ViewFrame, ViewWheel } from "../vendor/scm-sim";

/** Just enough of an element for the Game view's mount and its hiding class. */
function fakeElement(): HTMLElement {
  const classes = new Set<string>();
  return {
    className: "", hidden: false, style: {}, clientWidth: 1200, clientHeight: 700,
    append() {}, setAttribute() {}, getContext: () => null,
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
    const none = { dispose() {} };
    const view = {
      load: () => new Promise((resolve) => { finishLoad = () => resolve({ name: "", frames: 100, players: [], map: { width: 128, height: 128 }, rewinds: false, looks: {}, follows: false }); }),
      camera: (x: number, y: number, height?: number) => { sent.push({ x, y, height }); },
      play() {}, speed() {}, seek() {}, player() {}, follow() {},
      options: () => Promise.resolve({}),
      onFrame: (l: (f: ViewFrame) => void) => { frames.push(l); return none; }, onKey: () => none, onUnits: () => none,
      onCamera: (l: (c: ViewCamera) => void) => { cameras.push(l); return none; },
      onWheel: (l: (w: ViewWheel) => void) => { wheels.push(l); return none; },
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
            // The editor tells the view where its map was looking as it is shown: here, a stale place far out.
            show: (on: boolean) => { shown = on; if (on) spec.onShow?.({ x: 4000, y: 4000, width: 4000, height: 3000 } satisfies MapViewCamera); },
          };
        },
      },
    } as unknown as PluginApi;
    game = new GameView(api, { frame: (_id, f) => { told.push(f); }, movedByUser() {}, zoomed: () => { zooms++; }, shown() {}, state() {}, seeking() {}, hover() {} }, "Replay", { loading: (n) => n, failed: (m) => m });
    game.setService(sim);
  });
  afterEach(() => { vi.useRealTimers(); delete (globalThis as { document?: unknown }).document; delete (globalThis as { window?: unknown }).window; });
  let game: GameView;

  const entry = { id: 1, fileName: "a.rep", bytes: new Uint8Array(1), docId: 7, eyes: null };
  const report = (height: number) => { for (const l of cameras) l({ x: 0, y: 0, width: height * 1.7, height, byUser: false }); };

  it("looks at the start at the map's scale, not where the editor stood, and hides the game until it does", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    expect(element.classList.contains("afm-settling")).toBe(true);
    finishLoad();
    await held;
    // The frame is 700 pixels tall: 700 map pixels at the map's own scale.
    expect(sent).toEqual([{ x: 336, y: 1840, height: 700 }]);
    // Where the game opens on its own (480 rows) is not shown.
    report(480);
    expect(element.classList.contains("afm-settling")).toBe(true);
    report(700);
    expect(element.classList.contains("afm-settling")).toBe(false);
  });

  it("zooms the game where the editor asks, and has the camera track made again for the new scale at once", async () => {
    await game.offer(entry, true, { x: 336, y: 1840 });
    const held = game.hold(entry, 0, false, 1);
    finishLoad();
    await held;
    report(700);
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
