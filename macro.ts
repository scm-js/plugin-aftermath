/**
 * Production rhythm, read out of the engine's timeline: when each player's production buildings stood idle while
 * there was money for something they make, when the town halls made no workers, and when larvae waited at a full
 * hatchery.
 *
 * The timeline holds this exactly. A unit in training is `born` the frame it is started, at the very middle of the
 * building training it, and `done` the frame it walks out (measured: an SCV born at its Command Center's middle and
 * done 301 frames later, its build time being 300). So each building's work is known to the frame, and which building
 * did it, without guessing. An add-on going up keeps its building from training too. Larvae are `born` beside their
 * hall and become an egg (a `morph`) when used.
 *
 * Idle counts only while the player could have paid for the cheapest thing that kind of building made in this game,
 * and had the supply for it: a building with no money behind it is a money problem, not a missed round, and supply
 * blocks are counted on their own (`economy.ts`). The money is read at the samples (every two seconds).
 *
 * Pure: no editor, no DOM.
 */
import type { ReplayTimeline } from "./vendor/scm-sim";
import { FRAMES_PER_MINUTE as MINUTE } from "./analysis";
import { DEPOTS, KINDS, WORKERS, counted, isBuilding } from "./roles";

/** What is asked of the game's data. */
export interface MacroData {
  /** units.dat's build time in frames; null without the game's data. */
  buildTime(type: number): number | null;
  /** What a unit costs; zeros without the game's data. */
  cost(type: number): { minerals: number; gas: number };
  /** An add-on (a Comsat Station, a Machine Shop): the building it goes up on cannot train meanwhile. */
  addon(type: number): boolean;
}

export type LaneKind = "workers" | "units" | "larvae";

export interface Span { from: number; to: number }

/** One building that makes things, through the time it stood finished. */
export interface Lane {
  kind: LaneKind;
  /** The building's number in the timeline. */
  unit: number;
  /** Its type at the end (a Hatchery that became a Lair is a Lair). */
  type: number;
  owner: number;
  x: number;
  y: number;
  /** When it was finished, and when it was gone (or its player left, or the game ended). */
  from: number;
  to: number;
  /** Making something: training, an add-on going up; for a hall's larvae, while it held fewer than it can. */
  busy: Span[];
  /** Making nothing (larvae: full), while the player could pay for what it makes and had the supply; a hall's workers to `COUNT_UNTIL` only. */
  idle: Span[];
  /** What it made most, the unit an idle stretch's cost is counted in; null when it made nothing. */
  makes: number | null;
}

/** A stretch of idle time worth naming: idle pieces less than `GAP_JOIN` apart, taken as one. */
export interface Gap {
  player: number;
  kind: LaneKind;
  /** The building's type: for "workers", the player's first hall's. */
  type: number;
  /** The building; null for "workers", which is every hall of the player at once. */
  lane: Lane | null;
  /** From the first idle frame to the last. */
  from: number;
  to: number;
  /** The idle frames in it (the stretch less the moments without money). */
  frames: number;
  /** The most the player had unspent, minerals and gas, at a sample within it. */
  bank: number;
  /** Buildings of the kind idle over (nearly) the same stretch, listed once: 2 for two Gateways. */
  count: number;
}

export interface PlayerMacro {
  slot: number;
  /**
   * Before `until`: the time no hall had a worker in training, while the player could pay for one; null for a
   * player whose halls made no workers (Zerg, whose workers come from larvae).
   */
  noWorker: number | null;
  /** The workers that time before `shortAt` would have made at one hall's pace (a worker's build time each); null as above. */
  workersShort: number | null;
  /** That time, as stretches. */
  noWorkerSpans: Span[];
  /** The production buildings' idle time added up (the halls' left out), before `until`. */
  productionIdle: number;
  /** Before `until`: frames when larvae waited at any full hall, with money for something; null for a player with no larvae. */
  larvaeWaiting: number | null;
  /** The most the player had unspent at once before `until`, minerals and gas, and when. */
  peakBank: { value: number; frame: number };
  lanes: Lane[];
}

export interface Macro {
  players: PlayerMacro[];
  /** The longest gaps of every player, longest first. */
  gaps: Gap[];
  /** The players' numbers are counted to here (`COUNT_UNTIL`). */
  until: number;
  shortAt: number;
  /** The most larvae a hall holds, as used here. */
  larvaCap: number;
}

/**
 * The players' numbers are counted to here, the opening and the early middle game, where the rhythm of production
 * decides most: a player who stops at 60 or 70 workers later on has not missed anything, and late in a long game a
 * bank of thousands says more about what was left to build than about rounds missed. The chart shows the whole game.
 */
export const COUNT_UNTIL = 10 * MINUTE;
/** The moment the workers a player is short are counted at. */
export const SHORT_AT = 8 * MINUTE;
/** Idle pieces closer than this (four samples, 8 seconds) are one gap: money dipping for a moment does not end it. */
const GAP_JOIN = 4 * 48;
/** A gap shorter than this (10 seconds) is no gap worth listing. */
const GAP_MIN = 240;
/** How many gaps are listed. */
const GAPS = 8;
/** Work this close together (a second) is one stretch: the frames between a queue's units, or a click a moment late, are no idle time. */
const QUEUE_JOIN = 24;
/** A larva is its hall's when born within this many pixels of the hall's middle (6 tiles). */
const LARVA_REACH = 192;
/** An add-on goes up beside its building: its middle within this many pixels (4 tiles) to the right. */
const ADDON_REACH = 128;

interface Building { unit: number; type: number; owner: number; x: number; y: number; done: number | null; end: number | null; made: Map<number, number>; busy: Span[] }

/** Add `s` to `out`, joined with the last span when they touch. Spans arrive in order. */
function push(out: Span[], from: number, to: number, join = 0): void {
  if (to <= from) return;
  const last = out[out.length - 1];
  if (last && from <= last.to + join) last.to = Math.max(last.to, to);
  else out.push({ from, to });
}

/** `spans` merged where they overlap or touch, in order. */
export function merged(spans: readonly Span[], join = 0): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.from - b.from)) push(out, s.from, s.to, join);
  return out;
}

/** The time `spans` cover between `from` and `to`. */
export function covered(spans: readonly Span[], from = -Infinity, to = Infinity): number {
  let n = 0;
  for (const s of spans) n += Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
  return n;
}

/** `window` less `busy` (both in order, `busy` merged). */
function free(window: Span, busy: readonly Span[]): Span[] {
  const out: Span[] = [];
  let at = window.from;
  for (const b of busy) {
    if (b.to <= at) continue;
    if (b.from >= window.to) break;
    push(out, at, Math.min(b.from, window.to));
    at = Math.max(at, b.to);
  }
  push(out, at, window.to);
  return out;
}

export function macro(t: ReplayTimeline, players: readonly number[], data: MacroData, leftAt: ReadonlyMap<number, number | null> = new Map()): Macro {
  const end = t.frames;
  const playing = new Set(players);

  // What became of each unit: its first event, when it was done, when it was gone.
  const doneAt = new Map<number, number>(), goneAt = new Map<number, number>();
  for (const e of t.events) {
    if (e.kind === "done" && !doneAt.has(e.unit)) doneAt.set(e.unit, e.frame);
    else if (e.kind === "died") goneAt.set(e.unit, e.frame);
    // A unit that becomes another type (a larva an egg) is gone as what it was; recorded below where it matters.
  }

  // The buildings, and each trained unit given to the building at whose middle it was born.
  const buildings = new Map<number, Building>();
  /** Finished buildings standing now, by owner and middle. */
  const standing = new Map<string, Building>();
  const at = (owner: number, x: number, y: number) => `${owner}:${x}:${y}`;
  const larvaTypes = new Set<number>();
  for (const e of t.events) if (e.kind === "morph" && KINDS.eggs.has(e.type) && e.from !== undefined && !counted(e.from)) larvaTypes.add(e.from);
  /** Each player's larvae: born at a hall (its unit), gone at a frame. */
  const larvae: { hall: number; from: number; to: number; owner: number }[] = [];
  const larvaOf = new Map<number, (typeof larvae)[number]>();
  /** What came out of each player's eggs, for what a full hall could have made. */
  const hatched = new Map<number, Map<number, number>>();
  const hallsOf = (owner: number) => [...buildings.values()].filter((b) => b.owner === owner && b.done !== null && b.end === null && DEPOTS.has(b.type));
  const close = (b: Building, frame: number) => {
    if (b.end !== null) return;
    b.end = frame;
    if (standing.get(at(b.owner, b.x, b.y)) === b) standing.delete(at(b.owner, b.x, b.y));
  };
  const hallucinated = new Set<number>();

  // The kind of building each unit type comes out of, from the births at a place a building was put down.
  const placed = new Map<string, number>();
  for (const e of t.events) if ((e.kind === "born" || e.kind === "morph") && isBuilding(e.type) && e.owner <= 7) placed.set(at(e.owner, e.x, e.y), e.type);
  const tally = new Map<number, Map<number, number>>();
  for (const e of t.events) {
    if (e.kind !== "born" || e.frame === 0 || e.hallucination || isBuilding(e.type) || !counted(e.type) || doneAt.get(e.unit) === e.frame) continue;
    const kind = placed.get(at(e.owner, e.x, e.y));
    if (kind === undefined) continue;
    const m = tally.get(e.type) ?? new Map<number, number>();
    m.set(kind, (m.get(kind) ?? 0) + 1);
    tally.set(e.type, m);
  }
  const producerOf = new Map([...tally].map(([type, m]) => [type, [...m].sort((a, b) => b[1] - a[1])[0][0]] as const));

  for (const e of t.events) {
    if (e.kind === "born" && e.hallucination) { hallucinated.add(e.unit); continue; }
    if (hallucinated.has(e.unit)) continue;
    if (e.kind === "born") {
      if (e.owner > 7) continue;
      if (isBuilding(e.type)) {
        buildings.set(e.unit, { unit: e.unit, type: e.type, owner: e.owner, x: e.x, y: e.y, done: null, end: null, made: new Map(), busy: [] });
        // An add-on keeps the building beside it from training while it goes up.
        if (e.frame > 0 && data.addon(e.type)) {
          let best: Building | null = null, bestD = Infinity;
          for (const b of standing.values()) {
            if (b.owner !== e.owner || b.x >= e.x) continue;
            const d = Math.hypot(e.x - b.x, e.y - b.y);
            if (d < bestD && d <= ADDON_REACH) { best = b; bestD = d; }
          }
          if (best) best.busy.push({ from: e.frame, to: doneAt.get(e.unit) ?? goneAt.get(e.unit) ?? end });
        }
        continue;
      }
      if (larvaTypes.has(e.type)) {
        let hall: Building | null = null, bestD = Infinity;
        for (const b of hallsOf(e.owner)) { const d = Math.hypot(e.x - b.x, e.y - b.y); if (d < bestD && d <= LARVA_REACH) { hall = b; bestD = d; } }
        if (hall) { const l = { hall: hall.unit, from: e.frame, to: goneAt.get(e.unit) ?? end, owner: e.owner }; larvae.push(l); larvaOf.set(e.unit, l); }
        continue;
      }
      // (A unit that is finished the frame it appears was not trained: a worker leaving a refinery, say.)
      if (e.frame === 0 || !counted(e.type) || doneAt.get(e.unit) === e.frame) continue;
      let by = standing.get(at(e.owner, e.x, e.y));
      if (!by) {
        // Born where no building was put down: a Terran building that lifted off and landed there. Of the player's
        // buildings of the kind that makes this unit, the one that made nothing for longest is taken to be it, and
        // stands there from now on.
        const kind = producerOf.get(e.type);
        let best: Building | null = null, bestLast = Infinity;
        for (const b of standing.values()) {
          if (b.owner !== e.owner || b.type !== kind) continue;
          const last = b.busy.length ? b.busy[b.busy.length - 1].to : -1;
          if (last <= e.frame && last < bestLast) { best = b; bestLast = last; }
        }
        if (!best) continue;
        standing.delete(at(best.owner, best.x, best.y));
        best.x = e.x; best.y = e.y;
        standing.set(at(best.owner, best.x, best.y), best);
        by = best;
      }
      by.made.set(e.type, (by.made.get(e.type) ?? 0) + 1);
      by.busy.push({ from: e.frame, to: Math.min(doneAt.get(e.unit) ?? goneAt.get(e.unit) ?? end, goneAt.get(e.unit) ?? end) });
    } else if (e.kind === "done") {
      const b = buildings.get(e.unit);
      if (b && b.done === null && b.end === null) { b.done = e.frame; standing.set(at(b.owner, b.x, b.y), b); }
    } else if (e.kind === "morph") {
      const l = larvaOf.get(e.unit);
      if (l) { l.to = Math.min(l.to, e.frame); larvaOf.delete(e.unit); }
      if (e.from !== undefined && KINDS.eggs.has(e.from) && counted(e.type)) {
        const m = hatched.get(e.owner) ?? new Map<number, number>();
        m.set(e.type, (m.get(e.type) ?? 0) + 1);
        hatched.set(e.owner, m);
      }
      const b = buildings.get(e.unit);
      // A Drone becomes a building, a geyser a refinery: the building begins.
      if (!b) { if (isBuilding(e.type) && e.owner <= 7) buildings.set(e.unit, { unit: e.unit, type: e.type, owner: e.owner, x: e.x, y: e.y, done: null, end: null, made: new Map(), busy: [] }); continue; }
      // A building that becomes another (a Hatchery a Lair) goes on as itself; one that becomes no building (a
      // cancelled Hatchery is a Drone again) is gone.
      if (isBuilding(e.type)) b.type = e.type;
      else close(b, e.frame);
    } else if (e.kind === "given") {
      const b = buildings.get(e.unit);
      // A geyser becomes a refinery and the builder's in the frame it is begun: that is the building starting.
      if (b && b.done === null && b.end === null) { b.owner = e.owner; continue; }
      if (b) close(b, e.frame);
    } else if (e.kind === "died") {
      const b = buildings.get(e.unit);
      if (b) close(b, e.frame);
    }
  }

  // Which building types make what, over the whole game: a Gateway that never trained is idle all the same.
  const madeByType = new Map<number, Map<number, number>>();
  for (const b of buildings.values()) {
    if (!b.made.size) continue;
    const m = madeByType.get(b.type) ?? new Map<number, number>();
    for (const [type, n] of b.made) m.set(type, (m.get(type) ?? 0) + n);
    madeByType.set(b.type, m);
  }
  const most = (m: ReadonlyMap<number, number> | undefined) => (m && m.size ? [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : null);
  const cheapest = (types: Iterable<number>) => {
    let best: { minerals: number; gas: number } | null = null;
    for (const type of types) { const c = data.cost(type); if (!best || c.minerals + c.gas < best.minerals + best.gas) best = c; }
    return best ?? { minerals: 0, gas: 0 };
  };

  // The larvae a hall holds at most: the game's three, or for a mod's data the most any hall held here.
  const counts = new Map<number, { frame: number; d: number }[]>();
  for (const l of larvae) {
    const list = counts.get(l.hall) ?? [];
    list.push({ frame: l.from, d: 1 }, { frame: l.to, d: -1 });
    counts.set(l.hall, list);
  }
  const steps = new Map<number, { frame: number; n: number }[]>();
  let seenMost = 0;
  for (const [hall, list] of counts) {
    list.sort((a, b) => a.frame - b.frame || a.d - b.d);
    const out: { frame: number; n: number }[] = [];
    let n = 0;
    for (const c of list) { n += c.d; seenMost = Math.max(seenMost, n); const last = out[out.length - 1]; if (last && last.frame === c.frame) last.n = n; else out.push({ frame: c.frame, n }); }
    steps.set(hall, out);
  }
  const larvaCap = KINDS.game ? 3 : Math.max(3, seenMost);

  const frames = t.samples.frame;
  const result: PlayerMacro[] = [];
  const gaps: Gap[] = [];
  for (const series of t.samples.players) {
    if (!playing.has(series.slot)) continue;
    const slot = series.slot;
    const until = Math.min(end, leftAt.get(slot) ?? end);
    const bank = (i: number) => series.minerals[i] + series.gas[i];
    /** Whether, from sample `i` to the next, the player could pay `c` and had room for a unit. */
    const able = (i: number, c: { minerals: number; gas: number }) => {
      const max = series.supplyMax[i], used = series.supplyUsed[i];
      return series.minerals[i] >= c.minerals && series.gas[i] >= c.gas && !(max > 0 && used >= max);
    };
    /** The parts of `spans` when the player could pay `c`. */
    const withMoney = (spans: readonly Span[], c: { minerals: number; gas: number }) => {
      const out: Span[] = [];
      let i = 0;
      for (const s of spans) {
        while (i + 1 < frames.length && frames[i + 1] <= s.from) i++;
        for (let k = i; k < frames.length && frames[k] < s.to; k++) {
          const a = Math.max(s.from, frames[k]), b = Math.min(s.to, k + 1 < frames.length ? frames[k + 1] : end);
          if (able(k, c)) push(out, a, b);
        }
      }
      return out;
    };

    const lanes: Lane[] = [];
    for (const b of buildings.values()) {
      if (b.owner !== slot || b.done === null) continue;
      const window = { from: b.done, to: Math.min(b.end ?? until, until) };
      if (window.to <= window.from) continue;
      const larvaSteps = steps.get(b.unit);
      if (larvaSteps && DEPOTS.has(b.type)) {
        // Full: at the cap. Busy is the rest, when the hall was making larvae.
        const full: Span[] = [];
        for (let k = 0; k < larvaSteps.length; k++) if (larvaSteps[k].n >= larvaCap) push(full, larvaSteps[k].frame, larvaSteps[k + 1]?.frame ?? end);
        const fullIn = full.map((s) => ({ from: Math.max(s.from, window.from), to: Math.min(s.to, window.to) })).filter((s) => s.to > s.from);
        const made = hatched.get(slot);
        lanes.push({ kind: "larvae", unit: b.unit, type: b.type, owner: slot, x: b.x, y: b.y, from: window.from, to: window.to,
          busy: free(window, fullIn), idle: withMoney(fullIn, cheapest(made?.keys() ?? [])), makes: most(made) });
        continue;
      }
      const byType = madeByType.get(b.type);
      if (!byType) continue;
      const workers = [...byType.keys()].some((type) => WORKERS.has(type));
      // (One unit after another out of a queue leaves a frame or two between them: one round of work.)
      const busy = merged(b.busy, QUEUE_JOIN).map((s) => ({ from: Math.max(s.from, window.from), to: Math.min(s.to, window.to) })).filter((s) => s.to > s.from);
      // A hall's idle time is counted to `COUNT_UNTIL` only: later, a player with workers enough stops on purpose.
      const idle = withMoney(free(window, busy), cheapest(byType.keys()));
      lanes.push({ kind: workers ? "workers" : "units", unit: b.unit, type: b.type, owner: slot, x: b.x, y: b.y, from: window.from, to: window.to,
        busy, idle: workers ? idle.map((s) => ({ from: s.from, to: Math.min(s.to, COUNT_UNTIL) })).filter((s) => s.to > s.from) : idle, makes: most(b.made) ?? most(byType) });
    }
    lanes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "units" ? 1 : b.kind === "units" ? -1 : 0) || a.from - b.from || a.unit - b.unit);

    const workerLanes = lanes.filter((l) => l.kind === "workers"), unitLanes = lanes.filter((l) => l.kind === "units"), larvaLanes = lanes.filter((l) => l.kind === "larvae");
    const worker = workerLanes.map((l) => l.makes).find((m) => m !== null && WORKERS.has(m)) ?? null;
    const workerTime = worker === null ? null : data.buildTime(worker);
    // No worker anywhere: some hall standing, none of them training, money for one. (A player with three halls who
    // trains at one of them is making workers; a player who stops altogether is not.)
    const standingHalls = merged(workerLanes.map((l) => ({ from: l.from, to: Math.min(l.to, COUNT_UNTIL) })).filter((s) => s.to > s.from));
    const training = merged(workerLanes.flatMap((l) => l.busy));
    const noWorkerSpans = worker === null ? [] : withMoney(standingHalls.flatMap((s) => free(s, training)), data.cost(worker));
    let peak = { value: 0, frame: 0 };
    for (let i = 0; i < frames.length && frames[i] <= Math.min(until, COUNT_UNTIL); i++) if (bank(i) > peak.value) peak = { value: bank(i), frame: frames[i] };

    result.push({
      slot,
      noWorker: workerLanes.length ? covered(noWorkerSpans) : null,
      workersShort: workerLanes.length && workerTime ? Math.round(covered(noWorkerSpans, 0, SHORT_AT) / workerTime) : null,
      noWorkerSpans,
      productionIdle: unitLanes.reduce((n, l) => n + covered(l.idle, 0, COUNT_UNTIL), 0),
      larvaeWaiting: larvaLanes.length ? covered(merged(larvaLanes.flatMap((l) => l.idle)), 0, COUNT_UNTIL) : null,
      peakBank: peak,
      lanes,
    });

    // The gaps: the stretches with no worker made, and each building's idle stretches.
    const gapsOf = (idle: readonly Span[], kind: LaneKind, type: number, lane: Lane | null) => {
      for (const s of merged(idle, GAP_JOIN)) {
        const n = covered(idle, s.from, s.to);
        if (n < GAP_MIN) continue;
        let most = 0;
        for (let i = 0; i < frames.length && frames[i] <= s.to; i++) if (frames[i] >= s.from) most = Math.max(most, bank(i));
        // Another of the kind idle over nearly the same time is the same gap: "2 Gateways".
        const same = gaps.find((g) => g.player === slot && g.type === type && Math.abs(g.from - s.from) <= GAP_JOIN && Math.abs(g.to - s.to) <= GAP_JOIN);
        if (same) { same.count++; continue; }
        gaps.push({ player: slot, kind, type, lane, from: s.from, to: s.to, frames: n, bank: most, count: 1 });
      }
    };
    if (workerLanes.length) gapsOf(noWorkerSpans, "workers", workerLanes[0].type, null);
    // A building's gap is one it was used again after: one left standing to the end was given up, which its lane shows.
    for (const lane of lanes) if (lane.kind !== "workers") gapsOf(lane.idle.filter((s) => lane.busy.some((b) => b.from >= s.to)), lane.kind, lane.type, lane);
  }
  gaps.sort((a, b) => b.frames - a.frames || a.from - b.from);
  return { players: result, gaps: gaps.slice(0, GAPS), until: COUNT_UNTIL, shortAt: SHORT_AT, larvaCap };
}
