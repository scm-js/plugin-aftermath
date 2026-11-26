/**
 * The Analysis window's Macro tab: the rhythm of each player's production. A card a player with what most tells
 * (time with no worker in training, or with larvae waiting at a full hatchery; production buildings idle with money
 * there; the most left unspent), a sentence or two, one chart of every building that makes things, when it made
 * something and when it stood idle with money, and the longest gaps in a table, each with what it cost about.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { formatTime } from "./analysis";
import { IDLE_COLOUR, ProductionChart, type ChartHost, type ProductionGroup, type ProductionRow } from "./charts";
import { icons } from "./icons";
import { covered, macro, merged, SHORT_AT, type Gap, type Lane, type Macro, type MacroData, type PlayerMacro } from "./macro";
import { KINDS } from "./roles";
import type { ReplayTimeline } from "./vendor/scm-sim";

/** What the tab needs of the window. */
export interface MacroContext {
  api: PluginApi;
  t: (text: string, params?: Record<string, string | number>) => string;
  host: ChartHost;
  timeline: ReplayTimeline;
  /** The players shown, by slot, in the window's order. */
  players: { slot: number; name: string; color: string; leftAt: number | null }[];
  seek(frame: number): void;
  chart(c: ProductionChart): void;
  keep(d: { dispose(): void }): void;
}

/** The game's data as `macro` asks for it; null without it. */
export function macroData(api: PluginApi): MacroData | null {
  const units = api.data.units();
  if (!units) return null;
  return {
    buildTime: (type) => units.buildTime[type] ?? null,
    cost: (type) => ({ minerals: units.mineralCost[type] ?? 0, gas: units.vespeneCost[type] ?? 0 }),
    // units.dat's special ability flags: bit 1 is an add-on.
    addon: (type) => ((units.flags[type] ?? 0) & 2) !== 0,
  };
}

/** Each timeline's production rhythm, with the kinds it was worked out with (`KINDS.revision`). */
const kept = new WeakMap<ReplayTimeline, { revision: number; macro: Macro }>();

/** The production rhythm of every player in `timeline`; null without the game's data. Kept, so the side panel and the window share it. */
export function macroOf(api: PluginApi, timeline: ReplayTimeline, leftAt: ReadonlyMap<number, number | null>): Macro | null {
  const was = kept.get(timeline);
  if (was && was.revision === KINDS.revision) return was.macro;
  const data = macroData(api);
  if (!data) return null;
  const players = timeline.samples.players.filter((s) => s.supplyMax.some((n) => n > 0)).map((s) => s.slot);
  const m = macro(timeline, players, data, leftAt);
  kept.set(timeline, { revision: KINDS.revision, macro: m });
  return m;
}

/** A name where room is short: the game names most things after their race ("Protoss Gateway"), which the colour says already. */
const short = (name: string) => name.replace(/^(Terran|Zerg|Protoss) (?=\S)/, "");

export function mountMacro(body: HTMLElement, cx: MacroContext): void {
  const { api, t, timeline: tl } = cx;
  const el = api.ui.el, w = api.ui.widgets;
  const m = macroOf(api, tl, new Map(cx.players.map((p) => [p.slot, p.leftAt])));
  if (!m) { body.append(el("p", { className: "afm-dim afm-it-note" }, t("The Macro tab needs the game's data (what units cost and how long they take), which this editor does not have."))); return; }
  const data = macroData(api)!;
  const shown = cx.players.filter((p) => m.players.some((x) => x.slot === p.slot));
  const of = (slot: number) => m.players.find((p) => p.slot === slot)!;
  const nameOfType = (type: number) => short(api.names.unit(type));
  const swatch = (color: string) => el("span", { className: "afm-tip-swatch", style: `background:${color}` });
  const { picture, icon, watch } = icons(api);
  const until = formatTime(m.until);

  // A name for each lane: its building, and a number where the player had several ("Gateway 2").
  const laneNames = new Map<Lane, string>();
  for (const p of m.players) {
    const seen = new Map<number, number>();
    for (const l of p.lanes) {
      const n = (seen.get(l.type) ?? 0) + 1;
      seen.set(l.type, n);
      laneNames.set(l, n > 1 ? `${nameOfType(l.type)} ${n}` : nameOfType(l.type));
    }
  }
  const workerOf = (p: PlayerMacro) => p.lanes.find((l) => l.kind === "workers")?.makes ?? null;

  // The cards.
  const cards = el("div", { className: "afm-it-cards" }, ...shown.map((sp) => {
    const p = of(sp.slot);
    const worker = workerOf(p);
    const hero = p.noWorker !== null
      ? [formatTime(p.noWorker), t("no {worker} in training", { worker: worker === null ? t("worker") : nameOfType(worker) })]
      : p.larvaeWaiting !== null
        ? [formatTime(p.larvaeWaiting), t("larvae waiting at a full hatchery")]
        : ["–", t("no workers or larvae made")];
    const line = (value: string, text: string) => el("div", { className: "afm-it-card-line" }, el("b", {}, value), " ", el("span", { className: "afm-dim" }, text));
    const lines: HTMLElement[] = [];
    if (p.workersShort !== null && p.workersShort > 0) lines.push(line(t("about {n}", { n: p.workersShort }), t("workers short at {time}", { time: formatTime(SHORT_AT) })));
    if (p.lanes.some((l) => l.kind === "units")) lines.push(line(formatTime(p.productionIdle), t("production idle with money")));
    lines.push(line(Math.round(p.peakBank.value).toLocaleString(), t("unspent at the most, {time}", { time: formatTime(p.peakBank.frame) })));
    return el("div", { className: "afm-it-card", style: `border-top-color:${sp.color}` },
      el("div", { className: "afm-it-card-name" }, swatch(sp.color), el("span", { className: "afm-gt-name" }, sp.name)),
      el("div", { className: "afm-it-hero" }, hero[0]),
      el("div", { className: "afm-dim afm-it-card-line" }, hero[1]),
      ...lines);
  }));

  // A sentence a player: how often and how long the workers stopped, or the larvae waited.
  const said: string[] = [];
  for (const sp of shown) {
    const p = of(sp.slot);
    if (p.noWorker !== null) {
      const stops = merged(p.noWorkerSpans, 4 * 48).filter((s) => covered(p.noWorkerSpans, s.from, s.to) >= 240);
      if (!stops.length) { said.push(t("{name} kept a worker in training until {time}, but for moments.", { name: sp.name, time: until })); continue; }
      const longest = stops.reduce((a, b) => (covered(p.noWorkerSpans, b.from, b.to) > covered(p.noWorkerSpans, a.from, a.to) ? b : a));
      said.push(t("{name} stopped making workers {n, plural, one {once} other {# times}} for 10 seconds or more before {time}; the longest stop was {length} from {at}.",
        { name: sp.name, n: stops.length, time: until, length: formatTime(covered(p.noWorkerSpans, longest.from, longest.to)), at: formatTime(longest.from) }));
    } else if (p.larvaeWaiting !== null) {
      said.push(p.larvaeWaiting >= 240
        ? t("{name} had larvae waiting at a full hatchery, with money to spend, for {length} before {time}.", { name: sp.name, length: formatTime(p.larvaeWaiting), time: until })
        : t("{name} spent larvae as they came until {time}, but for moments.", { name: sp.name, time: until }));
    }
  }
  const verdict = said.length ? el("p", { className: "afm-it-verdict" }, said.join(" ")) : null;

  // The chart: every building that makes things, a group of rows a player.
  const rowLane = new Map<ProductionRow, Lane>();
  const groups: ProductionGroup[] = shown.map((sp) => ({
    slot: sp.slot, label: sp.name, color: sp.color,
    rows: of(sp.slot).lanes.map((l) => {
      const row: ProductionRow = { label: laneNames.get(l)!, icon: () => picture("unit", l.type, l.owner), from: l.from, to: l.to, busy: l.busy, idle: l.idle };
      rowLane.set(row, l);
      return row;
    }),
  }));
  const at = (spans: readonly { from: number; to: number }[], f: number) => spans.some((s) => s.from <= f && f < s.to);
  const chart: ProductionChart = new ProductionChart(cx.host, (f, pt) => {
    const hit = chart.rowAt(pt.offsetY);
    const head = el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(f)));
    if (!hit) return el("div", { className: "afm-gt" }, head, el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
    const lane = rowLane.get(hit.row)!;
    const state = f < lane.from || f >= lane.to ? t("not standing then")
      : at(lane.busy, f) ? (lane.kind === "larvae" ? t("making larvae") : t("making something"))
      : at(lane.idle, f) ? (lane.kind === "larvae" ? t("full of larvae, with money to spend") : t("idle, with money for a unit"))
      : lane.kind === "larvae" ? t("full of larvae, without the money or the supply") : t("idle, without the money or the supply");
    return el("div", { className: "afm-gt" }, head,
      el("div", { className: "afm-it-row" }, icon("unit", lane.type, { title: hit.row.label, wait: false, owner: lane.owner }), swatch(hit.group.color), el("span", { className: "afm-gt-name" }, hit.row.label)),
      el("div", {}, state),
      el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
  }, t("Production over the game"));
  chart.set(groups, tl.frames);
  cx.chart(chart);
  const legend = el("div", { className: "afm-it-controls afm-dim afm-it-about" },
    el("span", { className: "afm-ti-key" }, el("span", { className: "afm-mc-key afm-mc-busy" }), t("making something (a hatchery: making larvae)")),
    el("span", { className: "afm-ti-key" }, el("span", { className: "afm-mc-key afm-mc-idle", style: `border-color:${IDLE_COLOUR}` }), t("idle, with money for something it makes (a hatchery: full of larvae)")));
  const chartSection = el("section", { className: "afm-it-section" },
    el("h3", { className: "afm-sc-h" }, t("Production over the game")), legend,
    el("div", { className: "afm-it-chart" }, chart.element),
    el("p", { className: "afm-dim afm-it-note" }, t("A building counts from when it is finished. It is idle only while its owner could pay for something it makes and had the supply for it; supply blocks are on the Economy tab. A town hall's idle time is shown to {time}: later, a player with workers enough stops on purpose.", { time: until })));

  // The longest gaps.
  const what = (g: Gap) => {
    const name = nameOfType(g.type);
    if (g.kind === "workers") { const wk = workerOf(of(g.player)); return t("No {worker} in training", { worker: wk === null ? t("worker") : nameOfType(wk) }); }
    if (g.kind === "larvae") return t("Larvae waiting at {building}", { building: g.lane ? laneNames.get(g.lane)! : name });
    return g.count > 1 ? t("{n} × {building} idle", { n: g.count, building: name }) : t("{building} idle", { building: g.lane ? laneNames.get(g.lane)! : name });
  };
  const cost = (g: Gap) => {
    const p = of(g.player);
    const made = g.kind === "workers" ? workerOf(p) : g.lane?.makes ?? null;
    if (g.kind === "larvae") return t("{n} unspent at the most", { n: Math.round(g.bank).toLocaleString() });
    const time = made === null ? null : data.buildTime(made);
    if (made === null || !time) return "–";
    const n = Math.floor((g.frames / time) * g.count);
    return n >= 1 ? t("about {n} × {unit}", { n, unit: nameOfType(made) }) : t("less than one {unit}", { unit: nameOfType(made) });
  };
  const bySlot = new Map(shown.map((p) => [p.slot, p]));
  const gapRows = m.gaps.filter((g) => bySlot.has(g.player)).map((g) => {
    const sp = bySlot.get(g.player)!;
    const row = el("tr", { className: "afm-mc-gap", title: t("Go to the time") },
      el("td", {}, formatTime(g.from)),
      el("td", {}, el("span", { className: "afm-it-row" }, swatch(sp.color), icon("unit", g.kind === "workers" ? (workerOf(of(g.player)) ?? g.type) : g.type, { title: nameOfType(g.type), small: true, owner: g.player }), what(g))),
      el("td", {}, formatTime(g.frames)),
      el("td", { className: "afm-dim" }, cost(g)));
    row.addEventListener("click", () => cx.seek(g.from));
    return row;
  });
  const gapSection = el("section", { className: "afm-it-section" },
    el("h3", { className: "afm-sc-h" }, t("The longest gaps")),
    gapRows.length
      ? el("table", { className: "afm-it-table afm-sc-table afm-mc-table" },
        el("thead", {}, el("tr", {}, el("th", { scope: "col" }, t("When")), el("th", { scope: "col" }, t("What")), el("th", { scope: "col" }, t("How long")), el("th", { scope: "col" }, t("What it cost, about")))),
        el("tbody", {}, ...gapRows))
      : el("p", { className: "afm-dim afm-it-note" }, t("No gap of 10 seconds or more.")),
    el("p", { className: "afm-dim afm-it-note" }, t("Idle moments less than 8 seconds apart are one gap. A building is listed only for a gap it was used again after; one left standing to the end shows on the chart. The cost is the gap over what the building made most, at its build time.")));

  const how = w.fold({ text: t("How this is measured"), open: false });
  how.body.append(el("p", { className: "afm-dim afm-it-note" }, t("The game records each unit the frame its training begins, at the middle of the building training it, so what each building made, and when, is exact. A Terran building that lifts off and lands elsewhere is followed by what it trains there. Larvae count for the hatchery they appear beside; a hatchery is full at {n}. Money and supply are read every two seconds.", { n: m.larvaCap })));

  const cardsNote = el("p", { className: "afm-dim afm-it-note" }, t("The cards count the first {time}. Workers short: the time with no worker in training over a worker's build time, as one hall would have made them. Production idle: each production building's idle time with money there, added up.", { time: until }));
  body.append(cards, cardsNote, ...(verdict ? [verdict] : []), chartSection, gapSection, how);
  chart.draw();
  const watching = watch(() => chart.draw());
  if (watching) cx.keep(watching);
}
