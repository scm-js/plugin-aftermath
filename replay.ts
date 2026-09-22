/**
 * Reading a StarCraft: Brood War replay (`.rep`).
 *
 * A replay does not record where units were. It records the game's setup (the header),
 * every command each player gave with the frame it was given on, and the map the game was
 * played on — the game re-runs the simulation from those to play it back. This module
 * reads all three and nothing more; it knows nothing of the editor.
 *
 * The file is a run of sections. Each is a checksum, a chunk count and the chunks, each
 * chunk a length and its bytes; a section's data is its chunks joined. How a chunk is
 * packed depends on the game version that wrote the file:
 *
 *   - before 1.18 ("legacy"): PKWARE DCL implode, except a chunk whose length is already
 *     its unpacked size, which is stored as is. Four sections: the replay id, the header,
 *     the commands and the map.
 *   - 1.18 to 1.20: zlib, a chunk being packed when it starts with a zlib header. After
 *     the four comes a player-names section, then sections tagged with a four-character
 *     id (`SKIN`, `LMTS`, `BFIX`, `CCLR`, `GCFG`, and whatever a third party adds).
 *   - 1.21 on: as 1.18, the replay id reading `seRS` instead of `reRS`, and a four-byte
 *     value between the replay id and the header.
 *
 * The commands and map sections are variable in size: each is preceded by a four-byte
 * section of its own holding the size.
 *
 * The layout follows screp (github.com/icza/screp, Apache-2.0), the reference replay
 * parser, which in turn follows BWHF and bwreplib.
 */
import { explode } from "mopaq";

export type ReplayFormat = "legacy" | "1.18" | "1.21";

export interface ReplayPlayer {
  /** 0–11: where the player's record sits in the header, which is the map's player number. */
  index: number;
  /** The lobby slot id; chat names its sender by this. */
  slot: number;
  /** The id commands carry (`Command.player`). */
  id: number;
  /** 1 computer, 2 human, … as the map's OWNR byte. */
  type: number;
  /** 0 Zerg, 1 Terran, 2 Protoss. */
  race: number;
  team: number;
  name: string;
  /** `#rrggbb`, from the replay's own colour for the slot. */
  color: string;
}

export interface ReplayHeader {
  /** 0 StarCraft, 1 Brood War. */
  engine: number;
  /** The game's length in frames; a frame is 42 ms at Fastest. */
  frames: number;
  /** When the game started, or null when the header says 0. */
  started: Date | null;
  title: string;
  mapWidth: number;
  mapHeight: number;
  /** 0 Slowest … 6 Fastest. */
  speed: number;
  /** 2 Melee, 3 FFA, 4 1on1, 10 Use Map Settings, 15 Top vs Bottom, … */
  gameType: number;
  host: string;
  mapName: string;
}

/** What a command is, as far as Aftermath cares; `type` keeps the game's own byte. */
export type CommandKind =
  | "select" | "hotkey" | "rightClick" | "targeted" | "build" | "land" | "liftOff"
  | "train" | "morph" | "buildingMorph" | "upgrade" | "tech" | "cancel" | "simple"
  | "leave" | "ping" | "chat" | "alliance" | "vision" | "system";

export interface Command {
  frame: number;
  /** The issuing player's id (`ReplayPlayer.id`). */
  player: number;
  kind: CommandKind;
  /** The command's type byte. */
  type: number;
  /** Map pixels for clicks and pings; tiles for `build` and `land`. */
  x?: number;
  y?: number;
  /** A units.dat id: what was built, trained or clicked on; 228 (None) for ground. */
  unit?: number;
  /** An orders.dat id, for `targeted`, `build` and `land`. */
  order?: number;
  queued?: boolean;
  /** An upgrade or tech id, a leave reason, a hotkey group. */
  value?: number;
  /** Units named in a `select`, as the game's unit tags. */
  tags?: number[];
  /** A `chat` line. */
  text?: string;
}

export interface Replay {
  format: ReplayFormat;
  header: ReplayHeader;
  /** The players who took part, in slot order. */
  players: ReplayPlayer[];
  commands: Command[];
  /** Commands whose type the reader did not know; the rest of their frame block is skipped. */
  unknownCommands: number;
  /** The map the game was played on, as a bare `scenario.chk`. */
  chk: Uint8Array;
}

export class ReplayError extends Error {}

/** A frame at Fastest: 1000 / 24 ms, as the game rounds it. */
export const FRAME_MS = 42;

/* ── Section framing ────────────────────────────────────── */

const CHUNK = 0x2000;

type Inflate = (chunk: Uint8Array) => Promise<Uint8Array>;

/** zlib (RFC 1950) through the platform's DecompressionStream — the browser's and Node's. */
export async function inflate(chunk: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([chunk as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class Reader {
  pos = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  get left(): number { return this.b.length - this.pos; }
  u32(): number {
    if (this.pos + 4 > this.b.length) throw new ReplayError("The file ends in the middle of a section.");
    const v = (this.b[this.pos] | (this.b[this.pos + 1] << 8) | (this.b[this.pos + 2] << 16) | (this.b[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.b.length) throw new ReplayError("The file ends in the middle of a section.");
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function isZlib(c: Uint8Array): boolean {
  return c.length > 4 && c[0] === 0x78 && ((c[0] << 8) | c[1]) % 31 === 0;
}

/** One framed section of `size` unpacked bytes. */
async function section(r: Reader, size: number, format: ReplayFormat, unzip: Inflate): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array(0);
  r.u32(); // checksum — the game's, not checked here
  const count = r.u32();
  if (count > 0x10000) throw new ReplayError("A section claims more chunks than a replay can hold.");
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) chunks.push(r.bytes(r.u32()));

  if (format === "legacy") {
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      const want = Math.min(size - at, CHUNK);
      if (want <= 0) throw new ReplayError("A section holds more than its stated size.");
      if (c.length === want) out.set(c, at);
      else {
        let unpacked: Uint8Array;
        try { unpacked = explode(c, want); } catch { throw new ReplayError("A section's data does not unpack."); }
        out.set(unpacked.subarray(0, want), at);
      }
      at += want;
    }
    return out;
  }

  const parts = await Promise.all(chunks.map((c) => (isZlib(c) ? unzip(c) : Promise.resolve(c))));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function sized(r: Reader, format: ReplayFormat, unzip: Inflate): Promise<Uint8Array> {
  const head = await section(r, 4, format, unzip);
  if (head.length < 4) throw new ReplayError("A section's size is missing.");
  const size = (head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) >>> 0;
  if (size > 64 << 20) throw new ReplayError("A section claims to be larger than any replay.");
  return section(r, size, format, unzip);
}

export function detectFormat(b: Uint8Array): ReplayFormat | null {
  if (b.length < 30) return null;
  const id = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (id === "seRS") return "1.21";
  if (id !== "reRS") return null;
  return b[28] === 0x78 ? "1.18" : "legacy";
}

/* ── Strings ────────────────────────────────────────────── */

function cut(b: Uint8Array): Uint8Array {
  const end = b.indexOf(0);
  return end < 0 ? b : b.subarray(0, end);
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8 = new TextDecoder("utf-8");
let legacy: { korean: TextDecoder | null; western: TextDecoder | null } | undefined;

function decoder(label: string, fatal: boolean): TextDecoder | null {
  try { return new TextDecoder(label, { fatal }); } catch { return null; }
}

/**
 * A zero-terminated string. Remastered writes UTF-8. Older clients wrote the host's code
 * page, which the file does not name: UTF-8 when it is valid, else Korean (cp949, by far
 * the most common other one) when it is valid, else Western (windows-1252), which takes
 * any bytes — the order broodrep settled on.
 */
export function cString(b: Uint8Array, alwaysUtf8 = false): string {
  const s = cut(b);
  if (alwaysUtf8) return utf8.decode(s);
  try { return utf8Strict.decode(s); } catch { /* not UTF-8 */ }
  legacy ??= { korean: decoder("euc-kr", true), western: decoder("windows-1252", false) };
  if (legacy.korean) {
    try { return legacy.korean.decode(s); } catch { /* not Korean */ }
  }
  return (legacy.western ?? utf8).decode(s);
}

/* ── Header ─────────────────────────────────────────────── */

/** The game's player colours by id (`screp`'s table), used when the replay has no CCLR. */
const COLORS = [
  0xf40404, 0x0c48cc, 0x2cb494, 0x88409c, 0xf88c14, 0x703014, 0xcce0d0, 0xfcfc38,
  0x088008, 0xfcfc7c, 0xecc4b0, 0x4068d4, 0x74a47c, 0x9090b8, 0xfcfc7c, 0x00e4fc,
  0xffc4e4, 0x787800, 0xd2f53c, 0x0000e6, 0x4068d4, 0xf032e6, 0x808080, 0x3c3c3c,
];

const hex = (rgb: number) => "#" + rgb.toString(16).padStart(6, "0");

function readHeader(d: Uint8Array, format: ReplayFormat): { header: ReplayHeader; slots: ReplayPlayer[] } {
  if (d.length < 0x279) throw new ReplayError("The replay's header is too short.");
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const text = (at: number, n: number, utf = false) => cString(d.subarray(at, at + n), utf);
  const started = dv.getUint32(0x08, true);
  const header: ReplayHeader = {
    engine: d[0x00],
    frames: dv.getUint32(0x01, true),
    started: started ? new Date(started * 1000) : null,
    // Remastered writes UTF-8 and cuts a long title mid-character, so it is read leniently.
    title: text(0x18, 28, format !== "legacy"),
    mapWidth: dv.getUint16(0x34, true),
    mapHeight: dv.getUint16(0x36, true),
    speed: d[0x3a],
    gameType: dv.getUint16(0x3c, true),
    host: text(0x48, 24),
    mapName: text(0x61, 26),
  };
  const slots: ReplayPlayer[] = [];
  for (let i = 0; i < 12; i++) {
    const at = 0xa1 + i * 36;
    const color = i < 8 ? dv.getUint32(0x251 + i * 4, true) : -1;
    slots.push({
      index: i,
      slot: dv.getUint16(at, true),
      id: d[at + 4],
      type: d[at + 8],
      race: d[at + 9],
      team: d[at + 10],
      name: text(at + 11, 25),
      color: color >= 0 && color < COLORS.length ? hex(COLORS[color]) : "#9aa4b2",
    });
  }
  return { header, slots };
}

/* ── Commands ───────────────────────────────────────────── */

/** Game commands that carry nothing after the type byte: carrier and reaver stop, stim, merge archon … */
const EMPTY = new Set([0x1b, 0x1c, 0x1d, 0x27, 0x2a, 0x36, 0x5a]);
/** Cancels that name nothing: build, morph, nuke, tech, upgrade, addon. */
const CANCELS = new Set([0x18, 0x19, 0x2e, 0x31, 0x33, 0x34]);
/** Lobby and session commands with no payload: keep-alive, pause, resume, start game … */
const SESSION = new Set([0x05, 0x08, 0x10, 0x11, 0x38, 0x39, 0x3c, 0x54, 0x5b]);
/** Types whose payload Aftermath skips, by length. */
const SKIP: Record<number, number> = {
  0x37: 6, 0x3a: 1, 0x3b: 1, 0x3d: 1, 0x3e: 5, 0x3f: 7, 0x40: 17, 0x41: 2, 0x42: 1, 0x43: 1,
  0x44: 2, 0x45: 2, 0x48: 12, 0x56: 9, 0x55: 1,
};
/** Types that are one "queued" byte: stop, burrow, return cargo, hold, unload all, siege, cloak … */
const QUEUEABLE = new Set([0x1a, 0x1e, 0x21, 0x22, 0x25, 0x26, 0x28, 0x2b, 0x2c, 0x2d]);

/** The order a Build command carries when it is really a Terran building landing. */
const ORDER_LAND = 0x47;

export function readCommands(d: Uint8Array): { commands: Command[]; unknown: number } {
  const commands: Command[] = [];
  let unknown = 0;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let p = 0;
  const u8 = () => d[p++];
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };

  while (p + 5 <= d.length) {
    const frame = u32();
    const end = Math.min(d.length, p + 1 + d[p]);
    p++;
    while (p + 2 <= end) {
      const player = u8();
      const type = u8();
      const at = { frame, player, type };
      try {
        switch (type) {
          case 0x14: case 0x60: { // right click (1.21 adds a word after the tag)
            const x = u16(), y = u16();
            u16(); if (type === 0x60) u16();
            commands.push({ ...at, kind: "rightClick", x, y, unit: u16(), queued: u8() !== 0 });
            break;
          }
          case 0x15: case 0x61: { // targeted order
            const x = u16(), y = u16();
            u16(); if (type === 0x61) u16();
            const unit = u16(), order = u8();
            commands.push({ ...at, kind: "targeted", x, y, unit, order, queued: u8() !== 0 });
            break;
          }
          case 0x09: case 0x0a: case 0x0b: case 0x63: case 0x64: case 0x65: {
            const n = u8();
            const tags: number[] = [];
            for (let i = 0; i < n; i++) { tags.push(u16()); if (type >= 0x63) u16(); }
            commands.push({ ...at, kind: "select", tags });
            break;
          }
          case 0x13: { const kind = u8(); commands.push({ ...at, kind: "hotkey", value: u8(), order: kind }); break; }
          case 0x1f: commands.push({ ...at, kind: "train", unit: u16() }); break;
          case 0x23: commands.push({ ...at, kind: "morph", unit: u16() }); break;
          case 0x35: commands.push({ ...at, kind: "buildingMorph", unit: u16() }); break;
          case 0x0c: {
            const order = u8(), x = u16(), y = u16(), unit = u16();
            commands.push({ ...at, kind: order === ORDER_LAND ? "land" : "build", order, x, y, unit });
            break;
          }
          case 0x2f: { const x = u16(), y = u16(); commands.push({ ...at, kind: "liftOff", x, y }); break; }
          case 0x30: commands.push({ ...at, kind: "tech", value: u8() }); break;
          case 0x32: commands.push({ ...at, kind: "upgrade", value: u8() }); break;
          case 0x20: u16(); commands.push({ ...at, kind: "cancel" }); break;
          case 0x29: u16(); commands.push({ ...at, kind: "simple" }); break;
          case 0x62: u16(); u16(); commands.push({ ...at, kind: "simple" }); break;
          case 0x57: commands.push({ ...at, kind: "leave", value: u8() }); break;
          case 0x58: { const x = u16(), y = u16(); commands.push({ ...at, kind: "ping", x, y }); break; }
          case 0x5c: {
            const sender = u8();
            const text = cString(d.subarray(p, p + 80));
            p += 80;
            commands.push({ ...at, player: sender, kind: "chat", text });
            break;
          }
          case 0x0d: commands.push({ ...at, kind: "vision", value: u16() }); break;
          case 0x0e: commands.push({ ...at, kind: "alliance", value: u32() }); break;
          case 0x0f: u8(); commands.push({ ...at, kind: "system" }); break;
          case 0x12: u32(); commands.push({ ...at, kind: "system" }); break;
          case 0x06: case 0x07: p += u32(); commands.push({ ...at, kind: "system" }); break;
          default:
            if (QUEUEABLE.has(type)) commands.push({ ...at, kind: "simple", queued: u8() !== 0 });
            else if (EMPTY.has(type)) commands.push({ ...at, kind: "simple" });
            else if (CANCELS.has(type)) commands.push({ ...at, kind: "cancel" });
            else if (SESSION.has(type)) commands.push({ ...at, kind: "system" });
            else if (type in SKIP) { p += SKIP[type]; commands.push({ ...at, kind: "system" }); }
            else { unknown++; p = end; }
        }
      } catch {
        // A block that runs off the data: keep what was read.
        unknown++;
        p = end;
      }
    }
    p = end;
  }
  return { commands, unknown };
}

/* ── The whole file ─────────────────────────────────────── */

const tag = (s: string) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
/** Remastered's tagged sections and their unpacked sizes. */
const TAGGED: Record<number, number> = {
  [tag("SKIN")]: 0x15e0, [tag("LMTS")]: 0x1c, [tag("BFIX")]: 0x08, [tag("CCLR")]: 0xc0, [tag("GCFG")]: 0x19,
};

export async function parseReplay(bytes: Uint8Array, unzip: Inflate = inflate): Promise<Replay> {
  const format = detectFormat(bytes);
  if (!format) throw new ReplayError("This is not a StarCraft replay.");
  const r = new Reader(bytes);

  const id = await section(r, 4, format, unzip);
  if (format === "1.21") r.u32();
  const { header, slots } = readHeader(await section(r, 0x279, format, unzip), format);
  const { commands, unknown } = readCommands(await sized(r, format, unzip));
  const chk = await sized(r, format, unzip);
  void id;

  if (format !== "legacy") {
    // Remastered: the full-length player names, then tagged sections. A damaged or
    // unfamiliar tail costs only what it would have added.
    try {
      const names = await section(r, 0x300, format, unzip);
      slots.forEach((s, i) => {
        if (s.type === 0 || (i + 1) * 96 > names.length) return;
        const name = cString(names.subarray(i * 96, (i + 1) * 96));
        if (name) s.name = name;
      });
      while (r.left >= 8) {
        const kind = r.u32();
        const raw = r.u32();
        const start = r.pos;
        const size = TAGGED[kind];
        if (size && kind === tag("CCLR")) {
          const colors = await section(r, size, format, unzip);
          const dv = new DataView(colors.buffer, colors.byteOffset, colors.byteLength);
          slots.forEach((s, i) => {
            if ((i + 1) * 16 > colors.length) return;
            const c = [0, 4, 8].map((o) => Math.round(Math.min(1, Math.max(0, dv.getFloat32(i * 16 + o, true))) * 255));
            if (dv.getFloat32(i * 16 + 12, true) > 0) s.color = hex((c[0] << 16) | (c[1] << 8) | c[2]);
          });
        }
        r.pos = start + raw;
      }
    } catch { /* optional sections */ }
  }

  const players = slots.filter((s) => s.name !== "" && s.type !== 0);
  // A two-player melee game often has both on team 0; they are opponents.
  if ((header.gameType === 2 || header.gameType === 4) && players.length === 2 && players[0].team === players[1].team) {
    players[0].team = 1;
    players[1].team = 2;
  }
  if (header.gameType === 3) players.forEach((p, i) => { p.team = i + 1; });
  return { format, header, players, commands, unknownCommands: unknown, chk };
}
