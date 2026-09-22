/**
 * The little Aftermath needs from the map inside a replay: its size, tileset and tiles,
 * to tell whether the map open in the editor is the one the game was played on.
 */

export interface ChkInfo {
  width: number;
  height: number;
  /** `ERA & 7`. */
  tileset: number;
  /** MTXM, row-major; empty when the section is missing. */
  tiles: Uint16Array;
}

/** Sections in file order; a later copy of a section overrides an earlier one, as the game reads them. */
export function readChk(chk: Uint8Array): ChkInfo {
  const dv = new DataView(chk.buffer, chk.byteOffset, chk.byteLength);
  const found = new Map<string, Uint8Array>();
  for (let p = 0; p + 8 <= chk.length;) {
    const name = String.fromCharCode(chk[p], chk[p + 1], chk[p + 2], chk[p + 3]);
    const len = dv.getInt32(p + 4, true);
    const start = p + 8;
    if (len < 0) break; // a protection trick; the maps games are played on read without it
    found.set(name, chk.subarray(start, Math.min(chk.length, start + len)));
    p = start + len;
  }
  const dim = found.get("DIM ");
  const width = dim && dim.length >= 4 ? dim[0] | (dim[1] << 8) : 0;
  const height = dim && dim.length >= 4 ? dim[2] | (dim[3] << 8) : 0;
  const era = found.get("ERA ");
  const mtxm = found.get("MTXM");
  const tiles = new Uint16Array(width * height);
  if (mtxm) for (let i = 0; i < tiles.length && i * 2 + 1 < mtxm.length; i++) tiles[i] = mtxm[i * 2] | (mtxm[i * 2 + 1] << 8);
  return { width, height, tileset: era && era.length ? era[0] & 7 : 0, tiles };
}

/**
 * How much of the terrain two maps share, 0…1: 0 when their size or tileset differ. A
 * map maker's working copy, edited since the game, still scores high.
 */
export function likeness(a: ChkInfo, b: { width: number; height: number; tileset: number; tiles: Uint16Array }): number {
  if (a.width !== b.width || a.height !== b.height || a.tileset !== b.tileset || a.tiles.length === 0) return 0;
  let same = 0;
  const n = Math.min(a.tiles.length, b.tiles.length);
  for (let i = 0; i < n; i++) if (a.tiles[i] === b.tiles[i]) same++;
  return n ? same / n : 0;
}

/** Map text without StarCraft's colour and formatting bytes. */
export function plainText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}
