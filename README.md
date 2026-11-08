# Aftermath

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It opens StarCraft replays and shows what the players did on the map
the game was played on. You see where buildings went down and when, where units were sent,
heat maps of the orders, each player's build order and actions per minute, and the chat.
A timeline under the map plays the game back.

It is meant for map makers. On a melee map you can see which paths and chokes players use,
where and when they expand, and whether one start location plays differently from another.
On a UMS map you can see where players spent their time and which parts of the map nobody
went to.

In the editor at [scmjs.dev/editor](https://scmjs.dev/editor/), Aftermath also plays each
replay through with the game's own code. That shows the game itself in the map's place, and
what really happened in it: units where they stood, what was built and lost, the fights,
and each player's economy and tech. See [Analysis](#analysis).

## Install

Aftermath comes with the editor and starts on. If you removed it, open
**Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-aftermath
```

and press **Add**. To pin a version, add a tag: `github:scm-js/plugin-aftermath@v0.16.0`.
Aftermath needs the [scm-sim](https://github.com/scm-js/plugin-scm-sim) plugin, and the editor
installs it alongside.

## Use

**File ▸ Open Replay…** picks one or more `.rep` files. You can also drop replays anywhere
on the editor, or pick one in **File ▸ Open…**. Replays from every version of the game are
read: from before 1.18, from 1.18 to 1.20, and from 1.21 on.

Each replay opens the map it was played on in a tab of its own, marked with an eye. The map
is there to look at and can't be changed or saved. **File ▸ Edit a Copy** opens a copy you
can change. Switching tabs switches replays, each keeping its own place on the timeline.
Closing the tab closes the replay. With an ordinary map in front, Aftermath's panels go
away. **View ▸ Aftermath** opens the panel anyway, to drop replays on.

### The replay and the map

In the editor at scmjs.dev, with the game's files installed on the Game Data page, a
replay's tab opens on the **Replay**. This is the game played by its own code in the map's
place, with its own graphics. Blizzard's free map editor download is enough. You get
Remastered's graphics when your copy is Remastered and **View ▸ Remastered Graphics** is
ticked, and the classic ones otherwise.

The switch in the top-left corner goes between the **Replay** and the **Map**. The Map is
the overhead view with Aftermath's marks, heat maps and Map stats. Each opens where the
other was looking, at the same scale. Map stats is drawn on the Map, so opening it
switches there, and closing it goes back to the game.

The timeline drives whichever is shown, and follows the game. Once the game is analysed, a
jump anywhere takes about a second. A jump past the point the analysis has reached plays
the game forward to it, with a spinner over the game.

While the Replay is shown:

- The arrow keys scroll the game, as in the game itself. The other keys stay Aftermath's.
- The editor's minimap shows the game's units as the game's minimap would. Press or drag on
  it to move the game's camera.
- View ▸ Zoom In, Zoom Out, Zoom to Fit, the toolbar's magnifiers and Ctrl with the mouse
  wheel zoom the game (the wheel alone, if the editor's preferences say the wheel zooms).
  The game can show from half to four times as much of the map as the game itself does.
  A replay first opens at the game's own scale, on the first player's start.
- The editor's grid, locations and other plugins' overlays are drawn over the game, under
  Aftermath's own marks. View ▸ Grid and Locations turn them on and off.
- View ▸ Fog of War is the game's fog. On, the game is seen through the eyes chosen in the
  **Vision** menu (the first player at first). Off, through everyone's.
- Pointing at a unit or building shows what the game's console would: name, owner, hit
  points, shields, energy, and what it is doing, with a progress bar and the training queue
  for a building at work. It covers every player's units, but only what the chosen eyes
  can see.
- **Orders** draws the recent orders on the game, and **Legend** keys them.

One game is shown at a time. Switching to another replay's tab starts that one.

### The timeline

The strip under the map has:

- **Play** / **Pause**, the time, and the speed. 1× is the game's own speed at Fastest.
- Four switches, lit while on: **Spectate**, **Orders**, **Map stats** and **Legend**
  (a key to the marks, in the map's bottom-left corner).
- The **Vision** menu: everyone, or one player's eyes.
- How the analysis is going.
- **Play From Here**, **Analysis**, **Cast…** and **Cinematic**, where they apply.
- A menu for the graph: actions per minute, or once the game is analysed, the army lead (in
  a game of two), army value, army size, workers, supply, minerals or gas in the bank, or
  buildings.
- A lane of marks along the game: fights in red (taller the more they mattered, the turning
  point in gold), chat in grey, and a player leaving in their colour. The graph is under it.

Point at the lane or the graph for the moment: each player's number on the graph and how it
moved in the last ten seconds, their supply, workers, army and bank, and what happened
nearby. Press or drag to go to that moment. Drag the strip's top edge to make it taller.

Keys, while the replay's tab is in front:

| Key | Does |
| --- | --- |
| Space | Play and pause |
| ← / → | Ten seconds back or on (a minute with Shift) |
| N / Shift+N | Next and previous key moment |
| F | Spectate on or off |
| O | Orders on or off |
| Home / End | The start and the end |

### The panel

The right-hand column has the game (map name, game type, length, date and the game version
that wrote it) and the players. Each player's line shows colour, name, race and actions per
minute, with supply once the game is analysed, or when they left. Click a player to hide
them on the map and the graph, and again to bring them back.

It has five tabs:

- **Game**, once the game is analysed. See [Analysis](#analysis).
- **Build**: one player's buildings, units, upgrades and research in order. Workers are left
  out unless you tick **Workers**. Orders for the same unit next to each other are joined:
  `Zergling ×12` is twelve presses of the button, and may be fewer Zerglings. Town halls are
  in bold. Click a line to go to that moment and, for a building, to the place.
- **Fights**, once the game is analysed, with **Most kills** at the end.
- **Chat**, when there was any. Click a line to go to that moment.
- **Map stats**: every replay of this map you have open, taken together. See
  [Map stats](#map-stats-many-replays-of-one-map).

### Replays of mods

A replay of a game played with a mod, saved by scmJS's play page, says which mod it was.
The panel then shows "Replay of a mod" with the mod's name and its hash, a link to its
makers, and the plugins that ran.

A mod gives the game's unit numbers to its own units, so the replay is named only by the
mod: until the editor draws with the mod's files, units, upgrades and technologies show by
number, never by the game's names. **Attach the Mod's Folder…** asks for the mod's folder
(the one holding its `arr`, `unit` and other game folders, or a folder above it), checks
that it is the mod the replay names, and has the editor draw with it for the session.
Names, costs and pictures then come from the mod. A folder of another version is refused,
with both hashes.

The check is the mod's hash as the play page and `scmjs mod info` work it out: one line
for each of the folder's game files, each plugin it carries (`.qdp`, `.bwl`) and its
FireGraft project (`.fgp`), never compared with your copy of the game; a replay of a game
that ran none of the plugins names the hash without them, which is taken too, as are the
older forms a replay saved before November 2026 names. Only the folder's loose files are
read: archives in it (an `.mpq`, the mod's `.exe`) are not, so a mod that keeps its files
in one is refused here, and the message says so. Pick the folder of loose files.

With the scm-sim plugin 0.16.0 or later, **Play From Here** opens a mod's replay on the play
page with the mod's hash, name and link (never its files). The page plays it with that mod
when the browser keeps it, switching to it first if it plays another; otherwise it names the
mod and asks for its folder, with the makers' link, and plays the replay once the folder is
dropped. A copy of the mod of another version is refused. A replay saved by the play page
names its mod itself, and the page reads that first.

A mod whose code ran in the game (its plugins, as Cosmonarchy's do, or its FireGraft
project's changes to the game's program) plays only on a play page that runs it: one whose
address has `?lift=live`. With the scm-sim plugin 0.17.0, Play From Here opens the page that
way for such a replay, and the play page also reloads itself with `?lift=live` when it is
handed one without it.

With the scm-sim plugin 0.17.0 and a play page that knows a mod's replays, the Replay view
plays a mod's replay with its mod too: the view loads with the mod the replay names (from the
copy the browser keeps), and with `?lift=live` when its code ran. With older ones the tab of a
mod's replay shows the map only.

The analysis (the Game and Fights tabs, Analysis, Cast) does not play a mod's replay yet: it
plays replays with the game's own files. What is shown is the players' orders. A mod may send
commands of its own, which the game does not have; the panel counts their command blocks, and
they are left out of the analysis. The Build tab's choice of workers and town halls goes by
the game's own unit numbers, which a mod may give other units.

### On the map

Marks are in the player's colour. Before analysis, the map shows every building ordered up
to the moment on the timeline, and the recent orders. A new building has a thick edge.

**Orders** adds where units were sent in the last eight seconds. A diamond is a move, a
cross an attack or patrol, a ring an ability, a flag a rally point, and a widening double
ring a minimap ping.

**Spectate** is on unless you turn it off. Once the game is analysed, the camera follows the
action the way an observer would. It looks at fights that matter (from a few seconds
before), two armies about to meet, a new base going down, and otherwise each player's main
army in turn. Early on it looks at the players' main bases. It pans to nearby action and
cuts to anything further than a screen or so away. A line at the top of the map says what
the camera shows. Scroll the map, or go to a place from the panel, and the camera lets go.
Press **F** or the switch to follow again. Going to a fight, or **N** and **Shift+N**, keeps
it following. With a player chosen in **Vision**, Spectate
follows that player's game.

The overlay has its own tick in the **View** menu and a row in the Layers panel. Aftermath
never changes a map.

## Analysis

This part works only in the editor at scmjs.dev, where the scm-sim engine runs beside it. In
the desktop app and an editor hosted elsewhere, Aftermath works from the players' orders
alone.

A replay does not record where units were. It records the orders each player gave and when,
and the game runs again from those. Without analysis, Aftermath shows what players asked
for:

- a building appears where and when a player ordered it, even if it was cancelled or killed
  before it finished;
- a unit in the build order was ordered, and may never have been made;
- the heat maps count where players clicked.

At scmjs.dev, every replay you open is also played through in the background. It needs the
game's files on the Game Data page, and takes about fifteen seconds for a twenty-minute
game. Several replays are analysed one after another, and the timeline says how far it has
got. You can watch the replay meanwhile. The replay stays in your browser.

Once a game is analysed:

- On the map, buildings are the ones standing at that moment. A site is drawn fainter, with
  a dashed edge, until it is finished. Units are dots where they stood, with workers smaller
  and fainter. A small cross marks a loss, and a thin line runs for a moment from a unit to
  what it just killed.
- **Build** lists what each player really started, when it finished, and when it was lost.
  A Zerg unit is dated from its egg. A line struck through never finished.
- The players show their supply as the timeline moves.
- In a game of two, the graph opens on the **army lead**: one army less the other, filled in
  the colour of whoever is ahead, with the key fights shaded behind it.
- Map stats gains three heat maps: where units were lost, where the armies were, and the
  ground no unit ever entered.

The orders, the heat maps of orders and the chat stay as they were.

### The Game tab

A replay opens on this tab once it is analysed. It has:

- who won, and how the game ended;
- **Who led**: a bar the length of the game in the colour of whoever was ahead in army, and
  how long and by how much each was ahead. Click it to go there.
- **In numbers**: each player's largest army, most workers, bases, what they lost and killed
  (by cost), and actions per minute;
- **How it went**: the key fights, the bases taken and who left, in order. Click a line to go
  to that moment and place.

### Fights

Losses close together in time and place are one fight. Each fight is weighed against
everything the players had at that moment, armies and workers included. Four Zerglings lost
in passing count for little. A fight that cost a player half of everything counts for a lot.
The **Fights** tab groups them:

- **Key moments**: the fights that mattered most, about one per six minutes played (three
  to eight). Every decisive fight is among them.
  - **Turning point**: after this fight, the player ahead in army stayed ahead to the end.
    Games of two only.
  - **Decisive**: one side lost at least two fifths of everything it had, and the other came
    out clearly ahead.
  - **Even trade**: both lost about as much.
- **Other fights**: the rest of the fights that mattered.
- **Skirmishes**, folded away: the small ones.
- **Most kills**: the units that killed the most. Click one to go to its first kill.

Each fight says what it was (a battle, workers killed, or buildings destroyed), where it was
as a clock face, and what each side lost. The side that came out ahead is in bold. Hover a
side for what it had there, lost and killed. Click a fight to go to its moment and place,
or press **N** and **Shift+N**. While a fight goes on, a dashed box on the map follows where
things are falling. Two High or Dark Templar merging into an Archon are not counted as a loss.

A kill is the game's own credit, so a Reaver gets its Scarabs' kills and a Carrier its
Interceptors'. What a Spider Mine kills is credited to nobody. When several units fall in
the same instant, the pairing of killer and victim is the likeliest one.

**Each key moment played again.** Once every open replay is analysed, the engine plays each
game's key moments again, from just before the losses start, in two versions:

- as it was played;
- with both sides only attack-moving to where the fight happened. Nobody gives any other
  order anywhere. Production already queued finishes and walks to its rally point, and
  nothing new is started.

Under each key moment, *As played → attack-move only* gives each side's losses in both
versions, by cost. It counts every unit that came into the fight at any time, wherever it
stood at the start. Hover a line for how many units took part and what they were worth.
Only the busiest 45 seconds of a fight are played again. The attack-move number is what the
game does when nobody micros. Losing more as played can be on purpose, for example when a
player pulls back or trades units for time.

### The Analysis window

**Analysis** in the timeline strip, or **View ▸ Replay Analysis**, opens a large window
beside the replay. It can be resized, and the button in its title (or a double-click on the
title) makes it fill the map's area. Every chart follows the replay's clock. Point at one
for the numbers, and press or drag to go to that moment. The window needs an editor newer
than scmJS 0.7.3.

The **Economy** tab:

- A card for each player: average income a minute, average unspent, and how long and how
  often they were supply blocked. In a game of two, a sentence compares the players.
- A chart of **Income**, **Unspent** or **Workers** over the game, with **Both**,
  **Minerals** or **Gas** for the first two. Under it, a lane per player marks when they
  were at their supply limit (below 200).
- **Bases and mining**, folded: for each base a player mined from, how many mineral workers
  were there minute by minute. Two a field mine at the full rate.
- **All the numbers**, folded: mined, income, unspent, supply blocked and most workers, as a
  table.

Income needs a game engine from October 2026 or later. With an older one, the rest is shown
without it.

The **Tech** tab:

- A card for each player: the furthest tier they reached and when, how many upgrade levels
  and technologies they finished, and their tech buildings in order, as the game's icons.
  In a game of two, a sentence compares the players. Tier timings are compared only between
  players of the same race.
- A chart with a lane per player: a bar for the first of each tech building, from site to
  finish, and a bar for each upgrade level and technology, from start to done. Point at a
  bar for its times, or between bars for what each player had under way.
- **Army over the game**, folded: how many of each unit each player had at the end of every
  minute. Workers and Overlords are left out, and a sieged tank counts as a tank.
- **All the timings**, folded: every tech building and research, with when each player had
  it. The earlier of two is marked.

A research bar can end up to two seconds late, because the engine samples the game every
two seconds. The icons need game data installed on or after October 15 2026. With older
data, the cards name the buildings and the army shows each unit's picture, until you install
the game data again (**Help ▸ Game Data…**).

The **Scouting** tab shows what each player knew of their opponents (the players on another
team). The game decides what was seen: fog hides a unit, and a cloaked or burrowed unit is
seen only when detected. A unit at the edge of the screen counts the same as one in the
middle. The tab needs a game engine from October 2026 or later.

- A card for each player: how much of the opponents' army they had in sight on average, by
  cost; when they first saw an opponent's building; and how many of the opponents'
  buildings they never saw. A sentence says who saw more of the other's army.
- A chart of that share over the game, averaged over the half minute around each moment.
- **Seen and answered**: for the opponents' cloaked units (Dark Templar, Lurkers, Arbiters)
  and air units, it gives when the opponents first had one (or the building that makes
  them), when the player first saw one, and the first answer the player started after
  that. The answer is detection against cloaked units and anti-air against air units. Each
  answer says whether it was started before or after seeing the threat. One the player had
  before the threat existed, such as an opening cannon, shows as *already had*.
- **Scouts and what they found**: each of the opponents' units and buildings a player saw,
  credited to the player's unit that saw it first. A scout's worth is the cost of what
  it showed first. An SCV that walks into the main and sees a Gateway, a Cybernetics Core
  and an Assimilator is worth 425. For each player, the six scouts worth the most, with what
  they found and when. Buildings are left out. The best scout is also on the player's card.
  The game does not record which unit saw what, so the credit goes to the unit nearest to
  having the thing in sight.
- **Unseen the longest**, folded: the opponents' town halls, production and tech buildings
  that stood longest before each player saw them. A hidden expansion shows up here.

Press a time in either table to go there.

### The map as a player knew it

Once the game is analysed, choose a player in the **Vision** menu while the Map is shown. The
opponents are drawn as that player knew them at that moment:

- What the player could see then is drawn as usual.
- A building seen earlier is drawn faint with a short-dashed edge, as it was when last seen.
  It stays until the player sees it go.
- A unit seen in the last half minute is a ring where it was last seen, fading with time.
- What was there that the player did not know of is drawn very faintly: a dotted outline
  for a building, a small pale dot for a unit.

A line at the top of the map says whose map it is, and **Legend** keys the marks. Choose
*everyone* to see the game as it was.

### Map stats: many replays of one map

**Map stats** takes every replay you have open of one map together, and shows what they say
about the map. It is a tab of the right-hand column and a switch under the map. Once you have
more than one replay of the map open, the switch shows how many.

To fill it, open several replays of a map:

- Drop or pick them all at once. Aftermath asks whether to open one tab of the map with the
  rest in its Map stats, or a tab for each.
- Or press **Add replays of this map…** in Map stats. Replays added there get no tab.
  Replays of another map open in their own tabs.

The **Games** list shows every replay of the map: its length, players, and whether it is
counted, waiting, being analysed, failed or left out. Untick one to leave it out. **Watch**
opens it in a tab. Replays without a tab go when the last tab of their map closes.

Places are named as on a clock face, with their tile:

- **Start**: how many players started at each location, and how many of them won. The
  winner is the one player who never left, or else the only one with a building standing at
  the end. A game where that can't be told is left out of the count.
- **Base**: every mineral line other than a player's start where a town hall was finished
  or a Command Center landed. A hall with no mineral field within eight tiles is not a base,
  and a second hall at a line a player already had is not a new one. It shows in how many
  games the base was taken, about when (the middle game's time), and which base it usually
  was for the player who took it.
- **Fights**: places where fights happened more than once, how many and in how many games,
  and how often the player who started nearer came out ahead.
- The share of the map's ground no unit ever entered. Pick **Ground never entered** as the
  heat map to shade it in red. Water and cliffs are part of it.

While Map stats is open, the map shows it. A white ring at each start says how its players
did ("won 1 of 2"). A green ring at each base says how often it was taken ("taken 3 of 4").
A red circle marks where the fights that mattered were. Click a line to go to its place. The
heat map is chosen in Map stats: losses, armies, orders, buildings, or ground never entered.
The camera stays where you put it, and the timeline is faded. **Map stats**, **Spectate**,
**Play**, a press on the timeline or going to a fight brings the game back.

Different versions of a map count as the same map when nine tenths of the terrain agree.
Without analysis, Map stats has only the heat maps of orders and of buildings ordered.

### Cast: the game with commentary

With the scmjs.dev plugin signed in to an account the server offers casts to, an analysed
replay has a **Cast…** button on the timeline. A cast is the game as a broadcast: the camera
on the action, with a play-by-play caster and an analyst talking over it. The scmjs.dev AI
writes what they say from what the engine measured, and the server reads it aloud where it
has voices set up. The lines are shown as captions too. The commentators know only the
measured facts. They don't see micro or spells, and say nothing about the players beyond
their play.

**Cast…** opens a window with the choices:

- **Format**: **Whole game**, at normal speed with no cuts, or **Key moments**, each key
  fight from a little before to a little after, with cuts between them (about a third of
  the length and the price).
- **Banter**: how much the two talk about other things when little is happening.
- **Voices**: **Voiced** or **Captions only**.
- **Cards**: when the commentators mention an upgrade, unit or building, a card shows it
  with how far along it is.
- **Notes** for the commentators, such as a language or what to talk about more.

**Make cast** starts it.

The window says how long the cast will be, what it will likely cost from the account's
balance, and how long it takes to make. You can close the window while it is made. The
timeline says when it is ready.

Casts are kept in this browser with their voices, so watching one again costs nothing. When
you open a replay again, the timeline offers its newest cast as **Watch cast**, and the
window lists the others. Past 30 casts or 300 MB, the ones watched longest ago are deleted.
While a cast plays, pausing pauses the voices, and going elsewhere on the timeline ends it.

### Play From Here

With the scm-sim plugin 0.15.0 or later, **Play From Here** on the timeline opens the replay on
the site's play page at the moment shown, seen as the player chosen in the **Vision** menu (the
first player when it says everyone). The play page stops there with its Watch Replay menu
open. From there you take one of the players and play on alone, against a community bot, or
with others who join by an invite. Going back to an earlier moment in the play page watches
the replay again.

### Cinematic view

Where the game itself is shown, **Cinematic** on the timeline takes it full screen without
the editor. It has a broadcast bar with each player's supply, workers, army and the clock, a
title card, and the minimap (press or drag on it to look there). Move the pointer for the
controls: play and pause, the speed, **Follow**, **Minimap**, and the cast. The music is
the game's own, for one of the races in the game. Esc leaves.

With a cast made for the replay, **Watch cast** starts it inside the view, at normal speed
with the camera following the action. It adds larger
captions, a banner when a key fight begins, the cards and the winner at the end. **Stop
cast** ends it and stays in the view.

### Replays that can't be analysed

Replays from 1.18 and Remastered are rewritten in 1.16.1's form first, since the engine is
1.16.1's game. Two kinds of Remastered game cannot be analysed, and Aftermath says which:

- a game on a map that uses Remastered's added terrain, unless your copy of StarCraft on the
  site was made from a Remastered installation;
- a game that held more than 1,700 units at once.

As the game is played, every order is checked against it. An order for a unit that has not
been made yet means the game has drifted from the one recorded. Aftermath then shows the
moment, and leaves the game out of Map stats.

## Development

```sh
npm install
npm test          # the reader, the analysis and the map comparison
npm run typecheck
npm run build     # dist/plugin.js, the bundle the editor loads
```

The tests write their own replays in all three formats (`@scm-js/replay/write`), so
nobody's games are in the repository. Put real replays in `fixtures/` (gitignored) and the tests read
each of them as well.

| File | What it is |
| --- | --- |
| `analysis.ts` | Per-player build orders, placements, clicks and actions per minute; the heat grid. |
| `chk.ts` | The map's size, tileset and tiles, and whether two maps are the same one. |
| `played.ts`, `fights.ts`, `story.ts` | What the engine's timeline says happened: units, losses, fights, the Game tab. |
| `report.ts` | Map stats across many games. |
| `director.ts`, `camera.ts` | Spectate's camera. |
| `gameview.ts` | The Replay view, through scm-sim's `view`. |
| `insight.ts`, `economy.ts`, `tech.ts`, `techview.ts`, `knew.ts`, `scoutview.ts`, `charts.ts` | The Analysis window. |
| `cast.ts`, `castmake.ts`, `castplay.ts` | Casts. |
| `ko.ts` | The Korean catalogue. |
| `plugin.ts` | The tabs, the panels, the playback clock and the overlay. |

Replays are read by [@scm-js/replay](https://github.com/scm-js/replay), which began as
this plugin's own reader and is now shared with the `scmjs` command line. Its own tests
are there.

## Licence

MIT.
