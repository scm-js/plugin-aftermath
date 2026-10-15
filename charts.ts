/**
 * The Analysis window's charts: lines over the game's time, or a lane a player of spans along it. Plain canvas, drawn
 * at the screen's resolution, one y-axis each. Every chart in a window shares the pointer's moment (a line through
 * all of them) and the replay's own moment (a brighter one), and a press or a drag goes to the moment pressed.
 */
import { FRAMES_PER_MINUTE } from "./analysis";

export interface LineSeries {
  label: string;
  color: string;
  /** Frames, rising. */
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

export interface LaneRow {
  label: string;
  color: string;
  spans: { from: number; to: number }[];
}

/** What a chart needs of the window it is in. */
export interface ChartHost {
  /** The pointer is over the chart at `frame`, or has left it (null): every chart draws its line there. */
  hover(frame: number | null): void;
  /** Go to `frame` in the replay. */
  pick(frame: number): void;
  /** The tooltip over an element, asked again as the pointer moves. */
  tooltip(target: HTMLElement, content: (at: { offsetX: number; offsetY: number }) => HTMLElement | string | null): { refresh(): void; dispose(): void };
}

/** Space round the plot: the y-axis' labels at the left, the minutes under it, the series' names at the right. */
const LEFT = 46, RIGHT = 96, BOTTOM = 18, TOP = 8;

/** A round number at or above `v` to end an axis on: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Minutes between the time axis' labels, so they stand at least `gap` pixels apart. */
export function minuteStep(widthPx: number, minutes: number, gap = 56): number {
  for (const step of [1, 2, 5, 10, 15, 20, 30, 60]) if ((widthPx / Math.max(1, minutes)) * step >= gap) return step;
  return 60;
}

/** The y of each name at a line's end, moved apart so no two are closer than `gap`, in the order they stand. */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  // Pushed off the bottom: move the lot up.
  const over = order.length ? order[order.length - 1].y - bottom : 0;
  if (over > 0) for (const o of order) o.y -= over;
  for (const o of order) o.y = Math.max(top, o.y);
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

const css = (el: Element, name: string, fallback: string) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

abstract class Chart {
  readonly element: HTMLElement;
  protected readonly canvas: HTMLCanvasElement;
  protected end = 1;
  protected now: number | null = null;
  protected hovered: number | null = null;
  private readonly resize: ResizeObserver;
  private readonly tip: { refresh(): void; dispose(): void };
  /** The same on every chart of a window, so their times line up: the axis' numbers at the left, names at the right. */
  protected readonly right = RIGHT;
  protected readonly left = LEFT;
  /** The minutes under the plot; off for a chart with another under it on the same time axis. */
  protected axis = true;

  protected readonly host: ChartHost;
  protected readonly tipAt: (frame: number, at: { offsetX: number; offsetY: number }) => HTMLElement | null;

  constructor(host: ChartHost, height: number, tipAt: (frame: number, at: { offsetX: number; offsetY: number }) => HTMLElement | null, label: string) {
    this.host = host;
    this.tipAt = tipAt;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "afm-chart-canvas";
    this.canvas.style.height = `${height}px`;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", label);
    this.element = document.createElement("div");
    this.element.className = "afm-chart";
    this.element.append(this.canvas);
    const frameAt = (offsetX: number) => {
      const w = this.canvas.clientWidth - this.left - this.right;
      return Math.max(0, Math.min(this.end, ((offsetX - this.left) / Math.max(1, w)) * this.end));
    };
    const pickAt = (e: PointerEvent) => this.host.pick(frameAt(e.clientX - this.canvas.getBoundingClientRect().left));
    this.canvas.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; this.canvas.setPointerCapture(e.pointerId); pickAt(e); });
    this.canvas.addEventListener("pointermove", (e) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) pickAt(e);
      this.host.hover(frameAt(e.clientX - this.canvas.getBoundingClientRect().left));
    });
    this.canvas.addEventListener("pointerleave", () => this.host.hover(null));
    this.tip = host.tooltip(this.canvas, (at) => (at.offsetX < this.left - 4 ? null : this.tipAt(frameAt(at.offsetX), at)));
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.canvas);
  }

  /** Whether to write the minutes under the plot. */
  showAxis(on: boolean): void { this.axis = on; this.draw(); }

  /** The replay's moment, drawn as the brighter line. */
  setNow(frame: number | null): void { if (frame !== this.now) { this.now = frame; this.draw(); } }
  /** The pointer's moment, over this chart or another of the window's. */
  setHover(frame: number | null): void { if (frame !== this.hovered) { this.hovered = frame; this.draw(); this.tip.refresh(); } }
  dispose(): void { this.resize.disconnect(); this.tip.dispose(); }

  protected abstract plot(g: CanvasRenderingContext2D, box: { x: (f: number) => number; top: number; bottom: number; w: number; dpr: number }): void;

  draw(): void {
    const c = this.canvas;
    if (!c.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.scale(dpr, dpr);
    const width = c.clientWidth, height = c.clientHeight;
    const w = Math.max(1, width - this.left - this.right);
    const top = TOP, bottom = height - (this.axis ? BOTTOM : 2);
    const x = (f: number) => this.left + (Math.max(0, Math.min(this.end, f)) / this.end) * w;
    const dim = css(c, "--text-dim", "#99a2b3"), grid = "rgba(255,255,255,0.07)";

    // The minutes along the bottom, with a hairline up from each.
    g.font = "10px system-ui, sans-serif";
    g.textBaseline = "top";
    g.textAlign = "center";
    const minutes = this.end / FRAMES_PER_MINUTE, step = minuteStep(w, minutes);
    for (let m = 0; m <= minutes; m += step) {
      const px = Math.round(x(m * FRAMES_PER_MINUTE)) + 0.5;
      g.strokeStyle = grid;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke();
      if (!this.axis) continue;
      g.fillStyle = dim;
      g.fillText(`${m}:00`, Math.min(px, width - this.right - 14), bottom + 4);
    }
    this.plot(g, { x, top, bottom, w, dpr });

    // The replay's moment, and the pointer's.
    for (const [f, colour] of [[this.now, "rgba(255,255,255,0.85)"], [this.hovered, "rgba(255,255,255,0.35)"]] as const) {
      if (f === null) continue;
      const px = Math.round(x(f)) + 0.5;
      g.strokeStyle = colour;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke();
    }
  }
}

/** Lines over the game's time on one axis from 0, a series a player, each named at its end. */
export class LineChart extends Chart {
  private series: LineSeries[] = [];
  private format: (v: number) => string = (v) => Math.round(v).toLocaleString();

  constructor(host: ChartHost, height: number, tipAt: (frame: number) => HTMLElement | null, label: string) {
    super(host, height, tipAt, label);
  }

  set(series: LineSeries[], end: number, format?: (v: number) => string): void {
    this.series = series;
    this.end = Math.max(1, end);
    if (format) this.format = format;
    this.draw();
  }

  protected plot(g: CanvasRenderingContext2D, box: { x: (f: number) => number; top: number; bottom: number; w: number }): void {
    const { x, top, bottom } = box;
    const width = this.canvas.clientWidth;
    let peak = 0;
    for (const s of this.series) for (let i = 0; i < s.y.length; i++) peak = Math.max(peak, s.y[i]);
    const max = niceMax(peak);
    const y = (v: number) => bottom - (v / max) * (bottom - top);
    const dim = css(this.canvas, "--text-dim", "#99a2b3"), text = css(this.canvas, "--text", "#e4e8ef");

    // The axis: 0, half and the top, hairlines across.
    g.font = "10px system-ui, sans-serif";
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const v of [0, max / 2, max]) {
      const py = Math.round(y(v)) + 0.5;
      g.strokeStyle = v === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)";
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(this.left, py); g.lineTo(width - this.right, py); g.stroke();
      g.fillStyle = dim;
      g.fillText(this.format(v), this.left - 6, py);
    }

    // The lines, 2 px, joined round.
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    const ends: { y: number; s: LineSeries; v: number }[] = [];
    for (const s of this.series) {
      if (!s.x.length) continue;
      g.strokeStyle = s.color;
      g.beginPath();
      for (let i = 0; i < s.x.length; i++) { const px = x(s.x[i]), py = y(s.y[i]); if (i === 0) g.moveTo(px, py); else g.lineTo(px, py); }
      g.stroke();
      const last = s.y.length - 1;
      ends.push({ y: y(s.y[last]), s, v: s.y[last] });
    }
    // Each name at its line's end, kept apart; the mark beside it carries the colour, the words stay in the text's.
    const placed = spreadLabels(ends.map((e) => e.y), 13, top + 5, bottom - 5);
    g.textAlign = "left";
    g.font = "11px system-ui, sans-serif";
    ends.forEach((e, i) => {
      const lx = width - this.right + 8;
      g.fillStyle = e.s.color;
      g.fillRect(lx, placed[i] - 1, 6, 2);
      g.fillStyle = text;
      const name = e.s.label.length > 12 ? `${e.s.label.slice(0, 11)}…` : e.s.label;
      g.fillText(name, lx + 10, placed[i]);
    });

    // Where the pointer is, a dot on each line.
    if (this.hovered !== null) {
      for (const s of this.series) {
        const i = nearest(s.x, this.hovered);
        if (i < 0) continue;
        const px = x(s.x[i]), py = y(s.y[i]);
        g.fillStyle = css(this.canvas, "--bg-1", "#1b1e25");
        g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill();
        g.fillStyle = s.color;
        g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
      }
    }
  }
}

/** Height of a lane. */
const LANE = 16;

/** A thin lane a player, with spans along the game's time (when each was supply blocked), named in the left margin. */
export class LaneChart extends Chart {
  private rows: LaneRow[] = [];
  private spanColour = "#e5484d";
  private readonly caption: string;

  constructor(host: ChartHost, tipAt: (frame: number) => HTMLElement | null, label: string) {
    super(host, 0, tipAt, label);
    this.caption = label;
  }

  set(rows: LaneRow[], end: number, colour?: string): void {
    this.rows = rows;
    this.end = Math.max(1, end);
    if (colour) this.spanColour = colour;
    this.canvas.style.height = `${4 + rows.length * LANE + (this.axis ? BOTTOM : 2)}px`;
    this.draw();
  }

  protected plot(g: CanvasRenderingContext2D, box: { x: (f: number) => number; top: number }): void {
    const { x } = box;
    const top = 4;
    const width = this.canvas.clientWidth, text = css(this.canvas, "--text", "#e4e8ef");
    // What the lanes are, in the margin where the line chart above has its numbers.
    g.font = "10px system-ui, sans-serif";
    g.textBaseline = "middle";
    g.textAlign = "right";
    g.fillStyle = css(this.canvas, "--text-dim", "#99a2b3");
    const words = this.caption.split(" ");
    words.forEach((word, i) => g.fillText(word, this.left - 6, top + (this.rows.length * LANE) / 2 + (i - (words.length - 1) / 2) * 11));
    g.font = "11px system-ui, sans-serif";
    this.rows.forEach((row, r) => {
      const y0 = top + r * LANE, h = LANE - 2;
      g.fillStyle = "rgba(255,255,255,0.04)";
      g.fillRect(this.left, y0, width - this.left - this.right, h);
      // The player's name at the right, as the line charts name theirs.
      const lx = width - this.right + 8;
      g.fillStyle = row.color;
      g.fillRect(lx, y0 + h / 2 - 1, 6, 2);
      g.fillStyle = text;
      g.textAlign = "left";
      g.fillText(row.label.length > 12 ? `${row.label.slice(0, 11)}…` : row.label, lx + 10, y0 + h / 2);
      g.fillStyle = this.spanColour;
      for (const s of row.spans) {
        const a = x(s.from), b = Math.max(a + 2, x(s.to));
        g.beginPath();
        g.roundRect(a, y0 + 2, b - a, h - 4, 2);
        g.fill();
      }
    });
  }
}

export interface GanttBar {
  from: number;
  to: number;
  /** What the bar is, written on it where there is room. */
  label: string;
  /** The game's icon, drawn at the bar's start; null while it loads or when there is none. */
  icon: () => HTMLCanvasElement | null;
  /** A building is drawn quieter than research, so the research stands out and the path of buildings still reads. */
  quiet: boolean;
}

export interface GanttGroup {
  /** Whose the bars are. */
  slot: number;
  label: string;
  color: string;
  bars: GanttBar[];
}

/** Height of a Gantt row: the icon (36 × 34 at half size) and a pixel round it. */
const ROW = 20, ICON_W = 18, ICON_H = 17, GROUP_GAP = 8;

/**
 * Bars along the game's time, a group of rows a player: each bar from when something began to when it was done,
 * its icon at the start and its name on it where it fits. The rows are packed so that no two bars (with their
 * icons) overlap; how many a player needs depends on the width, so the chart grows taller as it narrows.
 */
export class GanttChart extends Chart {
  private groups: GanttGroup[] = [];
  /** Where each bar was drawn, for the tooltip: [group, bar, x0, x1, y0]. */
  private placed: { group: number; bar: number; x0: number; x1: number; y0: number }[] = [];

  constructor(host: ChartHost, tipAt: (frame: number, at: { offsetX: number; offsetY: number }) => HTMLElement | null, label: string) {
    super(host, 40, tipAt, label);
  }

  set(groups: GanttGroup[], end: number): void {
    this.groups = groups;
    this.end = Math.max(1, end);
    this.draw();
  }

  /** The bar under a point of the chart (CSS pixels), or null. */
  barAt(offsetX: number, offsetY: number): { group: GanttGroup; bar: GanttBar } | null {
    for (const p of this.placed) {
      if (offsetX >= p.x0 - 1 && offsetX <= p.x1 + 1 && offsetY >= p.y0 && offsetY < p.y0 + ROW) {
        const group = this.groups[p.group];
        return { group, bar: group.bars[p.bar] };
      }
    }
    return null;
  }

  protected plot(g: CanvasRenderingContext2D, box: { x: (f: number) => number; top: number }): void {
    const { x } = box;
    const width = this.canvas.clientWidth, text = css(this.canvas, "--text", "#e4e8ef");
    this.placed = [];
    let y = 4;
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    this.groups.forEach((group, gi) => {
      const spans = group.bars.map((b) => ({ from: x(b.from), to: Math.max(x(b.to), x(b.from) + ICON_W) }));
      const rows = packRows(spans, 3);
      const count = Math.max(1, ...rows.map((r) => r + 1));
      // The group's ground, and the player's name at the right as the line charts name theirs.
      g.fillStyle = "rgba(255,255,255,0.03)";
      g.fillRect(this.left, y, width - this.left - this.right, count * ROW);
      const lx = width - this.right + 8;
      g.fillStyle = group.color;
      g.fillRect(lx, y + ROW / 2 - 1, 6, 2);
      g.fillStyle = text;
      g.textAlign = "left";
      g.fillText(group.label.length > 12 ? `${group.label.slice(0, 11)}…` : group.label, lx + 10, y + ROW / 2);
      group.bars.forEach((bar, bi) => {
        const y0 = y + rows[bi] * ROW, x0 = spans[bi].from, x1 = Math.max(x0 + 2, x(bar.to));
        this.placed.push({ group: gi, bar: bi, x0, x1: spans[bi].to, y0 });
        g.globalAlpha = bar.quiet ? 0.35 : 0.7;
        g.fillStyle = group.color;
        g.beginPath(); g.roundRect(x0, y0 + 3, x1 - x0, ROW - 6, 3); g.fill();
        g.globalAlpha = 1;
        const icon = bar.icon();
        if (icon) {
          g.fillStyle = "#12151c";
          g.fillRect(x0, y0 + 1, ICON_W, ICON_H + 1);
          g.drawImage(icon, x0, y0 + 1.5, ICON_W, ICON_H);
        }
        // The name, inside the bar after the icon, where it fits.
        const room = x1 - x0 - (icon ? ICON_W : 0) - 8;
        if (room > 24) {
          g.fillStyle = text;
          g.textAlign = "left";
          let label = bar.label;
          while (label.length > 3 && g.measureText(label).width > room) label = `${label.slice(0, -2)}…`;
          if (g.measureText(label).width <= room) g.fillText(label, x0 + (icon ? ICON_W : 0) + 4, y0 + ROW / 2);
        }
      });
      y += count * ROW + GROUP_GAP;
    });
    // As tall as the rows need, which the width decides. Set on the next frame, not while a resize is being
    // answered (which the browser calls a loop), and only when it changes, as setting it draws again.
    const want = `${Math.max(ROW, y - GROUP_GAP + 4) + (this.axis ? BOTTOM : 2)}px`;
    if (this.canvas.style.height !== want) requestAnimationFrame(() => { this.canvas.style.height = want; });
  }
}

/** Lay `spans` out in rows so that no two in a row overlap (`gap` apart at least), the earliest placed first. */
export function packRows(spans: readonly { from: number; to: number }[], gap = 0): number[] {
  const ends: number[] = [];
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].from - spans[b].from || spans[a].to - spans[b].to);
  const out = new Array<number>(spans.length);
  for (const i of order) {
    let r = ends.findIndex((end) => end + gap <= spans[i].from);
    if (r < 0) { r = ends.length; ends.push(-Infinity); }
    ends[r] = spans[i].to;
    out[i] = r;
  }
  return out;
}

/** The index of the entry of `xs` nearest `x`, -1 for none. */
export function nearest(xs: ArrayLike<number>, x: number): number {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x) ? lo - 1 : lo;
}
