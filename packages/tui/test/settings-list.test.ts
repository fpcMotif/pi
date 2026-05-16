// Coverage for the SettingsList component: rendering of the main list,
// scrolling, descriptions, search mode, submenu open/close, value cycling,
// and keyboard input handling.
import assert from "node:assert";
import { describe, it } from "vitest";
import type { Component } from "../src/tui.js";
import { type SettingItem, SettingsList, type SettingsListTheme } from "../src/components/settings-list.js";

const theme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const strip = (lines: string[]): string => lines.join("\n");

describe("SettingsList", () => {
	it("renders an empty-state hint when there are no items", () => {
		const list = new SettingsList(
			[],
			5,
			theme,
			() => {},
			() => {},
		);
		const out = list.render(60);
		assert.ok(strip(out).includes("No settings available"));
	});

	it("renders items with label, value, and the cursor on the selected row", () => {
		const items: SettingItem[] = [
			{ id: "a", label: "Theme", currentValue: "dark" },
			{ id: "b", label: "Mode", currentValue: "fast" },
		];
		const list = new SettingsList(
			items,
			5,
			theme,
			() => {},
			() => {},
		);
		const out = list.render(60);
		assert.ok(out[0].startsWith("> "), "selected row gets the cursor prefix");
		assert.ok(out[0].includes("Theme"));
		assert.ok(out[0].includes("dark"));
		assert.ok(out[1].startsWith("  "), "non-selected row gets blank prefix");
		assert.ok(out[1].includes("Mode"));
		// Hint line is always added at the bottom
		assert.ok(strip(out).includes("Enter/Space to change"));
	});

	it("renders a description for the selected item", () => {
		const items: SettingItem[] = [{ id: "a", label: "Theme", currentValue: "dark", description: "Pick a color theme" }];
		const list = new SettingsList(
			items,
			5,
			theme,
			() => {},
			() => {},
		);
		const out = list.render(60);
		assert.ok(strip(out).includes("Pick a color theme"));
	});

	it("shows a scroll indicator when the item list exceeds maxVisible", () => {
		const items: SettingItem[] = Array.from({ length: 10 }, (_, i) => ({
			id: `i${i}`,
			label: `Item ${i}`,
			currentValue: `v${i}`,
		}));
		const list = new SettingsList(
			items,
			3,
			theme,
			() => {},
			() => {},
		);
		// Move selection down so scrolling kicks in
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		const out = list.render(60);
		assert.ok(/\(\d+\/10\)/.test(strip(out)), "scroll indicator should show position/total");
	});

	it("up/down arrows wrap around the item list", () => {
		const items: SettingItem[] = [
			{ id: "a", label: "A", currentValue: "1" },
			{ id: "b", label: "B", currentValue: "2" },
			{ id: "c", label: "C", currentValue: "3" },
		];
		const list = new SettingsList(
			items,
			5,
			theme,
			() => {},
			() => {},
		);
		// Up from index 0 wraps to last item
		list.handleInput("\x1b[A");
		assert.ok(list.render(60)[2].startsWith("> "), "up wraps selection to last item");
		// Down from last item wraps back to first
		list.handleInput("\x1b[B");
		assert.ok(list.render(60)[0].startsWith("> "), "down wraps selection to first item");
		// Down to middle, then up to a non-zero index (exercises selectedIndex - 1 arm)
		list.handleInput("\x1b[B"); // index 1
		list.handleInput("\x1b[A"); // back to index 0 via selectedIndex - 1
		assert.ok(list.render(60)[0].startsWith("> "));
	});

	it("up/down are no-ops when there are no items", () => {
		const list = new SettingsList(
			[],
			5,
			theme,
			() => {},
			() => {},
		);
		assert.doesNotThrow(() => {
			list.handleInput("\x1b[A");
			list.handleInput("\x1b[B");
		});
	});

	it("activating with no items is a no-op", () => {
		let changed = false;
		const list = new SettingsList(
			[],
			5,
			theme,
			() => {
				changed = true;
			},
			() => {},
		);
		// confirm with no items -> activateItem -> item is undefined -> early return
		list.handleInput("\r");
		list.handleInput(" ");
		assert.strictEqual(changed, false);
	});

	it("cycles through values on Enter and Space, invoking onChange", () => {
		const items: SettingItem[] = [{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] }];
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			items,
			5,
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
		);
		list.handleInput("\r"); // Enter -> cycle to "light"
		assert.deepStrictEqual(changes[0], ["theme", "light"]);
		list.handleInput(" "); // Space -> cycle back to "dark"
		assert.deepStrictEqual(changes[1], ["theme", "dark"]);
		assert.ok(list.render(60)[0].includes("dark"));
	});

	it("does nothing when activating an item with neither values nor submenu", () => {
		const items: SettingItem[] = [{ id: "static", label: "Static", currentValue: "frozen" }];
		let changed = false;
		const list = new SettingsList(
			items,
			5,
			theme,
			() => {
				changed = true;
			},
			() => {},
		);
		list.handleInput("\r");
		assert.strictEqual(changed, false);
	});

	it("cycling values wraps around when the current value is the last", () => {
		const items: SettingItem[] = [{ id: "m", label: "Mode", currentValue: "z", values: ["x", "y", "z"] }];
		const changes: string[] = [];
		const list = new SettingsList(
			items,
			5,
			theme,
			(_id, value) => changes.push(value),
			() => {},
		);
		list.handleInput("\r"); // z -> x (wrap)
		assert.strictEqual(changes[0], "x");
	});

	it("cycling values when the current value is not in the list starts at index 0", () => {
		const items: SettingItem[] = [{ id: "m", label: "Mode", currentValue: "unknown", values: ["x", "y"] }];
		const changes: string[] = [];
		const list = new SettingsList(
			items,
			5,
			theme,
			(_id, value) => changes.push(value),
			() => {},
		);
		// indexOf("unknown") === -1; (-1 + 1) % 2 === 0 -> "x"
		list.handleInput("\r");
		assert.strictEqual(changes[0], "x");
	});

	it("invokes onCancel when escape is pressed", () => {
		let cancelled = false;
		const items: SettingItem[] = [{ id: "a", label: "A", currentValue: "1" }];
		const list = new SettingsList(
			items,
			5,
			theme,
			() => {},
			() => {
				cancelled = true;
			},
		);
		list.handleInput("\x1b");
		assert.strictEqual(cancelled, true);
	});

	it("updateValue updates the displayed value of a matching item, ignores unknown ids", () => {
		const items: SettingItem[] = [{ id: "a", label: "A", currentValue: "old" }];
		const list = new SettingsList(
			items,
			5,
			theme,
			() => {},
			() => {},
		);
		list.updateValue("a", "new");
		assert.ok(list.render(60)[0].includes("new"));
		// Unknown id is a no-op (does not throw)
		assert.doesNotThrow(() => list.updateValue("missing", "x"));
	});

	describe("submenu", () => {
		function makeSubmenuItem(): { item: SettingItem; getDone: () => ((v?: string) => void) | undefined } {
			let captured: ((v?: string) => void) | undefined;
			const item: SettingItem = {
				id: "sub",
				label: "Submenu",
				currentValue: "initial",
				submenu: (_current, done) => {
					captured = done;
					const comp: Component = {
						render: () => ["SUBMENU CONTENT"],
						handleInput: () => {},
						invalidate: () => {},
					};
					return comp;
				},
			};
			return { item, getDone: () => captured };
		}

		it("opens a submenu on Enter and renders it instead of the main list", () => {
			const { item } = makeSubmenuItem();
			const list = new SettingsList(
				[item],
				5,
				theme,
				() => {},
				() => {},
			);
			list.handleInput("\r");
			assert.ok(strip(list.render(60)).includes("SUBMENU CONTENT"));
		});

		it("delegates input to the submenu while it is open", () => {
			let captured: ((v?: string) => void) | undefined;
			let submenuInput = "";
			const item: SettingItem = {
				id: "sub",
				label: "Submenu",
				currentValue: "initial",
				submenu: (_current, done) => {
					captured = done;
					return {
						render: () => ["SUB"],
						handleInput: (data: string) => {
							submenuInput += data;
						},
						invalidate: () => {},
					};
				},
			};
			const list = new SettingsList(
				[item],
				5,
				theme,
				() => {},
				() => {},
			);
			list.handleInput("\r"); // open submenu
			list.handleInput("x"); // forwarded to submenu
			assert.strictEqual(submenuInput, "x");
			assert.ok(captured, "submenu done callback captured");
		});

		it("closing a submenu with a value updates currentValue and calls onChange", () => {
			const { item, getDone } = makeSubmenuItem();
			const changes: Array<[string, string]> = [];
			const list = new SettingsList(
				[item],
				5,
				theme,
				(id, value) => changes.push([id, value]),
				() => {},
			);
			list.handleInput("\r"); // open
			getDone()!("chosen"); // close with a value
			assert.deepStrictEqual(changes, [["sub", "chosen"]]);
			// Back to the main list, showing the new value
			assert.ok(strip(list.render(60)).includes("chosen"));
		});

		it("closing a submenu without a value leaves currentValue unchanged", () => {
			const { item, getDone } = makeSubmenuItem();
			let changeCount = 0;
			const list = new SettingsList(
				[item],
				5,
				theme,
				() => {
					changeCount++;
				},
				() => {},
			);
			list.handleInput("\r"); // open
			getDone()!(); // close with no value
			assert.strictEqual(changeCount, 0);
			assert.ok(strip(list.render(60)).includes("initial"));
		});

		it("invalidate() forwards to the open submenu component", () => {
			let submenuInvalidated = false;
			const item: SettingItem = {
				id: "sub",
				label: "Submenu",
				currentValue: "v",
				submenu: () => ({
					render: () => ["SUB"],
					invalidate: () => {
						submenuInvalidated = true;
					},
				}),
			};
			const list = new SettingsList(
				[item],
				5,
				theme,
				() => {},
				() => {},
			);
			list.invalidate(); // no submenu yet -> no-op
			list.handleInput("\r"); // open submenu
			list.invalidate();
			assert.strictEqual(submenuInvalidated, true);
		});
	});

	describe("search mode", () => {
		const searchItems: SettingItem[] = [
			{ id: "theme", label: "Theme", currentValue: "dark" },
			{ id: "mode", label: "Mode", currentValue: "fast" },
			{ id: "lang", label: "Language", currentValue: "en" },
		];

		it("renders a search input and a search-specific hint", () => {
			const list = new SettingsList(
				searchItems,
				5,
				theme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			const out = list.render(60);
			assert.ok(strip(out).includes("Type to search"));
		});

		it("typing filters the list by fuzzy match", () => {
			const list = new SettingsList(
				searchItems,
				5,
				theme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			list.handleInput("the"); // matches "Theme"
			const out = strip(list.render(60));
			assert.ok(out.includes("Theme"));
			assert.ok(!out.includes("Language"));
		});

		it("shows a no-match hint when the filter excludes everything", () => {
			const list = new SettingsList(
				searchItems,
				5,
				theme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			list.handleInput("zzzzz");
			assert.ok(strip(list.render(60)).includes("No matching settings"));
		});

		it("ignores input that is only spaces in search mode", () => {
			const list = new SettingsList(
				searchItems,
				5,
				theme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			list.handleInput("   "); // sanitized to "" -> early return
			// All items still visible
			const out = strip(list.render(60));
			assert.ok(out.includes("Theme") && out.includes("Mode") && out.includes("Language"));
		});

		it("arrow keys navigate the filtered list and confirm cycles the filtered item", () => {
			const items: SettingItem[] = [
				{ id: "a", label: "Apple", currentValue: "x", values: ["x", "y"] },
				{ id: "b", label: "Apricot", currentValue: "p", values: ["p", "q"] },
			];
			const changes: Array<[string, string]> = [];
			const list = new SettingsList(
				items,
				5,
				theme,
				(id, value) => changes.push([id, value]),
				() => {},
				{ enableSearch: true },
			);
			list.handleInput("ap"); // both match
			list.handleInput("\x1b[B"); // down -> second filtered item
			list.handleInput("\r"); // cycle filtered item b
			assert.deepStrictEqual(changes[0], ["b", "q"]);
		});

		it("up/down are no-ops in search mode when the filter matches nothing", () => {
			const list = new SettingsList(
				searchItems,
				5,
				theme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			list.handleInput("zzz"); // filteredItems is empty
			assert.doesNotThrow(() => {
				list.handleInput("\x1b[A");
				list.handleInput("\x1b[B");
			});
		});

		it("renders an empty-state hint with the search variant when there are no items at all", () => {
			const list = new SettingsList(
				[],
				5,
				theme,
				() => {},
				() => {},
				{ enableSearch: true },
			);
			const out = strip(list.render(60));
			assert.ok(out.includes("No settings available"));
			assert.ok(out.includes("Type to search"));
		});
	});
});
