/**
 * A cast of a game: the moments a broadcast would show, the facts two commentators get about each (sent to the
 * scmjs.dev server's `cast` recipe, which writes what they say), and when each line is spoken once its voice is back
 * and measured. Everything is worked out before the cast plays, as the camera's track is: the whole game is known.
 * Pure and tested; the plugin plays the result.
 *
 * Times sent to the server are game seconds at Fastest (a frame is 42 ms); times here are frames unless named seconds.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";
import type { Fight } from "./fights";
import { NOT_MADE, WORKERS, counted, isBuilding } from "./played";
import type { Base } from "./story";

export const FRAME_SECONDS = 0.042;
const seconds = (frame: number) => Math.round(frame * FRAME_SECONDS * 10) / 10;
const frameOf = (s: number) => Math.round(s / FRAME_SECONDS);

/** A highlight's clip starts this long before its fight (twenty seconds), the first longer for the welcome, and runs this long after (six). */
const LEAD_IN = frameOf(20);
const FIRST_LEAD_IN = frameOf(40);
const AFTER = frameOf(6);
/** Deaths this close together are one line of what fell (three seconds). */
const LOSS_BUCKET = frameOf(3);
/** The most timed facts in one moment; past this, losses are bucketed wider. */
const MAX_EVENTS = 60;
/** Build steps said for each player's opening. */
const OPENING_STEPS = 12;
/** Supply Depot, Refinery, Extractor, Pylon, Assimilator, Overlord: not news when the first goes down. */
const ROUTINE = new Set([109, 110, 149, 156, 157, 42]);

/* ── What the server is sent, and what it answers (ai-server `src/protocol.ts`) ── */

export type CastSpeaker = "caster" | "analyst";

export interface CastInput {
  game: { map: string; length: number; players: { id: number; name: string; race: "Zerg" | "Terran" | "Protoss"; result: "won" | "lost" | "left" | "unknown" }[] };
  moments: CastMoment[];
  wishes?: string;
}

export interface CastMoment {
  from: number;
  to: number;
  title: string;
  before: string[];
  events: { at: number; text: string }[];
  after: string[];
}

export interface CastLine { moment: number; at: number; speaker: CastSpeaker; text: string; priority: 1 | 2 | 3 }

/* ── The moments ── */

/** A clip of the game a cast shows, in frames, and the fights in it. */
export interface Clip { from: number; to: number; fights: Fight[] }

/**
 * The highlights: a clip around each of the game's key fights, from a little before it (longer before the first, for
 * the welcome) to a little after; clips that would overlap are one.
 */
export function highlightClips(fights: readonly Fight[], frames: number): Clip[] {
  const keys = fights.filter((f) => f.key).sort((a, b) => a.from - b.from);
  const out: Clip[] = [];
  for (const f of keys) {
    const from = Math.max(0, f.from - (out.length ? LEAD_IN : FIRST_LEAD_IN)), to = Math.min(frames, f.to + AFTER);
    const last = out[out.length - 1];
    if (last && from <= last.to) { last.to = Math.max(last.to, to); last.fights.push(f); continue; }
    out.push({ from, to, fights: [f] });
  }
  return out;
}

/** Names the facts are written with: the game's names for units and research, and where on the map a point is. */
export interface CastNames {
  unit(id: number): string;
  upgrade(id: number): string;
  tech(id: number): string;
  /** "7 o'clock", "the middle". */
  place(x: number, y: number): string;
}

export interface CastPlayer {
  /** The game's player number (`ReplayPlayer.index`), as the timeline names a player. */
  index: number;
  name: string;
  /** 0 Zerg, 1 Terran, 2 Protoss. */
  race: number;
  /** The frame the player left on, or null. */
  leftAt: number | null;
  /** The opening as ordered: units.dat ids of what was built, trained or morphed, research ids, in order. */
  build: { frame: number; kind: "build" | "train" | "morph" | "upgrade" | "tech"; id: number; count: number }[];
}

export interface CastGame {
  map: string;
  timeline: ReplayTimeline;
  players: CastPlayer[];
  fights: readonly Fight[];
  bases: readonly Base[];
  /** The winner's player number, or null when it cannot be told. */
  winner: number | null;
  names: CastNames;
}

const RACES = ["Zerg", "Terran", "Protoss"] as const;
const clock = (frame: number) => { const s = Math.round(frame * FRAME_SECONDS); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const plural = (n: number, word: string) => (n === 1 ? `1 ${word}` : `${n} ${word}`);
const worth = (v: number) => (v >= 1000 ? `${(Math.round(v / 100) / 10).toFixed(1)}k` : String(Math.round(v / 10) * 10));

/** What each player had at a frame: finished units by type, never buildings (a unit in production is not there yet). */
export function unitsByType(t: ReplayTimeline, frame: number): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  const live = new Map<number, { type: number; owner: number }>();
  for (const e of t.events) {
    if (e.frame > frame) break;
    if (e.kind === "died") live.delete(e.unit);
    else if (e.kind === "done" || e.kind === "morph" || e.frame === 0 || live.has(e.unit)) live.set(e.unit, { type: e.type, owner: e.owner });
  }
  for (const { type, owner } of live.values()) {
    if (owner > 7 || !counted(type) || isBuilding(type)) continue;
    let m = out.get(owner);
    if (!m) out.set(owner, (m = new Map()));
    m.set(type, (m.get(type) ?? 0) + 1);
  }
  return out;
}

/** The facts of a moment and the ones before it, written for the commentators. */
export function castInput(game: CastGame, clips: readonly Clip[], wishes?: string): CastInput {
  const t = game.timeline;
  // One name for a unit whatever mode it is in: a Siege Tank is a Siege Tank, sieged or not.
  const n: CastNames = { ...game.names, unit: (id) => game.names.unit(id).replace(/\s*\([^)]*\)\s*$/, "") };
  const nameOf = (index: number) => game.players.find((p) => p.index === index)?.name ?? `Player ${index + 1}`;
  const shown = new Set(game.players.map((p) => p.index));
  const sample = (frame: number) => { let i = 0; while (i + 1 < t.samples.frame.length && t.samples.frame[i + 1] <= frame) i++; return i; };

  // The first of each kind of unit and building each player made: news the analyst reads tech from.
  const firsts: { frame: number; player: number; type: number }[] = [];
  const seen = new Set<string>();
  for (const e of t.events) {
    if ((e.kind !== "born" && e.kind !== "morph") || !shown.has(e.owner) || !counted(e.type) || WORKERS.has(e.type) || NOT_MADE.has(e.type) || ROUTINE.has(e.type) || e.frame === 0) continue;
    const k = `${e.owner}:${n.unit(e.type)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    firsts.push({ frame: e.frame, player: e.owner, type: e.type });
  }

  const standing = (frame: number) => {
    const out: string[] = [];
    const i = sample(frame), units = unitsByType(t, frame);
    for (const p of game.players) {
      const q = t.samples.players.find((s) => s.slot === p.index);
      if (!q) continue;
      const army = [...(units.get(p.index) ?? new Map<number, number>())].filter(([type]) => !WORKERS.has(type)).sort((a, b) => b[1] - a[1]);
      const mix = army.slice(0, 6).map(([type, k]) => `${k} ${n.unit(type)}`).join(", ");
      out.push(`${p.name} at ${clock(frame)}: supply ${q.supplyUsed[i] ?? 0}/${q.supplyMax[i] ?? 0}, ${q.workers[i] ?? 0} workers, army worth ${worth(q.armyValue[i] ?? 0)}${mix ? ` (${mix})` : ""}, ${q.minerals[i] ?? 0} minerals and ${q.gas[i] ?? 0} gas in the bank`);
    }
    return out;
  };

  const happened = (from: number, to: number) => {
    const out: { frame: number; text: string }[] = [];
    for (const b of game.bases) if (b.frame >= from && b.frame < to && shown.has(b.player)) out.push({ frame: b.frame, text: `${nameOf(b.player)} takes a base at ${n.place(b.x, b.y)} (their ${ordinal(b.nth)})` });
    for (const r of t.research) {
      if (r.frame < from || r.frame >= to || !shown.has(r.player)) continue;
      out.push({ frame: r.frame, text: r.kind === "tech" ? `${nameOf(r.player)} has ${n.tech(r.id)} researched` : `${nameOf(r.player)} finishes ${n.upgrade(r.id)}${r.level > 1 ? ` level ${r.level}` : ""}` });
    }
    for (const f of firsts) if (f.frame >= from && f.frame < to) out.push({ frame: f.frame, text: `${nameOf(f.player)} ${isBuilding(f.type) ? "starts their first" : "makes their first"} ${n.unit(f.type)}` });
    for (const p of game.players) if (p.leftAt !== null && p.leftAt >= from && p.leftAt < to) out.push({ frame: p.leftAt, text: `${p.name} leaves the game` });
    return out.sort((a, b) => a.frame - b.frame);
  };

  const lead = (frame: number) => {
    const two = game.players.filter((p) => t.samples.players.some((s) => s.slot === p.index));
    if (two.length !== 2) return null;
    const i = sample(frame);
    const [a, b] = two.map((p) => t.samples.players.find((s) => s.slot === p.index)!.armyValue[i] ?? 0);
    const big = Math.max(a, b);
    if (big < 300 || Math.abs(a - b) < Math.max(300, big * 0.15)) return `Armies about even at ${clock(frame)} (${worth(a)} against ${worth(b)})`;
    const [ahead, behind] = a > b ? [two[0], two[1]] : [two[1], two[0]];
    return `${ahead.name} leads in army at ${clock(frame)}: ${worth(Math.max(a, b))} against ${worth(Math.min(a, b))} for ${behind.name}`;
  };

  const losses = (from: number, to: number) => {
    let bucket = LOSS_BUCKET;
    for (;;) {
      const groups = new Map<string, { frame: number; player: number; types: Map<number, number> }>();
      for (const e of t.events) {
        if (e.frame < from) continue;
        if (e.frame > to) break;
        if (e.kind !== "died" || !shown.has(e.owner) || !counted(e.type)) continue;
        const k = `${Math.floor((e.frame - from) / bucket)}:${e.owner}`;
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { frame: e.frame, player: e.owner, types: new Map() }));
        g.types.set(e.type, (g.types.get(e.type) ?? 0) + 1);
      }
      if (groups.size <= MAX_EVENTS || bucket > frameOf(60)) {
        return [...groups.values()].map((g) => ({ frame: g.frame, text: `${nameOf(g.player)} loses ${[...g.types].sort((a, b) => b[1] - a[1]).map(([type, k]) => plural(k, n.unit(type))).join(", ")}` }));
      }
      bucket *= 2;
    }
  };

  const fightFacts = (f: Fight) => {
    const out: string[] = [];
    const label = f.turning ? "the turning point of the game" : f.tier === "decisive" ? "a decisive fight" : f.tier === "major" ? "a major fight" : "a skirmish";
    out.push(`${f.kind === "battle" ? "Battle" : f.kind === "workers" ? "Workers killed" : "Buildings destroyed"} at ${n.place(f.x, f.y)}, ${clock(f.from)} to ${clock(f.to)}: ${label}`);
    for (const s of f.sides) {
      if (!shown.has(s.player)) continue;
      const lost = [...s.lostTypes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([type, k]) => plural(k, n.unit(type))).join(", ");
      const share = s.had > 0 ? Math.round((s.lostValue / s.had) * 100) : 0;
      out.push(`${nameOf(s.player)} lost ${lost || "nothing"}${s.lostValue ? ` (${worth(s.lostValue)} worth, ${share}% of everything they had)` : ""}${s.army ? `, with ${s.army} fighting unit${s.army === 1 ? "" : "s"} there when it began` : ""}`);
    }
    out.push(f.winner === null ? "Neither side came out clearly ahead" : `${nameOf(f.winner)} came out ahead`);
    return out;
  };

  const moments: CastMoment[] = clips.map((c, i) => {
    const since = i ? clips[i - 1].to : 0;
    const before: string[] = [];
    if (i === 0) {
      for (const p of game.players) {
        // (Workers are taken as read, and the same order again soon after is one step: a building ordered twice, an add-on spammed.)
        const steps = p.build.filter((s, k, all) => s.frame <= c.from && !((s.kind === "train" || s.kind === "morph") && WORKERS.has(s.id))
          && !all.slice(0, k).some((b) => b.kind === s.kind && b.id === s.id && s.frame - b.frame < frameOf(30))).slice(0, OPENING_STEPS);
        if (steps.length) before.push(`${p.name}'s opening: ${steps.map((s) => `${clock(s.frame)} ${s.kind === "upgrade" ? n.upgrade(s.id) : s.kind === "tech" ? n.tech(s.id) : n.unit(s.id)}${s.count > 1 ? ` ×${s.count}` : ""}`).join(", ")}`);
      }
    }
    for (const h of happened(since, c.from)) before.push(`${clock(h.frame)} ${h.text}`);
    before.push(...standing(c.from));
    const l = lead(c.from);
    if (l) before.push(l);

    const events: CastMoment["events"] = [];
    for (const f of c.fights) {
      const sides = f.sides.filter((s) => shown.has(s.player) && s.army).map((s) => `${nameOf(s.player)} with ${s.army} fighting unit${s.army === 1 ? "" : "s"}`);
      events.push({ at: seconds(Math.max(c.from, f.from - frameOf(4))), text: `Armies close at ${n.place(f.x, f.y)}${sides.length ? `: ${sides.join(" against ")}` : ""}` });
    }
    for (const h of happened(c.from, c.to)) events.push({ at: seconds(h.frame), text: h.text });
    for (const x of losses(c.from, c.to)) events.push({ at: seconds(x.frame), text: x.text });
    events.sort((a, b) => a.at - b.at);

    const after = c.fights.flatMap(fightFacts);
    const la = lead(c.to);
    if (la) after.push(la);
    if (i === clips.length - 1) {
      after.push(game.winner === null ? `The game ends at ${clock(t.frames)}` : `${nameOf(game.winner)} wins; the game ends at ${clock(t.frames)}`);
    }
    const key = c.fights.find((f) => f.turning) ?? c.fights[0];
    const title = key ? `${key.turning ? "The turning point" : key.tier === "decisive" ? "A decisive fight" : key.tier === "major" ? "A major fight" : "A fight"} at ${n.place(key.x, key.y)}` : "The game";
    return { from: seconds(c.from), to: seconds(c.to), title, before: before.slice(0, 40), events: events.slice(0, 120), after: after.slice(0, 20) };
  });

  return {
    game: {
      map: game.map.trim(),
      length: seconds(t.frames),
      players: game.players.map((p) => ({
        id: p.index, name: p.name, race: RACES[p.race] ?? "Terran",
        result: game.winner === null ? (p.leftAt !== null ? "left" : "unknown") : p.index === game.winner ? "won" : p.leftAt !== null ? "left" : "lost",
      })),
    },
    moments,
    ...(wishes?.trim() ? { wishes: wishes.trim() } : {}),
  };
}

const ordinal = (k: number) => (k === 2 ? "second" : k === 3 ? "third" : k === 4 ? "fourth" : k === 5 ? "fifth" : `${k}th`);

/* ── When each line is said ── */

/** A line placed: when it starts in game seconds, how long it runs, and whether it is said over the clip's last frame. */
export interface Placed {
  moment: number;
  speaker: CastSpeaker;
  text: string;
  /** Index of the voiced clip, or -1 for a line with no voice (captions only). */
  clip: number;
  start: number;
  duration: number;
}

export interface Schedule {
  lines: Placed[];
  /** Seconds to hold on each moment's last frame, so a line said past its end finishes before the cut. */
  holds: number[];
}

/** How late a line may start for its priority before it is left out (seconds). */
const LATE: Record<1 | 2 | 3, number> = { 1: 6, 2: 3, 3: 1.5 };
/** A breath between two lines. */
const GAP = 0.3;
/** The longest a moment waits on its last frame for a line to end (the last moment waits for its sign-off). */
const MAX_HOLD = 5;

/**
 * Each line where it can be said: no earlier than written, after the line before has finished, and left out when that
 * would make it later than its priority allows. A line still running at its clip's end holds the clip's last frame.
 * `durations[i]` is line `i`'s measured length in seconds (estimated from its words when it has no voice).
 */
export function schedule(lines: readonly CastLine[], durations: readonly number[], moments: readonly { from: number; to: number }[]): Schedule {
  const out: Placed[] = [];
  const holds = moments.map(() => 0);
  moments.forEach((m, mi) => {
    const last = mi === moments.length - 1;
    let cursor = m.from;
    const mine = lines.map((l, i) => ({ l, i })).filter((x) => x.l.moment === mi).sort((a, b) => a.l.at - b.l.at);
    for (const { l, i } of mine) {
      const duration = durations[i] ?? estimate(l.text);
      const start = Math.max(l.at, cursor === m.from ? m.from : cursor + GAP);
      if (start - l.at > LATE[l.priority]) continue;
      const end = start + duration;
      if (!last && end - m.to > MAX_HOLD && l.priority > 1) continue;
      out.push({ moment: mi, speaker: l.speaker, text: l.text, clip: i, start, duration });
      cursor = end;
    }
    holds[mi] = Math.max(0, cursor - m.to);
  });
  return { lines: out, holds };
}

/** How long a line takes to say, from its words, when it has not been voiced (2.7 words a second). */
export function estimate(text: string): number {
  return Math.max(0.8, text.trim().split(/\s+/).length / 2.7);
}
