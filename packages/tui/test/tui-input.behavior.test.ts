/**
 * Behavioral regression tests for raw TUI input handling.
 *
 * These exercise the path where stdin data arrives outside bracketed paste and
 * is split into individual sequences by StdinBuffer before key parsing.
 */

import assert from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { StdinBuffer } from "../src/stdin-buffer.js";

describe("raw stdin input behavior", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });
		emittedSequences = [];
		buffer.on("data", (sequence) => {
			emittedSequences.push(sequence);
		});
	});

	// Regression: an astral code point (e.g. an emoji) delivered as raw stdin
	// data — i.e. outside a bracketed paste — used to be sliced one UTF-16 code
	// unit at a time, emitting the high and low surrogate as two separate
	// single-char "data" events ([\ud83c, \udf89]). parseKey() returns undefined
	// for each lone surrogate, so the typed codepoint was silently dropped.
	// extractCompleteSequences now advances by a full code point, so the
	// surrogate pair survives as one intact "🎉" sequence.
	it("keeps an emoji surrogate pair delivered as raw input intact (was: lost codepoint)", () => {
		buffer.process("🎉");
		assert.deepStrictEqual(emittedSequences, ["🎉"]);
	});

	it("keeps emoji intact when interleaved with ASCII and BMP characters", () => {
		buffer.process("a🎉b世🚀c");
		assert.deepStrictEqual(emittedSequences, ["a", "🎉", "b", "世", "🚀", "c"]);
	});

	it("keeps an emoji intact when it follows a complete escape sequence", () => {
		buffer.process("\x1b[A🎉");
		assert.deepStrictEqual(emittedSequences, ["\x1b[A", "🎉"]);
	});
});
