/**
 * A cast playing: the game run from the cast's first stretch to its last on the replay's own clock, each stretch at its
 * speed (the key fights at 1×, the quiet parts faster) with no cut between them, then the last frame held while the
 * sign-off finishes; each voiced line started when the clock reaches its frame. The reel only reads the clock, seeks
 * once, sets the speed and pauses, so the person's own pause pauses the voices too, and a jump of their own elsewhere
 * ends the cast.
 */
import { FRAME_SECONDS, spoken, type CastSpeaker, type Schedule } from "./cast";

export interface ReelHooks {
  /** The frame the replay shows now; null while a jump is on its way. */
  frame(): number | null;
  seek(frame: number): void;
  /** Play at this many times normal speed. */
  speed(multiplier: number): void;
  play(): void;
  pause(): void;
  playing(): boolean;
  /** Something the captions show changed. */
  changed(): void;
  /** The reel is over: run out, stopped, or left by a jump elsewhere. */
  ended(why: "done" | "stopped" | "left"): void;
  /** A voice is talking (true), or has stopped for long enough that the game may be heard again (false). */
  talking?(on: boolean): void;
}

/** A stretch of the cast, in game seconds, and how fast it plays. */
export interface ReelMoment { from: number; to: number; speed?: number }

/** Every line is brought to this loudness (LUFS, roughly), so the two voices match and a quiet line is not lost. */
export const TARGET_LOUDNESS = -18;
/** The most a line is turned up or down (decibels). */
const MAX_GAIN_DB = 15;

/**
 * How loud a clip is, in LUFS without the K-weighting (speech barely needs it): the mean power of 400 ms blocks a
 * quarter apart, the silent ones left out (below -70, then more than 10 below the rest), as ITU BS.1770 gates it.
 * -Infinity for a clip with nothing in it.
 */
export function loudness(channels: readonly Float32Array[], sampleRate: number): number {
  const block = Math.max(1, Math.round(sampleRate * 0.4)), step = Math.max(1, Math.round(block / 4));
  const length = channels[0]?.length ?? 0;
  const powers: number[] = [];
  for (let start = 0; start + block <= Math.max(length, block); start += step) {
    let sum = 0;
    for (const ch of channels) for (let i = start; i < Math.min(length, start + block); i++) sum += ch[i] * ch[i];
    powers.push(sum / block);
    if (start + block >= length) break;
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const loud = powers.filter((p) => p > 0 && lufs(p) > -70);
  if (!loud.length) return -Infinity;
  const mean = (ps: number[]) => ps.reduce((a, b) => a + b, 0) / ps.length;
  const gate = lufs(mean(loud)) - 10;
  const kept = loud.filter((p) => lufs(p) > gate);
  return lufs(mean(kept.length ? kept : loud));
}

/** The gain that brings a clip to the target loudness, within ±15 dB; 1 for a silent one. */
export function gainFor(buffer: { numberOfChannels: number; sampleRate: number; getChannelData(c: number): Float32Array }): number {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const l = loudness(channels, buffer.sampleRate);
  if (!Number.isFinite(l)) return 1;
  return 10 ** (Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_LOUDNESS - l)) / 20);
}

/** A seek is taken to have arrived once the clock is this near where it was sent (seconds). */
const ARRIVED = 3;
/** The clock this far before the stretch playing means the person went elsewhere (seconds of game, times the speed). */
const AWAY = 4;
/** A seek may take this long, in the Game view, before the reel gives up (milliseconds). */
const SEEK_WAIT = 30_000;
/** The game stays turned down this long after a voice stops, so it does not swell up between two lines (milliseconds). */
const TALK_HOLD = 700;

export class Reel {
  private readonly ctx: AudioContext | null;
  private readonly gain: GainNode | null;
  private readonly hooks: ReelHooks;
  private readonly moments: readonly ReelMoment[];
  private readonly plan: Schedule;
  /** Each schedule line's voice, by its `clip`; null for a line said in captions only. */
  private readonly voices: readonly (AudioBuffer | null)[];
  /** Each voice's gain to the common loudness. */
  private readonly gains: number[];
  /** The stretch playing. */
  private moment = 0;
  private phase: "seeking" | "playing" | "holding" | "paused" | "over" = "seeking";
  private since = 0;
  private holdFrom = 0;
  /** Where a seek was sent, game seconds. */
  private target = 0;
  private raf = 0;
  /** Lines started, by their index in the schedule. */
  private readonly started = new Set<number>();
  private sources: AudioBufferSourceNode[] = [];
  /** The line being said, and when (performance.now) it started: what the captions show. */
  private saying: { index: number; at: number } | null = null;
  /** Whether `talking` last said a voice talks, and when one last did (performance.now). */
  private talked = false;
  private talkedAt = -Infinity;

  constructor(hooks: ReelHooks, moments: readonly ReelMoment[], plan: Schedule, voices: readonly (AudioBuffer | null)[], ctx: AudioContext | null) {
    this.hooks = hooks;
    this.moments = moments;
    this.plan = plan;
    this.voices = voices;
    this.gains = voices.map((v) => (v ? gainFor(v) : 1));
    this.ctx = ctx;
    this.gain = ctx ? ctx.createGain() : null;
    this.gain?.connect(ctx!.destination);
  }

  start(): void {
    void this.ctx?.resume();
    this.moment = 0;
    this.phase = "seeking";
    this.since = performance.now();
    this.target = this.moments[0].from;
    this.hooks.speed(this.speedOf(0));
    this.hooks.seek(Math.round(this.moments[0].from / FRAME_SECONDS));
    this.hooks.play();
    const step = () => { if (this.phase === "over") return; this.step(); this.raf = requestAnimationFrame(step); };
    this.raf = requestAnimationFrame(step);
  }

  /** Stop the reel and the voices; the replay stays where it is. */
  stop(why: "stopped" | "left" | "done" = "stopped"): void {
    if (this.phase === "over") return;
    this.phase = "over";
    cancelAnimationFrame(this.raf);
    this.hush();
    this.saying = null;
    if (why !== "left") this.hooks.pause();
    this.talk(false);
    void this.ctx?.close();
    this.hooks.changed();
    this.hooks.ended(why);
  }

  get over(): boolean { return this.phase === "over"; }

  /** What is being said now, for the captions: who and what. */
  caption(): { speaker: CastSpeaker; text: string } | null {
    const s = this.saying;
    if (!s) return null;
    const line = this.plan.lines[s.index];
    if (!line || performance.now() - s.at > line.duration * 1000 + 300) return null;
    return { speaker: line.speaker, text: spoken(line.text) };
  }

  /** The card of the line being said, while it is said and a moment after; null when none. */
  card(): string | null {
    const s = this.saying;
    if (!s) return null;
    const line = this.plan.lines[s.index];
    if (!line?.card || performance.now() - s.at > line.duration * 1000 + 1500) return null;
    return line.card;
  }

  /** Which stretch of how many, for the strip. */
  progress(): { moment: number; of: number } { return { moment: this.moment, of: this.moments.length }; }

  private speedOf(m: number): number { return this.moments[m]?.speed ?? 1; }

  private step(): void {
    const now = performance.now();
    if (this.phase !== "paused" && this.voiced(now)) this.talkedAt = now;
    this.talk(now - this.talkedAt < TALK_HOLD);
    if (this.phase === "holding") {
      const held = (now - this.holdFrom) / 1000;
      this.sayDue(null, this.plan.length + held);
      if (held >= this.plan.hold && !this.speaking(now)) this.stop("done");
      return;
    }
    const frame = this.hooks.frame();
    if (frame === null) { if (now - this.since > SEEK_WAIT) this.stop("stopped"); return; }
    const at = frame * FRAME_SECONDS;
    if (this.phase === "seeking") {
      if (Math.abs(at - this.target) > ARRIVED) { if (now - this.since > SEEK_WAIT) this.stop("stopped"); return; }
      this.phase = "playing";
    }
    if (this.phase === "paused") {
      if (!this.hooks.playing()) return;
      this.phase = "playing";
      void this.ctx?.resume();
    }
    if (!this.hooks.playing()) { this.phase = "paused"; void this.ctx?.suspend(); return; }
    // Into the next stretch: its speed, and a cut to it when it does not follow on (a highlights cast); past the last,
    // hold its frame for the sign-off.
    while (this.moment < this.moments.length && at >= this.moments[this.moment].to) {
      this.moment++;
      if (this.moment >= this.moments.length) break;
      const next = this.moments[this.moment];
      this.hooks.speed(this.speedOf(this.moment));
      this.hooks.changed();
      if (next.from - at > ARRIVED) {
        this.phase = "seeking";
        this.since = now;
        this.target = next.from;
        this.hooks.seek(Math.round(next.from / FRAME_SECONDS));
        this.hooks.play();
        return;
      }
    }
    if (this.moment >= this.moments.length) {
      this.moment = this.moments.length - 1;
      this.sayDue(frame, null);
      this.hooks.pause();
      this.phase = "holding";
      this.holdFrom = now;
      return;
    }
    const m = this.moments[this.moment];
    if (at < m.from - AWAY * this.speedOf(this.moment)) { this.stop("left"); return; }
    this.sayDue(frame, null);
  }

  /**
   * Start the lines that are due: by the game's frame while it plays, by seconds on screen while the last frame is held.
   * A line long gone by (the clock ran on past it) is not started late.
   */
  private sayDue(frame: number | null, held: number | null): void {
    this.plan.lines.forEach((line, i) => {
      if (this.started.has(i)) return;
      let late: number;
      if (line.frame >= 0) {
        if (frame === null || frame < line.frame) return;
        late = ((frame - line.frame) * FRAME_SECONDS) / this.speedOf(this.moment);
      } else {
        if (held === null || held < line.start) return;
        late = held - line.start;
      }
      this.started.add(i);
      if (late > Math.max(1, line.duration * 0.5)) return;
      this.say(i);
    });
  }

  private say(i: number): void {
    const line = this.plan.lines[i];
    const voice = line.clip >= 0 ? this.voices[line.clip] : null;
    if (voice && this.ctx && this.gain) {
      const src = this.ctx.createBufferSource();
      src.buffer = voice;
      const level = this.ctx.createGain();
      level.gain.value = this.gains[line.clip] ?? 1;
      src.connect(level).connect(this.gain);
      src.start();
      src.onended = () => { this.sources = this.sources.filter((s) => s !== src); };
      this.sources.push(src);
    }
    this.saying = { index: i, at: performance.now() };
    this.hooks.changed();
  }

  private speaking(now: number): boolean {
    const s = this.saying;
    if (!s) return false;
    return now - s.at < this.plan.lines[s.index].duration * 1000;
  }

  /** A line with a voice is being said (one in captions only is not heard over the game). */
  private voiced(now: number): boolean {
    const s = this.saying;
    if (!s || !this.speaking(now)) return false;
    const clip = this.plan.lines[s.index].clip;
    return clip >= 0 && !!this.voices[clip];
  }

  private talk(on: boolean): void {
    if (on === this.talked) return;
    this.talked = on;
    this.hooks.talking?.(on);
  }

  private hush(): void {
    for (const s of this.sources) { try { s.stop(); } catch { /* already over */ } }
    this.sources = [];
  }
}
