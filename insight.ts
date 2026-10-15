/**
 * The Analysis window: a large panel beside the replay for reading a game at length, a tab a subject. Economy is the
 * first: what each player mined and how fast, what they left unspent, their workers, when they were supply blocked,
 * and how many workers stood at each mineral line, minute by minute. Every chart follows the replay's clock, and a
 * press on one goes there.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { formatTime, FRAMES_PER_MINUTE } from "./analysis";
import { LaneChart, LineChart, type ChartHost, type LineSeries } from "./charts";
import { economy, type Economy } from "./economy";
import type { MineralLines, UnitIndex } from "./played";
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
  settings: { tab: string; resource: Resource };
  save(): void;
}

export type Resource = "both" | "minerals" | "gas";

const economies = new WeakMap<ReplayTimeline, Economy>();

export class InsightView implements ChartHost {
  private game: InsightGame | null = null;
  private charts: (LineChart | LaneChart)[] = [];
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
    ], { value: settings.tab, onChange: (tab) => { settings.tab = tab; this.deps.save(); } });
    tabs.classList.add("afm-insight-tabs");
    this.root.append(tabs);
    this.update();
  }

  /* ── Economy ── */

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
    const resourceWord = () => settings.resource === "minerals" ? t("minerals") : settings.resource === "gas" ? t("gas") : t("minerals and gas");

    /** A tooltip for a moment on a chart: the time, then each shown player's value there. */
    const tipFor = (frame: number, title: string, value: (slot: number, i: number) => string | null) => {
      const i = Math.max(0, nearestSample(frames, frame));
      const rows = shown.map((p) => { const v = value(p.slot, i); return v === null ? null : el("div", { className: "afm-it-row" }, swatch(p.slot), el("span", { className: "afm-gt-name" }, name(p.slot)), el("b", { className: "afm-gt-num" }, v)); });
      return el("div", { className: "afm-gt" }, el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(frames[i])), el("span", { className: "afm-dim" }, title)), ...rows.filter((r) => r !== null),
        el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
    };

    // The choice that applies to everything below, in one row above it.
    const resource = w.segmented([
      { value: "both", label: t("Both") }, { value: "minerals", label: t("Minerals") }, { value: "gas", label: t("Gas") },
    ], { value: settings.resource, title: t("Which resource the income and unspent charts show"), onChange: (v) => { settings.resource = v as Resource; this.deps.save(); drawResourceCharts(); } });
    const filters = el("div", { className: "afm-it-filters" }, el("span", { className: "afm-dim" }, t("Resources")), resource);

    // In numbers: a column a player.
    const table = el("table", { className: "afm-it-table" });
    const head = el("tr", {}, el("th", {}), ...shown.map((p) => el("th", { scope: "col" }, el("span", { className: "afm-it-player" }, swatch(p.slot), name(p.slot)))));
    const row = (label: string, hint: string, cell: (p: (typeof eco.players)[number]) => string) =>
      el("tr", {}, el("th", { scope: "row", title: hint }, label), ...shown.map((p) => el("td", {}, cell(p))));
    const none = "–";
    table.append(el("thead", {}, head), el("tbody", {},
      row(t("Minerals mined"), t("Everything the player's workers brought back"), (p) => (p.mined ? number(p.mined.minerals) : none)),
      row(t("Gas mined"), t("Everything the player's workers brought back"), (p) => (p.mined ? number(p.mined.gas) : none)),
      row(t("Income a minute"), t("Minerals and gas a minute, on average over the time the player was in the game"), (p) => (p.averageIncome === null ? none : number(p.averageIncome))),
      row(t("Unspent, on average"), t("Minerals and gas in the bank, on average: lower means the money went to use sooner"), (p) => number(p.averageBank)),
      row(t("Supply blocked"), t("Time spent at the supply limit (below 200), when nothing more could be made"), (p) => (p.blockedFrames > 0 ? t("{time} in {n, plural, one {# block} other {# blocks}}", { time: formatTime(p.blockedFrames), n: p.blocks.length }) : t("never"))),
      row(t("Most workers"), t("The most workers the player had at once, and when"), (p) => t("{n} at {time}", { n: p.peakWorkers.n, time: formatTime(p.peakWorkers.frame) })),
    ));

    const section = (title: string, note: string | null, ...content: (HTMLElement | null)[]) =>
      el("section", { className: "afm-it-section" }, el("h3", {}, title), note ? el("p", { className: "afm-dim afm-it-note" }, note) : null, ...content);

    // Income, and what was left unspent: both follow the resource picked.
    const income = eco.exact ? new LineChart(this, 150, (f) => tipFor(f, t("Income a minute"), (slot, i) => {
      const p = eco.players.find((x) => x.slot === slot)!;
      return p.income ? number(resourceOf(p.income.minerals[i], p.income.gas[i])) : null;
    }), t("Income a minute")) : null;
    const bank = new LineChart(this, 130, (f) => tipFor(f, t("Unspent"), (slot, i) => number(resourceOf(series(slot).minerals[i], series(slot).gas[i]))), t("Unspent"));
    const drawResourceCharts = () => {
      if (income) income.set(shown.map((p): LineSeries => ({ label: name(p.slot), color: colour(p.slot), x: frames, y: p.income!.minerals.map((m, i) => resourceOf(m, p.income!.gas[i])) })), end);
      bank.set(shown.map((p): LineSeries => { const s = series(p.slot); return { label: name(p.slot), color: colour(p.slot), x: frames, y: s.minerals.map((m, i) => resourceOf(m, s.gas[i])) }; }), end);
      incomeTitle.textContent = t("Income a minute: {resource}", { resource: resourceWord() });
      bankTitle.textContent = t("Unspent: {resource}", { resource: resourceWord() });
    };
    const incomeTitle = el("h3", {}), bankTitle = el("h3", {});

    const workers = new LineChart(this, 120, (f) => tipFor(f, t("Workers"), (slot, i) => String(series(slot).workers[i])), t("Workers"));
    workers.set(shown.map((p) => ({ label: name(p.slot), color: colour(p.slot), x: frames, y: series(p.slot).workers })), end);

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

    this.charts.push(...(income ? [income] : []), bank, workers, blocks);
    drawResourceCharts();

    body.append(
      filters,
      el("section", { className: "afm-it-section" }, el("h3", {}, t("In numbers")), table),
      income
        ? el("section", { className: "afm-it-section" }, incomeTitle, el("p", { className: "afm-dim afm-it-note" }, t("Over the minute before each moment, from the game's own count of what was mined.")), income.element)
        : section(t("Income a minute"), t("The game engine on this site does not count what was mined yet, so income is not shown. The rest is.")),
      el("section", { className: "afm-it-section" }, bankTitle, el("p", { className: "afm-dim afm-it-note" }, t("What was in the bank. Money left there is not yet workers, army or tech.")), bank.element),
      section(t("Workers"), null, workers.element),
      section(t("Supply blocked"), t("At the supply limit, below 200: nothing more could be made until supply was built."), blocks.element),
      this.saturation(eco, game),
    );
    for (const c of this.charts) c.draw();
  }

  /** Workers at each mineral line a player worked, minute by minute. */
  private saturation(eco: Economy, game: InsightGame): HTMLElement {
    const { api, t } = this.deps;
    const el = api.ui.el;
    const bySlot = new Map(game.players.map((p) => [p.slot, p]));
    const rows = eco.lines.filter((l) => !bySlot.get(l.player)?.hidden);
    const title = el("h3", {}, t("Mineral lines"));
    if (!rows.length) return el("section", { className: "afm-it-section" }, title, el("p", { className: "afm-dim afm-it-note" }, t("Where the workers stood is not in this analysis.")));
    const minutes = eco.minutes;
    const grid = el("div", { className: "afm-it-sat", style: `grid-template-columns: 150px repeat(${minutes}, 22px)` });
    grid.append(el("span", { className: "afm-it-sat-corner afm-dim" }, t("minute")));
    for (let m = 0; m < minutes; m++) grid.append(el("span", { className: "afm-it-sat-min afm-dim" }, m % 5 === 0 ? String(m) : ""));
    for (const row of rows) {
      const p = bySlot.get(row.player);
      grid.append(el("span", { className: "afm-it-sat-line" },
        el("span", { className: "afm-tip-swatch", style: `background:${p?.color ?? "#888"}` }),
        el("span", { className: "afm-gt-name" }, this.deps.placeOf(row.x, row.y, game.map)),
        el("span", { className: "afm-dim" }, t("{n} fields", { n: row.fields }))));
      row.perMinute.forEach((n, m) => {
        // A single hue, stronger the more workers a field: two a field mine at the full rate, a third adds little.
        const perField = n / Math.max(1, row.fields);
        const a = n < 0.5 ? 0 : 0.1 + 0.7 * Math.min(1, perField / 3);
        const cell = el("span", { className: "afm-it-sat-cell", style: a ? `background: rgba(79,209,197,${a.toFixed(2)})` : "" }, n >= 0.5 ? String(Math.round(n)) : "");
        cell.dataset.line = String(row.line);
        cell.dataset.player = String(row.player);
        cell.dataset.minute = String(m);
        grid.append(cell);
      });
    }
    // Over a cell: the minute, the line and its workers; a press goes to the start of that minute.
    const cellAt = (x: number, y: number) => {
      const r = grid.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + x, r.top + y);
      return hit instanceof HTMLElement && hit.classList.contains("afm-it-sat-cell") ? hit : null;
    };
    this.tips.push(this.deps.tooltip(grid, (at) => {
      const cell = cellAt(at.offsetX, at.offsetY);
      if (!cell) return null;
      const row = rows.find((l) => String(l.line) === cell.dataset.line && String(l.player) === cell.dataset.player);
      if (!row) return null;
      const m = Number(cell.dataset.minute), n = row.perMinute[m];
      return el("div", { className: "afm-gt" },
        el("div", { className: "afm-gt-head" }, el("b", {}, `${m}:00–${m + 1}:00`), el("span", { className: "afm-dim" }, this.deps.placeOf(row.x, row.y, game.map))),
        el("div", {}, t("{n} workers at {fields} fields, {per} a field", { n: Math.round(n), fields: row.fields, per: (n / row.fields).toFixed(1) })),
        el("div", { className: "afm-gt-foot afm-dim" }, t("Press to go to that minute")));
    }));
    grid.addEventListener("click", (e) => {
      const target = e.target;
      if (target instanceof HTMLElement && target.dataset.minute) this.deps.seek(Number(target.dataset.minute) * FRAMES_PER_MINUTE);
    });
    return el("section", { className: "afm-it-section" }, title,
      el("p", { className: "afm-dim afm-it-note" }, t("Workers on the map at each mineral line, minute by minute: two a field mine at the full rate, and more add little. Workers in a refinery are not on the map, so these are mineral workers.")),
      el("div", { className: "afm-it-sat-wrap" }, grid));
  }
}

/** The sample nearest `frame`. */
function nearestSample(frames: readonly number[], frame: number): number {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid] < frame) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(frames[lo - 1] - frame) <= Math.abs(frames[lo] - frame) ? lo - 1 : lo;
}
