import { describe, expect, it } from "vitest";
import { formatTime } from "../analysis";
import { frameAt, pastStart, shareView, withMoment, type ShareChoice } from "../share";

/** 6:42 under the playhead: 9,572 is the first frame the clock reads 6:42 at. */
const AT = 9572;
const LINK = "https://scmjs.dev/replay/Qy2kqoBd5UCkc13EmPIFTajs";

describe("a shared moment", () => {
  it("opens at the first frame whose clock reads the link's time, and past the end at the end", () => {
    expect(frameAt(402, 20000)).toBe(AT);
    expect(formatTime(frameAt(402, 20000))).toBe("6:42");
    // (The spec's frame, round(402 * 1000 / 42) = 9,571, reads 6:41 on the clock; the one after it reads 6:42.)
    expect(formatTime(9571)).toBe("6:41");
    for (let s = 0; s < 4000; s += 1) {
      const f = frameAt(s, 1e9);
      expect(Math.floor((f * 42) / 1000), String(s)).toBe(s);
      expect(f - Math.round((s * 1000) / 42), String(s)).toBeLessThanOrEqual(1);
    }
    expect(frameAt(99999, 14482)).toBe(14482);
    expect(frameAt(0, 14482)).toBe(0);
    expect(frameAt(12.5, 14482)).toBe(298);
  });

  it("is written into the link as t, with play for the player whoever opens it plays as", () => {
    expect(withMoment(LINK, null)).toBe(LINK);
    expect(withMoment(LINK, { frame: AT })).toBe(`${LINK}?t=6:42`);
    expect(withMoment(LINK, { frame: AT, play: 1 })).toBe(`${LINK}?t=6:42&play=1`);
    expect(withMoment(LINK, { frame: AT, play: 0 })).toBe(`${LINK}?t=6:42&play=0`);
    expect(withMoment(LINK, { frame: AT, play: null })).toBe(`${LINK}?t=6:42`);
    expect(withMoment(LINK, { frame: frameAt(3723, 1e9) })).toBe(`${LINK}?t=1:02:03`);
    // A link with a query of its own (a development server's) keeps it; a moment already on it is replaced.
    const dev = "http://localhost:5220/replay/abcdefghijklmnop?scmjs-server=http%3A%2F%2Flocalhost%3A8787";
    expect(withMoment(dev, { frame: AT, play: 2 })).toBe(`${dev}&t=6:42&play=2`);
    expect(withMoment(`${dev}&t=1:00&play=4`, null)).toBe(dev);
    expect(withMoment(`${LINK}?t=1:00`, { frame: AT })).toBe(`${LINK}?t=6:42`);
  });

  it("is chosen when the playhead is past the first second", () => {
    expect(pastStart(0)).toBe(false);
    expect(pastStart(23)).toBe(false);
    expect(pastStart(24)).toBe(true);
    expect(pastStart(AT)).toBe(true);
  });
});

describe("the Share popover", () => {
  const atTime: ShareChoice = { from: "time", who: "watch", player: 1 };

  it("signed out: Sign in to share, says it keeps the replay, no link yet", () => {
    const v = shareView({ state: "signed-out", providers: [{ id: "discord", name: "Discord" }] }, atTime, AT);
    expect(v).toEqual({ time: "6:42", who: true, link: null, action: "sign-in", keeps: true, reason: null });
  });

  it("signed in, not kept: Keep and copy link, with the line", () => {
    const v = shareView({ state: "not-kept" }, atTime, AT);
    expect(v.action).toBe("keep");
    expect(v.keeps).toBe(true);
    expect(v.link).toBeNull();
  });

  it("kept: Copy link with the link as chosen, and nothing said about keeping", () => {
    const kept = { state: "kept" as const, link: LINK };
    expect(shareView(kept, atTime, AT)).toEqual({ time: "6:42", who: true, link: `${LINK}?t=6:42`, action: "copy", keeps: false, reason: null });
    expect(shareView(kept, { ...atTime, who: "play" }, AT).link).toBe(`${LINK}?t=6:42&play=1`);
    // From the start: no moment, and nobody to play as.
    expect(shareView(kept, { from: "start", who: "play", player: 1 }, AT)).toMatchObject({ who: false, link: LINK });
    // The link follows the playhead.
    expect(shareView(kept, atTime, AT + 24 * 10).link).toBe(`${LINK}?t=6:52`);
  });

  it("kept without a link: Copy link makes it, and nothing is said about keeping", () => {
    expect(shareView({ state: "kept", link: null }, atTime, AT)).toMatchObject({ action: "copy", keeps: false, link: null });
  });

  it("while asked, and where it cannot be shared", () => {
    expect(shareView({ state: "asking" }, atTime, AT)).toMatchObject({ action: null, link: null, keeps: false, reason: null });
    expect(shareView({ state: "unavailable", reason: "This server keeps no replays." }, atTime, AT)).toMatchObject({ action: null, reason: "This server keeps no replays." });
  });
});
