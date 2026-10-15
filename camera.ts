/**
 * Spectate's camera as an observer moves it, worked out once for the whole game from the shots (`director.ts`): a
 * track, where the middle of the view is at every other frame, that both the map and the Game view play back by the
 * clock. Pure and tested.
 *
 * What makes it an observer's rather than a machine's:
 * - It holds still while what it shows stays near the middle of the screen (a dead zone, smaller for a fight), and is
 *   drawn along once it strays, rather than chasing every step of the units' average.
 * - It cuts to a shot further than a screen or so away, as an observer clicks the minimap rather than scroll across
 *   the map, and pans to one within reach.
 * - It looks a little ahead of an army on the move.
 * - The whole game is known beforehand, so the track is smoothed forward and back in time: no lag behind what it
 *   follows, no corners in its speed, and a pan sets off a moment before the shot changes, as an observer who saw it
 *   coming would.
 *
 * Its timings are the person's seconds, not the game's: a pan takes the same time to watch at 1× as at 8×, as far as
 * the game frames allow. So the track is for one playback speed and one size of view, and is made again when either
 * changes.
 */
import { shotAt, type Shot } from "./director";

/** Where the camera looks at each moment of the game: the middle of the view, in map pixels. */
export interface CameraTrack {
  /** Frames between points: point `i` is at frame `i * every`. */
  every: number;
  x: Float32Array;
  y: Float32Array;
  /** 1 where the camera cuts to its point rather than moving to it from the point before. */
  cut: Uint8Array;
}

export interface TrackOptions {
  /** How much of the map the view shows, pixels. */
  view: { width: number; height: number };
  /** The map, pixels. */
  map: { width: number; height: number };
  /** The game's length in frames. */
  frames: number;
  /** Game frames a second of the person's time, at the playback speed. */
  rate: number;
}

/** Frames between the track's points. */
const EVERY = 2;
/** A target this far away is cut to (in screens: the larger of across and down). */
const CUT = 1.25;
/** How far what is shown may stray from the middle before the camera moves: a share of half the view. */
const DEAD = { fight: 0.2, other: 0.4 };
/** How much the track is smoothed: the spread of its bell, in the person's seconds, within the game frames given. A pan takes about four of these. */
const EASE = { seconds: 0.2, fewestFrames: 4, mostFrames: 160 };
/**
 * An army on the move is looked at this far ahead of where it is (game frames: a second and a half), at most a share of
 * half the view; and, once it moves at least `LEAD_SPEED` pixels a frame, the dead zone's width further, so the camera
 * drawn along behind it still has it short of the middle, with room on the screen for where it is going.
 */
const LEAD_FRAMES = 36;
const LEAD_MOST = 0.3;
const LEAD_SPEED = 1.5;

/** A shot's points with the wobble of the units' average taken out: each the mean of itself (twice) and its neighbours. */
function smoothed(path: Shot["path"]): Shot["path"] {
  if (path.length < 3) return path;
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    return { frame: p.frame, x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
  });
}

/** Where a path looks at a frame: a Catmull-Rom curve through its points, so the camera's speed has no corners. */
export function along(path: Shot["path"], frame: number): { x: number; y: number } {
  let i = 0;
  while (i + 1 < path.length && path[i + 1].frame <= frame) i++;
  const p1 = path[i], p2 = path[i + 1];
  if (!p2 || frame <= p1.frame) return { x: p1.x, y: p1.y };
  const p0 = path[i - 1] ?? p1, p3 = path[i + 2] ?? p2;
  const t = Math.min(1, (frame - p1.frame) / Math.max(1, p2.frame - p1.frame)), t2 = t * t, t3 = t2 * t;
  const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

/** The camera's track for the whole game; null when there are no shots. */
export function cameraTrack(shots: readonly Shot[], o: TrackOptions): CameraTrack | null {
  if (!shots.length) return null;
  const w = Math.max(1, o.view.width), h = Math.max(1, o.view.height);
  // The middle of the view stays where the view keeps to the map.
  const clampX = (x: number) => (o.map.width <= w ? o.map.width / 2 : Math.max(w / 2, Math.min(o.map.width - w / 2, x)));
  const clampY = (y: number) => (o.map.height <= h ? o.map.height / 2 : Math.max(h / 2, Math.min(o.map.height - h / 2, y)));
  const paths = new Map<Shot, Shot["path"]>();
  const pathOf = (s: Shot) => { let p = paths.get(s); if (!p) { p = smoothed(s.path); paths.set(s, p); } return p; };

  /** Where the camera means to look at a frame of a shot: the shot's curve, ahead of an army on the move. */
  const aim = (s: Shot, frame: number) => {
    const path = pathOf(s), at = along(path, frame);
    if (s.kind === "army" && path.length > 1) {
      const a = along(path, frame - LEAD_FRAMES / 2), b = along(path, frame + LEAD_FRAMES / 2);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len > 0) {
        const moving = Math.min(1, len / LEAD_FRAMES / LEAD_SPEED);
        const ahead = Math.min(len, (LEAD_MOST * Math.min(w, h)) / 2) + moving * DEAD.other * Math.min(w, h) / 2;
        at.x += (dx / len) * ahead; at.y += (dy / len) * ahead;
      }
    }
    return { x: clampX(at.x), y: clampY(at.y) };
  };

  // Where the camera would be, point by point, with no easing: still inside the dead zone, drawn along by what it shows
  // once that strays out of it, squarely on a new shot, and cut to anything too far to pan to.
  const n = Math.floor(Math.max(0, o.frames) / EVERY) + 2;
  const rawX = new Float32Array(n), rawY = new Float32Array(n), cut = new Uint8Array(n);
  let x = 0, y = 0, shown = -1;
  for (let i = 0; i < n; i++) {
    const frame = i * EVERY;
    const si = Math.max(0, shotAt(shots, frame)), shot = shots[si], target = aim(shot, frame);
    const dead = shot.kind === "fight" ? DEAD.fight : DEAD.other;
    const dx = target.x - x, dy = target.y - y, away = Math.max(Math.abs(dx) / w, Math.abs(dy) / h);
    if (i === 0 || away > CUT) { x = target.x; y = target.y; cut[i] = 1; }
    else if (si !== shown && away > dead / 2) { x = target.x; y = target.y; }
    else {
      const zx = (dead * w) / 2, zy = (dead * h) / 2;
      if (Math.abs(dx) > zx) x = target.x - Math.sign(dx) * zx;
      if (Math.abs(dy) > zy) y = target.y - Math.sign(dy) * zy;
    }
    shown = si;
    rawX[i] = x; rawY[i] = y;
  }

  // Eased: each point the mean of its neighbours under a bell, forward and back, never across a cut.
  const sigma = Math.max(EASE.fewestFrames, Math.min(EASE.mostFrames, EASE.seconds * Math.max(1, o.rate))) / EVERY;
  const reach = Math.ceil(sigma * 3), bell = new Float64Array(reach + 1);
  for (let k = 0; k <= reach; k++) bell[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
  const xs = new Float32Array(n), ys = new Float32Array(n);
  for (let from = 0; from < n;) {
    let to = from + 1;
    while (to < n && !cut[to]) to++;
    for (let i = from; i < to; i++) {
      let sx = 0, sy = 0, sw = 0;
      for (let j = Math.max(from, i - reach), last = Math.min(to - 1, i + reach); j <= last; j++) {
        const b = bell[Math.abs(j - i)];
        sx += rawX[j] * b; sy += rawY[j] * b; sw += b;
      }
      xs[i] = sx / sw; ys[i] = sy / sw;
    }
    from = to;
  }
  return { every: EVERY, x: xs, y: ys, cut };
}

/**
 * Where the track looks at a frame (fractional frames too): a curve through its points, so the screen's speed changes
 * smoothly between them too. It holds a point until a cut takes it elsewhere, and does not bend across a cut.
 */
export function trackAt(t: CameraTrack, frame: number): { x: number; y: number } {
  const last = t.x.length - 1, pos = Math.max(0, frame) / t.every, i = Math.min(last, Math.floor(pos));
  if (i >= last || t.cut[i + 1]) return { x: t.x[i], y: t.y[i] };
  const a = i > 0 && !t.cut[i] ? i - 1 : i, d = i + 2 <= last && !t.cut[i + 2] ? i + 2 : i + 1;
  const k = pos - i, k2 = k * k, k3 = k2 * k;
  const cr = (v: Float32Array) => 0.5 * (2 * v[i] + (v[i + 1] - v[a]) * k + (2 * v[a] - 5 * v[i] + 4 * v[i + 1] - v[d]) * k2 + (3 * v[i] - v[a] - 3 * v[i + 1] + v[d]) * k3);
  return { x: cr(t.x), y: cr(t.y) };
}
