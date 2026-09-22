/**
 * A replay writer for the tests: builds a file in any of the three formats from a header,
 * a command stream and a map, so the reader is exercised without shipping anyone's games.
 */
import { deflateSync } from "node:zlib";
import { implode } from "mopaq";
import type { ReplayFormat } from "../replay";

export interface TestPlayer {
  index: number;
  id: number;
  type?: number;
  race?: number;
  team?: number;
  name: string;
  color?: number;
}

export interface TestReplay {
  format: ReplayFormat;
  frames?: number;
  gameType?: number;
  mapName?: string;
  players: TestPlayer[];
  /** The command section's bytes, as `cmds()` builds them. */
  commands: Uint8Array;
  chk: Uint8Array;
  /** Remastered only: full names by header index, and RGBA floats by index. */
  names?: Record<number, string>;
  cclr?: Record<number, [number, number, number]>;
}

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A framed section: checksum, chunk count, then each 8 KB chunk packed the format's way. */
function section(data: Uint8Array, format: ReplayFormat): Uint8Array {
  if (data.length === 0) return data; // an empty section is not written at all
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += 0x2000) {
    const raw = data.subarray(at, at + 0x2000);
    let packed: Uint8Array;
    if (format === "legacy") {
      packed = implode(raw);
      if (packed.length >= raw.length) packed = raw; // stored: its length is its size
    } else {
      packed = raw.length > 4 ? new Uint8Array(deflateSync(raw)) : raw;
    }
    chunks.push(u32(packed.length), packed);
  }
  return join([u32(0), u32(chunks.length / 2), ...chunks]);
}

const sized = (data: Uint8Array, format: ReplayFormat) => join([section(u32(data.length), format), section(data, format)]);

function text(target: Uint8Array, at: number, s: string, n: number): void {
  const b = new TextEncoder().encode(s).subarray(0, n - 1);
  target.set(b, at);
}

export function writeReplay(r: TestReplay): Uint8Array {
  const header = new Uint8Array(0x279);
  const dv = new DataView(header.buffer);
  header[0] = 1;
  dv.setUint32(0x01, r.frames ?? 1000, true);
  dv.setUint32(0x08, 1_700_000_000, true);
  text(header, 0x18, "test game", 28);
  dv.setUint16(0x34, 64, true);
  dv.setUint16(0x36, 64, true);
  header[0x3a] = 6;
  dv.setUint16(0x3c, r.gameType ?? 2, true);
  text(header, 0x48, "host", 24);
  text(header, 0x61, r.mapName ?? "Test Map", 26);
  for (const p of r.players) {
    const at = 0xa1 + p.index * 36;
    dv.setUint16(at, p.index, true);
    header[at + 4] = p.id;
    header[at + 8] = p.type ?? 2;
    header[at + 9] = p.race ?? 1;
    header[at + 10] = p.team ?? 0;
    text(header, at + 11, p.name, 25);
    if (p.index < 8) dv.setUint32(0x251 + p.index * 4, p.color ?? p.index, true);
  }

  const id = new TextEncoder().encode(r.format === "1.21" ? "seRS" : "reRS");
  const parts = [section(id, r.format)];
  if (r.format === "1.21") parts.push(u32(0));
  parts.push(section(header, r.format), sized(r.commands, r.format), sized(r.chk, r.format));
  if (r.format !== "legacy") {
    const names = new Uint8Array(0x300);
    for (const [i, name] of Object.entries(r.names ?? {})) text(names, Number(i) * 96, name, 96);
    parts.push(section(names, r.format));
    if (r.cclr) {
      const colors = new Uint8Array(0xc0);
      const cv = new DataView(colors.buffer);
      for (const [i, [cr, cg, cb]] of Object.entries(r.cclr)) {
        const at = Number(i) * 16;
        cv.setFloat32(at, cr, true); cv.setFloat32(at + 4, cg, true); cv.setFloat32(at + 8, cb, true); cv.setFloat32(at + 12, 1, true);
      }
      const body = section(colors, r.format);
      parts.push(u32(0x524c4343 /* "CCLR" */), u32(body.length), body);
    }
    // A section from some other tool, which the reader must step over.
    parts.push(u32(0x74616253 /* "Sbat" */), u32(3), new Uint8Array([1, 2, 3]));
  }
  return join(parts);
}

/** A command stream: `[frame, player, type, ...payload bytes]` per command, one frame block each. */
export function cmds(list: [frame: number, player: number, type: number, ...payload: number[]][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [frame, player, type, ...payload] of list) {
    const body = new Uint8Array([player, type, ...payload]);
    blocks.push(u32(frame), new Uint8Array([body.length]), body);
  }
  return join(blocks);
}

export const le16 = (n: number) => [n & 255, (n >> 8) & 255];

/** A bare CHK with DIM, ERA and MTXM filled with `tile`. */
export function chk(width: number, height: number, tileset = 0, tile = 1): Uint8Array {
  const section = (name: string, data: Uint8Array) => join([new TextEncoder().encode(name), u32(data.length), data]);
  const mtxm = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i++) { mtxm[i * 2] = tile & 255; mtxm[i * 2 + 1] = tile >> 8; }
  return join([
    section("VER ", new Uint8Array([206, 0])),
    section("DIM ", new Uint8Array([...le16(width), ...le16(height)])),
    section("ERA ", new Uint8Array([tileset, 0])),
    section("MTXM", mtxm),
  ]);
}
