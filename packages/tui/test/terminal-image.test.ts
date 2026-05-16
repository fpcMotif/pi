/**
 * Tests for terminal image detection and line handling
 */

import assert from "node:assert";
import { describe, it } from "vitest";
import { Image } from "../src/components/image.js";
import {
	allocateImageId,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	imageFallback,
	isImageLine,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.js";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"CMUX_WORKSPACE_ID",
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			assert.strictEqual(longLine.length > 300000, true);
			assert.strictEqual(isImageLine(longLine), true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			assert.strictEqual(isImageLine(plainText), false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			assert.strictEqual(isImageLine(ansiText), false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in empty lines", () => {
			assert.strictEqual(isImageLine(""), false);
		});

		it("should not detect images in lines with newlines only", () => {
			assert.strictEqual(isImageLine("\n"), false);
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			assert.strictEqual(isImageLine(complexLine), true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false under tmux even if outer terminal supports OSC 8", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("does not disable Ghostty images solely because cmux is present", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "kitty");
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables true color but no images/hyperlinks for Alacritty", () => {
		withEnv({ TERM_PROGRAM: "alacritty", COLORTERM: "truecolor" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		assert.ok(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"));
	});

	it("suppresses Kitty replies for delete commands", () => {
		assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			assert.ok(result);
			assert.ok(!result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("can opt renderImage into no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			assert.ok(result);
			assert.ok(result.sequence.includes(",C=1,"));
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("restores the cursor to the reserved image row after Kitty rendering", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			const imageId = image.getImageId();
			assert.strictEqual(typeof imageId, "number");
			assert.deepStrictEqual(lines.slice(0, -1), [""]);
			assert.ok(lines[1].startsWith("\x1b[1A\x1b_G"));
			assert.ok(lines[1].includes(",C=1,"));
			assert.ok(lines[1].includes(`,i=${imageId}`));
			assert.ok(lines[1].endsWith("\x1b[1B"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(result.includes(styled));
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		assert.ok(result.includes("file:///home/user/README.md"));
		assert.ok(result.includes("README.md"));
	});
});

// Sample image headers built byte-for-byte: only the format magic + the
// dimension fields matter to the parsers, the rest is zero padding.
const PNG_100x50 = "iVBORw0KGgoAAAAAAAAAAAAAAGQAAAAy";
const JPEG_512x320 = "/9j/4AAQAQIDBAUGBwgJCgsMDQ7/wAARCAFAAgADAQIDBAUGBwg=";
const GIF_30x20 = "R0lGODlhHgAUAAAAAAAAAAAAAAA=";
const WEBP_VP8_64x48 = "UklGRgAAAABXRUJQVlA4IAAAAAAAAAAAAABAADAAAAAAAAAAAAAAAA==";
const WEBP_VP8L_99x49 = "UklGRgAAAABXRUJQVlA4TAAAAAAAYgAMAAAAAAAAAAAAAAAAAAAAAA==";
const WEBP_VP8X_199x99 = "UklGRgAAAABXRUJQVlA4WAAAAAAAAAAAxgAAYgAAAAAAAAAAAAAAAA==";

describe("getPngDimensions", () => {
	it("reads width and height from a PNG IHDR chunk", () => {
		assert.deepStrictEqual(getPngDimensions(PNG_100x50), { widthPx: 100, heightPx: 50 });
	});

	it("returns null for a buffer shorter than the 24-byte PNG header", () => {
		assert.strictEqual(getPngDimensions(Buffer.from("short").toString("base64")), null);
	});

	it("returns null when the PNG magic bytes are wrong", () => {
		// 24 bytes but not starting with the PNG signature
		assert.strictEqual(getPngDimensions(Buffer.alloc(24, 1).toString("base64")), null);
	});

	it("returns null for input that cannot be base64-decoded into enough bytes", () => {
		assert.strictEqual(getPngDimensions(""), null);
	});
});

describe("getJpegDimensions", () => {
	it("reads dimensions from a JPEG SOF0 marker", () => {
		assert.deepStrictEqual(getJpegDimensions(JPEG_512x320), { widthPx: 512, heightPx: 320 });
	});

	it("returns null for a buffer shorter than 2 bytes", () => {
		assert.strictEqual(getJpegDimensions(Buffer.alloc(1).toString("base64")), null);
	});

	it("returns null when the JPEG SOI marker is missing", () => {
		assert.strictEqual(getJpegDimensions(Buffer.from([0x00, 0x00, 0x00, 0x00]).toString("base64")), null);
	});

	it("returns null when no SOF marker is found before the buffer ends", () => {
		// Valid SOI but only filler bytes after — scanner walks off the end.
		const buf = Buffer.alloc(40);
		buf[0] = 0xff;
		buf[1] = 0xd8;
		assert.strictEqual(getJpegDimensions(buf.toString("base64")), null);
	});

	it("returns null when a segment declares an invalid length", () => {
		// SOI, then a non-SOF marker FF E0 with length 0 (< 2) → bail out.
		const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		assert.strictEqual(getJpegDimensions(buf.toString("base64")), null);
	});

	it("skips a non-marker byte and continues scanning", () => {
		// 0xFF 0xC1 is also a valid SOF marker; precede it with a stray 0x00 byte
		// so the `buffer[offset] !== 0xff` continue branch is exercised.
		const buf = Buffer.from([
			0xff, 0xd8, 0x00, 0xff, 0xc1, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 3, 1, 2, 3, 4, 5,
		]);
		assert.deepStrictEqual(getJpegDimensions(buf.toString("base64")), { widthPx: 200, heightPx: 100 });
	});
});

describe("getGifDimensions", () => {
	it("reads dimensions from a GIF89a header", () => {
		assert.deepStrictEqual(getGifDimensions(GIF_30x20), { widthPx: 30, heightPx: 20 });
	});

	it("reads dimensions from a GIF87a header", () => {
		const buf = Buffer.alloc(20);
		buf.write("GIF87a", 0, "ascii");
		buf.writeUInt16LE(12, 6);
		buf.writeUInt16LE(8, 8);
		assert.deepStrictEqual(getGifDimensions(buf.toString("base64")), { widthPx: 12, heightPx: 8 });
	});

	it("returns null for a buffer shorter than 10 bytes", () => {
		assert.strictEqual(getGifDimensions(Buffer.alloc(5).toString("base64")), null);
	});

	it("returns null when the GIF signature is not recognized", () => {
		assert.strictEqual(getGifDimensions(Buffer.alloc(20, 0x41).toString("base64")), null);
	});
});

describe("getWebpDimensions", () => {
	it("reads dimensions from a lossy VP8 WebP", () => {
		assert.deepStrictEqual(getWebpDimensions(WEBP_VP8_64x48), { widthPx: 64, heightPx: 48 });
	});

	it("reads dimensions from a lossless VP8L WebP", () => {
		assert.deepStrictEqual(getWebpDimensions(WEBP_VP8L_99x49), { widthPx: 99, heightPx: 49 });
	});

	it("reads dimensions from an extended VP8X WebP", () => {
		assert.deepStrictEqual(getWebpDimensions(WEBP_VP8X_199x99), { widthPx: 199, heightPx: 99 });
	});

	it("returns null for a buffer shorter than 30 bytes", () => {
		assert.strictEqual(getWebpDimensions(Buffer.alloc(20).toString("base64")), null);
	});

	it("returns null when the RIFF/WEBP container markers are missing", () => {
		assert.strictEqual(getWebpDimensions(Buffer.alloc(40, 0x41).toString("base64")), null);
	});

	it("returns null for a WebP with an unrecognized chunk type", () => {
		const buf = Buffer.alloc(40);
		buf.write("RIFF", 0, "ascii");
		buf.write("WEBP", 8, "ascii");
		buf.write("XXXX", 12, "ascii");
		assert.strictEqual(getWebpDimensions(buf.toString("base64")), null);
	});
});

describe("image dimension parsers are crash-safe", () => {
	// Buffer.from(nonString, "base64") throws TypeError; every parser wraps its
	// body in try/catch so corrupt/non-string input returns null instead of
	// crashing the renderer. We pass a non-string typed as string on purpose.
	const garbage = undefined as unknown as string;

	it("getPngDimensions returns null instead of throwing on non-string input", () => {
		assert.strictEqual(getPngDimensions(garbage), null);
	});

	it("getJpegDimensions returns null instead of throwing on non-string input", () => {
		assert.strictEqual(getJpegDimensions(garbage), null);
	});

	it("getGifDimensions returns null instead of throwing on non-string input", () => {
		assert.strictEqual(getGifDimensions(garbage), null);
	});

	it("getWebpDimensions returns null instead of throwing on non-string input", () => {
		assert.strictEqual(getWebpDimensions(garbage), null);
	});
});

describe("getImageDimensions", () => {
	it("dispatches to the PNG parser for image/png", () => {
		assert.deepStrictEqual(getImageDimensions(PNG_100x50, "image/png"), { widthPx: 100, heightPx: 50 });
	});

	it("dispatches to the JPEG parser for image/jpeg", () => {
		assert.deepStrictEqual(getImageDimensions(JPEG_512x320, "image/jpeg"), { widthPx: 512, heightPx: 320 });
	});

	it("dispatches to the GIF parser for image/gif", () => {
		assert.deepStrictEqual(getImageDimensions(GIF_30x20, "image/gif"), { widthPx: 30, heightPx: 20 });
	});

	it("dispatches to the WebP parser for image/webp", () => {
		assert.deepStrictEqual(getImageDimensions(WEBP_VP8_64x48, "image/webp"), { widthPx: 64, heightPx: 48 });
	});

	it("returns null for an unsupported mime type", () => {
		assert.strictEqual(getImageDimensions(PNG_100x50, "image/bmp"), null);
	});
});

describe("encodeITerm2", () => {
	it("emits an inline=1 sequence by default", () => {
		const seq = encodeITerm2("AAAA");
		assert.strictEqual(seq, "\x1b]1337;File=inline=1:AAAA\x07");
	});

	it("includes width and height parameters when provided", () => {
		const seq = encodeITerm2("AAAA", { width: 10, height: "auto" });
		assert.ok(seq.includes("width=10"));
		assert.ok(seq.includes("height=auto"));
	});

	it("base64-encodes the name parameter", () => {
		const seq = encodeITerm2("AAAA", { name: "pic.png" });
		assert.ok(seq.includes(`name=${Buffer.from("pic.png").toString("base64")}`));
	});

	it("adds preserveAspectRatio=0 only when explicitly disabled", () => {
		assert.ok(encodeITerm2("AAAA", { preserveAspectRatio: false }).includes("preserveAspectRatio=0"));
		assert.ok(!encodeITerm2("AAAA", { preserveAspectRatio: true }).includes("preserveAspectRatio"));
	});

	it("emits inline=0 when inline is explicitly false", () => {
		assert.ok(encodeITerm2("AAAA", { inline: false }).startsWith("\x1b]1337;File=inline=0"));
	});
});

describe("imageFallback", () => {
	it("includes filename, mime type, and dimensions when all are given", () => {
		assert.strictEqual(
			imageFallback("image/png", { widthPx: 100, heightPx: 50 }, "pic.png"),
			"[Image: pic.png [image/png] 100x50]",
		);
	});

	it("omits the filename when not provided", () => {
		assert.strictEqual(imageFallback("image/gif", { widthPx: 8, heightPx: 8 }), "[Image: [image/gif] 8x8]");
	});

	it("omits dimensions when not provided", () => {
		assert.strictEqual(imageFallback("image/jpeg"), "[Image: [image/jpeg]]");
	});
});

describe("renderImage iTerm2 path", () => {
	it("encodes via iTerm2 and reports calculated rows", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 40, heightPx: 20 }, { maxWidthCells: 4 });
			assert.ok(result);
			assert.ok(result.sequence.startsWith("\x1b]1337;File="));
			assert.strictEqual(result.imageId, undefined);
			// 4 cells * 10px = 40px wide, scale 1.0 → 20px tall / 10px per cell = 2 rows
			assert.strictEqual(result.rows, 2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("returns null when the terminal has no image support", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			assert.strictEqual(renderImage("AAAA", { widthPx: 40, heightPx: 20 }), null);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("defaults maxWidthCells to 80 when not provided", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 800, heightPx: 100 });
			assert.ok(result);
			assert.ok(result.sequence.includes("c=80"));
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});
});

describe("encodeKitty chunking", () => {
	it("splits payloads larger than 4096 bytes into m=1/m=0 chunks", () => {
		const bigPayload = "A".repeat(10000);
		const seq = encodeKitty(bigPayload, { columns: 4, rows: 2 });
		// First chunk carries the params and m=1, last chunk carries m=0.
		assert.ok(seq.includes(",m=1;"));
		assert.ok(seq.includes("\x1b_Gm=0;"));
		// Middle continuation chunks also use m=1.
		const m1Count = seq.split("\x1b_Gm=1;").length - 1;
		assert.ok(m1Count >= 1, "expected at least one continuation chunk");
	});

	it("emits a single sequence for payloads at or below the chunk size", () => {
		const seq = encodeKitty("A".repeat(4096), { columns: 2, rows: 2 });
		assert.strictEqual(seq.split("\x1b_G").length - 1, 1);
	});
});

describe("calculateImageRows", () => {
	it("scales the image height by the target width and rounds up to whole rows", () => {
		// 20 cells * 9px = 180px target width; image is 90px wide → 2x scale.
		// 60px tall * 2 = 120px / 18px per cell = 6.66 → ceil 7 rows.
		assert.strictEqual(calculateImageRows({ widthPx: 90, heightPx: 60 }, 20), 7);
	});

	it("never returns fewer than 1 row", () => {
		assert.strictEqual(calculateImageRows({ widthPx: 1000, heightPx: 1 }, 1), 1);
	});

	it("uses the provided cell dimensions over the default", () => {
		assert.strictEqual(calculateImageRows({ widthPx: 100, heightPx: 100 }, 10, { widthPx: 10, heightPx: 10 }), 10);
	});
});

describe("capability cache", () => {
	it("getCapabilities memoizes the detected capabilities", () => {
		resetCapabilitiesCache();
		const first = getCapabilities();
		const second = getCapabilities();
		assert.strictEqual(first, second, "cached capabilities should be the same object");
	});

	it("resetCapabilitiesCache forces re-detection on the next call", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		assert.strictEqual(getCapabilities().images, "kitty");
		resetCapabilitiesCache();
		// After reset, capabilities are re-detected from the environment (no longer "kitty" forced).
		const reDetected = getCapabilities();
		assert.strictEqual(typeof reDetected.hyperlinks, "boolean");
	});
});

describe("cell dimensions accessors", () => {
	it("setCellDimensions updates the value returned by getCellDimensions", () => {
		const original = getCellDimensions();
		try {
			setCellDimensions({ widthPx: 7, heightPx: 14 });
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 7, heightPx: 14 });
		} finally {
			setCellDimensions(original);
		}
	});
});

describe("allocateImageId", () => {
	it("returns a positive integer within the Kitty image ID range", () => {
		for (let i = 0; i < 50; i++) {
			const id = allocateImageId();
			assert.ok(Number.isInteger(id));
			assert.ok(id >= 1 && id <= 0xffffffff);
		}
	});
});
