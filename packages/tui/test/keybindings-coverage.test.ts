// Additional branch coverage for KeybindingsManager: undefined defaultKeys,
// user bindings referencing unknown actions, and conflict detection.
import { describe, expect, it } from "vitest";
import { type KeybindingDefinitions, KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.js";

describe("KeybindingsManager — defensive branches", () => {
	it("treats a definition with undefined defaultKeys as having no keys", () => {
		// normalizeKeys(undefined) -> [] : exercises the `keys === undefined` branch.
		const defs: KeybindingDefinitions = {
			"custom.action": { defaultKeys: undefined as never, description: "no default" },
		};
		const km = new KeybindingsManager(defs);
		expect(km.getKeys("custom.action" as never)).toEqual([]);
		// getResolvedBindings: keys.length === 0 -> the array branch
		expect(km.getResolvedBindings()["custom.action"]).toEqual([]);
		// matches() against an action with no keys is false
		expect(km.matches("a", "custom.action" as never)).toBe(false);
	});

	it("ignores user bindings that reference an action not present in the definitions", () => {
		// "not.a.real.action" is not in TUI_KEYBINDINGS -> the `!(keybinding in definitions)` continue branch.
		const km = new KeybindingsManager(TUI_KEYBINDINGS, {
			"not.a.real.action": "ctrl+x",
			"tui.input.submit": "ctrl+s",
		});
		// The bogus binding does not register and does not produce a conflict.
		expect(km.getConflicts()).toEqual([]);
		// The valid binding still applies.
		expect(km.getKeys("tui.input.submit")).toEqual(["ctrl+s"]);
	});

	it("normalizeKeys deduplicates repeated keys in a user binding", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "enter", "ctrl+s", "ctrl+s"],
		});
		expect(km.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+s"]);
	});

	it("getResolvedBindings returns the lone key as a string and multiple keys as an array", () => {
		const defs: KeybindingDefinitions = {
			"single.key": { defaultKeys: "enter", description: "one key" },
			"multi.key": { defaultKeys: ["ctrl+a", "ctrl+b"], description: "two keys" },
			"empty.key": { defaultKeys: [], description: "no keys" },
		};
		const km = new KeybindingsManager(defs);
		const resolved = km.getResolvedBindings();
		expect(resolved["single.key"]).toBe("enter");
		expect(resolved["multi.key"]).toEqual(["ctrl+a", "ctrl+b"]);
		expect(resolved["empty.key"]).toEqual([]);
	});

	it("a user binding that claims the same key for multiple actions is reported as a conflict", () => {
		const km = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.undo": ["ctrl+q", "ctrl+q"],
			"tui.input.tab": "ctrl+q",
		});
		const conflicts = km.getConflicts();
		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.key).toBe("ctrl+q");
		expect(conflicts[0]!.keybindings.sort()).toEqual(["tui.editor.undo", "tui.input.tab"]);
	});
});
