/**
 * Share: a link to the replay in front, from its start or from the moment under the playhead, for whoever opens it to
 * watch or to play on from as one of its players. The link is the replay's on scmjs.dev
 * (`https://scmjs.dev/replay/<token>`), with `?t=6:42` for the moment and `&play=<slot>` for the player.
 *
 * Aftermath never talks to the server: the scmjs.dev plugin's `scmjs-dev.replays` service says where the replay stands
 * (nobody signed in, not on the account, kept) and gives its link, signing in and keeping it on the account first as
 * needed. A replay opened from a link came with that link, which is used as it is.
 *
 * The popover sits over the map above the Share button (the timeline it describes stays in view), and closes on Esc
 * and on a press anywhere else.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { FRAME_MS } from "@scm-js/replay";
import { formatTime } from "./analysis";
import type { ReplayStatus, ScmjsReplaysService } from "./vendor/scmjs-dev";

/* ── The moment and the link ── */

/**
 * The frame a link's moment (`t`, in seconds of game time) opens at: the first whose clock reads that second, so the
 * timeline says the time the link said. That is `round(seconds * 1000 / 42)` or one frame after it. Past the end is
 * the end.
 */
export function frameAt(seconds: number, last: number): number {
  return Math.max(0, Math.min(last, Math.ceil((seconds * 1000) / FRAME_MS - 1e-6)));
}

/** A link with the moment it opens at (`t=6:42`) and the player whoever opens it plays as (`play=<slot>`), or neither. */
export function withMoment(link: string, moment: { frame: number; play?: number | null } | null): string {
  const at = link.indexOf("?");
  const path = at < 0 ? link : link.slice(0, at);
  const params = (at < 0 ? "" : link.slice(at + 1)).split("&").filter((p) => p && !/^(t|play)(=|$)/.test(p));
  if (moment) {
    params.push(`t=${formatTime(moment.frame)}`);
    if (moment.play !== undefined && moment.play !== null) params.push(`play=${moment.play}`);
  }
  return params.length ? `${path}?${params.join("&")}` : path;
}

/** Whether "From <time>" is the one chosen when the popover opens: the playhead is past the first second. */
export const pastStart = (frame: number) => formatTime(frame) !== formatTime(0);

/* ── What the popover shows ── */

/** Where the replay stands for Share: being asked, or the scmjs.dev plugin's answer. */
export type ShareStatus = { state: "asking" } | ReplayStatus;

export interface ShareChoice {
  from: "start" | "time";
  who: "watch" | "play";
  /** The player whoever opens it plays as: a slot, as Play From Here hands the play page. */
  player: number | null;
}

export interface ShareView {
  /** The time under the playhead, for "From 6:42". */
  time: string;
  /** "Whoever opens it" is asked: a time is chosen. */
  who: boolean;
  /** The link as chosen; null until the replay has one. */
  link: string | null;
  /**
   * The one button: copy the link (made first for a replay kept without one), keep the replay and copy its link, sign
   * in; none while asking or when it cannot be shared.
   */
  action: "copy" | "keep" | "sign-in" | null;
  /** "Sharing keeps this replay on your scmjs.dev account." */
  keeps: boolean;
  /** Why it cannot be shared, in words. */
  reason: string | null;
}

export function shareView(status: ShareStatus, choice: ShareChoice, frame: number): ShareView {
  const who = choice.from === "time";
  const base = status.state === "kept" ? status.link : null;
  const moment = who ? { frame, play: choice.who === "play" ? choice.player : null } : null;
  const action = status.state === "kept" ? "copy"
    : status.state === "not-kept" ? "keep"
    : status.state === "signed-out" ? "sign-in"
    : null;
  return {
    time: formatTime(frame),
    who,
    link: base ? withMoment(base, moment) : null,
    action,
    // (A replay kept without a link only needs its link made: nothing new is kept.)
    keeps: status.state === "not-kept" || status.state === "signed-out",
    reason: status.state === "unavailable" ? status.reason : null,
  };
}

/* ── The popover ── */

export interface ShareDeps {
  api: PluginApi;
  /** The scmjs.dev plugin's service, or null when it is off. */
  service: () => ScmjsReplaysService | null;
  /** The frame under the playhead. */
  frame: () => number;
  /** The players to play as, by slot, with their names and races as shown. */
  players: () => { slot: number; label: string }[];
  /** The player being watched through, or null for everyone's eyes. */
  watching: () => number | null;
  /** A press there leaves the popover open (the timeline, whose playhead it follows). */
  keepsOpen?: (node: Node) => boolean;
}

/** What the popover is about: one replay, with the link it came with or was given. */
export interface ShareTarget {
  bytes: Uint8Array;
  fileName: string;
  link?: string;
}

const STYLE = `
.afm-share { position: fixed; z-index: 170; width: 300px; max-width: calc(100vw - 16px); box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; background: var(--bg-2, #191d25); border: 1px solid var(--border-strong, #3b4453); border-radius: var(--radius-lg, 5px); box-shadow: var(--shadow-pop, 0 10px 30px rgba(0,0,0,0.55)), var(--bevel-raised, none); font-size: var(--fs-md, 12.5px); color: var(--text, #dde2ea); }
.afm-share-title { font-weight: 600; font-size: var(--fs-lg, 14px); }
.afm-share-choices { display: flex; flex-direction: column; gap: 2px; }
.afm-share-who { display: flex; flex-direction: column; gap: 3px; }
.afm-share-who > span { color: var(--text-dim, #99a2b3); }
.afm-share-who select { width: 100%; min-width: 0; }
.afm-share input.afm-share-link { width: 100%; box-sizing: border-box; font-family: var(--font-mono, monospace); font-size: var(--fs-sm, 11.5px); }
.afm-share-line { color: var(--text-dim, #99a2b3); line-height: 1.4; }
.afm-share-error { color: var(--danger, #d9534f); line-height: 1.4; }
.afm-share-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.afm-share-buttons > button { flex: 1 1 auto; }
`;

/** How long the button says "Copied". */
const COPIED_MS = 1600;

export class SharePopover {
  private readonly deps: ShareDeps;
  private readonly t: PluginApi["i18n"]["t"];
  private root: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private target: ShareTarget | null = null;
  private status: ShareStatus = { state: "asking" };
  private choice: ShareChoice = { from: "start", who: "watch", player: null };
  private error: string | null = null;
  private busy = false;
  private choosing = false;
  private copiedUntil = 0;
  private copiedTimer = 0;
  private asked = 0;
  private unsubscribe: (() => void) | null = null;
  private style: HTMLStyleElement | null = null;
  /* What moves with the clock, kept to be changed in place. */
  private timeLabel: HTMLElement | null = null;
  private field: HTMLInputElement | null = null;
  private shownLink: string | null = null;
  private shownTime = "";
  /** Told the link a replay was given, so it is kept with the replay. */
  onLink: ((target: ShareTarget, link: string) => void) | null = null;

  constructor(deps: ShareDeps) {
    this.deps = deps;
    this.t = deps.api.i18n.t;
  }

  isOpen(): boolean { return this.root !== null; }
  /** The replay it is open on. */
  holds(target: ShareTarget): boolean { return this.target === target; }

  toggle(anchor: HTMLElement, target: ShareTarget): void {
    if (this.root && this.target === target) { this.close(); return; }
    this.open(anchor, target);
  }

  open(anchor: HTMLElement, target: ShareTarget): void {
    this.close();
    if (!this.style) { this.style = document.createElement("style"); this.style.textContent = STYLE; document.head.append(this.style); }
    this.anchor = anchor;
    this.target = target;
    this.error = null;
    this.busy = false;
    this.choosing = false;
    const frame = this.deps.frame();
    this.choice = { from: pastStart(frame) ? "time" : "start", who: "watch", player: this.deps.watching() ?? this.deps.players()[0]?.slot ?? null };
    this.root = this.deps.api.ui.el("div", { className: "afm-share", role: "dialog", "aria-label": this.t("Share this replay") });
    document.body.append(this.root);
    anchor.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.onPointer, true);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.place);
    window.addEventListener("blur", this.onBlur);
    // (The timeline's row scrolls sideways on a narrow strip: the popover stays over its button.)
    document.addEventListener("scroll", this.place, true);
    const service = this.deps.service();
    this.unsubscribe = service ? service.onChange(() => { if (!this.busy) this.ask(); }) : null;
    this.ask();
    this.render();
    // (The press that opened it hands the keys to the popover: Enter copies, Esc closes.)
    (this.root.querySelector<HTMLButtonElement>(".afm-share-buttons button:not([disabled])") ?? this.root.querySelector<HTMLElement>("input"))?.focus();
  }

  close = (): void => {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    this.anchor?.setAttribute("aria-expanded", "false");
    this.anchor = null;
    this.target = null;
    this.timeLabel = this.field = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    clearTimeout(this.copiedTimer);
    this.copiedUntil = 0;
    this.asked++;
    document.removeEventListener("pointerdown", this.onPointer, true);
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.place);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("scroll", this.place, true);
  };

  /** The timeline drew its row again: the popover stays with the new Share button. */
  anchorTo(anchor: HTMLElement): void {
    if (!this.root) return;
    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    this.place();
  }

  /** The clock moved: "From 6:42" and the link follow it, and the popover its button, which the row's other words move. */
  update(): void {
    if (!this.root) return;
    this.place();
    const view = this.view();
    if (view.time !== this.shownTime && this.timeLabel) { this.timeLabel.textContent = this.t("From {time}", { time: view.time }); this.shownTime = view.time; }
    if (view.link !== this.shownLink && this.field && view.link) { this.field.value = view.link; this.shownLink = view.link; this.field.scrollLeft = this.field.scrollWidth; }
  }

  private view(): ShareView {
    return shareView(this.status, this.choice, Math.round(this.deps.frame()));
  }

  /** Where the replay stands: the link it came with, or the scmjs.dev plugin's answer. */
  private ask(): void {
    const target = this.target;
    if (!target) return;
    const asked = ++this.asked;
    if (target.link) { this.status = { state: "kept", link: target.link }; return; }
    const service = this.deps.service();
    if (!service) { this.status = { state: "unavailable", reason: "" }; return; }
    this.status = { state: "asking" };
    void service.status({ bytes: target.bytes, fileName: target.fileName }).then((s) => {
      if (asked !== this.asked || !this.root) return;
      this.status = s;
      this.render();
    });
  }

  private render(): void {
    const root = this.root;
    if (!root) return;
    const { el, widgets: w } = this.deps.api.ui;
    const t = this.t;
    const view = this.view();
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.key ?? null : null;
    root.replaceChildren();
    root.append(el("div", { className: "afm-share-title" }, t("Share this replay")));

    // From the start, or from the moment under the playhead.
    const radio = (value: ShareChoice["from"], label: string) => {
      const box = w.checkbox(label, { radio: true, name: "afm-share-from", value: this.choice.from === value, onChange: (on) => { if (on) { this.choice.from = value; this.render(); } } });
      box.input.dataset.key = `from-${value}`;
      return box;
    };
    const fromTime = radio("time", t("From {time}", { time: view.time }));
    // (The label's span follows the clock.)
    this.timeLabel = fromTime.querySelector("span");
    this.shownTime = view.time;
    root.append(el("div", { className: "afm-share-choices" }, radio("start", t("From the start")), fromTime));

    // Whoever opens it: watches, or plays on as one of the players.
    if (view.who) {
      // (One menu: Watches, then Plays as each player, the one being watched through first.)
      const players = this.deps.players();
      const watching = this.deps.watching();
      const order = [...players.filter((p) => p.slot === watching), ...players.filter((p) => p.slot !== watching)];
      const value = this.choice.who === "play" && this.choice.player !== null ? String(this.choice.player) : "watch";
      const pick = w.select([{ value: "watch", label: t("Watches") }, ...order.map((p) => ({ value: String(p.slot), label: t("Plays as {name}", { name: p.label }) }))], {
        value, title: t("Whoever opens it"),
        onChange: (v) => {
          if (v === "watch") this.choice.who = "watch";
          else { this.choice.who = "play"; this.choice.player = Number(v); }
          this.update();
        },
      });
      pick.dataset.key = "who";
      root.append(el("label", { className: "afm-share-who" }, el("span", {}, t("Whoever opens it")), pick));
    }

    // The link, once the replay has one.
    this.field = null;
    this.shownLink = view.link;
    if (view.link) {
      const field = w.text({ value: view.link });
      field.readOnly = true;
      field.className = `${field.className} afm-share-link`.trim();
      field.setAttribute("aria-label", t("Link"));
      field.dataset.key = "link";
      field.addEventListener("focus", () => field.select());
      this.field = field;
      root.append(field);
      // (The end of the link is what the choices change: it is what is shown.)
      requestAnimationFrame(() => { field.scrollLeft = field.scrollWidth; });
    }
    if (view.keeps) root.append(el("div", { className: "afm-share-line" }, t("Sharing keeps this replay on your scmjs.dev account.")));
    const reason = view.reason ?? this.error;
    if (reason) root.append(el("div", { className: "afm-share-error", role: "alert" }, reason));

    // The one button.
    const buttons = el("div", { className: "afm-share-buttons" });
    const status = this.status;
    if (this.choosing && status.state === "signed-out") {
      for (const p of status.providers) {
        const b = w.button(t("Sign in with {name}", { name: p.name }), { busy: this.busy, onClick: () => this.share(p.id) });
        b.dataset.key = `provider-${p.id}`;
        buttons.append(b);
      }
    } else if (view.action || status.state === "asking") {
      const copied = view.action === "copy" && Date.now() < this.copiedUntil;
      const label = view.action === "copy" ? (copied ? t("Copied") : t("Copy link"))
        : view.action === "sign-in" ? t("Sign in to share")
        : t("Keep and copy link");
      const b = w.button(label, { primary: true, busy: this.busy || status.state === "asking", onClick: () => this.press() });
      b.dataset.key = "action";
      buttons.append(b);
    }
    if (buttons.childElementCount) root.append(buttons);
    if (focused) root.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
    this.place();
  }

  private press(): void {
    const view = this.view();
    if (view.link) { void this.copy(view.link); return; }
    const status = this.status;
    if (status.state === "signed-out" && status.providers.length > 1) { this.choosing = true; this.render(); return; }
    this.share(status.state === "signed-out" ? status.providers[0]?.id : undefined);
  }

  /** Sign in if need be, keep the replay, get its link (the scmjs.dev plugin does all three), and copy it. */
  private share(provider?: string): void {
    const service = this.deps.service();
    const target = this.target;
    if (!service || !target || this.busy) return;
    this.busy = true;
    this.error = null;
    const asked = this.asked;
    // (Called in the press itself: the sign-in window opens on it.)
    const linking = service.link({ bytes: target.bytes, fileName: target.fileName }, provider);
    this.render();
    void linking.then(
      (link) => {
        target.link = link;
        this.onLink?.(target, link);
        if (asked !== this.asked || this.target !== target) return;
        this.busy = false;
        this.choosing = false;
        this.status = { state: "kept", link };
        this.render();
        const full = this.view().link;
        if (full) void this.copy(full);
      },
      (err: unknown) => {
        if (asked !== this.asked || this.target !== target) return;
        this.busy = false;
        const code = (err as { code?: string }).code;
        this.error = code === "aborted" ? null : err instanceof Error ? err.message : String(err);
        // (Signed in after all, or not: the button says what is left to do.)
        this.ask();
        this.render();
      },
    );
  }

  private async copy(link: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // (The browser would not let the page write it, after a sign-in window say: the link is selected to copy by hand.)
      this.field?.focus();
      this.field?.select();
      return;
    }
    if (!this.root) return;
    this.copiedUntil = Date.now() + COPIED_MS;
    clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => this.render(), COPIED_MS + 20);
    this.render();
  }

  /** Over the map above the Share button, so the timeline stays in view; below it, or at the top, when there is no room. */
  place = (): void => {
    const root = this.root, anchor = this.anchor;
    if (!root || !anchor || !anchor.isConnected) return;
    const gap = 6, edge = 8;
    const a = anchor.getBoundingClientRect();
    const w = root.offsetWidth, h = root.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(edge, Math.min(vw - w - edge, a.right - w));
    const above = a.top - gap - h;
    const below = a.bottom + gap;
    const top = above >= edge ? above : below + h <= vh - edge ? below : Math.max(edge, vh - h - edge);
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  };

  private onPointer = (e: PointerEvent): void => {
    const target = e.target as Node | null;
    if (!this.root || !target) return;
    if (this.root.contains(target) || this.anchor?.contains(target) || this.deps.keepsOpen?.(target)) return;
    this.close();
  };

  /** A press in a frame on the page (the Game view) is a press outside too, though the page never hears it. */
  private onBlur = (): void => {
    setTimeout(() => { if (this.root && document.activeElement instanceof HTMLIFrameElement) this.close(); }, 0);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.root) return;
    // (Keys pressed in the popover are its own: Space presses its button, the arrows move in its menu, and the
    // timeline's keys wait until it closes.)
    if (e.key !== "Escape") { if (this.root.contains(document.activeElement)) e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
    const anchor = this.anchor;
    this.close();
    anchor?.focus();
  };

  dispose(): void {
    this.close();
    this.style?.remove();
    this.style = null;
  }
}
