/**
 * The game's icons in the Analysis window and the side panel: a slot that shows a unit's, an upgrade's or a
 * technology's icon, filled in when the pictures arrive.
 *
 * The icons load lazily, and a copy of the game data installed before the editor kept them has none at all. A unit with
 * no icon is shown by its picture on the map (not a building, which shrinks past reading); until either arrives, or for
 * good when neither can, a slot shows the name instead, or nothing where the name is beside it already.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { isBuilding } from "./played";

export type IconKind = "unit" | "upgrade" | "tech";

export interface IconOptions {
  /** What it is, for the tooltip. */
  title: string;
  /** What the slot says until a picture comes (none: it takes no room meanwhile). */
  text?: string;
  small?: boolean;
  /** Fill it when pictures arrive (not a tooltip's, which is asked again anyway). */
  wait?: boolean;
  /** Whose colours a unit's picture takes. */
  owner?: number;
}

export interface Icons {
  /** The best picture there is now: the icon, or for a unit (not a building) its picture on the map. */
  picture(kind: IconKind, id: number, owner: number): { image: HTMLCanvasElement; width: number; height: number; icon: boolean } | null;
  /** A slot showing the icon. */
  icon(kind: IconKind, id: number, options: IconOptions): HTMLElement;
  /** Fill the slots waiting, and call `then` (a chart drawing again), whenever pictures arrive; null on an editor that does not say. */
  watch(then?: () => void): { dispose(): void } | null;
}

export function icons(api: PluginApi): Icons {
  const el = api.ui.el;
  type Kind = IconKind;
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
  return {
    picture,
    icon: (kind, id, options) => icon(kind, id, options),
    watch(then) {
      if (typeof api.graphics.onImageLoaded !== "function") return null;
      return api.graphics.onImageLoaded(() => {
        // (A slot no longer on the page, from a list drawn again since, is let go.)
        for (let i = waiting.length - 1; i >= 0; i--) if (!waiting[i].slot.isConnected || fill(waiting[i].slot, waiting[i].kind, waiting[i].id, waiting[i].owner)) waiting.splice(i, 1);
        then?.();
      });
    },
  };
}
