/**
 * A cast playing: the reel of moments run on the replay's own clock — each clip played from its start at 1×, its last
 * frame held while a line finishes, then a cut to the next — and each voiced line started when the clock reaches it.
 * The clock is the plugin's (or the Game view's); the reel only reads it, seeks and pauses, so the person's own pause
 * pauses the voices too, and a jump of their own elsewhere ends the cast.
 */
import { FRAME_SECONDS, spoken, type CastSpeaker, type Schedule } from "./cast";

export interface ReelHooks {
  /** The frame the replay shows now; null while a jump is on its way. */
  frame(): number | null;
  seek(frame: number): void;
  play(): void;
  pause(): void;
  playing(): boolean;
  /** Something the captions show changed. */
  changed(): void;
  /** The reel is over: run out, stopped, or left by a jump elsewhere. */
  ended(why: "done" | "stopped" | "left"): void;
}

export interface ReelMoment { from: number; to: number }

/** A seek is taken to have arrived once the clock is this near where it was sent (seconds). */
const ARRIVED = 3;
/** The clock this far outside the clip means the person went elsewhere (seconds). */
const AWAY = 4;
/** A seek may take this long, in the Game view, before the reel gives up (milliseconds). */
const SEEK_WAIT = 30_000;

export class Reel {
  private readonly ctx: AudioContext | null;
  private readonly gain: GainNode | null;
  private moment = 0;
  private phase: "seeking" | "playing" | "holding" | "paused" | "over" = "seeking";
  private since = 0;
  private holdFrom = 0;
  private raf = 0;
  /** Lines started, by their index in the schedule. */
  private readonly started = new Set<number>();
  private sources: AudioBufferSourceNode[] = [];
  /** The line being said, and when (performance.now) it started: what the captions show. */
  private saying: { index: number; at: number } | null = null;

  private readonly hooks: ReelHooks;
  private readonly moments: readonly ReelMoment[];
  private readonly plan: Schedule;
  /** Each schedule line's voice, by its `clip`; null for a line said in captions only. */
  private readonly voices: readonly (AudioBuffer | null)[];

  constructor(hooks: ReelHooks, moments: readonly ReelMoment[], plan: Schedule, voices: readonly (AudioBuffer | null)[], ctx: AudioContext | null) {
    this.hooks = hooks;
    this.moments = moments;
    this.plan = plan;
    this.voices = voices;
    this.ctx = ctx;
    this.gain = ctx ? ctx.createGain() : null;
    this.gain?.connect(ctx!.destination);
  }

  start(): void {
    void this.ctx?.resume();
    this.go(0);
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

  /** Which moment of how many, for the strip. */
  progress(): { moment: number; of: number } { return { moment: this.moment, of: this.moments.length }; }

  private go(m: number): void {
    this.moment = m;
    this.phase = "seeking";
    this.since = performance.now();
    this.hooks.seek(Math.round(this.moments[m].from / FRAME_SECONDS));
    this.hooks.play();
  }

  private step(): void {
    const m = this.moments[this.moment];
    const now = performance.now();
    const frame = this.hooks.frame();
    if (frame === null) { if (now - this.since > SEEK_WAIT) this.stop("stopped"); return; }
    const at = frame * FRAME_SECONDS;
    switch (this.phase) {
      case "seeking":
        if (Math.abs(at - m.from) <= ARRIVED) { this.phase = "playing"; break; }
        if (now - this.since > SEEK_WAIT) this.stop("stopped");
        return;
      case "paused":
        if (!this.hooks.playing()) return;
        this.phase = "playing";
        void this.ctx?.resume();
        break;
      case "holding": {
        const held = (now - this.holdFrom) / 1000;
        this.sayDue(m.to + held, true);
        if (held >= this.plan.holds[this.moment] && !this.speaking(now)) {
          if (this.moment + 1 >= this.moments.length) { this.stop("done"); return; }
          this.go(this.moment + 1);
        }
        return;
      }
      default:
        break;
    }
    if (this.phase !== "playing") return;
    if (!this.hooks.playing()) { this.phase = "paused"; void this.ctx?.suspend(); return; }
    if (at < m.from - AWAY || at > m.to + AWAY) { this.stop("left"); return; }
    if (at >= m.to) {
      this.hooks.pause();
      this.phase = "holding";
      this.holdFrom = now;
      return;
    }
    this.sayDue(at, false);
  }

  /** Start the lines of this moment due by `at` (game seconds); while holding, the ones past the clip's end too. */
  private sayDue(at: number, holding: boolean): void {
    const m = this.moments[this.moment];
    this.plan.lines.forEach((line, i) => {
      if (line.moment !== this.moment || this.started.has(i) || line.start > at) return;
      if (!holding && line.start >= m.to) return;
      this.started.add(i);
      // A line long gone by (the clock ran on past it) is not started late.
      if (at - line.start > Math.max(1, line.duration * 0.5)) return;
      this.say(i);
    });
  }

  private say(i: number): void {
    const line = this.plan.lines[i];
    const voice = line.clip >= 0 ? this.voices[line.clip] : null;
    if (voice && this.ctx && this.gain) {
      const src = this.ctx.createBufferSource();
      src.buffer = voice;
      src.connect(this.gain);
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

  private hush(): void {
    for (const s of this.sources) { try { s.stop(); } catch { /* already over */ } }
    this.sources = [];
  }
}
