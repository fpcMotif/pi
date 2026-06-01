import assert from "node:assert";
import { describe, it } from "vitest";
import { applyInputListeners, type InputListener, parseCellSizeResponse } from "../src/tui-input.js";

describe("applyInputListeners", () => {
	it("returns the input unchanged when no listeners are attached", () => {
		assert.deepStrictEqual(applyInputListeners("abc", []), { consume: false, data: "abc" });
	});

	it("returns consume:true as soon as a listener consumes the input", () => {
		const calls: string[] = [];
		const listeners: InputListener[] = [
			(d) => {
				calls.push(d);
				return { consume: true };
			},
			() => {
				calls.push("should-not-run");
				return undefined;
			},
		];
		assert.deepStrictEqual(applyInputListeners("xyz", listeners), { consume: true });
		assert.deepStrictEqual(calls, ["xyz"]);
	});

	it("threads transformed data through subsequent listeners", () => {
		const seen: string[] = [];
		const listeners: InputListener[] = [
			() => ({ data: "transformed" }),
			(d) => {
				seen.push(d);
				return undefined;
			},
		];
		assert.deepStrictEqual(applyInputListeners("orig", listeners), { consume: false, data: "transformed" });
		assert.deepStrictEqual(seen, ["transformed"]);
	});

	it("treats listeners that return undefined or no result as pass-through", () => {
		const listeners: InputListener[] = [() => undefined, (d) => ({ data: d })];
		assert.deepStrictEqual(applyInputListeners("plain", listeners), { consume: false, data: "plain" });
	});

	it("treats an empty post-transformation string as a consume", () => {
		const listeners: InputListener[] = [() => ({ data: "" })];
		assert.deepStrictEqual(applyInputListeners("anything", listeners), { consume: true });
	});
});

describe("parseCellSizeResponse", () => {
	it("returns undefined when the input does not match the CSI 6 t reply shape", () => {
		assert.strictEqual(parseCellSizeResponse("not a CSI sequence"), undefined);
		assert.strictEqual(parseCellSizeResponse("\x1b[6;abc;def t"), undefined);
	});

	it("returns a valid cell size for a well-formed reply", () => {
		assert.deepStrictEqual(parseCellSizeResponse("\x1b[6;14;7t"), {
			_tag: "valid",
			heightPx: 14,
			widthPx: 7,
		});
	});

	it("flags non-positive dimensions as invalid", () => {
		assert.deepStrictEqual(parseCellSizeResponse("\x1b[6;0;7t"), { _tag: "invalid" });
		assert.deepStrictEqual(parseCellSizeResponse("\x1b[6;14;0t"), { _tag: "invalid" });
	});
});
