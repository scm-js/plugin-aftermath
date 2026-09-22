/**
 * What Aftermath reads out of a parsed replay: per player the build order, where every
 * building was put down, where units were sent, actions per minute and when they left.
 *
 * Everything here comes from the commands alone — what a player *asked* for. A replay
 * holds no results: a Build command whose builder was killed on the way, a Train that was
 * cancelled, a building that never finished all look the same as ones that happened. The
 * one thing done about it is folding repeats (a player clicking the same building onto
 * the same spot several times while waiting for the money), so the lists read as intent.
 *
 * Pure: no editor, no DOM. `plugin.ts` turns it into the panel and the overlay.
 */
import { FRAME_MS, type Command, type Replay, type ReplayPlayer } from "./replay";

export type ClickKind = "move" | "attack" | "patrol" | "rally" | "ability" | "ping";

export interface Click {
  frame: number;
  player: number;
  /** Map pixels. */
  x: number;
  y: number;
  kind: ClickKind;
}

export interface Placement {
  /** The first order's frame. */
  frame: number;
  /** The last folded order's frame. */
  last: number;
  player: number;
  unit: number;
  /** The building's top-left tile, as the command gives it. */
  tx: number;
  ty: number;
  /** A Terran building landing rather than one being started. */
  landed: boolean;
  /** How many commands were folded into this one. */
  repeats: number;
}

export type BuildStepKind = "build" | "train" | "morph" | "upgrade" | "tech";

export interface BuildStep {
  frame: number;
  kind: BuildStepKind;
  /** A units.dat id for build / train / morph, an upgrade or tech id otherwise. */
  id: number;
  /** Orders for the same thing a few seconds apart, folded; `frame` is the first one's. */
  count: number;
  /** For `build`: the placement this step is. */
  placement?: Placement;
}

export interface PlayerReport {
  player: ReplayPlayer;
  /** Actions (see `isAction`) over the minutes the player was in the game. */
  apm: number;
  actions: number;
  /** Actions in each minute of the game, from the first. */
  perMinute: number[];
  /** The frame the player left on, or null when they were in to the end. */
  leftAt: number | null;
  build: BuildStep[];
  placements: Placement[];
  /** Command Centers, Hatcheries and Nexuses put down (the one each player starts with is not a command). */
  expansions: Placement[];
  clicks: Click[];
}

export interface ChatLine {
  frame: number;
  player: number;
  text: string;
}

export interface ReplayReport {
  replay: Replay;
  /** The last frame anything happened on, or the header's length when larger. */
  frames: number;
  players: PlayerReport[];
  chat: ChatLine[];
}

/** Command Center, Hatchery, Nexus. */
export const TOWN_HALLS = new Set([106, 131, 154]);

/**
 * How far apart identical orders may be and still read as one: a building ordered onto
 * the same spot again within 30 s of the last try (waiting for money, a builder that was
 * blocked), a unit or research ordered again within 3 s of the first (queueing several).
 */
const FOLD_BUILD_FRAMES = 30 * 24;
const FOLD_TRAIN_FRAMES = 3 * 24;

const ATTACK_ORDERS = new Set([0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0e, 0x35, 0x3b]);

export function clickKind(c: Command): ClickKind | null {
  switch (c.kind) {
    case "rightClick": return "move";
    case "ping": return "ping";
    case "targeted": {
      const o = c.order ?? 0;
      if (o === 0x06) return "move";
      if (ATTACK_ORDERS.has(o)) return "attack";
      if (o === 0x98) return "patrol";
      if (o === 0x27 || o === 0x28) return "rally";
      return "ability";
    }
    default: return null;
  }
}

/** Whether a command counts towards APM: anything a player does in the game but talk and the session's own traffic. */
export function isAction(c: Command): boolean {
  return c.kind !== "system" && c.kind !== "chat" && c.kind !== "leave";
}

export const FRAMES_PER_MINUTE = 60_000 / FRAME_MS;

export function formatTime(frame: number): string {
  const s = Math.floor((frame * FRAME_MS) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function analyse(replay: Replay): ReplayReport {
  const last = replay.commands.length ? replay.commands[replay.commands.length - 1].frame : 0;
  const frames = Math.max(replay.header.frames, last);
  const minutes = Math.max(1, Math.ceil(frames / FRAMES_PER_MINUTE));
  const chat: ChatLine[] = [];
  const byId = new Map<number, PlayerReport>();
  const players = replay.players.map((player) => {
    const r: PlayerReport = {
      player, apm: 0, actions: 0, perMinute: new Array(minutes).fill(0), leftAt: null,
      build: [], placements: [], expansions: [], clicks: [],
    };
    byId.set(player.id, r);
    return r;
  });

  for (const c of replay.commands) {
    if (c.kind === "chat") {
      if (c.text) chat.push({ frame: c.frame, player: c.player, text: c.text });
      continue;
    }
    const r = byId.get(c.player);
    if (!r) continue;
    if (isAction(c)) {
      r.actions++;
      r.perMinute[Math.min(minutes - 1, Math.floor(c.frame / FRAMES_PER_MINUTE))]++;
    }
    const click = clickKind(c);
    if (click && c.x !== undefined && c.y !== undefined) r.clicks.push({ frame: c.frame, player: c.player, x: c.x, y: c.y, kind: click });

    switch (c.kind) {
      case "leave": if (r.leftAt === null) r.leftAt = c.frame; break;
      case "build": case "land": {
        const landed = c.kind === "land";
        const prev = r.placements[r.placements.length - 1];
        if (prev && !landed && !prev.landed && prev.unit === c.unit && prev.tx === c.x && prev.ty === c.y && c.frame - prev.last <= FOLD_BUILD_FRAMES) {
          prev.last = c.frame;
          prev.repeats++;
          break;
        }
        const p: Placement = { frame: c.frame, last: c.frame, player: c.player, unit: c.unit!, tx: c.x!, ty: c.y!, landed, repeats: 1 };
        r.placements.push(p);
        if (!landed) r.build.push({ frame: c.frame, kind: "build", id: p.unit, count: 1, placement: p });
        break;
      }
      case "train": case "morph": case "buildingMorph":
        step(r.build, c.frame, c.kind === "train" ? "train" : "morph", c.unit!);
        break;
      case "upgrade": step(r.build, c.frame, "upgrade", c.value!); break;
      case "tech": step(r.build, c.frame, "tech", c.value!); break;
    }
  }

  for (const r of players) {
    // Every race starts with its town hall standing, so each one built is a new base —
    // or, for Zerg, sometimes a second Hatchery at home.
    r.expansions = r.placements.filter((p) => !p.landed && TOWN_HALLS.has(p.unit));
    const end = r.leftAt ?? frames;
    r.apm = end > 0 ? Math.round(r.actions / (end / FRAMES_PER_MINUTE)) : 0;
  }
  return { replay, frames, players, chat };
}

/** Orders for the same thing within a few seconds of the first fold into one step, which keeps the first's time. */
function step(list: BuildStep[], frame: number, kind: BuildStepKind, id: number): void {
  const prev = list[list.length - 1];
  if (prev && prev.kind === kind && prev.id === id && frame - prev.frame <= FOLD_TRAIN_FRAMES) {
    prev.count++;
    return;
  }
  list.push({ frame, kind, id, count: 1 });
}

/** SCV, Drone, Probe. */
export const WORKERS = new Set([7, 41, 64]);

/**
 * The build order as a list reads best: workers left out unless asked for, and
 * neighbouring steps for the same unit or research joined (`Zergling ×12`), since players
 * press train many times over. Buildings are never joined: each has its own place.
 */
export function buildOrderRows(steps: readonly BuildStep[], options: { workers?: boolean } = {}): BuildStep[] {
  const rows: BuildStep[] = [];
  for (const s of steps) {
    if (!options.workers && s.kind !== "upgrade" && s.kind !== "tech" && WORKERS.has(s.id)) continue;
    const prev = rows[rows.length - 1];
    if (prev && !s.placement && !prev.placement && prev.kind === s.kind && prev.id === s.id) {
      rows[rows.length - 1] = { ...prev, count: prev.count + s.count };
      continue;
    }
    rows.push(s);
  }
  return rows;
}

/* ── Heat ───────────────────────────────────────────────── */

export interface HeatGrid {
  /** In cells of `cell` pixels. */
  width: number;
  height: number;
  cell: number;
  values: Float32Array;
  max: number;
}

/**
 * Clicks of the chosen kinds up to `frame`, counted into cells and softened with a small
 * blur so a cluster reads as a patch rather than as specks.
 */
export function heat(clicks: Iterable<Click>, mapWidth: number, mapHeight: number, options: { cell?: number; kinds?: ReadonlySet<ClickKind>; until?: number; from?: number } = {}): HeatGrid {
  const cell = options.cell ?? 32;
  const width = Math.ceil((mapWidth * 32) / cell);
  const height = Math.ceil((mapHeight * 32) / cell);
  const raw = new Float32Array(width * height);
  for (const c of clicks) {
    if (options.kinds && !options.kinds.has(c.kind)) continue;
    if (options.until !== undefined && c.frame > options.until) continue;
    if (options.from !== undefined && c.frame < options.from) continue;
    const x = Math.floor(c.x / cell);
    const y = Math.floor(c.y / cell);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    raw[y * width + x] += 1;
  }
  const values = blur(raw, width, height);
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return { width, height, cell, values, max };
}

/** A 5 × 5 binomial blur, separable. */
function blur(src: Float32Array, w: number, h: number): Float32Array {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) s += src[y * w + xx] * k[i + 2];
      }
      tmp[y * w + x] = s / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) s += tmp[yy * w + x] * k[i + 2];
      }
      out[y * w + x] = s / 16;
    }
  }
  return out;
}
