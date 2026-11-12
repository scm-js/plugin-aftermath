import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPLAY_ERRORS } from "@scm-js/replay";
import { KO } from "../ko";
import { MOD_WORD_TEXTS } from "../modreplay";

// Every literal the plugin shows through `t("…")` / `api.i18n.t("…")`, or keeps in a table as `msg("…")`,
// read from the source the way the editor's own extractor reads it; and the replay reader's errors (@scm-js/replay's
// REPLAY_ERRORS) and the mod reader's sentences it shows (@scm-js/mod's, MOD_WORDS), which the plugin shows translated.
const files = ["plugin.ts", "analysis.ts", "chk.ts", "insight.ts", "techview.ts", "scoutview.ts"];
const sources = files.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const keys = new Set([...sources.flatMap((source) => [...source.matchAll(/\b(?:t|msg)\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string)), ...REPLAY_ERRORS, ...MOD_WORD_TEXTS]);

/** The brace that closes the one at `open`. */
const closing = (s: string, open: number) => { let depth = 0; for (let i = open; i < s.length; i++) { if (s[i] === "{") depth++; else if (s[i] === "}" && --depth === 0) return i; } return s.length; };
/**
 * The placeholders a string fills: `{name}`, `{n, plural, …}`, `{x, select, …}`, `{name|을}` — and those inside a
 * plural's or a select's branches, never the braces of a branch itself (`other {them}` is a word, not a placeholder).
 */
const names = (s: string, out = new Set<string>()) => {
  for (let open = s.indexOf("{"); open >= 0; open = s.indexOf("{", open)) {
    const close = closing(s, open), inner = s.slice(open + 1, close);
    const m = /^(\w+)(?:\s*,\s*(?:plural|select)\s*,([\s\S]*))?(?:\|[^}]*)?$/.exec(inner);
    if (m) {
      out.add(m[1]);
      // (each branch's text, `key {text}`, read for placeholders of its own)
      if (m[2] !== undefined) for (let b = m[2].indexOf("{"); b >= 0; b = m[2].indexOf("{", closing(m[2], b) + 1)) names(m[2].slice(b + 1, closing(m[2], b)), out);
    }
    open = close + 1;
  }
  return out;
};
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
