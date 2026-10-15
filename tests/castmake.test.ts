import { describe, expect, it } from "vitest";
import { batches, castKey, estimate, readStream, writingProgress, type StreamEvent } from "../castmake";

describe("a script being written", () => {
  it("says nothing before the storyline is whole, then gives it, and counts the lines and the part they are in", () => {
    expect(writingProgress('{"storyline":"genius goes me')).toEqual({ storyline: null, lines: 0, stretch: -1 });
    const text = '{"storyline":"genius goes mech; InJo \\"Nexus first\\".","arc":["a","b"],"lines":[{"moment":0,"at":0},{"moment":0,"at":9},{"moment":2,"at';
    expect(writingProgress(text)).toEqual({ storyline: 'genius goes mech; InJo "Nexus first".', lines: 3, stretch: 2 });
  });
});

describe("voicing in batches", () => {
  it("cuts the lines into batches of twelve, each with where it starts", () => {
    const b = batches(Array.from({ length: 30 }, (_, i) => i));
    expect(b.map((x) => [x.from, x.items.length])).toEqual([[0, 12], [12, 12], [24, 6]]);
  });
});

describe("what a cast will likely cost", () => {
  it("is about $0.45 of script and $1.60 of voice for ten minutes of a whole game at $0.30 a thousand characters", () => {
    const e = estimate(600, { format: "game", banter: "light" }, 0.3);
    expect(e.scriptUsd).toBeCloseTo(0.45, 2);
    expect(e.voiceUsd).toBeCloseTo(1.62, 2);
    expect(e.making).toEqual([2, 3]);
    expect(estimate(600, { format: "game", banter: "light" }, null).voiceUsd).toBe(0);
  });

  it("keys a cast by the replay and every choice that changes it", () => {
    expect(castKey("abc", { format: "game", banter: "lots" }, true, " In Korean ")).toBe("abc:game:lots:voiced:in korean");
  });
});

describe("the server's stream", () => {
  it("hands over each event as it arrives, across chunks that split frames", async () => {
    const chunks = ['event: start\ndata: {"event":"start"}\n\nevent: delta\nda', 'ta: {"event":"delta","text":"{\\"story"}\n\n', 'event: done\ndata: {"event":"done"}\n\n'];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const k of chunks) c.enqueue(new TextEncoder().encode(k)); c.close(); } });
    const seen: StreamEvent[] = [];
    await readStream(body, (e) => seen.push(e));
    expect(seen.map((e) => e.event)).toEqual(["start", "delta", "done"]);
    expect(seen[1].text).toBe('{"story');
  });
});

describe("casts kept in the browser", () => {
  const cast = (key: string, made: number, bytes: number, watched?: number) => ({ key, made, bytes, ...(watched ? { watched } : {}) });
  it("lets go of the ones watched or made longest ago past the count, and never the newest", async () => {
    const { toEvict } = await import("../castmake");
    const casts = [cast("a", 1, 10), cast("b", 2, 10, 50), cast("c", 3, 10), cast("d", 4, 10)];
    expect(toEvict(casts, 2, 1000)).toEqual(["c", "a"]);
    expect(toEvict(casts, 10, 25)).toEqual(["c", "a"]);
    expect(toEvict([cast("huge", 1, 5000)], 10, 100)).toEqual([]);
  });
});
