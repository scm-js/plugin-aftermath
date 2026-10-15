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
import { NOT_MADE, WORKERS, buildings, counted, isBuilding } from "./played";
import { incomeRate, supplyBlocks } from "./economy";
import type { Base } from "./story";

export const FRAME_SECONDS = 0.042;
const seconds = (frame: number) => Math.round(frame * FRAME_SECONDS * 10) / 10;
const frameOf = (s: number) => Math.round(s / FRAME_SECONDS);

/** A highlight's clip starts this long before its fight (twenty seconds), the first longer for the welcome, and runs this long after (six). */
const LEAD_IN = frameOf(20);
const FIRST_LEAD_IN = frameOf(40);
const AFTER = frameOf(6);
/**
 * A whole-game cast plays the quiet stretches fast: the opening to take about this long on screen (two minutes), at 2×
 * to 8×; a stretch between two fights about this long (forty seconds), at 4× to 16×; what is left after the last fight
 * about this long (fifteen seconds).
 */
const OPENING_SECONDS = 120;
const BRIDGE_SECONDS = 40;
const TAIL_SECONDS = 15;
/** Deaths this close together are one line of what fell (three seconds). */
const LOSS_BUCKET = frameOf(3);
/** The most timed facts in one moment; past this, losses are bucketed wider. */
const MAX_EVENTS = 60;
/** Build steps said for each player's opening, and how far into the game it reaches (six minutes). */
const OPENING_STEPS = 18;
const OPENING_UNTIL = frameOf(360);
/** A supply block worth saying lasted this long (six seconds). */
const BLOCK_SAID = frameOf(6);
/** Command Center, Hatchery, Lair, Hive, Nexus; and what makes units: Barracks, Factory, Starport, Gateway, Stargate, Robotics Facility. */
const HALL_TYPES = new Set([106, 131, 132, 133, 154]);
const PRODUCTION = new Set([111, 113, 114, 160, 167, 155]);
/** Supply Depot, Refinery, Extractor, Pylon, Assimilator, Overlord: not news when the first goes down. */
const ROUTINE = new Set([109, 110, 149, 156, 157, 42]);

/* ── What the server is sent, and what it answers (ai-server `src/protocol.ts`) ── */

export type CastSpeaker = "caster" | "analyst";

/** How a cast is made: the whole game or its key moments, and how much the two talk about other things. */
export interface CastOptions {
  format: "game" | "highlights";
  banter: "off" | "light" | "lots";
}

export interface CastInput {
  options?: CastOptions;
  game: {
    map: string;
    length: number;
    players: { id: number; name: string; race: "Zerg" | "Terran" | "Protoss"; result: "won" | "lost" | "left" | "unknown" }[];
    /** Each player's opening as ordered, with the supply each step was ordered at. */
    openings?: string[];
  };
  moments: CastMoment[];
  wishes?: string;
}

export interface CastMoment {
  /** Game seconds the stretch starts and ends at. */
  from: number;
  to: number;
  /** How fast it plays (1: a key fight at normal speed), and so how long it is on screen, in seconds. */
  speed?: number;
  seconds?: number;
  title: string;
  /** Where each player stands when the clip starts: economy, buildings, upgrades, the whole army. */
  state?: string[];
  before: string[];
  events: { at: number; text: string }[];
  after: string[];
}

export interface CastLine { moment: number; at: number; speaker: CastSpeaker; text: string; priority: 1 | 2 | 3 }

/* ── The moments ── */

/**
 * A stretch of the game a cast shows, in frames, and the fights in it. `speed` is how fast it plays (1 for a key fight,
 * more through the quiet parts); a whole-game cast's stretches follow on from one another with no cut.
 */
export interface Clip { from: number; to: number; fights: Fight[]; speed?: number }

/**
 * The whole game as one cast: the key fights at normal speed, and everything between them played fast — the opening,
 * the stretches between fights, what is left after the last — so the story runs on without a cut.
 */
export function castSegments(fights: readonly Fight[], frames: number): Clip[] {
  const live: Clip[] = [];
  for (const f of fights.filter((x) => x.key).sort((a, b) => a.from - b.from)) {
    const from = Math.max(0, f.from - LEAD_IN), to = Math.min(frames, f.to + AFTER);
    const last = live[live.length - 1];
    if (last && from <= last.to) { last.to = Math.max(last.to, to); last.fights.push(f); continue; }
    live.push({ from, to, fights: [f], speed: 1 });
  }
  const fast = (from: number, to: number, target: number, lo: number, hi: number): Clip =>
    ({ from, to, fights: [], speed: Math.max(lo, Math.min(hi, Math.round(((to - from) * FRAME_SECONDS) / target))) });
  if (!live.length) return [fast(0, frames, OPENING_SECONDS, 2, 16)];
  const out: Clip[] = [];
  let at = 0;
  live.forEach((c, i) => {
    if (c.from - at > frameOf(5)) out.push(fast(at, c.from, i ? BRIDGE_SECONDS : OPENING_SECONDS, i ? 4 : 2, i ? 16 : 8));
    else if (out.length) out[out.length - 1].to = c.from;
    else c.from = 0;
    out.push(c);
    at = c.to;
  });
  if (frames - at > frameOf(5)) out.push(fast(at, frames, TAIL_SECONDS, 2, 16));
  else if (out.length) out[out.length - 1].to = frames;
  return out;
}

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
export function castInput(game: CastGame, clips: readonly Clip[], wishes?: string, options?: CastOptions): CastInput {
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

  const built = buildings(t);
  const series = (index: number) => t.samples.players.find((s) => s.slot === index);
  const perMinute = (v: number) => (v >= 1000 ? `${(Math.round(v / 100) * 100).toLocaleString("en-US")}` : String(Math.round(v / 10) * 10));

  /** Where each player stands at a frame, a few lines each: economy, buildings, upgrades, the whole army. */
  const standing = (frame: number) => {
    const out: string[] = [];
    const i = sample(frame), units = unitsByType(t, frame);
    for (const p of game.players) {
      const q = series(p.index);
      if (!q) continue;
      const income = q.mineralsGathered && q.gasGathered
        ? `, mining about ${perMinute(incomeRate(t.samples.frame, q.mineralsGathered)[i] ?? 0)} minerals and ${perMinute(incomeRate(t.samples.frame, q.gasGathered)[i] ?? 0)} gas a minute` : "";
      out.push(`${p.name} at ${clock(frame)}: supply ${q.supplyUsed[i] ?? 0}/${q.supplyMax[i] ?? 0}, ${q.workers[i] ?? 0} workers${income}, ${q.minerals[i] ?? 0} minerals and ${q.gas[i] ?? 0} gas in the bank`);
      const have = new Map<number, number>();
      for (const b of built) if (b.owner === p.index && b.done !== null && b.done <= frame && (b.to === null || b.to > frame) && !ROUTINE.has(b.type)) have.set(b.type, (have.get(b.type) ?? 0) + 1);
      const rank = (type: number) => (HALL_TYPES.has(type) ? 0 : PRODUCTION.has(type) ? 1 : 2);
      const list = [...have].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]).map(([type, k]) => `${k} ${n.unit(type)}`);
      if (list.length) out.push(`${p.name}'s buildings: ${list.join(", ")}`);
      const levels = new Map<string, number>();
      for (const r of t.research) if (r.player === p.index && r.frame <= frame) {
        const name = r.kind === "tech" ? n.tech(r.id) : n.upgrade(r.id);
        levels.set(name, Math.max(levels.get(name) ?? 0, r.kind === "tech" ? 0 : r.level));
      }
      out.push(levels.size ? `${p.name}'s upgrades and research: ${[...levels].map(([name, level]) => (level > 1 ? `${name} ${level}` : name)).join(", ")}` : `${p.name} has no upgrades or research yet`);
      const army = [...(units.get(p.index) ?? new Map<number, number>())].filter(([type]) => !WORKERS.has(type) && !ROUTINE.has(type)).sort((a, b) => b[1] - a[1]);
      const count = army.reduce((k, [, c]) => k + c, 0);
      out.push(army.length ? `${p.name}'s whole army, wherever it stands: ${army.map(([type, k]) => `${k} ${n.unit(type)}`).join(", ")} (${count} units, worth ${worth(q.armyValue[i] ?? 0)})` : `${p.name} has no army`);
    }
    return out;
  };

  /** Spans a player stood at the supply limit for long, between two frames. */
  const blocks = (from: number, to: number) => {
    const out: { frame: number; text: string }[] = [];
    for (const p of game.players) {
      const q = series(p.index);
      if (!q) continue;
      for (const b of supplyBlocks(t.samples.frame, q.supplyUsed, q.supplyMax, to)) {
        if (b.to < from || b.to - b.from < BLOCK_SAID) continue;
        out.push({ frame: b.from, text: `${p.name} is supply blocked at ${q.supplyUsed[sample(b.from)] ?? 0} supply from ${clock(b.from)} to ${clock(b.to)}` });
      }
    }
    return out;
  };

  /** A player's opening as ordered, with the supply at each order: workers taken as read, a unit only the first time. */
  const opening = (p: CastPlayer) => {
    const q = series(p.index);
    const seenTrain = new Set<number>();
    const steps = p.build.filter((s, k, all) => {
      if (s.frame > OPENING_UNTIL) return false;
      if ((s.kind === "train" || s.kind === "morph") && WORKERS.has(s.id)) return false;
      if (s.kind === "train" || (s.kind === "morph" && !isBuilding(s.id))) { if (seenTrain.has(s.id)) return false; seenTrain.add(s.id); }
      return !all.slice(0, k).some((b) => b.kind === s.kind && b.id === s.id && s.frame - b.frame < frameOf(30));
    }).slice(0, OPENING_STEPS);
    if (!steps.length) return null;
    const what = (s: CastPlayer["build"][number]) => (s.kind === "upgrade" ? n.upgrade(s.id) : s.kind === "tech" ? n.tech(s.id) : n.unit(s.id));
    return `${p.name} (${RACES[p.race] ?? "Terran"}), supply and time of each order: ${steps.map((s) => `${q ? `${q.supplyUsed[sample(s.frame)] ?? 0} ` : ""}${what(s)} (${clock(s.frame)})`).join(", ")}`;
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

  const losses = (from: number, to: number, first = LOSS_BUCKET) => {
    let bucket = first;
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
      out.push(`${nameOf(s.player)} lost ${lost || "nothing"}${s.lostValue ? ` (${worth(s.lostValue)} worth, ${share}% of their whole army and workers)` : ""}${s.army ? `; ${s.army} of their fighting units were at the fight when it began` : ""}`);
    }
    out.push(f.winner === null ? "Neither side came out clearly ahead" : `${nameOf(f.winner)} came out ahead`);
    return out;
  };

  /** The orders of a player's opening that fall between two frames, as news: workers taken as read, a unit the first time. */
  const orders = (from: number, to: number) => {
    const out: { frame: number; text: string }[] = [];
    for (const p of game.players) {
      const q = series(p.index), trained = new Set<number>();
      p.build.forEach((s, k, all) => {
        if ((s.kind === "train" || s.kind === "morph") && WORKERS.has(s.id)) return;
        if (s.kind === "train" || (s.kind === "morph" && !isBuilding(s.id))) { if (trained.has(s.id)) return; trained.add(s.id); }
        if (s.frame < from || s.frame >= to || s.frame > OPENING_UNTIL) return;
        if (all.slice(0, k).some((b) => b.kind === s.kind && b.id === s.id && s.frame - b.frame < frameOf(30))) return;
        const what = s.kind === "upgrade" ? n.upgrade(s.id) : s.kind === "tech" ? n.tech(s.id) : n.unit(s.id);
        out.push({ frame: s.frame, text: `${p.name} orders ${s.kind === "upgrade" || s.kind === "tech" ? "research of " : ""}${what}${q ? ` at ${q.supplyUsed[sample(s.frame)] ?? 0} supply` : ""}` });
      });
    }
    return out;
  };

  const moments: CastMoment[] = clips.map((c, i) => {
    const speed = c.speed ?? 1, fast = speed > 1, last = i === clips.length - 1;
    // Times in a stretch are seconds on screen from its start; each fact also says the game's clock.
    const at = (frame: number) => Math.round(((Math.max(c.from, frame) - c.from) * FRAME_SECONDS * 10) / speed) / 10;
    const since = i ? clips[i - 1].to : 0;
    const before: string[] = [];
    for (const h of [...happened(since, c.from), ...blocks(since, c.from)].sort((a, b) => a.frame - b.frame)) before.push(`${clock(h.frame)} ${h.text}`);
    const state = fast && i > 0 ? [] : standing(c.from);
    const l = lead(c.from);
    if (l && state.length) state.push(l);

    const events: CastMoment["events"] = [];
    const news = (frame: number, text: string) => events.push({ at: at(frame), text: `${clock(frame)} ${text}` });
    for (const f of c.fights) {
      const sides = f.sides.filter((x) => shown.has(x.player) && x.army).map((x) => `${x.army} of ${nameOf(x.player)}'s fighting units`);
      news(Math.max(c.from, f.from - frameOf(4)), `Armies close at ${n.place(f.x, f.y)}${sides.length ? `; at the fight: ${sides.join(", ")}` : ""}`);
    }
    if (fast) for (const o of orders(c.from, c.to)) news(o.frame, o.text);
    for (const h of [...happened(c.from, c.to), ...blocks(c.from, c.to)]) news(h.frame, h.text);
    for (const x of losses(c.from, c.to, fast ? LOSS_BUCKET * speed : LOSS_BUCKET)) news(x.frame, x.text);
    events.sort((a, b) => a.at - b.at);

    const after = c.fights.flatMap(fightFacts);
    if (fast && !last) after.push(...standing(c.to));
    const la = lead(c.to);
    if (la) after.push(la);
    if (last) after.push(game.winner === null ? `The game ends at ${clock(t.frames)}` : `${nameOf(game.winner)} wins; the game ends at ${clock(t.frames)}`);
    const key = c.fights.find((f) => f.turning) ?? c.fights[0];
    const title = key
      ? `${key.turning ? "The turning point" : key.tier === "decisive" ? "A decisive fight" : key.tier === "major" ? "A major fight" : "A fight"} at ${n.place(key.x, key.y)}`
      : i === 0 ? "The opening" : last ? "The end of the game" : "Between the fights";
    return {
      from: seconds(c.from), to: seconds(c.to), speed, seconds: Math.round(((c.to - c.from) * FRAME_SECONDS * 10) / speed) / 10,
      title, state: state.slice(0, 20), before: before.slice(0, 40), events: events.slice(0, 120), after: after.slice(0, 24),
    };
  });

  return {
    ...(options ? { options } : {}),
    game: {
      map: game.map.trim(),
      length: seconds(t.frames),
      players: game.players.map((p) => ({
        id: p.index, name: p.name, race: RACES[p.race] ?? "Terran",
        result: game.winner === null ? (p.leftAt !== null ? "left" : "unknown") : p.index === game.winner ? "won" : p.leftAt !== null ? "left" : "lost",
      })),
      openings: game.players.map(opening).filter((o): o is string => o !== null),
    },
    moments,
    ...(wishes?.trim() ? { wishes: wishes.trim() } : {}),
  };
}

const ordinal = (k: number) => (k === 2 ? "second" : k === 3 ? "third" : k === 4 ? "fourth" : k === 5 ? "fifth" : `${k}th`);

/* ── When each line is said ── */

/**
 * A line placed on the cast's one timeline: when it starts in seconds on screen from the cast's start, how long it runs,
 * and the game frame that starts it (-1: after the game's last frame, while the cast holds it for the sign-off).
 */
export interface Placed {
  moment: number;
  speaker: CastSpeaker;
  text: string;
  /** Index of the voiced clip, or -1 for a line with no voice (captions only). */
  clip: number;
  start: number;
  duration: number;
  frame: number;
}

export interface Schedule {
  lines: Placed[];
  /** Where each stretch starts on screen, in seconds from the cast's start, and the whole length before the hold. */
  starts: number[];
  length: number;
  /** Seconds the last frame is held so the sign-off finishes. */
  hold: number;
}

/** How late a line may start for its priority before it is left out (seconds). */
const LATE: Record<1 | 2 | 3, number> = { 1: 6, 2: 3, 3: 1.5 };
/** A breath between two lines. */
const GAP = 0.3;

/**
 * Each line where it can be said, on one timeline for the whole cast: no earlier than written, after the line before
 * has finished — even across the start of the next stretch — and left out when that would make it later than its
 * priority allows. A line's `at` is seconds on screen from the start of its stretch. `durations[i]` is line `i`'s
 * measured length in seconds (estimated from its words when it has no voice).
 */
export function schedule(lines: readonly CastLine[], durations: readonly number[], moments: readonly { from: number; to: number; speed?: number; seconds?: number }[]): Schedule {
  const span = (m: (typeof moments)[number]) => m.seconds ?? (m.to - m.from) / (m.speed ?? 1);
  const starts: number[] = [];
  let length = 0;
  for (const m of moments) { starts.push(length); length += span(m); }
  const frameAt = (t: number) => {
    let k = moments.length - 1;
    while (k > 0 && starts[k] > t) k--;
    if (t >= length) return -1;
    const m = moments[k];
    return Math.round((m.from + (t - starts[k]) * (m.speed ?? 1)) / FRAME_SECONDS);
  };
  const order = lines.map((l, i) => ({ l, i, when: (starts[l.moment] ?? 0) + l.at })).sort((a, b) => a.when - b.when);
  const out: Placed[] = [];
  let cursor = -Infinity;
  for (const { l, i, when } of order) {
    const duration = durations[i] ?? estimate(l.text);
    const start = Math.max(when, cursor + GAP);
    if (start - when > LATE[l.priority]) continue;
    out.push({ moment: l.moment, speaker: l.speaker, text: l.text, clip: i, start, duration, frame: frameAt(start) });
    cursor = start + duration;
  }
  return { lines: out, starts, length, hold: Math.max(0, cursor - length) };
}

/** A line without its delivery cues (`[surprised]`, acted by the voice, not said): what the captions show. */
export function spoken(text: string): string {
  return text.replace(/\[[^\]]*\]\s*/g, "").replace(/\s+/g, " ").trim();
}

/** How long a line takes to say, from its words, when it has not been voiced (2.7 words a second). */
export function estimate(text: string): number {
  return Math.max(0.8, spoken(text).split(/\s+/).length / 2.7);
}
