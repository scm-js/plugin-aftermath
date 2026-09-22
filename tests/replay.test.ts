import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyse, buildOrderRows, clickKind, formatTime, heat } from "../analysis";
import { likeness, plainText, readChk } from "../chk";
import { cString, detectFormat, parseReplay, ReplayError, type ReplayFormat } from "../replay";
import { chk, cmds, le16, writeReplay } from "./writer";

const players = [
  { index: 0, id: 0, race: 1, name: "Alpha", color: 0 },
  { index: 1, id: 1, race: 0, name: "Beta", color: 1 },
];

/** One of each command Aftermath reads, in the classic encodings. */
const classic = cmds([
  [10, 0, 0x09, 2, ...le16(5), ...le16(6)],                                  // select two
  [12, 0, 0x14, ...le16(640), ...le16(320), ...le16(0), ...le16(228), 0],     // right click on ground
  [20, 0, 0x15, ...le16(100), ...le16(200), ...le16(0), ...le16(228), 0x0e, 1], // attack-move, queued
  [30, 0, 0x0c, 0x1e, ...le16(10), ...le16(12), ...le16(109)],                // build a Supply Depot at (10, 12)
  [40, 0, 0x0c, 0x1e, ...le16(10), ...le16(12), ...le16(109)],                //   the same again: folds
  [50, 0, 0x1f, ...le16(7)],                                                   // train an SCV
  [51, 0, 0x1f, ...le16(7)],                                                   //   and another: folds
  [60, 1, 0x23, ...le16(37)],                                                  // morph a Zergling
  [70, 1, 0x32, 3],                                                            // upgrade 3
  [80, 1, 0x30, 5],                                                            // tech 5
  [90, 1, 0x58, ...le16(1000), ...le16(1100)],                                 // minimap ping
  [95, 1, 0x13, 0, 4],                                                         // hotkey
  [96, 1, 0x37, 1, 2, 3, 4, 5, 6],                                             // sync: skipped by length
  [100, 1, 0x5c, 1, ...new TextEncoder().encode("gg"), ...new Array(78).fill(0)], // chat from slot 1
  [110, 1, 0x57, 1],                                                           // leave
]);

describe.each<ReplayFormat>(["legacy", "1.18", "1.21"])("a %s replay", (format) => {
  const bytes = writeReplay({ format, frames: 120, players, commands: classic, chk: chk(64, 64, 4), mapName: "\u0007Test \u0006Map" });

  it("is recognised", () => {
    expect(detectFormat(bytes)).toBe(format);
  });

  it("reads the header, the players and the map", async () => {
    const r = await parseReplay(bytes);
    expect(r.format).toBe(format);
    expect(r.header.frames).toBe(120);
    expect(r.header.gameType).toBe(2);
    expect(r.header.started?.getTime()).toBe(1_700_000_000_000);
    expect(plainText(r.header.mapName)).toBe("Test Map");
    expect(r.players.map((p) => [p.name, p.race, p.color])).toEqual([["Alpha", 1, "#f40404"], ["Beta", 0, "#0c48cc"]]);
    // Two melee players on one team are opponents.
    expect(r.players.map((p) => p.team)).toEqual([1, 2]);
    const map = readChk(r.chk);
    expect([map.width, map.height, map.tileset]).toEqual([64, 64, 4]);
  });

  it("reads every command", async () => {
    const r = await parseReplay(bytes);
    expect(r.unknownCommands).toBe(0);
    expect(r.commands.map((c) => c.kind)).toEqual([
      "select", "rightClick", "targeted", "build", "build", "train", "train", "morph", "upgrade", "tech", "ping", "hotkey", "system", "chat", "leave",
    ]);
    expect(r.commands[0].tags).toEqual([5, 6]);
    expect(r.commands[1]).toMatchObject({ x: 640, y: 320, unit: 228, queued: false });
    expect(r.commands[2]).toMatchObject({ x: 100, y: 200, order: 0x0e, queued: true });
    expect(r.commands[3]).toMatchObject({ x: 10, y: 12, unit: 109 });
    expect(r.commands[13]).toMatchObject({ player: 1, text: "gg" });
  });
});

describe("Remastered extras", () => {
  it("takes full names and CCLR colours, and steps over sections it does not know", async () => {
    const bytes = writeReplay({
      format: "1.21", players, commands: cmds([]), chk: chk(64, 64),
      names: { 0: "A much longer name than the header holds" },
      cclr: { 1: [1, 0.5, 0] },
    });
    const r = await parseReplay(bytes);
    expect(r.players[0].name).toBe("A much longer name than the header holds");
    expect(r.players[1].color).toBe("#ff8000");
  });

  it("reads the 1.21 commands, which carry an extra word", async () => {
    const commands = cmds([
      [5, 0, 0x60, ...le16(64), ...le16(96), ...le16(0), ...le16(0), ...le16(228), 0],
      [6, 0, 0x61, ...le16(64), ...le16(96), ...le16(0), ...le16(0), ...le16(228), 0x98, 0],
      [7, 0, 0x63, 1, ...le16(9), ...le16(0)],
      [8, 0, 0x62, ...le16(9), ...le16(0)],
    ]);
    const r = await parseReplay(writeReplay({ format: "1.21", players, commands, chk: chk(64, 64) }));
    expect(r.unknownCommands).toBe(0);
    expect(r.commands.map((c) => c.kind)).toEqual(["rightClick", "targeted", "select", "simple"]);
    expect(r.commands[1]).toMatchObject({ x: 64, y: 96, order: 0x98 });
    expect(clickKind(r.commands[1])).toBe("patrol");
    expect(r.commands[2].tags).toEqual([9]);
  });

  it("skips the rest of a frame block after a command it does not know, and keeps going", async () => {
    const commands = cmds([
      [5, 0, 0xee, 1, 2, 3],
      [6, 0, 0x1f, ...le16(7)],
    ]);
    const r = await parseReplay(writeReplay({ format: "1.18", players, commands, chk: chk(64, 64) }));
    expect(r.unknownCommands).toBe(1);
    expect(r.commands.map((c) => c.kind)).toEqual(["train"]);
  });
});

describe("files that are not replays", () => {
  it("are refused with a reason", async () => {
    await expect(parseReplay(new Uint8Array(100))).rejects.toBeInstanceOf(ReplayError);
    const cut = writeReplay({ format: "1.21", players, commands: classic, chk: chk(64, 64) }).subarray(0, 200);
    await expect(parseReplay(cut)).rejects.toBeInstanceOf(ReplayError);
  });
});

describe("analysis", () => {
  it("folds repeats, counts actions and notes who left", async () => {
    const r = analyse(await parseReplay(writeReplay({ format: "1.21", frames: 120, players, commands: classic, chk: chk(64, 64) })));
    const [a, b] = r.players;
    expect(a.placements).toHaveLength(1);
    expect(a.placements[0]).toMatchObject({ unit: 109, tx: 10, ty: 12, repeats: 2, frame: 30, last: 40 });
    expect(a.build.map((s) => [s.kind, s.id, s.count])).toEqual([["build", 109, 1], ["train", 7, 2]]);
    expect(b.build.map((s) => [s.kind, s.id])).toEqual([["morph", 37], ["upgrade", 3], ["tech", 5]]);
    expect(a.clicks.map((c) => c.kind)).toEqual(["move", "attack"]);
    expect(b.clicks.map((c) => c.kind)).toEqual(["ping"]);
    expect(a.actions).toBe(7);
    expect(b.leftAt).toBe(110);
    expect(a.leftAt).toBeNull();
    expect(r.chat).toEqual([{ frame: 100, player: 1, text: "gg" }]);
  });

  it("counts clicks into a heat grid, up to a frame when asked", () => {
    const clicks = [
      { frame: 1, player: 0, x: 40, y: 40, kind: "move" as const },
      { frame: 2, player: 0, x: 40, y: 40, kind: "attack" as const },
      { frame: 50, player: 0, x: 900, y: 900, kind: "move" as const },
    ];
    const all = heat(clicks, 32, 32);
    const early = heat(clicks, 32, 32, { until: 10 });
    const moves = heat(clicks, 32, 32, { kinds: new Set(["move"]) });
    const cell = (g: typeof all, px: number, py: number) => g.values[Math.floor(py / 32) * g.width + Math.floor(px / 32)];
    expect(cell(all, 40, 40)).toBeGreaterThan(cell(moves, 40, 40));
    expect(cell(early, 900, 900)).toBe(0);
    expect(cell(all, 900, 900)).toBeGreaterThan(0);
  });

  it("writes times as a game clock at Fastest", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(24)).toBe("0:01");
    expect(formatTime(30979)).toBe("21:41");
    expect(formatTime(100_000)).toBe("1:10:00");
  });
});

describe("maps", () => {
  it("are the same when size, tileset and nearly all tiles agree", () => {
    const a = readChk(chk(64, 64, 4, 1));
    expect(likeness(a, readChk(chk(64, 64, 4, 1)))).toBe(1);
    expect(likeness(a, readChk(chk(64, 64, 4, 2)))).toBe(0);
    expect(likeness(a, readChk(chk(64, 64, 3, 1)))).toBe(0);
    expect(likeness(a, readChk(chk(96, 64, 4, 1)))).toBe(0);
    const edited = readChk(chk(64, 64, 4, 1));
    edited.tiles.fill(9, 0, 64 * 3);
    expect(likeness(a, edited)).toBeGreaterThan(0.9);
  });
});

// Real replays, when there are some in fixtures/ (gitignored: nobody's games are committed).
const dir = new URL("../fixtures/", import.meta.url);
const reps = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".rep")) : [];
if (reps.length) {
  describe("replays in fixtures/", () => {
    it.each(reps)("%s reads through with every command known", async (name) => {
      const r = await parseReplay(new Uint8Array(readFileSync(new URL(name, dir))));
      expect(r.unknownCommands).toBe(0);
      expect(r.players.length).toBeGreaterThan(0);
      const map = readChk(r.chk);
      expect(map.width * map.height).toBeGreaterThan(0);
      const report = analyse(r);
      for (const p of report.players) {
        for (const pl of p.placements) {
          expect(pl.tx).toBeLessThan(map.width);
          expect(pl.ty).toBeLessThan(map.height);
        }
      }
    });
  });
}

describe("text from before Remastered", () => {
  it("is UTF-8, else Korean when it reads as Korean, else Western", () => {
    const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0x41]);
    expect(cString(bytes(0x54, 0xc3, 0xab))).toBe("Të");
    expect(cString(bytes(0xc5, 0xf5, 0xc8, 0xa5))).toBe("투혼");
    // 0xEB 0x6E is not a Korean pair, so this is windows-1252's "rën".
    expect(cString(bytes(0x72, 0xeb, 0x6e))).toBe("rën");
  });
});

describe("the build order list", () => {
  const steps = [
    { frame: 1, kind: "train" as const, id: 64, count: 3 },
    { frame: 5, kind: "train" as const, id: 65, count: 1 },
    { frame: 9, kind: "train" as const, id: 64, count: 2 },
    { frame: 12, kind: "train" as const, id: 65, count: 2 },
    { frame: 20, kind: "build" as const, id: 156, count: 1, placement: { frame: 20, last: 20, player: 0, unit: 156, tx: 1, ty: 1, landed: false, repeats: 1 } },
    { frame: 21, kind: "build" as const, id: 156, count: 1, placement: { frame: 21, last: 21, player: 0, unit: 156, tx: 4, ty: 1, landed: false, repeats: 1 } },
  ];

  it("leaves workers out and joins what they separated", () => {
    expect(buildOrderRows(steps).map((s) => [s.id, s.count, s.frame])).toEqual([[65, 3, 5], [156, 1, 20], [156, 1, 21]]);
  });

  it("keeps workers when asked", () => {
    expect(buildOrderRows(steps, { workers: true }).map((s) => [s.id, s.count])).toEqual([[64, 3], [65, 1], [64, 2], [65, 2], [156, 1], [156, 1]]);
  });
});
