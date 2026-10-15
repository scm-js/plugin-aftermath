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

## Analysing the game

In the editor at scmjs.dev, Aftermath does more: every replay you open is analysed. The
site's game engine plays the whole game through in the background, out of sight, to see
what happened. You can watch the replay while it does. It needs your own copy of StarCraft
given to the site (the Game Data page), and takes about fifteen seconds for a twenty-minute
game. Several replays are analysed one after another; the timeline says how far it has got.
The replay stays in your browser.

Afterwards Aftermath shows what happened instead of what was ordered:

- On the map, **buildings** are the ones that stood at the moment on the
  timeline. A site is drawn fainter with a dashed edge until it is finished, and a building
  that was cancelled or destroyed goes when it did. **Units** are dots where they stood,
  moving as the timeline plays; workers are smaller and fainter. A small cross marks where
  something was just lost.
- **Build** lists what was made instead of what was ordered: everything a player really
  started, when it was finished, and when it was lost. A Zerg unit is dated from its egg. A
  line struck through never finished.
- **The players** show their supply as the timeline moves.
- **The graph** can show army value, army size, workers, supply, minerals or gas in the
  bank, or buildings, in place of actions per minute. In a game of two it opens on the
  **army lead**: one army less the other, filled in the colour of whoever is ahead, with
  the key fights shaded behind it (the turning point in gold), so you can see what each
  fight did to the lead.
- **Game**, the tab a replay opens on:
  - who won, and how it ended;
  - **Who led**: a bar the length of the game in the colour of whoever was ahead in army,
    and how long each was ahead and by how much at most (click to go there);
  - **In numbers**: each player's largest army, most workers, bases, what they lost and
    killed (by cost), and actions per minute, a column per player under their colour;
  - **How it went**: the key fights, the bases taken and who left, in order. Click a line
    to go to the moment and the place.
- Three more **heat maps** in **Map stats**: where units were lost, where the armies
  were (workers left out), and the ground no unit ever entered.
- **Fights**: losses close together in time and place are one fight, and a fight that
  pauses and starts again nearby is still one. Each fight is weighed against everything
  the players had at that moment, armies and workers, so four Zerglings lost in passing
  count for little and a fight that cost a player half of everything counts for a lot.
  - **Key moments**: the fights that mattered most, about one for every six minutes
    played (at least three, at most eight). Every decisive fight is among them.
    **Turning point** marks the fight after which the player ahead in army stayed ahead
    to the end (games of two players only). **Decisive** means one side lost at least
    two fifths of everything it had while the other came out clearly ahead. **Even
    trade** means both lost about as much.
  - **Other fights**: the rest of the fights that mattered.
  - **Skirmishes**, folded away: the small ones.

  Each fight says what it was (a battle, workers killed, or buildings destroyed), where on
  the map as a clock face, and what each side lost, with the side that came out ahead in
  bold. Hover a side for what it had there, lost and killed. Click a fight to go to the
  moment and the place, or press **N** and **Shift+N** for the next and the previous key
  moment. While a fight goes on, a dashed box on the map follows where things are falling.
  Two High or Dark Templar merging into an Archon are not counted as a loss.
- **Most kills**: the units that killed the most. Click one to go to its first kill.
- On the map, a thin line runs for a moment from a unit to what it just killed.

The orders (the **Orders** switch), the heat maps of orders and the chat stay as they are.

A kill is the game's own credit, so a Reaver gets its Scarab's kills and a Carrier its
Interceptors'. What a Spider Mine kills is credited to nobody. When several units fall in
the same instant, which killer goes with which victim is the likeliest pairing, not a
certain one.

### Map stats: many replays of one map

One game says little about a map; twenty show which starts do well, which bases get taken
and when, and where the fighting happens. **Map stats** takes every replay you have open of
a map together and shows what they say about the map itself. It is a tab of the right-hand
column and a switch under the map; the switch says how many replays of the map you have
open once there is more than one.

To fill it, open several replays of a map:

- drop or pick them all at once, and Aftermath asks whether to open one tab of the map and
  put the rest in its Map stats, or open a tab for each;
- or press **Add replays of this map…** in Map stats. Replays added there get no tab of
  their own; replays of another map open in their own tabs.

The **Games** list at the top shows every replay of the map: its length, its players, and
whether it is counted, waiting, being analysed, could not be analysed, or left out. Untick
one to leave it out of everything Map stats shows; **Watch** opens it in a tab. Replays
without a tab go when the last tab of their map closes. When a second game of a map has
been analysed while you watch another, Aftermath says once that Map stats has something to
compare.

Everything in Map stats counts the same games, each whole: the lines, the rings on the map
and the heat map. Places are named as on a clock face, with their tile:

- **Start** lines: how many players started at each location and how many of them won.
  The winner is the one player who never left, or else the only one with a building
  standing at the end; a game where that cannot be told is left out of the count.
- **Base** lines: every mineral line other than a player's start where a Command Center,
  Hatchery or Nexus was finished, or a Command Center flown in and landed (when its Land
  order was given). A hall with no mineral field within eight tiles (a macro Hatchery, a
  proxy, a Command Center built to fly elsewhere) is not a base, and a second hall at a
  line a player already had is not a new one. In how many games it was taken, about when
  (the middle game's time), and which base it usually was for the player who took it. The
  **Game** tab's bases and Spectate's look at a new base count the same way.
- **Fights** lines: the places where fights happened in more than one instance, how many
  and in how many games, and how often the player who started nearer came out ahead. A
  place where the nearer player usually loses is hard to hold.
- The share of the map's ground no unit ever entered. Pick **Ground never entered** as the
  heat map to shade it in red. Water and cliffs are part of it, so read it for the
  walkable ground you expected to be used and was not.

While Map stats is open, the map shows it: a line at the top names the map and how many
games are taken together, a white ring at each start with how its
players did ("won 1 of 2"), a green ring at each base with the games it was taken in
("taken 3 of 4"), and a red circle where the fights that mattered were, with how many
(skirmishes are left out). Click a line to go to its place.

Different versions of a map count as the same map when nine tenths of the terrain agree.

The analysis only happens where the editor has the engine beside it, which is scmjs.dev. In
the desktop app and an editor hosted elsewhere, Aftermath works from the orders alone, and
Map stats has only the heat maps of the orders and of the buildings ordered.
Replays from every version play: one written by StarCraft 1.18 or Remastered is rewritten in
1.16.1's form first, since the engine is 1.16.1's game. Two kinds of Remastered game cannot be
analysed, and Aftermath says which when you try: a game on a map that uses Remastered's
added terrain, unless your copy of StarCraft on the site was made from a Remastered
installation, and a game that held more than 1,700 units at once.

A replay holds the players' orders and nothing to compare the game against. So while the game
is played, every order is checked against it: an order for a unit that has not been made yet
means the game on screen is no longer the one that was recorded. When that happens Aftermath
shows the moment, and leaves the game out of Map stats.

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-aftermath
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-aftermath@v0.1.0`.

## Use

**File ▸ Open Replay…** picks one or more `.rep` files. You can also drop replays anywhere
on the editor, or pick one in **File ▸ Open**. Replays from every version of the game are
read: from before 1.18, from 1.18 to 1.20, and from 1.21 on.

Each replay opens the map it was played on in a tab of its own, marked with an eye. The map
is there to look at: it can't be changed or saved (**File ▸ Edit a Copy** opens one you can
change). Switching tabs switches replays, each keeping its own place on the timeline, and
closing the tab closes the replay. With an ordinary map in front, Aftermath's panels go
away; **View ▸ Aftermath** opens the panel anyway, to drop replays on.

**The replay, or the map.** In the editor at scmjs.dev, with your copy of StarCraft given to
the site, a replay's tab opens on the **Replay**: the replay played out by the game's own code
in the map's place, with its own graphics: Remastered's when your copy is Remastered and **View ▸ Remastered Graphics** is ticked, the classic ones otherwise. The switch in the top-left corner goes between it and the **Map**, the
overhead view with Aftermath's marks, heat maps and Map stats. The timeline drives
whichever is shown: Play, the speed, a press on the timeline, the keys and Spectate's
camera all move the game while it is in front, and the timeline follows the game. Once the
game is analysed, a jump anywhere in it takes about a second: the analysis keeps moments of
the game as it goes, and the game starts from the nearest. A jump past where the analysis
has got to plays the game ahead, which takes longer; the game is seen moving on meanwhile,
with a spinner over it and the timeline saying how far it has got. The arrow keys scroll the game while it has the keyboard, as in the game;
the other keys stay Aftermath's. The game is shown without its console: the editor's
minimap shows the game's units as the game's own minimap would, its box is where the game
looks, and a press or a drag on it moves the game's camera there. Switching between the
replay and the map keeps your place: each opens where the other was looking, at the same
scale. The replay can show between half and twice as much of the map as the game itself
does, so a map zoomed further out or in than that opens the replay at the nearest it can.
Map stats shows on the map, so opening it switches to the
map, and closing it goes back to the game. One game is shown at a time: switching to
another replay's tab starts that one.

While a replay's tab is in front:

**Under the map**, the timeline:

- **Play** / **Pause**, the time, and the speed. 1× is the game's own speed at Fastest.
  **Space** plays and pauses, **←** and **→** go ten seconds back or on (a minute with
  **Shift**), **N** and **Shift+N** go to the next and the previous key moment, **F**
  follows the action or lets the camera go, **O** shows the orders, and **Home** and
  **End** go to the start and the end. These keys belong to the replay only while its tab
  is in front.
- Four switches, lit while they are on: **Spectate** (the camera follows the action, see
  below), **Orders** (the recent orders over the units drawn faintly), **Map stats** (every
  replay of the map together, see above) and **Legend** (a key to the marks in the map's
  bottom-left corner).
- How the analysis is going, or that it is done.
- The graph's menu: actions per minute, or, once the game is analysed, the army lead (in a
  game of two), army value, army size, workers, supply, minerals or gas in the bank, or
  buildings.
- A lane of marks along the game: fights in red, taller the more they mattered, with the
  turning point marked in gold; chat in grey; and a player leaving in their colour. Under
  it, the graph. Point at either to read the moment, what the graph says there and the
  fight there; press or drag to go to that moment. Drag the strip's top edge to make it
  taller.

**In the right-hand column**, the replay:

- **The game**: the map's name, the game type, length, date and the game version that wrote
  it.
- **The players**, a line each: colour, name, race, and their actions per minute (with
  supply once the game is analysed), or when they left. Click a player to hide them
  on the map and the graph, and again to bring them back.
- Five tabs:
  - **Game**, once the game is analysed (see above).
  - **Build**: one player's buildings, units, upgrades and research in order. Workers are
    left out unless you tick **Workers**, and orders for the same unit next to each other
    are joined (`Zergling ×12` is twelve presses of the button, not necessarily twelve
    Zerglings). Town halls are in bold. Click a line to go to that moment and, for a
    building, to the place.
  - **Fights** and **Most kills**, once the game is analysed.
  - **Chat**, when there was any. Click a line to go to that moment.
  - **Map stats**: every replay of this map you have open, taken together, shown on the
    map while the tab is open (see above and below).

**On the map**, the game at the moment on the timeline. Marks are in the player's colour:
every building ordered up to the timeline (or, once the game is analysed, the ones
standing), with a thick edge while it is new; the units, kills and losses once the game is
analysed, and a dashed box around a fight that matters while it goes on. Until the game is
analysed, the recent orders are shown too, since they are all there is.

**Spectate**, on unless you turn it off: once the game is analysed, the camera follows the
action the way an observer would. Aftermath works out where to look for the whole game: a
fight that matters (from a few seconds before it starts, held until it is over), two armies
about to meet, a new base going down, and otherwise each player's main army on the move,
taking turns; early on, before there are armies, it looks at the players' main bases in
turn. It moves the way an observer does, too. It holds still while the action stays near
the middle of the screen. It pans to something within reach, starting a moment before it
happens, and cuts to anything further than a screen or so away. It keeps a moving army a
little behind the middle, so you see where the army is heading. A pan takes the same time
to watch at any speed. In the Replay view the game moves its own camera along this path as
it draws, so the camera stays smooth and in step with the picture. A line at the top of the
map says what the camera shows. Scroll the map, or go to a
place from the panel, and the camera lets go (the switch goes dark); press **F** or the
switch and it follows again. Going to a fight, or **N** and **Shift+N**, keep it following.

**Orders** adds where units were sent in the last eight seconds, over the units drawn
faintly. A diamond is a move, a cross an attack or patrol, a ring an ability, a flag a
rally point, and a double ring, the outer one widening, a minimap ping.

**Map stats**: while it is open, the map shows every replay of the map together instead of
the game, and the camera stays where you put it. The timeline is faded, since it belongs to
one game. A heat map is chosen in Map stats: where units were lost, where the armies were,
where units were sent, where buildings went, or the ground never entered, over every game
counted. The **Map stats** switch, **Spectate**, **Play**, a press on the timeline, or going
to a fight brings the game back, on the tab you had open.

The overlay is listed under **View ▸ Overlays** and switches off there like any other.
Aftermath never changes a map.

An editor from before view-only maps opens the replay's map as an ordinary tab, and an
editor from before the strip under the map floats the timeline over the map instead.

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
| `plugin.ts` | The tabs, the two panels, the playback clock and the overlay. |

The reader follows the replay format as [screp](https://github.com/icza/screp) (Apache-2.0)
documents it in code. Sections from before 1.18 are unpacked with
[mopaq](https://www.npmjs.com/package/mopaq)'s PKWARE decoder.

## Licence

MIT.
