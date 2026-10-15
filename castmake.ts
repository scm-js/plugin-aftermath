/**
 * Making a cast, the parts that are not drawing: reading the server's stream as the script is written (how far it has
 * got, and its storyline as soon as that is there), voicing in batches so progress can be counted, what a cast will
 * likely cost and take, and keeping finished casts in the browser so watching one again costs nothing.
 */
import type { CastLine, CastOptions } from "./cast";

/* ── The script as it is written ── */

/** How far a script being written has got, read from the text so far (a JSON object still being written). */
export interface Writing {
  /** The storyline, once it has been written in full; null before. */
  storyline: string | null;
  /** Lines written so far. */
  lines: number;
  /** The stretch the last line written belongs to (from 0), or -1 before the first line. */
  stretch: number;
}

export function writingProgress(text: string): Writing {
  const story = /"storyline"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  let storyline: string | null = null;
  if (story) { try { storyline = JSON.parse(`"${story[1]}"`) as string; } catch { storyline = null; } }
  const moments = [...text.matchAll(/"moment"\s*:\s*(\d+)/g)];
  return { storyline, lines: moments.length, stretch: moments.length ? Number(moments[moments.length - 1][1]) : -1 };
}

/** One event of the server's stream (`event: …` / `data: {…}`), parsed. */
export interface StreamEvent { event: string; [key: string]: unknown }

/** Read a server-sent event stream to its end, handing each event over as it arrives. */
export async function readStream(body: ReadableStream<Uint8Array>, each: (e: StreamEvent) => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try { each(JSON.parse(data) as StreamEvent); } catch { /* a frame that is not JSON is not ours */ }
    }
    if (done) return;
  }
}

/* ── Voicing in batches ── */

/** Lines voiced in one request: small enough to count progress by, large enough not to wait on many round trips. */
export const VOICE_BATCH = 12;

/** The lines cut into batches, each with the index of its first line. */
export function batches<T>(items: readonly T[], size = VOICE_BATCH): { from: number; items: T[] }[] {
  const out: { from: number; items: T[] }[] = [];
  for (let i = 0; i < items.length; i += size) out.push({ from: i, items: items.slice(i, i + size) });
  return out;
}

/* ── What a cast will likely cost and take ── */

export interface Estimate {
  /** Dollars for the script and, when voiced, the voices. */
  scriptUsd: number;
  voiceUsd: number;
  /** Minutes on screen, and minutes to make. */
  minutes: number;
  making: [number, number];
}

/**
 * A cast's likely cost and time, from what the first casts measured (a whole game of twenty minutes: about $0.45 of
 * script and 5,400 characters of voice, ten minutes on screen, two to three minutes to make; its key moments about
 * half of each). `seconds` is how long it will be on screen; `usdPer1kChars` the server's price for voicing, or null
 * for captions only.
 */
export function estimate(seconds: number, options: CastOptions, usdPer1kChars: number | null): Estimate {
  const minutes = seconds / 60;
  const banter = options.banter === "lots" ? 1.1 : options.banter === "off" ? 0.9 : 1;
  const chars = minutes * 540 * banter;
  const scriptUsd = 0.12 + minutes * 0.033;
  return {
    scriptUsd,
    voiceUsd: usdPer1kChars === null ? 0 : (chars / 1000) * usdPer1kChars,
    minutes,
    making: options.format === "game" ? [2, 3] : [1, 2],
  };
}

/* ── Casts kept in the browser ── */

/** A finished cast as kept: what was sent, what came back, and the voices as their files. */
export interface KeptCast {
  key: string;
  /** The replay it is of (a hash of its file), and how it was made. */
  replay: string;
  options: CastOptions;
  voiced: boolean;
  notes: string;
  made: number;
  /** When it was last watched (absent: never), for which to let go first when the browser's room runs short. */
  watched?: number;
  input: unknown;
  lines: CastLine[];
  storyline: string;
  interests: { caster: string; analyst: string } | null;
  /** Each line's voice as the file it came as (mp3), or null for captions only. */
  clips: (ArrayBuffer | null)[];
}

/** Kept casts at most: this many, and this many bytes of voices (a cast is about 5–8 MB). */
export const KEEP_CASTS = 30;
export const KEEP_BYTES = 300 * 1024 * 1024;

/**
 * The casts to let go when there are more than the browser should keep: the ones watched (or made) longest ago, until
 * what is left is within the count and the bytes. The newest is always kept.
 */
export function toEvict(casts: readonly { key: string; made: number; watched?: number; bytes: number }[], maxCount = KEEP_CASTS, maxBytes = KEEP_BYTES): string[] {
  const order = [...casts].sort((a, b) => (b.watched ?? b.made) - (a.watched ?? a.made));
  const out: string[] = [];
  let bytes = 0;
  order.forEach((c, i) => {
    bytes += c.bytes;
    if (i > 0 && (i >= maxCount || bytes > maxBytes)) out.push(c.key);
  });
  return out;
}

/** A kept cast's size: its voices. */
export const castBytes = (c: Pick<KeptCast, "clips">) => c.clips.reduce((n, b) => n + (b?.byteLength ?? 0), 0);

/** The replay's file as a key: its SHA-256, in hex. */
export async function replayKey(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key of one way of casting one replay. */
export const castKey = (replay: string, options: CastOptions, voiced: boolean, notes: string) =>
  `${replay}:${options.format}:${options.banter}:${voiced ? "voiced" : "captions"}:${notes.trim().toLowerCase()}`;

/**
 * Finished casts in the browser's IndexedDB, so a cast is made once and watched again for nothing. Every call fails
 * soft: no storage (a private window, storage turned off) means casts are not kept, not that casting fails.
 */
export class CastStore {
  private db: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open("scmjs.plugin.aftermath.casts", 1);
        req.onupgradeneeded = () => { const store = req.result.createObjectStore("casts", { keyPath: "key" }); store.createIndex("replay", "replay"); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = work(db.transaction("casts", mode).objectStore("casts"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  private asked = false;

  /**
   * Keep a cast; then ask the browser, once, to keep this storage when it runs short of room (it may say no, and the
   * casts are then kept as long as it allows), and let go of the casts watched longest ago past the limits.
   */
  async put(cast: KeptCast): Promise<boolean> {
    const ok = (await this.run("readwrite", (s) => s.put(cast))) !== null;
    if (!this.asked) { this.asked = true; try { await navigator.storage?.persist?.(); } catch { /* not offered here */ } }
    await this.prune();
    return ok;
  }

  /** Say a cast was watched now: the last to go. */
  async touch(key: string): Promise<void> {
    const c = await this.get(key);
    if (c) await this.run("readwrite", (s) => s.put({ ...c, watched: Date.now() }));
  }

  /** Let go of the casts watched longest ago, past the count and the bytes kept. */
  async prune(): Promise<void> {
    const all = (await this.run("readonly", (s) => s.getAll() as IDBRequest<KeptCast[]>)) ?? [];
    for (const key of toEvict(all.map((c) => ({ key: c.key, made: c.made, watched: c.watched, bytes: castBytes(c) })))) await this.remove(key);
  }

  /** How many casts are kept, and how many bytes of voices. */
  async usage(): Promise<{ casts: number; bytes: number }> {
    const all = (await this.run("readonly", (s) => s.getAll() as IDBRequest<KeptCast[]>)) ?? [];
    return { casts: all.length, bytes: all.reduce((n, c) => n + castBytes(c), 0) };
  }
  get(key: string): Promise<KeptCast | null> { return this.run("readonly", (s) => s.get(key) as IDBRequest<KeptCast>).then((c) => c ?? null); }
  async forReplay(replay: string): Promise<KeptCast[]> {
    const all = await this.run("readonly", (s) => s.index("replay").getAll(replay) as IDBRequest<KeptCast[]>);
    return (all ?? []).sort((a, b) => b.made - a.made);
  }
  async remove(key: string): Promise<void> { await this.run("readwrite", (s) => s.delete(key)); }
}
