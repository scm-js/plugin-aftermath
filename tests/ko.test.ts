import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPLAY_ERRORS } from "@scm-js/replay";
import { KO } from "../ko";

// Every literal the plugin shows through `t("…")` / `api.i18n.t("…")`, or keeps in a table as `msg("…")`,
// read from the source the way the editor's own extractor reads it; and the replay reader's errors (@scm-js/replay's
// REPLAY_ERRORS), which the plugin shows translated.
const files = ["plugin.ts", "analysis.ts", "chk.ts", "insight.ts", "techview.ts", "scoutview.ts"];
const sources = files.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const keys = new Set([...sources.flatMap((source) => [...source.matchAll(/\b(?:t|msg)\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)), ...REPLAY_ERRORS]);

/** The placeholders a string fills: `{name}`, `{n, plural, …}`, `{name|을}` — not the words inside a plural's branches. */
const names = (s: string) => new Set([...s.matchAll(/\{(\w+)(?=[},|])/g)].map((m) => m[1]));
/** The ones only English needs: the count a plural chooses its branch by. */
const counts = (s: string) => new Set([...s.matchAll(/\{(\w+), plural/g)].map((m) => m[1]));

describe("the Korean catalogue", () => {
  it("has every string the plugin shows", () => {
    expect([...keys].filter((k) => !(k in KO))).toEqual([]);
  });

  it("has nothing the plugin no longer shows", () => {
    expect(Object.keys(KO).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("keeps every placeholder, and adds none", () => {
    for (const [en, ko] of Object.entries(KO)) {
      const want = [...names(en)].filter((n) => !counts(en).has(n) || names(ko).has(n)).sort();
      expect([...names(ko)].sort(), en).toEqual(want);
    }
  });
});
