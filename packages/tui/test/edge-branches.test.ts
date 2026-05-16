// ADR-0017 phase B.4: quick wins on small branch gaps.
import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.js";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.js";

describe("fuzzy.ts edge branches", () => {
	it("fuzzyFilter with whitespace-only query returns the original items unmodified (covers !query.trim() branch)", () => {
		const items = [{ name: "a" }, { name: "b" }];
		expect(fuzzyFilter(items, "   ", (i) => i.name)).toEqual(items);
		expect(fuzzyFilter(items, "", (i) => i.name)).toEqual(items);
	});

	it("fuzzyFilter with multiple tokens — all tokens must match each item", () => {
		const items = ["alpha bravo", "alpha", "bravo charlie"];
		const result = fuzzyFilter(items, "alpha bravo", (s) => s);
		expect(result).toContain("alpha bravo");
		expect(result).not.toContain("alpha"); // missing "bravo"
	});

	it("fuzzyMatch on a digit-alpha query (e.g. '1abc') exercises the numericAlpha swap branch", () => {
		// e.g. user types "1ab" intending "ab1"; the swap path retries with letters-then-digits
		const result = fuzzyMatch("1ab", "ab1");
		expect(result.matches).toBe(true);
	});

	it("fuzzyMatch on an alpha-digit query without any digit-numeric counterpart still works", () => {
		// "abc" has no swap candidate (no digits in query) → swappedQuery === "" → return primary.
		const result = fuzzyMatch("abc", "xyz");
		expect(result.matches).toBe(false);
	});

	it("fuzzyMatch — swapped match exists but primary already matches: primary score wins or swap bonus", () => {
		// "1a" against "a1": both primary and swapped should match; swap path's bonus may add to score.
		const result = fuzzyMatch("1a", "a1");
		expect(result.matches).toBe(true);
	});

	it("fuzzyFilter with a tokenizer-empty result returns items unmodified", () => {
		// Crafted: query that trims non-empty but splits to zero tokens. Practically '   ' → trim() === '' so first branch.
		// To reach the second `if (tokens.length === 0) return items;` we need a query that survives trim
		// but whose split(\s+) yields only empty strings — which is itself impossible after trim.
		// However the .filter((t) => t.length > 0) closes the loophole for inputs like single spaces.
		// This test covers the documented behavior: any query that yields zero usable tokens returns items.
		const items = ["a"];
		// "  " trimmed is "" → first branch.
		expect(fuzzyFilter(items, "  ", (s) => s)).toEqual(items);
	});
});

describe("keybindings.ts: setKeybindings + getResolvedBindings", () => {
	it("setKeybindings replaces the global singleton (covers setKeybindings)", () => {
		const fresh = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s" });
		setKeybindings(fresh);
		expect(getKeybindings().getKeys("tui.input.submit")).toEqual(["ctrl+s"]);
		// Restore defaults so other tests aren't affected.
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("getResolvedBindings returns single-string for one binding and array for multiple", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": ["enter", "ctrl+enter"] });
		const resolved = km.getResolvedBindings();
		// "tui.input.submit" has two keys → array.
		expect(Array.isArray(resolved["tui.input.submit"])).toBe(true);
		// Some other action has exactly one default key → string.
		const singleKeyActions = Object.entries(resolved).filter(([_, v]) => typeof v === "string");
		expect(singleKeyActions.length).toBeGreaterThan(0);
	});

	it("getResolvedBindings for an action with no keys returns an empty array (defensive)", () => {
		// Construct a KeybindingsManager with explicit empty bindings for a known action.
		const km = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": [] });
		const resolved = km.getResolvedBindings();
		// keys.length === 0 → falls into the `[...keys]` (array) branch.
		expect(resolved["tui.input.submit"]).toEqual([]);
	});

	it("getUserBindings returns a snapshot copy", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+x" });
		const a = km.getUserBindings();
		const b = km.getUserBindings();
		expect(a).not.toBe(b); // distinct objects (spread copy)
		expect(a).toEqual(b);
	});

	it("getDefinition returns the registered definition for an action (covers 207-208)", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS);
		const def = km.getDefinition("tui.input.submit");
		expect(def).toBeDefined();
	});

	it("setUserBindings replaces userBindings and rebuilds (covers 215-217)", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS);
		km.setUserBindings({ "tui.input.submit": "ctrl+s" });
		expect(km.getKeys("tui.input.submit")).toEqual(["ctrl+s"]);
		km.setUserBindings({});
		// Reverts to defaults — at least one default key.
		expect(km.getKeys("tui.input.submit").length).toBeGreaterThan(0);
	});

	it("getConflicts returns a snapshot copy with cloned arrays", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});
		const a = km.getConflicts();
		const b = km.getConflicts();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
		// Mutating returned copy must not affect a subsequent call.
		a[0]!.keybindings.push("polluted");
		expect(km.getConflicts()[0]!.keybindings).not.toContain("polluted");
	});
});

describe("fuzzy.ts: swappedMatch failure path", () => {
	it("query with digits where neither primary NOR swapped matches the text → returns no-match (89-90)", () => {
		// "1ab" against "xyz" — primary fails, swappedQuery="ab1" also fails.
		const result = fuzzyMatch("1ab", "xyz");
		expect(result.matches).toBe(false);
	});
});

describe("keybindings.ts: defensive ?? [] fallback branches", () => {
	it("matches() returns false for an unknown keybinding (covers keysById.get ?? [] branch at line 195)", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS);
		// Cast to bypass TS constraint — at runtime, an unknown id yields undefined → ?? [].
		expect(km.matches("a", "tui.bogus.action" as never)).toBe(false);
	});

	it("getKeys returns [] for an unknown keybinding (covers ?? [] at line 203)", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS);
		expect(km.getKeys("tui.bogus.action" as never)).toEqual([]);
	});
});
