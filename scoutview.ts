/**
 * The Analysis window's Scouting tab: what each player knew of the others, from the game's own sightings (`knew.ts`).
 * A card a player with how much of the others' army they had in sight; a sentence comparing two players; a chart of
 * that share through the game; for cloaked and air units, when the others had them, when the player saw them and when
 * they answered; and folded below, the others' buildings that stood the longest unseen.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { formatTime } from "./analysis";
import { LineChart, nearest, type ChartHost } from "./charts";
import { armyInSight, firstLooks, knowledge, scouts, threats, unseen, type Knowledge, type Scout, type Threat } from "./knew";
import { isBuilding } from "./played";
import type { ReplayTimeline } from "./vendor/scm-sim";

export interface ScoutContext {
  api: PluginApi;
  t: (text: string, params?: Record<string, string | number>) => string;
  host: ChartHost;
  timeline: ReplayTimeline;
  /** The players shown, by slot, in the window's order. */
  players: { slot: number; name: string; color: string }[];
  /** A player's opponents, by slot. */
  opponents(slot: number): ReadonlySet<number>;
  /** A unit's cost by units.dat id (minerals and gas; a pair's half for Zerglings and Scourge). */
  cost(type: number): number;
  seek(frame: number): void;
  /** Keep a chart, so the window moves its replay line and disposes it. */
  chart(c: LineChart): void;
}

/** The span the chart's share is taken over: half a minute. */
const SMOOTH_FRAMES = 720;
/** The scouts a player is shown. */
const SCOUTS_SHOWN = 6;
/** The buildings a player is shown as unseen the longest. */
const UNSEEN_SHOWN = 8;

const known = new WeakMap<ReplayTimeline, Knowledge>();

export function mountScouting(body: HTMLElement, cx: ScoutContext): void {
  const { api, t, timeline: tl } = cx;
  const el = api.ui.el, w = api.ui.widgets;
  let k = known.get(tl);
  if (!k) { k = knowledge(tl); known.set(tl, k); }
  if (!k.has) {
    body.append(el("p", { className: "afm-dim afm-it-note" }, t("The game engine on this site does not say who saw what yet, so there is nothing to show here.")));
    return;
  }
  const playing = new Set(tl.samples.players.filter((s) => s.supplyMax.some((n) => n > 0)).map((s) => s.slot));
  const shown = cx.players.filter((p) => playing.has(p.slot));
  const raceOf = (slot: number) => tl.players.find((p) => p.slot === slot)?.race ?? -1;
  const unit = (type: number) => api.names.unit(type).replace(/^(Terran|Zerg|Protoss) (?=\S)/, "");
  const swatch = (color: string) => el("span", { className: "afm-tip-swatch", style: `background:${color}` });
  const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);
  const go = (node: HTMLElement, frame: number) => { node.title = t("Go to the time"); node.classList.add("afm-sc-go"); node.addEventListener("click", () => cx.seek(frame)); return node; };

  const k0 = k;
  const sights = new Map(shown.map((p) => [p.slot, armyInSight(k0, tl, p.slot, cx.opponents(p.slot), cx.cost)]));
  const looks = new Map(shown.map((p) => [p.slot, firstLooks(k0, p.slot, cx.opponents(p.slot))]));
  const hidden = new Map(shown.map((p) => [p.slot, unseen(k0, tl, p.slot, cx.opponents(p.slot))]));
  // Scouts are what moves: a building that sees what comes at it is defending, not scouting.
  const found = new Map(shown.map((p) => [p.slot, scouts(k0, p.slot, cx.opponents(p.slot), cx.cost).filter((sc) => !isBuilding(sc.type))]));
  const number = (n: number) => Math.round(n).toLocaleString();

  // The cards: how much of the others' army each had in sight, their first look, what of theirs they never saw.
  const cards = el("div", { className: "afm-it-cards" }, ...shown.map((p) => {
    const look = looks.get(p.slot)!, never = hidden.get(p.slot)!.filter((u) => u.seen === null).length;
    return el("div", { className: "afm-it-card", style: `border-top-color:${p.color}` },
      el("div", { className: "afm-it-card-name" }, swatch(p.color), el("span", { className: "afm-gt-name" }, p.name)),
      el("div", { className: "afm-it-hero" }, percent(sights.get(p.slot)!.share), el("span", { className: "afm-it-unit" }, t("of their army"))),
      el("div", { className: "afm-dim afm-it-card-line" }, t("in sight, on average")),
      el("div", { className: "afm-it-card-line" }, ...(look.building
        ? [el("b", {}, formatTime(look.building.frame)), " ", el("span", { className: "afm-dim" }, t("first saw a building of theirs"))]
        : [el("span", { className: "afm-dim" }, t("never saw a building of theirs"))])),
      el("div", { className: "afm-it-card-line" }, el("b", {}, String(never)), " ", el("span", { className: "afm-dim" }, t("{n, plural, one {building of theirs never seen} other {buildings of theirs never seen}}", { n: never }))),
      ...bestScout(p.slot),
    );
  }));

  // A card's line for the player's best scout: the unit that showed them the most.
  function bestScout(slot: number): HTMLElement[] {
    const best = found.get(slot)![0];
    return best ? [el("div", { className: "afm-it-card-line" }, el("b", {}, number(best.worth)), " ", el("span", { className: "afm-dim" }, t("found by their best scout: {unit}, {time}", { unit: unit(best.type), time: formatTime(best.from) })))] : [];
  }

  // A sentence for a game of two: who saw more of the other.
  let verdict: HTMLElement | null = null;
  if (shown.length === 2) {
    const [a, b] = shown, sa = sights.get(a.slot)!.share, sb = sights.get(b.slot)!.share;
    if (sa !== null && sb !== null) {
      const [more, less, hi, lo] = sa >= sb ? [a, b, sa, sb] : [b, a, sb, sa];
      verdict = el("p", { className: "afm-it-verdict" }, hi - lo < 0.05
        ? t("Both had about as much of the other's army in sight.")
        : t("{name} had more of {other}'s army in sight: {more} against {less}.", { name: more.name, other: less.name, more: percent(hi), less: percent(lo) }));
    }
  }

  // The share through the game.
  const frames = tl.samples.frame;
  // The line is the share over the half minute around each moment: a fight makes what is in sight flicker by the second.
  const reach = Math.max(1, Math.round(SMOOTH_FRAMES / 2 / Math.max(1, tl.samples.every)));
  const shareAt = (slot: number, i: number) => {
    const s = sights.get(slot)!;
    let seen = 0, total = 0;
    for (let j = Math.max(0, i - reach); j <= Math.min(frames.length - 1, i + reach); j++) { seen += s.seen[j]; total += s.total[j]; }
    return total > 0 ? (seen / total) * 100 : 0;
  };
  const chart = new LineChart(cx.host, 180, (f) => {
    const i = Math.max(0, nearest(frames, f));
    return el("div", { className: "afm-gt" },
      el("div", { className: "afm-gt-head" }, el("b", {}, formatTime(frames[i])), el("span", { className: "afm-dim" }, t("Their army in sight"))),
      ...shown.map((p) => {
        const s = sights.get(p.slot)!;
        return el("div", { className: "afm-it-row" }, swatch(p.color), el("span", { className: "afm-gt-name" }, p.name),
          el("b", { className: "afm-gt-num" }, s.total[i] > 0 ? `${Math.round((s.seen[i] / s.total[i]) * 100)}%` : "–"),
          el("span", { className: "afm-dim" }, s.total[i] > 0 ? t("{seen} of {total}", { seen: Math.round(s.seen[i]), total: Math.round(s.total[i]) }) : t("no army")));
      }),
      el("div", { className: "afm-gt-foot afm-dim" }, t("Press or drag to go there")));
  }, t("Their army in sight"));
  chart.set(shown.map((p) => ({ label: p.name, color: p.color, x: frames, y: frames.map((_, i) => shareAt(p.slot, i)) })), tl.frames, (v) => `${Math.round(v)}%`);
  cx.chart(chart);
  const chartSection = el("section", { className: "afm-it-section" },
    el("div", { className: "afm-it-controls afm-dim afm-it-about" }, t("How much of the opponents' army, by cost, each player could see, over the half minute around each moment. Units under the fog, and cloaked or burrowed units not detected, are not seen.")),
    el("div", { className: "afm-it-chart" }, chart.element));

  // Cloaked and air units: when the others had them, when the player saw them, and the first answer.
  const kindName = (th: Threat) => (th.kind === "cloaked" ? t("Cloaked units") : t("Air units"));
  const seenCell = (th: Threat) => {
    if (!th.seen) return el("td", { className: "afm-dim" }, t("never"));
    const late = th.seen.frame - th.made.frame;
    return go(el("td", {}, `${formatTime(th.seen.frame)} · ${unit(th.seen.type)}`, el("span", { className: "afm-dim" }, ` · ${t("{time} later", { time: formatTime(late) })}`)), th.seen.frame);
  };
  const answerCell = (th: Threat) => {
    const already = th.already ? el("div", { className: "afm-dim" }, t("already had: {name}, {time}", { name: unit(th.already.type), time: formatTime(th.already.frame) })) : null;
    if (!th.answer) return el("td", {}, already ?? el("span", { className: "afm-dim" }, t("none")));
    const when = !th.seen ? "" : th.answer.frame <= th.seen.frame ? t("{time} before seeing", { time: formatTime(th.seen.frame - th.answer.frame) }) : t("{time} after seeing", { time: formatTime(th.answer.frame - th.seen.frame) });
    return go(el("td", {}, el("div", {}, `${formatTime(th.answer.frame)} · ${unit(th.answer.type)}`, when ? el("span", { className: "afm-dim" }, ` · ${when}`) : null), already), th.answer.frame);
  };
  const threatRows = shown.flatMap((p) => {
    const list = threats(k0, p.slot, raceOf(p.slot), cx.opponents(p.slot));
    if (!list.length) return [];
    return [
      el("tr", {}, el("th", { scope: "rowgroup", className: "afm-ti-group", colSpan: 4 }, el("span", { className: "afm-it-player" }, swatch(p.color), p.name))),
      ...list.map((th) => el("tr", {},
        el("th", { scope: "row" }, kindName(th)),
        go(el("td", {}, `${formatTime(th.made.frame)} · ${unit(th.made.type)}`), th.made.frame),
        seenCell(th), answerCell(th))),
    ];
  });
  const threatSection = threatRows.length ? el("section", { className: "afm-it-section" },
    el("h3", { className: "afm-sc-h" }, t("Seen and answered")),
    el("p", { className: "afm-dim afm-it-note" }, t("For the cloaked and the air units the opponents had: when they first had one (or the building that makes them), when the player first saw one, and the first answer the player started after that: detection against cloaked units, anti-air against air units. An answer started before seeing was guessed at, or scouted some other way. One the player had before the opponents had the threat at all is shown as already had.")),
    el("table", { className: "afm-it-table afm-ti-table afm-sc-table" },
      el("thead", {}, el("tr", {}, el("th", {}), el("th", { scope: "col" }, t("They had it")), el("th", { scope: "col" }, t("First seen")), el("th", { scope: "col" }, t("First answer")))),
      el("tbody", {}, ...threatRows))) : null;

  // What each unit was the first to show its player, the most first.
  const scoutRow = (sc: Scout) => {
    const kinds = sc.kinds.map(unit);
    const row = el("tr", {},
      el("th", { scope: "row" }, unit(sc.type)),
      go(el("td", {}, sc.from === sc.to ? formatTime(sc.from) : `${formatTime(sc.from)}–${formatTime(sc.to)}`), sc.from),
      el("td", { className: "afm-sc-worth" }, number(sc.worth)),
      el("td", { className: "afm-dim afm-sc-kinds" }, kinds.length ? t("new: {kinds}", { kinds: kinds.join(", ") }) : t("nothing new")));
    row.title = t("{n, plural, one {# unit or building} other {# units and buildings}} of theirs this {unit} was the first to show them, worth {worth}", { n: sc.revealed.length, unit: unit(sc.type), worth: number(sc.worth) });
    return row;
  };
  const scoutRows = shown.flatMap((p) => {
    const list = found.get(p.slot)!.slice(0, SCOUTS_SHOWN);
    if (!list.length) return [];
    return [el("tr", {}, el("th", { scope: "rowgroup", className: "afm-ti-group", colSpan: 4 }, el("span", { className: "afm-it-player" }, swatch(p.color), p.name))), ...list.map(scoutRow)];
  });
  const scoutSection = scoutRows.length ? el("section", { className: "afm-it-section" },
    el("h3", { className: "afm-sc-h" }, t("Scouts and what they found")),
    el("p", { className: "afm-dim afm-it-note" }, t("Each of the opponents' units and buildings a player ever saw, counted to the player's unit that saw it first; a unit's worth is what all it showed them first cost. The game does not record which unit sees what: it is the unit nearest to having the thing in its sight, the likeliest one. Buildings are left out, and new kinds are the ones the player had never seen before.")),
    el("table", { className: "afm-it-table afm-ti-table afm-sc-table" },
      el("thead", {}, el("tr", {}, el("th", {}), el("th", { scope: "col" }, t("When")), el("th", { scope: "col" }, t("Worth")), el("th", { scope: "col" }, t("What it found")))),
      el("tbody", {}, ...scoutRows))) : null;

  // The others' buildings that stood the longest before each player saw them.
  const unseenFold = w.fold({ text: t("Unseen the longest"), open: false });
  unseenFold.body.append(el("p", { className: "afm-dim afm-it-note" }, t("The opponents' town halls, production and tech buildings that stood the longest before each player saw them, from when they were started. Supply, gas and static defence are left out, and so is what stood from the start.")),
    el("table", { className: "afm-it-table afm-ti-table afm-sc-table" }, el("tbody", {}, ...shown.flatMap((p) => {
      const list = hidden.get(p.slot)!.slice(0, UNSEEN_SHOWN);
      if (!list.length) return [];
      return [
        el("tr", {}, el("th", { scope: "rowgroup", className: "afm-ti-group", colSpan: 3 }, el("span", { className: "afm-it-player" }, swatch(p.color), p.name))),
        ...list.map((u) => el("tr", {},
          el("th", { scope: "row" }, unit(u.type)),
          go(el("td", {}, t("started {time}", { time: formatTime(u.from) })), u.from),
          u.seen === null ? el("td", { className: "afm-dim" }, t("never seen")) : go(el("td", {}, t("seen {time}", { time: formatTime(u.seen) }), el("span", { className: "afm-dim" }, ` · ${t("{time} unseen", { time: formatTime(u.unseenFor) })}`)), u.seen))),
      ];
    }))));

  body.append(cards, ...(verdict ? [verdict] : []), chartSection, ...(scoutSection ? [scoutSection] : []), ...(threatSection ? [threatSection] : []), unseenFold);
  chart.draw();
}
