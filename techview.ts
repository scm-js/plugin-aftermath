/**
 * The Analysis window's Tech tab: how each player's technology went. A card a player with the furthest tier they
 * reached and when; a sentence comparing two players; one chart of everything that opened their tech (the first of
 * each tech building and every research, from start to done, with the game's icons); and folded below, the army they
 * fielded unit type by unit type, minute by minute, and every timing in a table.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { formatTime, FRAMES_PER_MINUTE } from "./analysis";
import { GanttChart, type ChartHost, type GanttBar } from "./charts";
import { isBuilding } from "./played";
import { tech, type ArmyRow, type Durations, type Tech, type TechItem } from "./tech";
import type { ReplayTimeline } from "./vendor/scm-sim";

/** What the tab needs of the window. */
export interface TechContext {
  api: PluginApi;
  t: (text: string, params?: Record<string, string | number>) => string;
  host: ChartHost;
  timeline: ReplayTimeline;
  /** The players shown, by slot, in the window's order. */
  players: { slot: number; name: string; color: string }[];
  seek(frame: number): void;
  /** Keep a chart, so the window moves its replay line and disposes it. */
  chart(c: GanttChart): void;
  /** Keep something to dispose with the tab. */
  keep(d: { dispose(): void }): void;
}

/** The buildings that make a race's second and third tier: the first of them finished is when the player got there. */
const TIERS: Record<number, [second: number[], third: number[]]> = {
  // Zerg: Lair, Hive.
  0: [[132], [133]],
  // Terran: Factory, Science Facility.
  1: [[113], [116]],
  // Protoss: Citadel of Adun, Robotics Facility or Stargate; Templar Archives, Fleet Beacon or Arbiter Tribunal.
  2: [[163, 155, 167], [165, 169, 170]],
};

/** The furthest tier a player reached: 3 or 2, the building that took them there; null for neither. */
export function tierOf(race: number, buildings: readonly TechItem[]): { tier: 2 | 3; item: TechItem } | null {
  const tiers = TIERS[race];
  if (!tiers) return null;
  for (const tier of [3, 2] as const) {
    const item = buildings.find((b) => tiers[tier - 2].includes(b.id));
    if (item) return { tier, item };
  }
  return null;
}

/** A name where room is short: the game names most things after their race ("Zerg Carapace"), which the colour beside it says already. */
const short = (name: string) => name.replace(/^(Terran|Zerg|Protoss) (?=\S)/, "");

const techs = new WeakMap<ReplayTimeline, Tech>();

export function mountTech(body: HTMLElement, cx: TechContext): void {
  const { api, t, timeline: tl } = cx;
  const el = api.ui.el, w = api.ui.widgets;
  const data = { units: api.data.units(), upgrades: api.data.upgrades(), techs: api.data.techs() };
  const time: Durations = (kind, id, level) => kind === "unit" ? (data.units?.buildTime[id] ?? null)
    : kind === "upgrade" ? (data.upgrades ? data.upgrades.timeCost[id] + data.upgrades.timeFactor[id] * (level - 1) : null)
    : (data.techs?.researchTime[id] ?? null);
  let all = techs.get(tl);
  if (!all) {
    all = tech(tl, tl.samples.players.filter((s) => s.supplyMax.some((n) => n > 0)).map((s) => s.slot), time);
    // Kept only when the game's tables were there: without them the starts are not known, and a later look may have them.
    if (data.units && data.upgrades && data.techs) techs.set(tl, all);
  }
  const shown = cx.players.filter((p) => all.players.some((x) => x.slot === p.slot));
  const of = (slot: number) => all.players.find((p) => p.slot === slot)!;
  const raceOf = (slot: number) => tl.players.find((p) => p.slot === slot)?.race ?? -1;
  const nameOf = (item: TechItem) => item.kind === "building" ? api.names.unit(item.id)
    : item.kind === "tech" ? api.names.tech(item.id)
    : (data.upgrades?.maxRepeats[item.id] ?? item.level) > 1 ? `${api.names.upgrade(item.id)} ${item.level}` : api.names.upgrade(item.id);
  const swatch = (color: string) => el("span", { className: "afm-tip-swatch", style: `background:${color}` });

  // The game's icons load lazily, and a copy of the game data installed before the editor kept them has none at all.
  // A unit with no icon is shown by its picture on the map (not a building, which shrinks past reading); until either arrives, or for good when neither can, a slot
  // shows the name instead (a card's path), or nothing where the name is beside it already.
  type Kind = "unit" | "upgrade" | "tech";
  const waiting: { slot: HTMLElement; kind: Kind; id: number; owner: number }[] = [];
  const picture = (kind: Kind, id: number, owner: number): { image: HTMLCanvasElement; width: number; height: number; icon: boolean } | null => {
    const pic = typeof api.graphics.icon === "function" ? api.graphics.icon(kind, id) : null;
    if (pic) return { ...pic, icon: true };
    // A building's art shrunk to an icon's size reads as a smudge: its name says more.
    if (kind !== "unit" || isBuilding(id)) return null;
    const unit = api.graphics.unitImage(id, { owner });
    return unit ? { ...unit, icon: false } : null;
  };
  const ask = (kind: Kind, id: number) => {
    if (typeof api.graphics.requestIcons === "function") api.graphics.requestIcons();
    if (kind === "unit" && !isBuilding(id)) api.graphics.requestUnit(id);
  };
  /** Put the best picture there is in `slot`; true once it is the icon, which nothing replaces. */
  const fill = (slot: HTMLElement, kind: Kind, id: number, owner: number): boolean => {
    const pic = picture(kind, id, owner);
    if (!pic || slot.dataset.shown === (pic.icon ? "icon" : "unit")) return pic?.icon ?? false;
    // Drawn into the icon sheet's size, a unit's picture fitted in, so the two line up.
    const w = 36, h = 34, k = Math.min(w / pic.width, h / pic.height, 1);
    const c = el("canvas", { width: w, height: h }) as HTMLCanvasElement;
    c.getContext("2d")?.drawImage(pic.image, (w - pic.width * k) / 2, (h - pic.height * k) / 2, pic.width * k, pic.height * k);
    slot.replaceChildren(c);
    slot.dataset.shown = pic.icon ? "icon" : "unit";
    slot.classList.remove("afm-gi-none", "afm-ti-text", "afm-ti-empty");
    return pic.icon;
  };
  /**
   * A slot for an icon. `text`: what it says until a picture comes (none: it takes no room meanwhile). `wait`: fill it
   * when pictures arrive (not a tooltip's, which is asked again anyway). `owner`: whose colours a unit's picture takes.
   */
  const icon = (kind: Kind, id: number, options: { title: string; text?: string; small?: boolean; wait?: boolean; owner?: number }) => {
    const slot = el("span", { className: `afm-ti${options.small ? " afm-ti-sm" : ""}` });
    slot.dataset.name = options.title;
    const owner = options.owner ?? 0;
    if (!fill(slot, kind, id, owner)) {
      if (!slot.dataset.shown) {
        if (options.text) { slot.classList.add("afm-ti-text"); slot.textContent = options.text; }
        else slot.classList.add("afm-ti-empty");
      }
      if (options.wait ?? true) { waiting.push({ slot, kind, id, owner }); ask(kind, id); }
    }
    return slot;
  };
  const kindOf = (item: TechItem) => (item.kind === "building" ? "unit" : item.kind);

  // The cards: the furthest tier and when, what was researched, and the path of buildings as icons.
  const cards = el("div", { className: "afm-it-cards" }, ...shown.map((p) => {
    const pt = of(p.slot), reached = tierOf(raceOf(p.slot), pt.buildings);
    const levels = pt.research.filter((r) => r.kind === "upgrade").length, abilities = pt.research.length - levels;
    return el("div", { className: "afm-it-card", style: `border-top-color:${p.color}` },
      el("div", { className: "afm-it-card-name" }, swatch(p.color), el("span", { className: "afm-gt-name" }, p.name)),
      el("div", { className: "afm-it-hero" }, reached ? formatTime(reached.item.done) : "–",
        el("span", { className: "afm-it-unit" }, reached ? (reached.tier === 3 ? t("third tier") : t("second tier")) : t("no second tier"))),
      el("div", { className: "afm-dim afm-it-card-line" }, reached ? nameOf(reached.item) : "\u00a0"),
      el("div", { className: "afm-it-card-line" }, t("{levels, plural, one {# upgrade level} other {# upgrade levels}}, {n, plural, one {# technology} other {# technologies}}", { levels, n: abilities })),
      el("div", { className: "afm-ti-path" }, ...pt.buildings.map((b) => icon("unit", b.id, { title: `${nameOf(b)} · ${formatTime(b.done)}`, text: short(nameOf(b)), small: true, owner: p.slot }))),
    );
  }));
  // The names on the cards' icons, in the editor's tooltip.
  cx.keep(cx.host.tooltip(cards, (at) => {
    const r = cards.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + at.offsetX, r.top + at.offsetY);
    const slot = hit instanceof Element ? hit.closest<HTMLElement>(".afm-ti") : null;
    return slot?.dataset.name ?? null;
  }));

  // Everything that opened each player's tech, from when it began to when it was done.
  const items = new Map<GanttBar, TechItem>();
  const groups = shown.map((p) => {
    const pt = of(p.slot);
    const bars = [...pt.buildings, ...pt.research].sort((a, b) => a.start - b.start).map((item) => {
      const bar: GanttBar = { from: item.start, to: item.done, label: short(nameOf(item)), quiet: item.kind === "building", icon: () => picture(kindOf(item), item.id, p.slot) };
      items.set(bar, item);
      return bar;
    });
    return { slot: p.slot, label: p.name, color: p.color, bars };
  });
  const describe = (item: TechItem) => item.start === item.done
    ? t("done {time}", { time: formatTime(item.done) })
    : t("{from} to {to}, {span}", { from: formatTime(item.start), to: formatTime(item.done), span: formatTime(item.done - item.start) });
  const chart: GanttChart = new GanttChart(cx.host, (f, at) => {
    const hit = chart.barAt(at.offsetX, at.offsetY);
    if (hit) {
      const item = items.get(hit.bar)!;
      return el("div", { className: "afm-gt" },
        el("div", { className: "afm-gt-head" }, icon(kindOf(item), item.id, { title: nameOf(item), wait: false, owner: item.player }), el("b", {}, nameOf(item))),
        el("div", { className: "afm-it-row" }, swatch(hit.group.color), el("span", { className: "afm-gt-name" }, hit.group.label)),
        el("div", {}, describe(item)),
        el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
    }
    // Between bars: what each player had under way at that moment.
    const rows = shown.map((p) => {
      const busy = [...of(p.slot).buildings, ...of(p.slot).research].filter((i) => i.start <= f && f < i.done);
      return el("div", { className: "afm-it-row" }, swatch(p.color), el("span", { className: "afm-gt-name" }, p.name),
        el("span", { className: "afm-dim" }, busy.length ? busy.map(nameOf).join(", ") : t("nothing under way")));
    });
    return el("div", { className: "afm-gt" }, el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(f)), el("span", { className: "afm-dim" }, t("Under way"))), ...rows,
      el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
  }, t("Tech over the game"));
  chart.set(groups, tl.frames);
  cx.chart(chart);

  const legend = el("div", { className: "afm-it-controls afm-dim afm-it-about" },
    el("span", { className: "afm-ti-key" }, el("span", { className: "afm-ti-key-bar afm-ti-quiet" }), t("Tech buildings, the first of each")),
    el("span", { className: "afm-ti-key" }, el("span", { className: "afm-ti-key-bar" }), t("Upgrades and technologies")));
  const notes: HTMLElement[] = [];
  if (!data.upgrades || !data.techs) notes.push(el("p", { className: "afm-dim afm-it-note" }, t("Without the game's data, research is shown when it was done, not when it began.")));

  const army = w.fold({ text: t("Army over the game"), open: false });
  army.body.append(armyGrid(cx, all, shown, icon));
  const timings = w.fold({ text: t("All the timings"), open: false });
  timings.body.append(timingsTable(cx, all, shown, nameOf, icon, kindOf));

  const verdict = sayTech(cx, all, shown, raceOf, nameOf);
  body.append(cards, ...(verdict ? [el("p", { className: "afm-it-verdict" }, verdict)] : []),
    el("section", { className: "afm-it-section" }, legend, el("div", { className: "afm-it-chart" }, chart.element), ...notes), army, timings);
  chart.draw();

  if (typeof api.graphics.onImageLoaded === "function") {
    cx.keep(api.graphics.onImageLoaded(() => {
      for (let i = waiting.length - 1; i >= 0; i--) if (fill(waiting[i].slot, waiting[i].kind, waiting[i].id, waiting[i].owner)) waiting.splice(i, 1);
      chart.draw();
    }));
  }
}

/** A sentence or two comparing two players' tech; null for another number of players or nothing to say. */
function sayTech(cx: TechContext, all: Tech, shown: TechContext["players"], raceOf: (slot: number) => number, nameOf: (i: TechItem) => string): string | null {
  const { t } = cx;
  if (shown.length !== 2) return null;
  const [a, b] = shown;
  const pa = all.players.find((p) => p.slot === a.slot)!, pb = all.players.find((p) => p.slot === b.slot)!;
  const said: string[] = [];
  // Tiers are compared only between players of one race: a Templar Archives and a Hive are not the same step.
  const mirror = raceOf(a.slot) === raceOf(b.slot);
  const ta = mirror ? tierOf(raceOf(a.slot), pa.buildings) : null, tb = mirror ? tierOf(raceOf(b.slot), pb.buildings) : null;
  const reachedFirst = (tier: 2 | 3, name: string, other: string, time: string) => tier === 3
    ? t("{name} reached the third tier {time} before {other}.", { name, other, time })
    : t("{name} reached the second tier {time} before {other}.", { name, other, time });
  const reachedOnly = (tier: 2 | 3, name: string, other: string, building: string, time: string) => tier === 3
    ? t("{name} reached the third tier ({building}, {time}); {other} did not.", { name, other, building, time })
    : t("{name} reached the second tier ({building}, {time}); {other} did not.", { name, other, building, time });
  if (ta && tb && ta.tier === tb.tier) {
    const [first, second, gap] = ta.item.done <= tb.item.done ? [a, b, tb.item.done - ta.item.done] : [b, a, ta.item.done - tb.item.done];
    if (gap >= 24 * 10) said.push(reachedFirst(ta.tier, first.name, second.name, formatTime(gap)));
    else said.push(ta.tier === 3 ? t("Both reached the third tier at about the same time.") : t("Both reached the second tier at about the same time."));
  } else if (ta && (!tb || ta.tier > tb.tier)) said.push(reachedOnly(ta.tier, a.name, b.name, nameOf(ta.item), formatTime(ta.item.done)));
  else if (tb) said.push(reachedOnly(tb.tier, b.name, a.name, nameOf(tb.item), formatTime(tb.item.done)));
  const na = pa.research.length, nb = pb.research.length;
  if (Math.abs(na - nb) >= 2) {
    const [more, fewer, n, m] = na > nb ? [a, b, na, nb] : [b, a, nb, na];
    said.push(t("{name} finished {n} upgrade levels and technologies, {other} {m}.", { name: more.name, other: fewer.name, n, m }));
  }
  return said.length ? said.join(" ") : null;
}

/** Each player's army, unit type by unit type, at the end of every minute: shaded by how many against the most of that type. */
function armyGrid(cx: TechContext, all: Tech, shown: TechContext["players"], icon: (kind: "unit", id: number, options: { title: string; small?: boolean; owner?: number }) => HTMLElement): HTMLElement {
  const { api, t } = cx;
  const el = api.ui.el;
  const want = new Set(shown.map((p) => p.slot));
  const rows = all.army.filter((r) => want.has(r.player));
  if (!rows.length) return el("p", { className: "afm-dim afm-it-note" }, t("Nobody had an army."));
  const minutes = all.minutes;
  const grid = el("div", { className: "afm-it-sat", style: `grid-template-columns: 150px repeat(${minutes}, minmax(6px, 1fr))` });
  grid.append(el("span", {}));
  // A column is the count at its minute's end, so it is named by that time.
  for (let m = 0; m < minutes; m++) grid.append(el("span", { className: "afm-it-sat-min afm-dim" }, (m + 1) % 5 === 0 ? String(m + 1) : ""));
  const kept: ArmyRow[] = [];
  for (const p of shown) {
    for (const row of rows.filter((r) => r.player === p.slot)) {
      kept.push(row);
      grid.append(el("span", { className: "afm-it-sat-line" }, el("span", { className: "afm-tip-swatch", style: `background:${p.color}` }),
        icon("unit", row.type, { title: api.names.unit(row.type), small: true, owner: row.player }), el("span", { className: "afm-gt-name" }, short(api.names.unit(row.type)))));
      row.perMinute.forEach((n, m) => {
        const a = n === 0 ? 0 : 0.15 + 0.7 * (n / Math.max(1, row.peak));
        const cell = el("span", { className: "afm-it-sat-cell", style: a ? `background: rgba(79,209,197,${a.toFixed(2)})` : "" });
        cell.dataset.row = String(kept.length - 1);
        cell.dataset.minute = String(m);
        grid.append(cell);
      });
    }
  }
  const at = (m: number) => Math.min(cx.timeline.frames, (m + 1) * FRAMES_PER_MINUTE);
  cx.keep(cx.host.tooltip(grid, (pt) => {
    const r = grid.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + pt.offsetX, r.top + pt.offsetY);
    if (!(hit instanceof HTMLElement) || !hit.classList.contains("afm-it-sat-cell")) return null;
    const row = kept[Number(hit.dataset.row)], m = Number(hit.dataset.minute);
    if (!row) return null;
    const p = shown.find((x) => x.slot === row.player);
    return el("div", { className: "afm-gt" },
      el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(at(m))), el("span", { className: "afm-dim" }, api.names.unit(row.type))),
      el("div", { className: "afm-it-row" }, p ? el("span", { className: "afm-tip-swatch", style: `background:${p.color}` }) : null, el("span", { className: "afm-gt-name" }, p?.name ?? ""),
        el("b", { className: "afm-gt-num" }, String(row.perMinute[m]))),
      el("div", { className: "afm-dim" }, t("{n} at the most", { n: row.peak })),
      el("div", { className: "afm-gt-foot afm-dim" }, t("Press to go there")));
  }));
  grid.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && target.dataset.minute) cx.seek(at(Number(target.dataset.minute)));
  });
  return el("div", {}, el("p", { className: "afm-dim afm-it-note" }, t("How many of each unit a player had at the end of each minute; the darker, the nearer the most they had of it.")),
    el("div", { className: "afm-it-sat-wrap" }, grid));
}

/** Every tech building and research, a row each, and when each player had it done: the table the chart is drawn from. */
function timingsTable(cx: TechContext, all: Tech, shown: TechContext["players"], nameOf: (i: TechItem) => string,
  icon: (kind: "unit" | "upgrade" | "tech", id: number, options: { title: string; small?: boolean; owner?: number }) => HTMLElement, kindOf: (i: TechItem) => "unit" | "upgrade" | "tech"): HTMLElement {
  const { api, t } = cx;
  const el = api.ui.el;
  const players = shown.map((p) => all.players.find((x) => x.slot === p.slot)!);
  const section = (title: string, pick: (p: (typeof players)[number]) => TechItem[]) => {
    const rows = new Map<string, { item: TechItem; done: Map<number, TechItem> }>();
    for (const p of players) for (const item of pick(p)) {
      const key = `${item.kind}:${item.id}:${item.level}`;
      const row = rows.get(key) ?? { item, done: new Map() };
      row.done.set(p.slot, item);
      if (item.done < row.item.done) row.item = item;
      rows.set(key, row);
    }
    const sorted = [...rows.values()].sort((a, b) => a.item.done - b.item.done);
    if (!sorted.length) return null;
    return el("tbody", {},
      el("tr", {}, el("th", { scope: "rowgroup", className: "afm-ti-group", colSpan: shown.length + 1 }, title)),
      ...sorted.map((row) => {
        const times = shown.map((p) => row.done.get(p.slot)?.done ?? null);
        const best = Math.min(...times.filter((x) => x !== null));
        return el("tr", {},
          el("th", { scope: "row" }, el("span", { className: "afm-ti-name" }, icon(kindOf(row.item), row.item.id, { title: nameOf(row.item), small: true, owner: row.item.player }), nameOf(row.item))),
          ...times.map((x) => {
            const td = el("td", { className: x !== null && x === best && times.filter((y) => y !== null).length > 1 ? "afm-ti-first" : "" }, x === null ? "–" : formatTime(x));
            if (x !== null) { td.title = t("Go to the time"); td.addEventListener("click", () => cx.seek(x)); }
            return td;
          }));
      }));
  };
  return el("table", { className: "afm-it-table afm-ti-table" },
    el("thead", {}, el("tr", {}, el("th", {}), ...shown.map((p) => el("th", { scope: "col" }, el("span", { className: "afm-it-player" },
      el("span", { className: "afm-tip-swatch", style: `background:${p.color}` }), p.name))))),
    section(t("Tech buildings"), (p) => p.buildings),
    section(t("Upgrades and technologies"), (p) => p.research));
}
