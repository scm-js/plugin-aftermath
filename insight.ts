/**
 * The Analysis window: a large panel beside the replay for reading a game at length, a tab a subject. Economy: what
 * each player mined and how fast, what they left unspent, their workers, when they were supply blocked, and how many
 * workers stood at each mineral line, minute by minute. Tech (`techview.ts`): the tier each reached, every tech
 * building and research from start to done, and the army they fielded. Every chart follows the replay's clock, and a
 * press on one goes there.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { formatTime, FRAMES_PER_MINUTE } from "./analysis";
import { GanttChart, LaneChart, LineChart, type ChartHost, type LineSeries } from "./charts";
import { economy, type Economy, type LineSaturation } from "./economy";
import type { MineralLines, UnitIndex } from "./played";
import { mountTech } from "./techview";
import type { ReplayTimeline } from "./vendor/scm-sim";

/** One played game, as the window reads it. */
export interface InsightGame {
  timeline: ReplayTimeline;
  lines: MineralLines;
  index: UnitIndex;
  /** The players by slot, observers among them (the economy leaves those out). */
  players: { slot: number; name: string; color: string; leftAt: number | null; hidden: boolean }[];
  map: { width: number; height: number };
}

export interface InsightDeps {
  api: PluginApi;
  t: (text: string, params?: Record<string, string | number>) => string;
  /** The replay's clock. */
  frame(): number;
  seek(frame: number): void;
  /** Where on the map, in words ("5 o'clock"). */
  placeOf(x: number, y: number, map: { width: number; height: number }): string;
  tooltip: ChartHost["tooltip"];
  /** The settings the window keeps (the tab, the resource shown). */
  settings: { tab: string; resource: Resource; metric: Metric };
  save(): void;
}

export type Resource = "both" | "minerals" | "gas";
/** What the economy's chart shows. */
export type Metric = "income" | "bank" | "workers";

const economies = new WeakMap<ReplayTimeline, Economy>();

export class InsightView implements ChartHost {
  private game: InsightGame | null = null;
  private charts: (LineChart | LaneChart | GanttChart)[] = [];
  private tips: { dispose(): void }[] = [];
  private readonly root: HTMLElement;

  private readonly deps: InsightDeps;

  constructor(body: HTMLElement, deps: InsightDeps) {
    this.deps = deps;
    this.root = deps.api.ui.el("div", { className: "afm-insight" });
    body.append(this.root);
  }

  /** What is shown, so asking again for the same leaves the window as it is (its scroll, the tab's state). */
  private shownKey = "";
  private shownTimeline: ReplayTimeline | null = null;

  /** Show `game`, or say why there is nothing to show. */
  show(game: InsightGame | null, why: string): void {
    const key = game ? game.players.filter((p) => p.hidden).map((p) => p.slot).join(",") : `none:${why}`;
    if (game?.timeline === this.shownTimeline && key === this.shownKey) return;
    this.shownKey = key;
    this.shownTimeline = game?.timeline ?? null;
    this.game = game;
    this.render(why);
  }

  /** The replay's clock moved. */
  update(): void {
    const now = this.deps.frame();
    for (const c of this.charts) c.setNow(now);
  }

  dispose(): void {
    for (const c of this.charts) c.dispose();
    for (const tip of this.tips) tip.dispose();
    this.charts = [];
    this.tips = [];
  }

  /* ── ChartHost ── */

  hover(frame: number | null): void { for (const c of this.charts) c.setHover(frame); }
  pick(frame: number): void { this.deps.seek(frame); }
  tooltip(target: HTMLElement, content: Parameters<ChartHost["tooltip"]>[1]) { return this.deps.tooltip(target, content); }

  private render(why: string): void {
    const { api, t, settings } = this.deps;
    const el = api.ui.el, w = api.ui.widgets;
    this.dispose();
    this.root.replaceChildren();
    if (!this.game) { this.root.append(el("div", { className: "afm-insight-empty" }, why)); return; }
    const tabs = w.tabs([
      { value: "economy", label: t("Economy"), mount: (body) => this.economy(body) },
      { value: "tech", label: t("Tech"), mount: (body) => this.tech(body) },
    ], { value: settings.tab, onChange: (tab) => { settings.tab = tab; this.deps.save(); } });
    tabs.classList.add("afm-insight-tabs");
    this.root.append(tabs);
    this.update();
  }

  /* ── Tech ── */

  private tech(body: HTMLElement): void {
    const game = this.game!;
    mountTech(body, {
      api: this.deps.api, t: this.deps.t, host: this, timeline: game.timeline,
      players: game.players.filter((p) => !p.hidden),
      seek: (f) => this.deps.seek(f),
      chart: (c) => { this.charts.push(c); c.setNow(this.deps.frame()); },
      keep: (d) => { this.tips.push(d); },
    });
  }

  /* ── Economy ── */

  /**
   * The economy, most telling first: a card a player with the three numbers that say most, a sentence comparing
   * them, then one chart at a time (income, unspent or workers) with the supply blocks under it on the same time,
   * and the mineral lines and the full table folded away below.
   */
  private economy(body: HTMLElement): void {
    const game = this.game!;
    const { api, t, settings } = this.deps;
    const el = api.ui.el, w = api.ui.widgets;
    let e = economies.get(game.timeline);
    if (!e) {
      e = economy(game.timeline, game.lines, game.index, new Map(game.players.map((p) => [p.slot, p.leftAt])));
      economies.set(game.timeline, e);
    }
    const eco = e;
    const tl = game.timeline, frames = tl.samples.frame, end = tl.frames;
    const bySlot = new Map(game.players.map((p) => [p.slot, p]));
    const shown = eco.players.filter((p) => !bySlot.get(p.slot)?.hidden);
    const series = (slot: number) => tl.samples.players.find((s) => s.slot === slot)!;
    const name = (slot: number) => bySlot.get(slot)?.name ?? "";
    const colour = (slot: number) => bySlot.get(slot)?.color ?? "#888";
    const number = (n: number) => Math.round(n).toLocaleString();
    const swatch = (slot: number) => el("span", { className: "afm-tip-swatch", style: `background:${colour(slot)}` });
    const resourceOf = (m: number, g: number) => (settings.resource === "minerals" ? m : settings.resource === "gas" ? g : m + g);
    if (!eco.exact && settings.metric === "income") settings.metric = "bank";

    // The cards: income, unspent and supply blocked, a player each, in the player's colour.
    const cards = el("div", { className: "afm-it-cards" }, ...shown.map((p) => el("div", { className: "afm-it-card", style: `border-top-color:${colour(p.slot)}` },
      el("div", { className: "afm-it-card-name" }, swatch(p.slot), el("span", { className: "afm-gt-name" }, name(p.slot))),
      el("div", { className: "afm-it-hero" }, p.averageIncome === null ? "–" : number(p.averageIncome), el("span", { className: "afm-it-unit" }, t("a minute"))),
      el("div", { className: "afm-dim afm-it-card-line" }, t("income, on average")),
      el("div", { className: "afm-it-card-line" }, el("b", {}, number(p.averageBank)), " ", el("span", { className: "afm-dim" }, t("unspent, on average"))),
      p.blockedFrames > 0
        ? el("div", { className: "afm-it-card-line" }, el("b", {}, formatTime(p.blockedFrames)), " ", el("span", { className: "afm-dim" }, t("supply blocked, {n, plural, one {# time} other {# times}}", { n: p.blocks.length })))
        : el("div", { className: "afm-it-card-line afm-dim" }, t("never supply blocked")),
    )));

    // One chart, chosen above it; the resource choice only where it means something.
    const metricItems = [
      { value: "income", label: t("Income"), disabled: !eco.exact },
      { value: "bank", label: t("Unspent") },
      { value: "workers", label: t("Workers") },
    ];
    const metric = w.segmented(metricItems, { value: settings.metric, onChange: (v) => { settings.metric = v as Metric; this.deps.save(); drawMain(); } });
    const resource = w.segmented([
      { value: "both", label: t("Both") }, { value: "minerals", label: t("Minerals") }, { value: "gas", label: t("Gas") },
    ], { value: settings.resource, title: t("Which resource the chart shows"), onChange: (v) => { settings.resource = v as Resource; this.deps.save(); drawMain(); } });
    const about = el("span", { className: "afm-dim afm-it-about" });

    const valueAt = (slot: number, i: number) => {
      const p = eco.players.find((x) => x.slot === slot)!, s = series(slot);
      if (settings.metric === "income") return p.income ? resourceOf(p.income.minerals[i], p.income.gas[i]) : 0;
      if (settings.metric === "bank") return resourceOf(s.minerals[i], s.gas[i]);
      return s.workers[i];
    };
    const metricTitle = () => (settings.metric === "income" ? t("Income a minute") : settings.metric === "bank" ? t("Unspent") : t("Workers"));
    const main = new LineChart(this, 200, (f) => {
      const i = Math.max(0, nearestSample(frames, f));
      return el("div", { className: "afm-gt" }, el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(frames[i])), el("span", { className: "afm-dim" }, metricTitle())),
        ...shown.map((p) => el("div", { className: "afm-it-row" }, swatch(p.slot), el("span", { className: "afm-gt-name" }, name(p.slot)), el("b", { className: "afm-gt-num" }, number(valueAt(p.slot, i))))),
        el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
    }, t("Economy over the game"));
    main.showAxis(false);
    const drawMain = () => {
      resource.hidden = settings.metric === "workers";
      about.textContent = settings.metric === "income" ? t("over the minute before each moment")
        : settings.metric === "bank" ? t("what was in the bank, not yet spent") : t("workers on the map and in buildings");
      main.set(shown.map((p): LineSeries => ({ label: name(p.slot), color: colour(p.slot), x: frames, y: frames.map((_, i) => valueAt(p.slot, i)) })), end);
    };

    // The supply blocks under it, on the same time.
    const blocks = new LaneChart(this, (f) => {
      const rows = shown.map((p) => {
        const b = p.blocks.find((x) => f >= x.from && f <= x.to);
        return b ? el("div", { className: "afm-it-row" }, swatch(p.slot), el("span", { className: "afm-gt-name" }, name(p.slot)),
          el("span", {}, t("blocked {time} from {at}", { time: formatTime(b.to - b.from), at: formatTime(b.from) }))) : null;
      }).filter((r) => r !== null);
      return el("div", { className: "afm-gt" }, el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(f)), el("span", { className: "afm-dim" }, t("Supply blocked"))),
        ...(rows.length ? rows : [el("div", { className: "afm-dim" }, t("Nobody blocked here"))]));
    }, t("Supply blocked"));
    blocks.set(shown.map((p) => ({ label: name(p.slot), color: colour(p.slot), spans: p.blocks })), end, "rgba(229,72,77,0.85)");

    this.charts.push(main, blocks);
    drawMain();

    const chart = el("section", { className: "afm-it-section" },
      el("div", { className: "afm-it-controls" }, metric, resource, about),
      el("div", { className: "afm-it-chart" }, main.element, blocks.element),
      eco.exact ? null : el("p", { className: "afm-dim afm-it-note" }, t("Income is not shown: the game engine on this site does not count what was mined yet.")));

    const mining = w.fold({ text: t("Bases and mining"), open: false });
    mining.body.append(this.saturation(eco, game));
    const numbers = w.fold({ text: t("All the numbers"), open: false });
    numbers.body.append(this.table(eco, game));

    const verdict = this.verdict(eco, game);
    body.append(cards, ...(verdict ? [verdict] : []), chart, mining, numbers);
    for (const c of this.charts) c.draw();
  }

  /** A sentence or two comparing the players, for a game of two; nothing for another. */
  private verdict(eco: Economy, game: InsightGame): HTMLElement | null {
    const { api, t } = this.deps;
    const shown = eco.players.filter((p) => !game.players.find((x) => x.slot === p.slot)?.hidden);
    if (shown.length !== 2) return null;
    const name = (slot: number) => game.players.find((p) => p.slot === slot)?.name ?? "";
    const [a, b] = shown;
    const said: string[] = [];
    if (a.mined && b.mined) {
      const ma = a.mined.minerals + a.mined.gas, mb = b.mined.minerals + b.mined.gas;
      const [hi, lo, more] = ma >= mb ? [a, b, ma / Math.max(1, mb) - 1] : [b, a, mb / Math.max(1, ma) - 1];
      said.push(more < 0.05 ? t("They mined about the same.") : t("{name} mined {n}% more than {other}.", { name: name(hi.slot), n: Math.round(more * 100), other: name(lo.slot) }));
    }
    const lean = a.averageBank <= b.averageBank ? a : b, heavy = lean === a ? b : a;
    if (heavy.averageBank > lean.averageBank * 1.15) said.push(t("{name} kept less unspent.", { name: name(lean.slot) }));
    const blocked = a.blockedFrames >= b.blockedFrames ? a : b, freer = blocked === a ? b : a;
    if (blocked.blockedFrames - freer.blockedFrames >= 24 * 30) said.push(t("{name} was supply blocked {time} longer.", { name: name(blocked.slot), time: formatTime(blocked.blockedFrames - freer.blockedFrames) }));
    return said.length ? api.ui.el("p", { className: "afm-it-verdict" }, said.join(" ")) : null;
  }

  /** Every number, a column a player: the table the charts are drawn from. */
  private table(eco: Economy, game: InsightGame): HTMLElement {
    const { api, t } = this.deps;
    const el = api.ui.el;
    const shown = eco.players.filter((p) => !game.players.find((x) => x.slot === p.slot)?.hidden);
    const player = (slot: number) => game.players.find((p) => p.slot === slot);
    const number = (n: number) => Math.round(n).toLocaleString();
    const none = "–";
    const row = (label: string, hint: string, cell: (p: (typeof eco.players)[number]) => string) =>
      el("tr", {}, el("th", { scope: "row", title: hint }, label), ...shown.map((p) => el("td", {}, cell(p))));
    return el("table", { className: "afm-it-table" },
      el("thead", {}, el("tr", {}, el("th", {}), ...shown.map((p) => el("th", { scope: "col" }, el("span", { className: "afm-it-player" },
        el("span", { className: "afm-tip-swatch", style: `background:${player(p.slot)?.color ?? "#888"}` }), player(p.slot)?.name ?? ""))))),
      el("tbody", {},
        row(t("Minerals mined"), t("Everything the player's workers brought back"), (p) => (p.mined ? number(p.mined.minerals) : none)),
        row(t("Gas mined"), t("Everything the player's workers brought back"), (p) => (p.mined ? number(p.mined.gas) : none)),
        row(t("Income a minute"), t("Minerals and gas a minute, on average over the time the player was in the game"), (p) => (p.averageIncome === null ? none : number(p.averageIncome))),
        row(t("Unspent, on average"), t("Minerals and gas in the bank, on average: lower means the money went to use sooner"), (p) => number(p.averageBank)),
        row(t("Supply blocked"), t("Time spent at the supply limit (below 200), when nothing more could be made"), (p) => (p.blockedFrames > 0 ? t("{time} in {n, plural, one {# block} other {# blocks}}", { time: formatTime(p.blockedFrames), n: p.blocks.length }) : t("never"))),
        row(t("Most workers"), t("The most workers the player had at once, and when"), (p) => t("{n} at {time}", { n: p.peakWorkers.n, time: formatTime(p.peakWorkers.frame) })),
      ));
  }

  /** Workers at each base a player mined from, minute by minute: colour for how full, the numbers on the pointer. */
  private saturation(eco: Economy, game: InsightGame): HTMLElement {
    const { api, t } = this.deps;
    const el = api.ui.el;
    const bySlot = new Map(game.players.map((p) => [p.slot, p]));
    const players = eco.players.map((p) => p.slot).filter((slot) => !bySlot.get(slot)?.hidden);
    if (!eco.lines.length) return el("p", { className: "afm-dim afm-it-note" }, t("Where the workers stood is not in this analysis."));
    const minutes = eco.minutes;
    const grid = el("div", { className: "afm-it-sat", style: `grid-template-columns: 132px repeat(${minutes}, minmax(6px, 1fr))` });
    grid.append(el("span", {}));
    for (let m = 0; m < minutes; m++) grid.append(el("span", { className: "afm-it-sat-min afm-dim" }, m % 5 === 0 ? String(m) : ""));
    /** What a base is called: the first a player mined from is their main, then in the order they began. */
    const label = new Map<LineSaturation, string>();
    for (const slot of players) {
      eco.lines.filter((l) => l.player === slot).forEach((l, i) => label.set(l, i === 0 ? t("Main") : t("Base {n}", { n: i + 1 })));
    }
    const rows: LineSaturation[] = [];
    for (const slot of players) {
      for (const row of eco.lines.filter((l) => l.player === slot)) {
        rows.push(row);
        grid.append(el("span", { className: "afm-it-sat-line" }, el("span", { className: "afm-tip-swatch", style: `background:${bySlot.get(slot)?.color ?? "#888"}` }),
          el("span", { className: "afm-gt-name" }, label.get(row) ?? ""), el("span", { className: "afm-dim" }, this.deps.placeOf(row.x, row.y, game.map))));
        row.perMinute.forEach((n, m) => {
          const a = n < 0.5 ? 0 : 0.12 + 0.7 * Math.min(1, n / Math.max(1, row.fields) / 3);
          const cell = el("span", { className: "afm-it-sat-cell", style: a ? `background: rgba(79,209,197,${a.toFixed(2)})` : "" });
          cell.dataset.row = String(rows.length - 1);
          cell.dataset.minute = String(m);
          grid.append(cell);
        });
      }
    }
    const cellAt = (x: number, y: number) => {
      const r = grid.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + x, r.top + y);
      return hit instanceof HTMLElement && hit.classList.contains("afm-it-sat-cell") ? hit : null;
    };
    this.tips.push(this.deps.tooltip(grid, (at) => {
      const cell = cellAt(at.offsetX, at.offsetY);
      const row = cell ? rows[Number(cell.dataset.row)] : undefined;
      if (!cell || !row) return null;
      const m = Number(cell.dataset.minute), n = row.perMinute[m];
      return el("div", { className: "afm-gt" },
        el("div", { className: "afm-gt-head" }, el("b", {}, `${m}:00–${m + 1}:00`), el("span", { className: "afm-dim" }, `${label.get(row) ?? ""} · ${this.deps.placeOf(row.x, row.y, game.map)}`)),
        el("div", {}, t("{n} workers at {fields} fields, {per} a field", { n: Math.round(n), fields: row.fields, per: (n / row.fields).toFixed(1) })),
        el("div", { className: "afm-gt-foot afm-dim" }, t("Press to go to that minute")));
    }));
    grid.addEventListener("click", (e) => {
      const target = e.target;
      if (target instanceof HTMLElement && target.dataset.minute) this.deps.seek(Number(target.dataset.minute) * FRAMES_PER_MINUTE);
    });
    // The scale, so the colour can be read: workers a field.
    const key = el("div", { className: "afm-it-key afm-dim" }, t("Workers a field"),
      ...[0.5, 1, 2, 3].map((per) => el("span", { className: "afm-it-key-step" }, el("span", { className: "afm-it-sat-cell", style: `background: rgba(79,209,197,${(0.12 + 0.7 * Math.min(1, per / 3)).toFixed(2)})` }), per === 3 ? "3+" : String(per))),
      el("span", {}, t("· two a field mine at the full rate")));
    return el("div", {}, key, el("div", { className: "afm-it-sat-wrap" }, grid));
  }
}

/** The sample nearest `frame`. */
function nearestSample(frames: readonly number[], frame: number): number {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid] < frame) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(frames[lo - 1] - frame) <= Math.abs(frames[lo] - frame) ? lo - 1 : lo;
}
