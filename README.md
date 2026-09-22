# Aftermath

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It opens StarCraft replays and shows, on the map the game was played
on, what the players did: where buildings went down and when, where units were sent, heat
maps of the orders, each player's build order and actions per minute, and the chat, on a
timeline you can scrub or play.

It is meant for map makers. On a melee map you can see which paths and chokes players use,
where and when they expand, and whether one start location plays differently from another.
On a UMS map you can see where players spent their time and which parts of the map nobody
went to.

## What a replay can and cannot tell you

A replay does not record where units were. It records the orders each player gave, when
they gave them, and the map; the game re-runs itself from those to play the replay back.
Aftermath reads the orders without re-running the game, so it shows what players asked for:

- a building appears where and when a player ordered it, whether or not it was finished,
  cancelled or killed on the way;
- a unit in the build order was ordered, not necessarily made;
- the heat maps count where players clicked, not where units ended up or where they died.

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-aftermath
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-aftermath@v0.1.0`.

## Use

**File ▸ Open Replay…** picks one or more `.rep` files; you can also drop them on the
Aftermath panel. Replays from every version of the game are read: from before 1.18, from
1.18 to 1.20, and from 1.21 on.

The replay carries a copy of the map. When the map in front is the one the game was played
on (the same size and tileset and at least nine tenths of the same terrain, so a copy you
have edited since still counts), Aftermath draws over it. Otherwise it opens the replay's
copy in a new tab. **View ▸ Aftermath** brings the panel back after you close it.

The panel, from the top:

- **Which replay**, when several are loaded, **Open Replay…**, **Close**, which closes the
  replay and leaves the map open, and **Dock** / **Float**: the panel floats over the map
  at first; **Dock** moves it into the right-hand column beside the map, and it stays
  there next time.
- **The game**: its type, length, date and the game version that wrote it.
- **The timeline**: **Play** / **Pause**, a slider, and the speed. 1× is the game's own
  speed at Fastest.
- **The players**: colour, name, race, actions per minute over the time they were in the
  game, and when they left. Untick a player to hide them on the map.
- **Actions per minute** through the game, one line per player. Click it to go to that
  moment.
- **Show**:
  - **Buildings**: every building ordered up to the timeline, in the player's colour, with
    a ring around the ones ordered in the last few seconds.
  - **Recent orders**: where units were sent in the last eight seconds. A dot is a move, a
    cross an attack or patrol, a ring an ability, a flag a rally point, and a widening
    circle a minimap ping.
  - **Heat**: all orders, moves, attacks, buildings or minimap pings, counted up to the
    timeline or over the **Whole game**. With several replays of the same map loaded,
    **All N replays of this map** adds them together. One game says little about a map;
    twenty say more.
- **Build order**: one player's buildings, units, upgrades and research in order. Workers
  are left out unless you tick **Workers**, and orders for the same unit next to each other
  are joined (`Zergling ×12` is twelve presses of the button, not necessarily twelve
  Zerglings). Town halls are in bold. Click a line to go to that moment and, for a
  building, to the place.
- **Chat**, when there was any. Click a line to go to that moment.

The overlay is listed under **View ▸ Overlays** and in the Layers panel, and switches off
there like any other. Aftermath never changes the map.

## Development

```sh
npm install
npm test          # the reader, the analysis and the map comparison
npm run typecheck
npm run build     # dist/plugin.js, the bundle the editor loads
```

The tests write their own replays in all three formats (`tests/writer.ts`), so nobody's
games are in the repository. Put real replays in `fixtures/` (gitignored) and the tests read
each of them as well.

| File | What it is |
| --- | --- |
| `replay.ts` | Reads a `.rep`: the sections, the header, every command and the map. |
| `analysis.ts` | Per-player build orders, placements, clicks and actions per minute; the heat grid. |
| `chk.ts` | The map's size, tileset and tiles, and whether two maps are the same one. |
| `plugin.ts` | The panel, the playback clock and the overlay. |

The reader follows the replay format as [screp](https://github.com/icza/screp) (Apache-2.0)
documents it in code. Sections from before 1.18 are unpacked with
[mopaq](https://www.npmjs.com/package/mopaq)'s PKWARE decoder.

## Licence

MIT.
