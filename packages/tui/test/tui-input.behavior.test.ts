/**
 * Behavior tests for the real stdin byte -> key-event decoding pipeline.
 *
 * The decoding path that a live terminal actually drives is:
 *
 *   raw stdin chunks
 *     -> StdinBuffer.process()  (re-assembles partial escape sequences,
 *                                extracts bracketed paste, drops Kitty dup chars)
 *     -> "data" / "paste" events
 *     -> parseKey()             (turns a complete sequence into a key id)
 *
 * The existing suites (`stdin-buffer.test.ts`, `keys.test.ts`,
 * `coverage-fills*.test.ts`) exercise StdinBuffer and parseKey *in isolation*.
 * These tests instead wire the two real modules together exactly the way the
 * TUI does and assert on the decoded key ids that fall out the far end, with a
 * focus on:
 *   - realistic byte sequences (plain chars, arrows, home/end, function keys),
 *   - partial sequences split across two or more chunks (a real streaming /
 *     latency concern over slow links and SSH),
 *   - multi-byte UTF-8 and surrogate-pair (emoji) handling,
 *   - bracketed paste (including split across chunks),
 *   - malformed / incomplete sequences and the timeout flush,
 *   - mode-dependent decoding (Kitty keyboard protocol active vs not),
 *   - throughput of a large input burst.
 *
 * Almost nothing is mocked: a `Pipeline` helper subscribes to the real
 * StdinBuffer events and runs each emitted sequence through the real parseKey.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePrintableKey, isKeyRelease, parseKey, setKittyProtocolActive } from "../src/keys.js";
import { StdinBuffer } from "../src/stdin-buffer.js";

type Decoded = { sequence: string; key: string | undefined };

/**
 * Drives the genuine StdinBuffer -> parseKey path. Each "data" sequence the
 * buffer emits is decoded immediately, mirroring the TUI's handleInput flow.
 */
class Pipeline {
	readonly buffer: StdinBuffer;
	readonly decoded: Decoded[] = [];
	readonly pastes: string[] = [];

	constructor(timeout = 5) {
		this.buffer = new StdinBuffer({ timeout });
		this.buffer.on("data", (sequence) => {
			this.decoded.push({ sequence, key: parseKey(sequence) });
		});
		this.buffer.on("paste", (content) => {
			this.pastes.push(content);
		});
	}

	feed(...chunks: (string | Buffer)[]): this {
		for (const chunk of chunks) this.buffer.process(chunk);
		return this;
	}

	/** Force the timeout flush synchronously (what the real timer would do). */
	flushNow(): this {
		for (const seq of this.buffer.flush()) {
			this.decoded.push({ sequence: seq, key: parseKey(seq) });
		}
		return this;
	}

	/** Just the decoded key ids, in emission order. */
	keys(): (string | undefined)[] {
		return this.decoded.map((d) => d.key);
	}

	destroy(): void {
		this.buffer.destroy();
	}
}

describe("stdin byte -> key decoding pipeline (StdinBuffer + parseKey)", () => {
	let pipe: Pipeline;

	beforeEach(() => {
		// parseKey reads global Kitty-protocol state; default to the legacy mode
		// so each test starts from a known baseline.
		setKittyProtocolActive(false);
		pipe = new Pipeline();
	});

	afterEach(() => {
		pipe.destroy();
		setKittyProtocolActive(false);
	});

	describe("plain printable characters", () => {
		it("decodes a run of ASCII characters one key at a time, in order", () => {
			pipe.feed("hello");
			expect(pipe.keys()).toEqual(["h", "e", "l", "l", "o"]);
		});

		it("decodes space, digits and punctuation as their literal characters", () => {
			pipe.feed("a 1!");
			expect(pipe.keys()).toEqual(["a", "space", "1", "!"]);
		});

		it("decodes control characters: tab, enter, ctrl+letter, backspace", () => {
			pipe.feed("\t\r\x01\x7f");
			expect(pipe.keys()).toEqual(["tab", "enter", "ctrl+a", "backspace"]);
		});
	});

	describe("escape sequences for navigation keys (delivered whole)", () => {
		it("decodes the four arrow keys", () => {
			pipe.feed("\x1b[A\x1b[B\x1b[C\x1b[D");
			expect(pipe.keys()).toEqual(["up", "down", "right", "left"]);
		});

		it("decodes home and end (CSI and SS3 forms)", () => {
			pipe.feed("\x1b[H\x1b[F\x1bOH\x1bOF");
			expect(pipe.keys()).toEqual(["home", "end", "home", "end"]);
		});

		it("decodes function/navigation keys delivered as a single CSI ~ sequence", () => {
			pipe.feed("\x1b[3~\x1b[5~\x1b[6~");
			expect(pipe.keys()).toEqual(["delete", "pageUp", "pageDown"]);
		});

		it("decodes shift+tab and modified arrows", () => {
			pipe.feed("\x1b[Z\x1b[1;5C\x1b[1;2A");
			expect(pipe.keys()).toEqual(["shift+tab", "ctrl+right", "shift+up"]);
		});

		it("keeps adjacent complete sequences separate when concatenated in one chunk", () => {
			pipe.feed("\x1b[A\x1b[Aab");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[A", "\x1b[A", "a", "b"]);
			expect(pipe.keys()).toEqual(["up", "up", "a", "b"]);
		});
	});

	describe("partial sequences split across chunks (streaming / latency)", () => {
		it("reassembles an arrow key split into three single-byte chunks", () => {
			pipe.feed("\x1b");
			expect(pipe.keys()).toEqual([]); // nothing decodable yet
			expect(pipe.buffer.getBuffer()).toBe("\x1b");

			pipe.feed("[");
			expect(pipe.keys()).toEqual([]);

			pipe.feed("A");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[A"]);
			expect(pipe.keys()).toEqual(["up"]);
			expect(pipe.buffer.getBuffer()).toBe("");
		});

		it("reassembles a modified-arrow CSI sequence arriving in two chunks", () => {
			pipe.feed("\x1b[1;5");
			expect(pipe.keys()).toEqual([]);
			pipe.feed("D");
			expect(pipe.keys()).toEqual(["ctrl+left"]);
		});

		it("reassembles a function-key sequence split mid-number", () => {
			pipe.feed("\x1b[2", "0", "0"); // looks like start of paste prefix...
			// \x1b[200~ would start a paste; without the ~ it stays buffered.
			expect(pipe.keys()).toEqual([]);
			pipe.feed("1~"); // -> \x1b[2001~ is not a known functional key
			// \x1b[2001~ parses via the functional regex but maps to no key -> undefined,
			// while still being emitted as one complete sequence.
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[2001~"]);
			expect(pipe.keys()).toEqual([undefined]);
		});

		it("emits leading plain chars immediately and buffers a trailing partial CSI", () => {
			pipe.feed("ab\x1b[");
			expect(pipe.keys()).toEqual(["a", "b"]);
			expect(pipe.buffer.getBuffer()).toBe("\x1b[");

			pipe.feed("C");
			expect(pipe.keys()).toEqual(["a", "b", "right"]);
		});

		it("decodes a full Kitty press/release pair batched in one chunk (common over SSH)", () => {
			setKittyProtocolActive(true);
			pipe.feed("\x1b[97u\x1b[97;1:3u");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[97u", "\x1b[97;1:3u"]);
			// Both decode to the same key id; the release is distinguished via isKeyRelease.
			expect(pipe.keys()).toEqual(["a", "a"]);
			expect(isKeyRelease(pipe.decoded[0]!.sequence)).toBe(false);
			expect(isKeyRelease(pipe.decoded[1]!.sequence)).toBe(true);
		});
	});

	describe("multi-byte UTF-8 and surrogate pairs", () => {
		it("emits each BMP CJK code unit as its own sequence (one JS char each)", () => {
			pipe.feed("世界");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["世", "界"]);
		});

		it("decodes a raw multi-byte BMP char as its own literal key (full Unicode printable support)", () => {
			pipe.feed("世");
			// The raw character is forwarded intact and the legacy parser now recognizes
			// non-ASCII printable codepoints, returning the character itself as the key id.
			expect(pipe.decoded[0]!.sequence).toBe("世");
			expect(pipe.keys()).toEqual(["世"]);
		});

		it("recovers a high codepoint character through the Kitty CSI-u printable decoder", () => {
			// 世 is U+4E16 = 19990. A Kitty-protocol terminal reports it as ESC[19990u.
			expect(decodePrintableKey("\x1b[19990u")).toBe("世");
			// And the same sequence flows cleanly through the buffer as one unit.
			pipe.feed("\x1b[19990u");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[19990u"]);
			// parseKey (the keybinding path) does NOT recover the printable char — it is
			// undefined here, and recovery happens only via decodePrintableKey above. Lock
			// this so a regression that started routing CSI-u through parseKey is caught.
			expect(pipe.keys()).toEqual([undefined]);
		});

		it("decodes a raw accented Latin char (single code unit, codepoint > 127) as itself", () => {
			// 'é' is U+00E9 = 233: a one-code-unit char above ASCII that the legacy
			// parser must now surface as its own key id.
			pipe.feed("é");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["é"]);
			expect(pipe.keys()).toEqual(["é"]);
		});

		it("does not decode a raw C1 control char as a printable key", () => {
			// U+0080 (codepoint 128) sits in the C1 control range; it is not a
			// printable keystroke, so it must stay undefined rather than be echoed.
			pipe.feed("\x80");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x80"]);
			expect(pipe.keys()).toEqual([undefined]);
		});

		it("emits an emoji surrogate pair delivered as raw input as a single intact codepoint", () => {
			// "🎉" (U+1F389) is two UTF-16 code units. StdinBuffer advances by whole
			// codepoints, so the surrogate pair survives as one sequence and decodes to
			// the emoji itself rather than two lone surrogate halves.
			pipe.feed("🎉");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["🎉"]);
			expect(pipe.keys()).toEqual(["🎉"]);
		});

		it("preserves the same emoji intact when it arrives inside a bracketed paste", () => {
			// The paste path buffers the raw string rather than slicing per char,
			// so the surrogate pair survives — contrast with the raw-input case above.
			pipe.feed("\x1b[200~🎉 done\x1b[201~");
			expect(pipe.pastes).toEqual(["🎉 done"]);
			expect(pipe.keys()).toEqual([]); // paste content never surfaces as key events
		});
	});

	describe("bracketed paste", () => {
		it("routes a complete paste to the paste channel with no key events", () => {
			pipe.feed("\x1b[200~multi word paste\x1b[201~");
			expect(pipe.pastes).toEqual(["multi word paste"]);
			expect(pipe.keys()).toEqual([]);
		});

		it("reassembles a paste split across chunks and keeps surrounding keys distinct", () => {
			pipe.feed("x", "\x1b[200~hel", "lo\nthere", "\x1b[201~", "y");
			expect(pipe.pastes).toEqual(["hello\nthere"]);
			// 'x' before the paste and 'y' after are real key events.
			expect(pipe.keys()).toEqual(["x", "y"]);
		});

		it("does not misread :3 inside pasted text as a Kitty key release", () => {
			const mac = "90:62:3F:A5";
			pipe.feed(`\x1b[200~${mac}\x1b[201~`);
			expect(pipe.pastes).toEqual([mac]);
			// Guard in isKeyRelease: bracketed-paste-wrapped content is never a release.
			expect(isKeyRelease(`\x1b[200~${mac}\x1b[201~`)).toBe(false);
		});
	});

	describe("malformed / incomplete sequences", () => {
		it("holds a lone ESC in the buffer until flushed, then decodes it as escape", () => {
			pipe.feed("\x1b");
			expect(pipe.keys()).toEqual([]);
			expect(pipe.buffer.getBuffer()).toBe("\x1b");

			pipe.flushNow();
			expect(pipe.keys()).toEqual(["escape"]);
		});

		it("flushes an incomplete CSI sequence verbatim; parseKey then returns undefined", () => {
			pipe.feed("\x1b[99"); // no final byte -> incomplete CSI
			expect(pipe.keys()).toEqual([]);
			expect(pipe.buffer.getBuffer()).toBe("\x1b[99");

			pipe.flushNow();
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[99"]);
			expect(pipe.keys()).toEqual([undefined]);
		});

		it("emits an incomplete sequence via the real timeout timer", async () => {
			const timed = new Pipeline(8);
			try {
				timed.feed("\x1b[<35"); // partial SGR mouse
				expect(timed.keys()).toEqual([]);
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(timed.decoded.map((d) => d.sequence)).toEqual(["\x1b[<35"]);
			} finally {
				timed.destroy();
			}
		});

		it("decodes a recognizable key that immediately follows a flushed malformed fragment", () => {
			pipe.feed("\x1b[99");
			pipe.flushNow(); // -> undefined
			pipe.feed("a");
			expect(pipe.keys()).toEqual([undefined, "a"]);
		});

		it("treats a bare ESC + ordinary letter as a complete (alt) sequence", () => {
			// isCompleteSequence marks ESC + single char complete; parseKey maps ESC z -> alt+z.
			// ('b'/'f' are special-cased to alt+left/right, so use a neutral letter here.)
			pipe.feed("\x1bz");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1bz"]);
			expect(pipe.keys()).toEqual(["alt+z"]);
		});
	});

	describe("mode-dependent decoding (Kitty keyboard protocol)", () => {
		it("decodes newline as enter in legacy mode but shift+enter when Kitty protocol is active", () => {
			const legacy = new Pipeline();
			try {
				setKittyProtocolActive(false);
				legacy.feed("\n");
				expect(legacy.keys()).toEqual(["enter"]);
			} finally {
				legacy.destroy();
			}

			const kitty = new Pipeline();
			try {
				setKittyProtocolActive(true);
				kitty.feed("\n");
				expect(kitty.keys()).toEqual(["shift+enter"]);
			} finally {
				kitty.destroy();
			}
		});
	});

	describe("high-byte single-byte buffer conversion", () => {
		it("converts a lone high byte into ESC + (byte-128) and decodes the meta key", () => {
			// 225 - 128 = 97 = 'a'. The buffer rewrites the high byte to ESC a, which the
			// legacy parser then reads as alt+a. Asserting the decoded key (not just the
			// raw sequence) pins the exact `- 128` arithmetic: any off-by-one or sign flip
			// produces a different character and fails here.
			pipe.feed(Buffer.from([225]));
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1ba"]);
			expect(pipe.keys()).toEqual(["alt+a"]);
		});

		it("does not rewrite a multi-byte buffer (only lone high bytes get the ESC prefix)", () => {
			// The conversion guard is `data.length === 1 && data[0] > 127`. A two-byte
			// buffer must be decoded as plain UTF-8, NOT prefixed with ESC. This kills a
			// mutation that drops the `length === 1` guard and rewrites every chunk.
			pipe.feed(Buffer.from("ab"));
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["a", "b"]);
			expect(pipe.keys()).toEqual(["a", "b"]);
		});
	});

	describe("Kitty SSH duplicate suppression", () => {
		it("drops a raw char that duplicates the codepoint of the preceding CSI-u key", () => {
			// Over SSH some terminals echo a Kitty CSI-u key AND the raw character. The
			// buffer remembers the last emitted CSI-u codepoint and swallows an immediately
			// following raw char with the same codepoint. ESC[97u is 'a'; the trailing raw
			// 'a' (codepoint 97) is suppressed, leaving exactly one key event.
			setKittyProtocolActive(true);
			pipe.feed("\x1b[97u", "a");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[97u"]);
			expect(pipe.keys()).toEqual(["a"]);
		});

		it("does NOT drop a following raw char whose codepoint differs from the CSI-u key", () => {
			// Guards the suppression so it only fires on an exact codepoint match: ESC[97u
			// is 'a', the trailing raw 'b' (98) is a distinct keystroke and must survive.
			setKittyProtocolActive(true);
			pipe.feed("\x1b[97u", "b");
			expect(pipe.decoded.map((d) => d.sequence)).toEqual(["\x1b[97u", "b"]);
			expect(pipe.keys()).toEqual(["a", "b"]);
		});
	});

	describe("throughput / latency", () => {
		it("decodes a large mixed burst correctly and within a tight time budget", () => {
			const burst = "abc\x1b[A\x1b[B\x1b[1;5C\t\r".repeat(2000);
			// Per repeat: a,b,c,up,down,ctrl+right,tab,enter = 8 keys.
			const big = new Pipeline();
			try {
				const start = performance.now();
				big.feed(burst);
				const elapsed = performance.now() - start;

				expect(big.decoded.length).toBe(2000 * 8);
				// Spot-check correctness at the boundaries of the stream.
				expect(big.keys().slice(0, 8)).toEqual(["a", "b", "c", "up", "down", "ctrl+right", "tab", "enter"]);
				expect(big.keys().slice(-2)).toEqual(["tab", "enter"]);
				expect(big.buffer.getBuffer()).toBe(""); // fully consumed, no dangling remainder
				// 16k decoded key events should be near-instant; generous CI-safe bound.
				expect(elapsed).toBeLessThan(1000);
			} finally {
				big.destroy();
			}
		});

		it("reassembles a sequence delivered byte-by-byte without spurious intermediate keys", () => {
			const sequence = "\x1b[1;5C"; // ctrl+right, 6 bytes
			for (const byte of sequence) {
				pipe.feed(byte);
			}
			// Exactly one decoded key, no garbage emitted from the partial states.
			expect(pipe.keys()).toEqual(["ctrl+right"]);
		});
	});
});
