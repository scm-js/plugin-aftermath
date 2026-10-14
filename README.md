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

## Playing the game through

In the editor at scmjs.dev, Aftermath can do more: **Play the game through** runs the whole
game out of sight in the site's game engine and shows what happened. It needs your own copy
of StarCraft given to the site (the Game Data page), and takes about fifteen seconds for a
twenty-minute game. The replay stays in your browser.

Afterwards the panel shows what happened instead of what was ordered:

- **Buildings** are the ones that stood at the moment on the timeline. A site is drawn
  fainter with a dashed edge until it is finished, and a building that was cancelled or
  destroyed goes when it did.
- **Units** draws every unit where it stood, moving as the timeline plays; workers are
  smaller. A small cross marks where something was just lost.
- **What was made** replaces the build order: everything a player really started, when it
  was finished, and when it was lost. A Zerg unit is dated from its egg. A line struck
  through never finished.
- **The players** table adds what each lost: how many units and buildings, and what they
  cost.
- **The graph** can show army value, army size, workers, supply, minerals or gas in the
  bank, or buildings, in place of actions per minute.
- Two more **heat maps**: where the armies were (workers left out) and where units were
  lost.

- **Fights**: losses close together in time and place are one fight. Each line gives when
  it began and what each side lost, with the side that came out ahead in bold; hover a
  name for what that side had there, lost and killed. Click a line to go to the moment and
  the place. The fights are also marked in red along the bottom of the graph.
- **Most kills**: the units that killed the most. Click one to go to its first kill.
- On the map, a thin line runs for a moment from a unit to what it just killed.

Recent orders, the order heat maps and the chat stay as they are.

A kill is the game's own credit, so a Reaver gets its Scarab's kills and a Carrier its
Interceptors'. What a Spider Mine kills is credited to nobody. When several units fall in
the same instant, which killer goes with which victim is the likeliest pairing, not a
certain one.

### Many replays of one map

Load several replays and **Play all N through** runs them one after another. With **All N
replays of this map** ticked, the heat maps then add every game together: where armies
went across all of them, and where units were lost. One game says little about a map;
twenty show which paths and chokes are used and where the fighting happens.

The button is only there where the editor has the engine beside it, which is scmjs.dev. In
the desktop app and an editor hosted elsewhere, Aftermath works from the orders alone.
Replays written by StarCraft 1.16.1 are what the engine has been run on; replays from 1.18
and later, StarCraft: Remastered included, have not been tried yet and may not play.

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
  there next time. The same choice is on the plugin's page in **Edit ▸ Preferences ▸
  Plugins ▸ Aftermath**.
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
