/**
 * Covers the two near-identical tool render-utils modules:
 *   - src/core/tools/render-utils.ts
 *   - src/modes/interactive/tool-renderers/render-utils.ts
 */

import * as os from "node:os";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import * as coreRenderUtils from "../src/core/tools/render-utils.js";
import * as interactiveRenderUtils from "../src/modes/interactive/tool-renderers/render-utils.js";

const modules = [
	{ name: "core/tools/render-utils", mod: coreRenderUtils },
	{ name: "interactive/tool-renderers/render-utils", mod: interactiveRenderUtils },
];

// A tiny 1x1 transparent PNG, base64-encoded.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

afterEach(() => {
	resetCapabilitiesCache();
});

for (const { name, mod } of modules) {
	describe(name, () => {
		describe("shortenPath", () => {
			it("replaces the home directory prefix with ~", () => {
				const home = os.homedir();
				expect(mod.shortenPath(`${home}/projects/foo`)).toBe("~/projects/foo");
			});

			it("leaves non-home paths untouched", () => {
				expect(mod.shortenPath("/var/log/system.log")).toBe("/var/log/system.log");
			});

			it("returns empty string for non-string input", () => {
				expect(mod.shortenPath(undefined)).toBe("");
				expect(mod.shortenPath(42)).toBe("");
			});
		});

		describe("str", () => {
			it("returns the string unchanged", () => {
				expect(mod.str("hello")).toBe("hello");
			});

			it("maps null and undefined to empty string", () => {
				expect(mod.str(null)).toBe("");
				expect(mod.str(undefined)).toBe("");
			});

			it("returns null for non-string, non-nullish values", () => {
				expect(mod.str(123)).toBeNull();
				expect(mod.str({})).toBeNull();
			});
		});

		it("replaceTabs expands tab characters to three spaces", () => {
			expect(mod.replaceTabs("a\tb\tc")).toBe("a   b   c");
		});

		it("normalizeDisplayText strips carriage returns", () => {
			expect(mod.normalizeDisplayText("line1\r\nline2\r")).toBe("line1\nline2");
		});

		describe("getTextOutput", () => {
			it("returns empty string when result is undefined", () => {
				expect(mod.getTextOutput(undefined, true)).toBe("");
			});

			it("joins text blocks, strips ansi and carriage returns", () => {
				const result = {
					content: [
						{ type: "text", text: "[31mred[0m\r" },
						{ type: "text", text: "second" },
					],
				};
				expect(mod.getTextOutput(result as never, true)).toBe("red\nsecond");
			});

			it("appends image fallback indicators when terminal has no image support", () => {
				setCapabilities({ images: null, trueColor: true, hyperlinks: false });
				const result = {
					content: [
						{ type: "text", text: "preamble" },
						{ type: "image", data: PNG_1x1, mimeType: "image/png" },
					],
				};
				const out = mod.getTextOutput(result as never, true);
				expect(out.startsWith("preamble\n")).toBe(true);
				expect(out).toContain("image/png");
			});

			it("produces image-only output when there is no text block", () => {
				setCapabilities({ images: null, trueColor: true, hyperlinks: false });
				const result = {
					content: [{ type: "image", data: PNG_1x1, mimeType: "image/png" }],
				};
				const out = mod.getTextOutput(result as never, true);
				expect(out).toContain("image/png");
				expect(out.startsWith("\n")).toBe(false);
			});

			it("falls back to image/unknown and skips dimensions when mimeType is missing", () => {
				setCapabilities({ images: null, trueColor: true, hyperlinks: false });
				const result = {
					content: [{ type: "image", data: PNG_1x1 }],
				};
				const out = mod.getTextOutput(result as never, true);
				expect(out).toContain("image/unknown");
			});

			it("omits image indicators when the terminal supports images and showImages is true", () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
				const result = {
					content: [
						{ type: "text", text: "just text" },
						{ type: "image", data: PNG_1x1, mimeType: "image/png" },
					],
				};
				expect(mod.getTextOutput(result as never, true)).toBe("just text");
			});

			it("shows image indicators when the terminal supports images but showImages is false", () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
				const result = {
					content: [{ type: "image", data: PNG_1x1, mimeType: "image/png" }],
				};
				expect(mod.getTextOutput(result as never, false)).toContain("image/png");
			});
		});

		it("invalidArgText renders an error-colored marker", () => {
			const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
			expect(mod.invalidArgText(theme as never)).toBe("<error>[invalid arg]</error>");
		});
	});
}
