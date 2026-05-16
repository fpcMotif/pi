// Coverage for terminal-image.ts decoders and helpers not exercised by the
// existing terminal-image.test.ts: image dimension parsers (PNG/JPEG/GIF/WEBP),
// iTerm2 encoding, calculateImageRows, allocateImageId, getCellDimensions, the
// alacritty capability branch, and imageFallback.
import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	allocateImageId,
	calculateImageRows,
	detectCapabilities,
	encodeITerm2,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.js";

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");

afterEach(() => {
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

const TERM_ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
] as const;

function withTermEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of TERM_ENV_KEYS) {
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
		for (const key of TERM_ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("detectCapabilities — alacritty", () => {
	it("reports no image protocol but truecolor + hyperlinks for alacritty", () => {
		withTermEnv({ TERM_PROGRAM: "alacritty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, null);
			assert.strictEqual(caps.trueColor, true);
			assert.strictEqual(caps.hyperlinks, true);
		});
	});
});

describe("getPngDimensions", () => {
	it("parses width and height from a valid PNG header", () => {
		// PNG signature (8 bytes) + IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4)
		const bytes = [
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
			0x00, 0x00, 0x00, 0x0d, // IHDR length
			0x49, 0x48, 0x44, 0x52, // "IHDR"
			0x00, 0x00, 0x01, 0x90, // width = 400
			0x00, 0x00, 0x00, 0xc8, // height = 200
		];
		assert.deepStrictEqual(getPngDimensions(b64(bytes)), { widthPx: 400, heightPx: 200 });
	});

	it("returns null for a buffer that is too short", () => {
		assert.strictEqual(getPngDimensions(b64([0x89, 0x50])), null);
	});

	it("returns null when the PNG signature does not match", () => {
		const bytes = new Array(24).fill(0);
		assert.strictEqual(getPngDimensions(b64(bytes)), null);
	});
});

describe("getJpegDimensions", () => {
	it("parses dimensions from a SOF0 marker", () => {
		// SOI, then a SOF0 (0xFFC0) segment: marker + length(4..) precision + height + width
		const bytes = [
			0xff, 0xd8, // SOI
			0xff, 0xc0, // SOF0 marker
			0x00, 0x11, // segment length
			0x08, // precision
			0x00, 0xf0, // height = 240
			0x01, 0x40, // width = 320
			0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		];
		assert.deepStrictEqual(getJpegDimensions(b64(bytes)), { widthPx: 320, heightPx: 240 });
	});

	it("skips non-SOF markers before reaching the SOF segment", () => {
		// SOI, an APP0 segment (0xFFE0) we must skip, then SOF0
		const bytes = [
			0xff, 0xd8, // SOI
			0xff, 0xe0, // APP0 marker
			0x00, 0x04, // length 4 -> skip 4 bytes total (2 length + 2 payload)
			0x00, 0x00, // payload
			0xff, 0xc1, // SOF1 marker (in 0xC0..0xC2 range)
			0x00, 0x11,
			0x08,
			0x00, 0x64, // height = 100
			0x00, 0xc8, // width = 200
			0, 0, 0, 0, 0, 0,
		];
		assert.deepStrictEqual(getJpegDimensions(b64(bytes)), { widthPx: 200, heightPx: 100 });
	});

	it("skips non-0xff bytes between markers", () => {
		// SOI, then a stray non-0xff byte (exercises `if (buffer[offset] !== 0xff) offset++`),
		// then a SOF marker carrying width=32 height=16.
		const bytes = [
			0xff, 0xd8,
			0x00, // stray byte — parser advances past it
			0xff, 0xc0,
			0x00, 0x11,
			0x08,
			0x00, 0x10, // height = 16
			0x00, 0x20, // width  = 32
			0, 0, 0, 0, 0, 0,
		];
		assert.deepStrictEqual(getJpegDimensions(b64(bytes)), { widthPx: 32, heightPx: 16 });
	});

	it("returns null for a buffer that is too short", () => {
		assert.strictEqual(getJpegDimensions(b64([0xff])), null);
	});

	it("returns null when the JPEG SOI marker is missing", () => {
		assert.strictEqual(getJpegDimensions(b64(new Array(20).fill(0))), null);
	});

	it("returns null when a segment length is invalid (< 2)", () => {
		const bytes = [
			0xff, 0xd8,
			0xff, 0xe0, // non-SOF marker
			0x00, 0x01, // length 1 -> invalid
			0, 0, 0, 0,
		];
		assert.strictEqual(getJpegDimensions(b64(bytes)), null);
	});

	it("returns null when no SOF marker is found before the buffer ends", () => {
		const bytes = [
			0xff, 0xd8,
			0xff, 0xe0,
			0x00, 0x04,
			0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		];
		assert.strictEqual(getJpegDimensions(b64(bytes)), null);
	});

	it("returns null when a marker length runs past the end of the buffer", () => {
		// SOI + non-SOF marker whose declared length points past the buffer end,
		// so `offset + 3 >= buffer.length` triggers the early null return.
		const bytes = [
			0xff, 0xd8,
			0xff, 0xe1, // APP1 marker
			0xff, // single trailing byte: offset+3 >= length
		];
		assert.strictEqual(getJpegDimensions(b64(bytes)), null);
	});
});

describe("getGifDimensions", () => {
	it("parses dimensions from a GIF89a header", () => {
		// "GIF89a" + width (LE16) + height (LE16)
		const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xc8, 0x00];
		assert.deepStrictEqual(getGifDimensions(b64(bytes)), { widthPx: 0x0140, heightPx: 0x00c8 });
	});

	it("parses dimensions from a GIF87a header", () => {
		const bytes = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x0a, 0x00, 0x14, 0x00];
		assert.deepStrictEqual(getGifDimensions(b64(bytes)), { widthPx: 10, heightPx: 20 });
	});

	it("returns null for a buffer that is too short", () => {
		assert.strictEqual(getGifDimensions(b64([0x47, 0x49])), null);
	});

	it("returns null when the GIF signature does not match", () => {
		assert.strictEqual(getGifDimensions(b64(new Array(10).fill(0x41))), null);
	});
});

describe("getWebpDimensions", () => {
	const riffWebpHeader = (chunk: string, payload: number[]): number[] => {
		const bytes = [
			0x52, 0x49, 0x46, 0x46, // "RIFF"
			0, 0, 0, 0, // file size (ignored)
			0x57, 0x45, 0x42, 0x50, // "WEBP"
			...[...chunk].map((c) => c.charCodeAt(0)), // chunk fourcc
			...payload,
		];
		while (bytes.length < 30) bytes.push(0);
		return bytes;
	};

	it("parses a lossy VP8 chunk", () => {
		// VP8  chunk: width = LE16 at byte 26 & 0x3fff, height = LE16 at byte 28 & 0x3fff.
		// The chunk fourcc occupies bytes 12..15, so payload starts at byte 16
		// and payload[10/11] -> bytes 26/27, payload[12/13] -> bytes 28/29.
		const payload = new Array(14).fill(0);
		payload[10] = 0x20; // byte 26
		payload[11] = 0x00;
		payload[12] = 0x10; // byte 28
		payload[13] = 0x00;
		assert.deepStrictEqual(getWebpDimensions(b64(riffWebpHeader("VP8 ", payload))), {
			widthPx: 0x20,
			heightPx: 0x10,
		});
	});

	it("parses a lossless VP8L chunk", () => {
		// VP8L: 32-bit LE at byte 21 packs (width-1) low 14 bits, (height-1) next 14.
		// Payload starts at byte 16, so payload[5..8] -> bytes 21..24.
		const width = 50;
		const height = 30;
		const bits = (width - 1) | ((height - 1) << 14);
		const payload = new Array(14).fill(0);
		payload[5] = bits & 0xff;
		payload[6] = (bits >> 8) & 0xff;
		payload[7] = (bits >> 16) & 0xff;
		payload[8] = (bits >> 24) & 0xff;
		assert.deepStrictEqual(getWebpDimensions(b64(riffWebpHeader("VP8L", payload))), {
			widthPx: width,
			heightPx: height,
		});
	});

	it("parses an extended VP8X chunk", () => {
		// VP8X: 24-bit LE (width-1) at offset 24, (height-1) at offset 27.
		const width = 100;
		const height = 80;
		const payload = new Array(8).fill(0); // offsets 16..23
		const w = width - 1;
		const h = height - 1;
		payload.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff); // offset 24..26
		payload.push(h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff); // offset 27..29
		assert.deepStrictEqual(getWebpDimensions(b64(riffWebpHeader("VP8X", payload))), {
			widthPx: width,
			heightPx: height,
		});
	});

	it("returns null for an unknown chunk type", () => {
		assert.strictEqual(getWebpDimensions(b64(riffWebpHeader("ZZZZ", new Array(20).fill(0)))), null);
	});

	it("returns null for a buffer that is too short", () => {
		assert.strictEqual(getWebpDimensions(b64(new Array(10).fill(0))), null);
	});

	it("returns null when the RIFF/WEBP signature does not match", () => {
		assert.strictEqual(getWebpDimensions(b64(new Array(40).fill(0))), null);
	});
});

describe("getImageDimensions", () => {
	it("dispatches to the PNG parser for image/png", () => {
		const bytes = [
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
			0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x06,
		];
		assert.deepStrictEqual(getImageDimensions(b64(bytes), "image/png"), { widthPx: 5, heightPx: 6 });
	});

	it("dispatches to the JPEG parser for image/jpeg", () => {
		const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x04, 0, 0, 0, 0, 0, 0];
		assert.deepStrictEqual(getImageDimensions(b64(bytes), "image/jpeg"), { widthPx: 4, heightPx: 3 });
	});

	it("dispatches to the GIF parser for image/gif", () => {
		const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x07, 0x00, 0x08, 0x00];
		assert.deepStrictEqual(getImageDimensions(b64(bytes), "image/gif"), { widthPx: 7, heightPx: 8 });
	});

	it("dispatches to the WEBP parser for image/webp", () => {
		// VP8 chunk; width at byte 26, height at byte 28 (payload starts at byte 16).
		const payload = new Array(14).fill(0);
		payload[10] = 0x09; // byte 26 -> width 9
		payload[12] = 0x0b; // byte 28 -> height 11
		const bytes = [
			0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
			...payload,
		];
		assert.deepStrictEqual(getImageDimensions(b64(bytes), "image/webp"), { widthPx: 9, heightPx: 11 });
	});

	it("returns null for an unsupported mime type", () => {
		assert.strictEqual(getImageDimensions(b64([1, 2, 3]), "image/bmp"), null);
	});
});

describe("encodeITerm2", () => {
	it("emits an inline iTerm2 image sequence with default options", () => {
		const seq = encodeITerm2("QUJD");
		assert.ok(seq.startsWith("\x1b]1337;File=inline=1"));
		assert.ok(seq.endsWith("QUJD\x07"));
	});

	it("includes width, height, base64 name, and preserveAspectRatio=0 when supplied", () => {
		const seq = encodeITerm2("QUJD", {
			width: "100px",
			height: 40,
			name: "photo.png",
			preserveAspectRatio: false,
		});
		assert.ok(seq.includes("width=100px"));
		assert.ok(seq.includes("height=40"));
		assert.ok(seq.includes(`name=${Buffer.from("photo.png").toString("base64")}`));
		assert.ok(seq.includes("preserveAspectRatio=0"));
	});

	it("emits inline=0 when inline is explicitly false", () => {
		const seq = encodeITerm2("QUJD", { inline: false });
		assert.ok(seq.includes("inline=0"));
	});
});

describe("calculateImageRows", () => {
	it("scales image height to terminal rows based on target width", () => {
		// 100x50 image at 10 cells wide, cells 10x20px:
		// targetWidthPx = 100, scale = 1, scaledHeight = 50, rows = ceil(50/20) = 3
		const rows = calculateImageRows({ widthPx: 100, heightPx: 50 }, 10, { widthPx: 10, heightPx: 20 });
		assert.strictEqual(rows, 3);
	});

	it("never returns fewer than 1 row", () => {
		const rows = calculateImageRows({ widthPx: 1000, heightPx: 1 }, 1, { widthPx: 9, heightPx: 18 });
		assert.strictEqual(rows, 1);
	});

	it("uses the default cell dimensions when none are provided", () => {
		const rows = calculateImageRows({ widthPx: 90, heightPx: 90 }, 10);
		assert.ok(rows >= 1);
	});
});

describe("allocateImageId / getCellDimensions", () => {
	it("allocateImageId returns a positive integer within the Kitty id range", () => {
		for (let i = 0; i < 20; i++) {
			const id = allocateImageId();
			assert.ok(Number.isInteger(id));
			assert.ok(id >= 1 && id <= 0xffffffff);
		}
	});

	it("getCellDimensions reflects the most recent setCellDimensions call", () => {
		setCellDimensions({ widthPx: 11, heightPx: 22 });
		assert.deepStrictEqual(getCellDimensions(), { widthPx: 11, heightPx: 22 });
	});
});

describe("imageFallback", () => {
	it("renders just the mime type when no dimensions or filename are given", () => {
		assert.strictEqual(imageFallback("image/png"), "[Image: [image/png]]");
	});

	it("includes the filename and dimensions when provided", () => {
		assert.strictEqual(
			imageFallback("image/jpeg", { widthPx: 640, heightPx: 480 }, "vacation.jpg"),
			"[Image: vacation.jpg [image/jpeg] 640x480]",
		);
	});
});

describe("renderImage", () => {
	it("returns null when the terminal has no image protocol", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		assert.strictEqual(renderImage("QUJD", { widthPx: 10, heightPx: 10 }), null);
	});

	it("returns an iTerm2 sequence when the protocol is iterm2", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const result = renderImage("QUJD", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 4 });
		assert.ok(result);
		assert.ok(result.sequence.startsWith("\x1b]1337;File="));
		assert.strictEqual(result.imageId, undefined);
	});

	it("uses the default maxWidthCells when none is provided", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const result = renderImage("QUJD", { widthPx: 100, heightPx: 100 });
		assert.ok(result);
		assert.ok(result.sequence.includes("c=80"));
	});
});
