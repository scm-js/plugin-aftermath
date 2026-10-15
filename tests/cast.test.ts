import { describe, expect, it } from "vitest";
import type { PlayerSeries, ReplayTimeline, UnitEvent } from "../vendor/scm-sim";
import type { Fight } from "../fights";
import { gainFor, loudness, TARGET_LOUDNESS } from "../castplay";
import { castCards, castInput, castSegments, estimate, highlightClips, schedule, spoken, unitsByType, type CastGame, type CastLine } from "../cast";

const MARINE = 0, SCV = 7, ZERGLING = 37, MUTALISK = 43, CC = 106, HATCHERY = 131, LAIR = 132;
const NAMES: Record<number, string> = { [MARINE]: "Marine", [SCV]: "SCV", [ZERGLING]: "Zergling", [MUTALISK]: "Mutalisk", [CC]: "Command Center", [HATCHERY]: "Hatchery", [LAIR]: "Lair" };
const S = (s: number) => Math.round(s / 0.042);

const fight = (from: number, to: number, extra: Partial<Fight> = {}): Fight => ({
  from, to, x: 2000, y: 2000, rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, points: [], losses: 10, value: 2000, winner: 0,
  kind: "battle", tier: "decisive", share: 0.4, turning: false, importance: 0.6, key: true,
  sides: [
    { player: 0, lost: 2, lostValue: 100, killed: 8, killedValue: 600, army: 10, armyValue: 500, had: 2000, lostTypes: new Map([[MARINE, 2]]) },
    { player: 1, lost: 8, lostValue: 600, killed: 2, killedValue: 100, army: 12, armyValue: 600, had: 1500, lostTypes: new Map([[MUTALISK, 2], [ZERGLING, 6]]) },
  ],
  ...extra,
});

describe("highlight clips", () => {
  it("frames each key fight, longer before the first, and joins clips that would overlap", () => {
    const clips = highlightClips([fight(S(300), S(320)), fight(S(330), S(340)), fight(S(600), S(630)), fight(S(100), S(110), { key: false })], S(900));
    expect(clips.map((c) => [Math.round(c.from * 0.042), Math.round(c.to * 0.042), c.fights.length])).toEqual([[260, 346, 2], [580, 636, 1]]);
  });

  it("stays inside the game", () => {
    const [c] = highlightClips([fight(S(10), S(895))], S(900));
    expect([c.from, c.to]).toEqual([0, S(900)]);
  });
});

function series(slot: number, n: number, armyValue: number[]): PlayerSeries {
  const z = () => Array.from({ length: n }, () => 0);
  return { slot, minerals: z().map(() => 200), gas: z().map(() => 50), supplyUsed: z().map(() => 40), supplyMax: z().map(() => 50), workers: z().map(() => 20), army: z(), armyValue, buildings: z() };
}

function game(): CastGame {
  const ev = (frame: number, kind: UnitEvent["kind"], unit: number, type: number, owner: number): UnitEvent => ({ frame, kind, unit, type, owner, x: 100, y: 100 });
  const events: UnitEvent[] = [
    ev(0, "born", 0, CC, 0), ev(0, "born", 1, HATCHERY, 1), ev(0, "born", 2, SCV, 0),
    ev(S(100), "born", 3, MARINE, 0), ev(S(110), "born", 4, MARINE, 0), ev(S(115), "done", 3, MARINE, 0), ev(S(125), "done", 4, MARINE, 0),
    ev(S(150), "morph", 1, LAIR, 1),
    ev(S(200), "born", 5, MUTALISK, 1), ev(S(201), "born", 6, MUTALISK, 1), ev(S(240), "done", 5, MUTALISK, 1), ev(S(241), "done", 6, MUTALISK, 1),
    ev(S(255), "born", 7, MUTALISK, 1),
    { ...ev(S(305), "died", 5, MUTALISK, 1), by: 3, byType: MARINE, byOwner: 0 }, { ...ev(S(305), "died", 6, MUTALISK, 1), by: 4, byType: MARINE, byOwner: 0 }, ev(S(318), "died", 3, MARINE, 0),
  ];
  const frames = [0, S(100), S(200), S(300), S(400)];
  const timeline: ReplayTimeline = {
    version: 4, frames: S(400), total: S(400), ended: null, map: { width: 128, height: 128 },
    players: [{ slot: 0, name: "T", race: 1 }, { slot: 1, name: "Z", race: 0 }], events,
    research: [{ frame: S(250), player: 0, kind: "upgrade", id: 9, level: 1 }],
    samples: { every: S(100), frame: frames, players: [series(0, 5, [0, 100, 100, 1500, 1500]), series(1, 5, [0, 0, 400, 400, 0])] },
    positions: null,
  };
  return {
    map: "Ridge", timeline, winner: 0,
    players: [
      { index: 0, name: "Tara", race: 1, leftAt: null, build: [{ frame: S(5), kind: "train", id: SCV, count: 4 }, { frame: S(20), kind: "build", id: 111, count: 1 }, { frame: S(40), kind: "train", id: MARINE, count: 2 }] },
      { index: 1, name: "Zed", race: 0, leftAt: S(390), build: [{ frame: S(30), kind: "build", id: 142, count: 1 }] },
    ],
    fights: [fight(S(300), S(320))],
    bases: [{ player: 1, frame: S(120), x: 3000, y: 3000, line: 1, nth: 2 }],
    names: { unit: (id) => NAMES[id] ?? `Unit ${id}`, upgrade: (id) => `Upgrade ${id}`, tech: (id) => `Tech ${id}`, place: (x) => (x > 2500 ? "4 o'clock" : "the middle") },
  };
}

describe("the facts sent", () => {
  it("counts each player's finished units at a moment, leaving buildings and what is still being made out", () => {
    const at = unitsByType(game().timeline, S(250));
    expect([...at.get(0)!]).toEqual([[SCV, 1], [MARINE, 2]]);
    expect([...at.get(1)!]).toEqual([[MUTALISK, 2]]);
  });

  it("writes the opening, what changed, where things stand, what fell and how it came out", () => {
    const g = game();
    const input = castInput(g, highlightClips(g.fights, g.timeline.frames), " louder ");
    expect(input.game).toEqual({
      map: "Ridge", length: 400, players: [{ id: 0, name: "Tara", race: "Terran", result: "won" }, { id: 1, name: "Zed", race: "Zerg", result: "left" }],
      // Workers taken as read; the supply each step was ordered at.
      openings: ["Tara (Terran), supply and time of each order: 40 Unit 111 (0:20), 40 Marine (0:40)", "Zed (Zerg), supply and time of each order: 40 Unit 142 (0:30)"],
    });
    expect(input.wishes).toBe("louder");
    const [m] = input.moments;
    expect([m.from, m.to, m.title]).toEqual([260, 326, "A decisive fight at the middle"]);
    // What can be shown on screen is tagged with its card.
    expect(m.before).toEqual(["1:40 Tara makes their first Marine [card c1]", "2:00 Zed takes a base at 4 o'clock (their second)", "2:30 Zed starts their first Lair [card c2]", "3:20 Zed makes their first Mutalisk [card c3]", "4:10 Tara finishes Upgrade 9 [card c4]"]);
    expect(m.state).toEqual([
      "Tara at 4:20: supply 40/50, 20 workers, 200 minerals and 50 gas in the bank",
      "Tara's upgrades and research: Upgrade 9",
      "Tara's whole army, wherever it stands: 2 Marine (2 units, worth 100)",
      "Zed at 4:20: supply 40/50, 20 workers, 200 minerals and 50 gas in the bank",
      "Zed has no upgrades or research yet",
      "Zed's whole army, wherever it stands: 2 Mutalisk (2 units, worth 400)",
      "Zed leads in army at 4:20: 400 against 100 for Tara",
    ]);
    // Seconds on screen from the clip's start, each with the game's clock; a key fight blow by blow, with what killed what.
    expect(m.events).toEqual([
      { at: 36, text: "4:56 Armies close at the middle; at the fight: 10 of Tara's fighting units, 12 of Zed's fighting units" },
      { at: 45, text: "5:05 the first Mutalisk Zed has lost" },
      { at: 45, text: "5:05 Zed loses 2 Mutalisk to Tara's Marine" },
      { at: 58, text: "5:18 the first Marine Tara has lost" },
      { at: 58, text: "5:18 Tara loses 1 Marine" },
    ]);
    // What fell is weighed against everything the side had; the units at the fight are said apart from the whole army.
    expect(m.after).toContain("Zed lost 6 Zergling, 2 Mutalisk (600 worth, 40% of their whole army and workers); 12 of their fighting units were at the fight when it began");
    expect(m.after).toContain("Tara came out ahead");
    expect(m.after).toContain("Tara leads in army at 5:26: 1.5k against 400 for Zed");
    expect(m.after.at(-1)).toBe("Tara wins; the game ends at 6:40");
  });
});

describe("the cards on screen", () => {
  it("are each research and the first of each unit and building, numbered in the order they begin, from start to finish", () => {
    const g = game();
    expect(castCards(g).map((c) => [c.id, c.kind, c.type, c.player, c.start, c.done])).toEqual([
      ["c1", "unit", MARINE, 0, S(100), S(115)],
      ["c2", "unit", LAIR, 1, S(150), S(150)],
      ["c3", "unit", MUTALISK, 1, S(200), S(240)],
      ["c4", "upgrade", 9, 0, S(250), S(250)],
    ]);
    // With the game's research times, a research card starts when the research did.
    expect(castCards({ ...g, durations: () => 100 }).find((c) => c.kind === "upgrade")?.start).toBe(S(250) - 100);
  });
});

describe("the whole game as one cast", () => {
  it("plays the quiet stretches fast between the key fights, with no gap and no cut", () => {
    const segs = castSegments([fight(S(300), S(320)), fight(S(600), S(630))], S(900));
    expect(segs.map((c) => [Math.round(c.from * 0.042), Math.round(c.to * 0.042), c.speed, c.fights.length])).toEqual([
      [0, 280, 2, 0], [280, 326, 1, 1], [326, 580, 6, 0], [580, 636, 1, 1], [636, 900, 16, 0],
    ]);
  });

  it("is played fast from end to end when nothing was key", () => {
    expect(castSegments([], S(600)).map((c) => c.speed)).toEqual([5]);
  });
});

describe("the schedule", () => {
  // Fifteen seconds on screen of a minute of game at 4×, then thirty seconds of fight at 1×.
  const moments = [{ from: 0, to: 60, speed: 4, seconds: 15 }, { from: 60, to: 90, speed: 1, seconds: 30 }];
  const line = (moment: number, at: number, priority: 1 | 2 | 3 = 2, speaker: "caster" | "analyst" = "caster"): CastLine => ({ moment, at, speaker, text: "x", priority });

  it("says lines in turn on one timeline, across a stretch's end, and drops what would come too late for its priority", () => {
    const s = schedule([line(0, 0, 1), line(0, 1, 3), line(0, 12, 2, "analyst"), line(1, 0, 2)], [4, 2, 5, 2], moments);
    expect(s.lines.map((l) => [l.clip, l.start, l.frame])).toEqual([[0, 0, 0], [2, 12, Math.round(48 / 0.042)], [3, 17.3, Math.round(62.3 / 0.042)]]);
    expect([s.starts, s.length, s.hold]).toEqual([[0, 15], 45, 0]);
  });

  it("holds the last frame for a line that runs past the end, and starts one after the end by the clock", () => {
    const s = schedule([line(1, 28, 1), line(1, 30, 1, "analyst")], [5, 3], moments);
    expect(s.lines.map((l) => [l.start, l.frame])).toEqual([[43, Math.round(88 / 0.042)], [48.3, -1]]);
    expect(s.hold).toBeCloseTo(6.3, 6);
  });

  it("guesses a line's length from its words when it has no voice", () => {
    expect(estimate("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven")).toBe(10);
    expect(estimate("Yes")).toBe(0.8);
    // A cue is acted, not said: it is not counted, and the captions leave it out.
    expect(estimate("[surprised] one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven")).toBe(10);
    expect(spoken("[getting excited] Here they come!  [chuckles] Oh no.")).toBe("Here they come! Oh no.");
  });
});

describe("the voices' loudness", () => {
  const tone = (amplitude: number, seconds = 2, rate = 8000) => Float32Array.from({ length: seconds * rate }, (_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));
  const buffer = (data: Float32Array) => ({ numberOfChannels: 1, sampleRate: 8000, getChannelData: () => data });

  it("measures a steady tone the way the standard does (a full-scale sine is about -3.7)", () => {
    expect(loudness([tone(1)], 8000)).toBeCloseTo(-3.7, 1);
    expect(loudness([tone(0.1)], 8000)).toBeCloseTo(-23.7, 1);
    expect(loudness([new Float32Array(16000)], 8000)).toBe(-Infinity);
  });

  it("leaves the pauses out, so a line with a gap is as loud as one without", () => {
    const gapped = new Float32Array(48000); gapped.set(tone(0.1), 0); gapped.set(tone(0.1), 32000);
    // (Blocks across the edge of a pause count a little, as the standard has it: within half a decibel.)
    expect(Math.abs(loudness([gapped], 8000) - loudness([tone(0.1)], 8000))).toBeLessThan(0.5);
  });

  it("brings a quiet voice and a loud one to the same level, within fifteen decibels", () => {
    const quiet = gainFor(buffer(tone(0.05))), loud = gainFor(buffer(tone(0.4)));
    expect(loudness([tone(0.05 * quiet)], 8000)).toBeCloseTo(TARGET_LOUDNESS, 1);
    expect(loudness([tone(0.4 * loud)], 8000)).toBeCloseTo(TARGET_LOUDNESS, 1);
    expect(gainFor(buffer(tone(0.0005)))).toBeCloseTo(10 ** (15 / 20), 6);
    expect(gainFor(buffer(new Float32Array(16000)))).toBe(1);
  });
});
