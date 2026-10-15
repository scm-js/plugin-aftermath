import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_SECONDS, type Placed } from "../cast";
import { Reel } from "../castplay";

const line = (at: number, clip: number): Placed => ({ moment: 0, speaker: "caster", text: "…", clip, start: at, duration: 2, frame: Math.round(at / FRAME_SECONDS) });
const voice = { numberOfChannels: 1, sampleRate: 8000, getChannelData: () => new Float32Array(8000).fill(0.1) } as unknown as AudioBuffer;

describe("the game under the commentary", () => {
  let now = 0;
  let next: FrameRequestCallback | null = null;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { next = cb; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { next = null; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("is turned down while a voice talks, held down across a short gap between two lines, and not for a line in captions only", () => {
    const said: [boolean, number][] = [];
    // Two voiced lines 0.3 s apart, then one in captions only.
    const plan = { lines: [line(0, 0), line(2.3, 1), line(10, -1)], starts: [0], length: 12, hold: 0 };
    const reel = new Reel({
      frame: () => Math.floor(now / 1000 / FRAME_SECONDS),
      seek: () => {}, speed: () => {}, play: () => {}, pause: () => {}, playing: () => true, changed: () => {}, ended: () => {},
      talking: (on) => said.push([on, now]),
    }, [{ from: 0, to: 12 }], plan, [voice, voice], null);
    reel.start();
    while (next && now < 14_000) { const cb = next; next = null; cb(now); now += 100; }
    expect(said.map(([on]) => on)).toEqual([true, false]);
    // On from the first line; off 0.7 s after the second one ends (4.3 s), and not again for the captions.
    expect(said[0][1]).toBeLessThan(300);
    expect(said[1][1]).toBeGreaterThanOrEqual(4300 + 700 - 100);
    expect(said[1][1]).toBeLessThan(4300 + 700 + 200);
    reel.stop();
  });
});
