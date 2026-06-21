/**
 * Behavior tests for the keybindings DISPATCH surface.
 *
 * These drive the real `KeybindingsManager` end-to-end: a human key spec
 * (e.g. "ctrl+a", "shift+enter", "ctrl+shift+p") is resolved into the manager's
 * internal key list, and a real terminal byte sequence (a genuine KeyEvent) is
 * fed through `matches()` to assert it does / does not fire the keybinding.
 *
 * Scope vs. existing tests:
 *   - keys.test.ts covers `matchesKey`/`parseKey` at the byte-decoding layer.
 *   - keybindings.test.ts + keybindings-coverage.test.ts cover the manager's
 *     dedup / conflict / resolved-binding bookkeeping with synthetic specs.
 *
 * What is NEW here: asserting that real terminal bytes flow through the
 * manager's binding map and produce the right match result, that user
 * overrides actually change which bytes fire an action, that case-insensitive
 * and reordered modifier specs behave as documented, and that the global
 * registry (getKeybindings/setKeybindings) is honored. No mocks — the real
 * keys.ts decoder runs underneath.
 */
import { describe, expect, it } from "vitest";
import {
	getKeybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "../src/keybindings.js";
import { matchesKey, setKittyProtocolActive } from "../src/keys.js";

// Raw control bytes for ctrl+<letter>: ASCII letter & 0x1f.
const ctrl = (letter: string): string => String.fromCharCode(letter.toLowerCase().charCodeAt(0) & 0x1f);

const fresh = (overrides: KeybindingsConfig = {}): KeybindingsManager =>
	new KeybindingsManager(TUI_KEYBINDINGS, overrides);

describe("KeybindingsManager.matches — real bytes through default bindings", () => {
	it("fires editor.cursorLineStart for either of its default keys (home seq OR raw ctrl+a)", () => {
		const km = fresh();
		// Default: ["home", "ctrl+a"]. Both must fire; a third unrelated byte must not.
		expect(km.matches("\x1b[H", "tui.editor.cursorLineStart")).toBe(true); // home (legacy CSI)
		expect(km.matches("\x1bOH", "tui.editor.cursorLineStart")).toBe(true); // home (SS3 form)
		expect(km.matches(ctrl("a"), "tui.editor.cursorLineStart")).toBe(true); // raw ctrl+a (0x01)
		expect(km.matches("\x1b[F", "tui.editor.cursorLineStart")).toBe(false); // end seq must NOT fire line-start
	});

	it("distinguishes plain enter (submit) from shift+enter (newLine) for the SAME logical key", () => {
		const km = fresh();
		// submit default = "enter"; newLine default = "shift+enter".
		expect(km.matches("\r", "tui.input.submit")).toBe(true);
		expect(km.matches("\r", "tui.input.newLine")).toBe(false);

		// shift+enter arrives as xterm modifyOtherKeys: CSI 27 ; 2 ; 13 ~  (mod 2 = shift).
		const shiftEnter = "\x1b[27;2;13~";
		expect(km.matches(shiftEnter, "tui.input.newLine")).toBe(true);
		expect(km.matches(shiftEnter, "tui.input.submit")).toBe(false);
	});

	it("shares ctrl+c across input.copy and select.cancel (real overlapping default)", () => {
		const km = fresh();
		const ctrlC = ctrl("c"); // 0x03
		expect(km.matches(ctrlC, "tui.input.copy")).toBe(true);
		// select.cancel default = ["escape", "ctrl+c"] — both real bytes fire it.
		expect(km.matches(ctrlC, "tui.select.cancel")).toBe(true);
		expect(km.matches("\x1b", "tui.select.cancel")).toBe(true);
		// ...but ctrl+c does NOT fire submit.
		expect(km.matches(ctrlC, "tui.input.submit")).toBe(false);
	});

	it("fires cursorWordLeft for every one of its three default forms", () => {
		const km = fresh();
		// defaults: ["alt+left", "ctrl+left", "alt+b"]
		expect(km.matches("\x1b[1;3D", "tui.editor.cursorWordLeft")).toBe(true); // alt+left (CSI)
		expect(km.matches("\x1b[1;5D", "tui.editor.cursorWordLeft")).toBe(true); // ctrl+left (CSI)
		expect(km.matches("\x1bb", "tui.editor.cursorWordLeft")).toBe(true); // alt+b (legacy ESC-prefixed)
		// A plain (unmodified) left arrow must NOT count as a word-left jump.
		expect(km.matches("\x1b[D", "tui.editor.cursorWordLeft")).toBe(false);
		// ...it fires cursorLeft instead.
		expect(km.matches("\x1b[D", "tui.editor.cursorLeft")).toBe(true);
	});

	it("decodes the ctrl+- undo binding from its raw control byte (0x1f)", () => {
		const km = fresh();
		expect(km.matches("\x1f", "tui.editor.undo")).toBe(true);
		expect(km.matches(ctrl("u"), "tui.editor.undo")).toBe(false); // ctrl+u is deleteToLineStart, not undo
		expect(km.matches(ctrl("u"), "tui.editor.deleteToLineStart")).toBe(true);
	});

	it("returns false for an action that has no keys, never throwing", () => {
		const km = fresh({ "tui.input.tab": [] }); // override to an empty binding list
		expect(km.getKeys("tui.input.tab")).toEqual([]);
		expect(km.matches("\t", "tui.input.tab")).toBe(false);
	});
});

describe("KeybindingsManager.matches — user override precedence", () => {
	it("an override REPLACES the default keys: old bytes stop firing, new bytes start", () => {
		const km = fresh({ "tui.editor.cursorLineStart": "ctrl+g" });
		// New binding fires.
		expect(km.matches(ctrl("g"), "tui.editor.cursorLineStart")).toBe(true);
		// Both former defaults (home seq AND raw ctrl+a) no longer fire — replacement, not merge.
		expect(km.matches("\x1b[H", "tui.editor.cursorLineStart")).toBe(false);
		expect(km.matches(ctrl("a"), "tui.editor.cursorLineStart")).toBe(false);
		expect(km.getKeys("tui.editor.cursorLineStart")).toEqual(["ctrl+g"]);
	});

	it("overriding one action leaves other actions' defaults intact (no cross-eviction)", () => {
		const km = fresh({ "tui.input.submit": ["enter", "ctrl+enter"] });
		// The unrelated select.confirm still resolves to its default and still fires on plain enter.
		expect(km.getKeys("tui.select.confirm")).toEqual(["enter"]);
		expect(km.matches("\r", "tui.select.confirm")).toBe(true);
		// And the overridden submit still fires on plain enter too.
		expect(km.matches("\r", "tui.input.submit")).toBe(true);
	});

	it("setUserBindings rebuilds the live map so matching switches immediately", () => {
		const km = fresh();
		expect(km.matches("\r", "tui.input.submit")).toBe(true);

		km.setUserBindings({ "tui.input.submit": "ctrl+s" });
		expect(km.matches("\r", "tui.input.submit")).toBe(false); // enter no longer submits
		expect(km.matches(ctrl("s"), "tui.input.submit")).toBe(true); // ctrl+s now does

		// Reverting to empty user bindings restores the defaults.
		km.setUserBindings({});
		expect(km.matches("\r", "tui.input.submit")).toBe(true);
		expect(km.matches(ctrl("s"), "tui.input.submit")).toBe(false);
	});

	it("getResolvedBindings round-trips back into a manager that matches identically", () => {
		const original = fresh({ "tui.input.submit": ["enter", "ctrl+s"] });
		const resolved = original.getResolvedBindings();

		// Output SHAPE is load-bearing: a single-key binding is emitted as a bare
		// KeyId (not a 1-element array), a multi-key binding as an array. This pins
		// the `keys.length === 1 ? keys[0] : [...keys]` branch — a mutation that
		// always wraps in an array would still "work" on round-trip but changes the
		// observable config shape, so assert it directly.
		expect(resolved["tui.input.submit"]).toEqual(["enter", "ctrl+s"]); // 2 keys -> array
		expect(resolved["tui.editor.undo"]).toBe("ctrl+-"); // 1 key -> bare scalar, NOT ["ctrl+-"]
		expect(resolved["tui.input.tab"]).toBe("tab"); // single default -> bare scalar
		expect(Array.isArray(resolved["tui.editor.undo"])).toBe(false);

		const rebuilt = new KeybindingsManager(TUI_KEYBINDINGS, resolved);

		// Overridden action survives the round-trip.
		expect(rebuilt.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+s"]);
		expect(rebuilt.matches(ctrl("s"), "tui.input.submit")).toBe(true);
		// A scalar-resolved action survives and still matches its single byte.
		expect(rebuilt.getKeys("tui.editor.undo")).toEqual(["ctrl+-"]);
		expect(rebuilt.matches("\x1f", "tui.editor.undo")).toBe(true);
		// Untouched action (cursorLeft) keeps its full default set after round-trip.
		expect(rebuilt.matches("\x1b[D", "tui.editor.cursorLeft")).toBe(true);
		expect(rebuilt.matches(ctrl("b"), "tui.editor.cursorLeft")).toBe(true);
	});

	it("getUserBindings hands back a defensive copy that cannot mutate the manager", () => {
		const km = fresh({ "tui.input.submit": "ctrl+s" });
		const copy = km.getUserBindings();
		copy["tui.input.submit"] = "ctrl+x";
		copy["tui.editor.undo"] = "ctrl+z";
		// Internal state is untouched: ctrl+s still fires, ctrl+x does not.
		expect(km.matches(ctrl("s"), "tui.input.submit")).toBe(true);
		expect(km.matches(ctrl("x"), "tui.input.submit")).toBe(false);
		expect(km.getUserBindings()["tui.editor.undo"]).toBeUndefined();
	});
});

describe("matchesKey spec parsing — case-insensitivity, reordering, invalid input", () => {
	it("treats key specs case-insensitively (CTRL+B / Ctrl+B / ctrl+b all match ctrl-b bytes)", () => {
		const ctrlB = ctrl("b"); // 0x02
		expect(matchesKey(ctrlB, "ctrl+b")).toBe(true);
		expect(matchesKey(ctrlB, "Ctrl+B")).toBe(true);
		expect(matchesKey(ctrlB, "CTRL+B" as never)).toBe(true);
	});

	it("ignores modifier order in the spec (ctrl+shift+p === shift+ctrl+p) for a real event", () => {
		setKittyProtocolActive(true);
		try {
			// Kitty CSI-u for ctrl+shift+p: codepoint 112 ('p'), modifier byte 6 (ctrl|shift +1).
			const ctrlShiftP = "\x1b[112;6u";
			expect(matchesKey(ctrlShiftP, "ctrl+shift+p")).toBe(true);
			expect(matchesKey(ctrlShiftP, "shift+ctrl+p")).toBe(true);
		} finally {
			setKittyProtocolActive(false);
		}
	});

	it("rejects unknown / malformed / empty specs without throwing", () => {
		expect(matchesKey("x", "frobnicate" as never)).toBe(false);
		expect(matchesKey("x", "" as never)).toBe(false);
		expect(matchesKey("x", "ctrl+" as never)).toBe(false); // trailing '+' -> empty base key
		expect(matchesKey("x", "ctrl+notakey" as never)).toBe(false);
	});

	it("a manager built around an unknown spec simply never matches", () => {
		// User points an action at a key id that the byte decoder cannot recognize.
		const km = fresh({ "tui.input.submit": "frobnicate" as never });
		expect(km.getKeys("tui.input.submit")).toEqual(["frobnicate"]);
		expect(km.matches("\r", "tui.input.submit")).toBe(false);
		expect(km.matches("frobnicate", "tui.input.submit")).toBe(false);
	});
});

describe("global keybinding registry", () => {
	it("getKeybindings returns a stable lazily-initialized singleton, replaceable via setKeybindings", () => {
		const first = getKeybindings();
		expect(getKeybindings()).toBe(first); // same instance on repeat calls

		const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s" });
		setKeybindings(custom);
		try {
			expect(getKeybindings()).toBe(custom);
			expect(getKeybindings().matches(ctrl("s"), "tui.input.submit")).toBe(true);
			expect(getKeybindings().matches("\r", "tui.input.submit")).toBe(false);
		} finally {
			// Restore a clean default manager so other suites are not affected by
			// this module-level mutable state (see realBugRisks).
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});
});

describe("conflict detection vs. real-event ambiguity (regression: modifier-order)", () => {
	it("flags two actions bound to the byte-identical spec as a conflict", () => {
		const km = fresh({
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});
		const conflicts = km.getConflicts();
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.key).toBe("ctrl+x");
		expect(conflicts[0]!.keybindings.sort()).toEqual(["tui.input.submit", "tui.select.confirm"]);
	});

	it("DOES NOT flag a conflict when two actions bind the same physical key via different modifier order", () => {
		// REAL DEFECT: conflict detection compares spec strings verbatim, but the
		// decoder normalizes modifier order. "ctrl+shift+p" and "shift+ctrl+p" are
		// the SAME physical key, yet they are not reported as conflicting...
		const km = fresh({
			"tui.input.submit": "ctrl+shift+p",
			"tui.input.tab": "shift+ctrl+p",
		});
		expect(km.getConflicts()).toEqual([]); // <-- documents the missed conflict

		// ...even though ONE real key event fires BOTH actions — silent ambiguity.
		setKittyProtocolActive(true);
		try {
			const event = "\x1b[112;6u"; // ctrl+shift+p
			expect(km.matches(event, "tui.input.submit")).toBe(true);
			expect(km.matches(event, "tui.input.tab")).toBe(true);
		} finally {
			setKittyProtocolActive(false);
		}
	});
});

describe("dispatch throughput", () => {
	it("matches a burst of realistic key events across many bindings well under budget", () => {
		const km = fresh();
		const events = [
			"\r", // enter
			"\x1b", // escape
			ctrl("c"),
			ctrl("a"),
			"\x1b[D", // left
			"\x1b[C", // right
			"\x1b[1;5D", // ctrl+left
			"\x1b[27;2;13~", // shift+enter
			"\x1bb", // alt+b
			"\x1f", // ctrl+-
			"\t", // tab
			ctrl("k"),
		];
		const bindings = Object.keys(TUI_KEYBINDINGS) as Array<keyof typeof TUI_KEYBINDINGS>;

		const iterations = 2000;
		const start = performance.now();
		let matchCount = 0;
		for (let i = 0; i < iterations; i++) {
			const data = events[i % events.length]!;
			for (const binding of bindings) {
				if (km.matches(data, binding)) matchCount++;
			}
		}
		const elapsedMs = performance.now() - start;

		// Real work happened (some events fire at least one binding); the exact
		// count is deterministic given the fixed event/binding sets, so pin it so a
		// mutation that silently stops scanning bindings cannot pass the timer alone.
		expect(matchCount).toBe(2334);
		// ~2000 * 32 bindings = 64k full match scans: ~18ms on an idle desktop, but
		// a loaded CI runner has been observed at ~140ms. The ceiling only guards
		// against an order-of-magnitude / O(n^2) regression (seconds at this size),
		// not an aspirational latency target — so it sits well above loaded-CI noise,
		// matching the input-loop guard in tui-input.behavior.test.ts.
		expect(elapsedMs).toBeLessThan(1000);
	});
});
