/**
 * Behavior regression tests for raw Unicode input decoding.
 *
 * These cover two related defects:
 *
 *   1. StdinBuffer.extractCompleteSequences sliced the buffer per UTF-16 code
 *      unit, splitting astral characters like '🎉' (U+1F389) into two lone
 *      surrogate halves on raw (non-bracketed-paste) input.
 *
 *   2. parseKey only recognized printable codepoints 32-126, so any raw
 *      non-ASCII printable character (CJK '世', accented Latin 'é', emoji)
 *      decoded to undefined on terminals without the Kitty CSI-u protocol,
 *      silently dropping the keystroke.
 *
 * Both are now fixed: full Unicode codepoints (including astral/emoji and
 * non-ASCII BMP characters) decode as a single key event on raw input.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "vitest";
import { parseKey, setKittyProtocolActive } from "../src/keys.js";
import { StdinBuffer } from "../src/stdin-buffer.js";

const PARTY_POPPER = "🎉"; // U+1F389, surrogate pair "🎉"
const CONFETTI_BALL = "🎊"; // U+1F38A

describe("raw Unicode input decoding", () => {
	describe("StdinBuffer surrogate-pair handling", () => {
		let buffer: StdinBuffer;
		let emitted: string[];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });
			emitted = [];
			buffer.on("data", (sequence) => emitted.push(sequence));
		});

		afterEach(() => {
			buffer.destroy();
		});

		it("emits an astral character as a single codepoint, not two surrogate halves", () => {
			buffer.process(PARTY_POPPER);
			// Previously emitted ["\uD83C", "\uDF89"] (two lone surrogates).
			assert.deepStrictEqual(emitted, [PARTY_POPPER]);
			assert.strictEqual(emitted[0]!.codePointAt(0), 0x1f389);
		});

		it("keeps consecutive astral characters separate and intact", () => {
			buffer.process(PARTY_POPPER + CONFETTI_BALL);
			assert.deepStrictEqual(emitted, [PARTY_POPPER, CONFETTI_BALL]);
		});

		it("handles astral characters interleaved with ASCII", () => {
			buffer.process(`a${PARTY_POPPER}b`);
			assert.deepStrictEqual(emitted, ["a", PARTY_POPPER, "b"]);
		});

		it("handles an astral character followed by an escape sequence", () => {
			buffer.process(`${PARTY_POPPER}\x1b[A`);
			assert.deepStrictEqual(emitted, [PARTY_POPPER, "\x1b[A"]);
		});

		it("still emits BMP characters one per codepoint", () => {
			buffer.process("世界");
			assert.deepStrictEqual(emitted, ["世", "界"]);
		});
	});

	describe("parseKey full-codepoint decoding (non-Kitty terminal)", () => {
		beforeEach(() => {
			setKittyProtocolActive(false);
		});

		afterEach(() => {
			setKittyProtocolActive(false);
		});

		it("decodes a CJK character as itself", () => {
			// Previously returned undefined.
			assert.strictEqual(parseKey("世"), "世");
		});

		it("decodes an accented Latin character as itself", () => {
			// Previously returned undefined.
			assert.strictEqual(parseKey("é"), "é");
		});

		it("decodes an astral/emoji character as itself", () => {
			// Previously returned undefined.
			assert.strictEqual(parseKey(PARTY_POPPER), PARTY_POPPER);
		});

		it("still decodes printable ASCII", () => {
			assert.strictEqual(parseKey("a"), "a");
			assert.strictEqual(parseKey("Z"), "Z");
			assert.strictEqual(parseKey("~"), "~");
		});

		it("rejects C0 control characters not otherwise mapped", () => {
			assert.strictEqual(parseKey("\x1e"), undefined);
		});

		it("rejects DEL/C1 control characters", () => {
			assert.strictEqual(parseKey("\x80"), undefined);
		});

		it("accepts a printable character just above the C1 range (U+00A0)", () => {
			assert.strictEqual(parseKey(" "), " ");
		});

		it("rejects a lone surrogate code unit", () => {
			assert.strictEqual(parseKey("\uD83C"), undefined);
		});

		it("rejects multi-codepoint strings", () => {
			assert.strictEqual(parseKey("ab"), undefined);
		});

		it("rejects the empty string", () => {
			assert.strictEqual(parseKey(""), undefined);
		});
	});

	describe("end-to-end: StdinBuffer feeding parseKey", () => {
		it("turns a raw emoji keystroke into a single key event", () => {
			const buffer = new StdinBuffer({ timeout: 10 });
			const keys: (string | undefined)[] = [];
			buffer.on("data", (sequence) => keys.push(parseKey(sequence)));
			buffer.process(PARTY_POPPER);
			buffer.destroy();
			assert.deepStrictEqual(keys, [PARTY_POPPER]);
		});

		it("turns raw non-ASCII text into one key event per codepoint", () => {
			const buffer = new StdinBuffer({ timeout: 10 });
			const keys: (string | undefined)[] = [];
			buffer.on("data", (sequence) => keys.push(parseKey(sequence)));
			buffer.process("héllo 世");
			buffer.destroy();
			assert.deepStrictEqual(keys, ["h", "é", "l", "l", "o", "space", "世"]);
		});
	});
});
