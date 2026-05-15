// Coverage for ProcessTerminal.enableWindowsVTInput — Windows-only code path.
// On non-Windows hosts we simulate process.platform === "win32" and inject a
// fake `koffi` native-FFI module into the CJS require cache so the Win32
// console-mode calls run against controllable stubs.
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ProcessTerminal } from "../src/terminal.js";

const require = createRequire(import.meta.url);
// terminal.ts resolves "koffi" from its own location; resolved to the same
// absolute path regardless of which module does the resolving in this monorepo.
const koffiPath = require.resolve("koffi");

function makeFakeStdin(): EventEmitter & {
	isRaw: boolean;
	setRawMode: (m: boolean) => void;
	setEncoding: () => void;
	resume: () => void;
	pause: () => void;
} {
	const e = new EventEmitter() as ReturnType<typeof makeFakeStdin>;
	e.isRaw = false;
	e.setRawMode = (m: boolean) => {
		e.isRaw = m;
	};
	e.setEncoding = () => {};
	e.resume = () => {};
	e.pause = () => {};
	return e;
}

function makeFakeStdout(): EventEmitter & { columns: number; rows: number; write: (d: string) => boolean } {
	const e = new EventEmitter() as ReturnType<typeof makeFakeStdout>;
	e.columns = 80;
	e.rows = 24;
	e.write = () => true;
	return e;
}

describe("ProcessTerminal.enableWindowsVTInput (simulated win32)", () => {
	let originalStdin: PropertyDescriptor | undefined;
	let originalStdout: PropertyDescriptor | undefined;
	let originalPlatform: PropertyDescriptor | undefined;
	let originalKoffi: NodeModule | undefined;
	let originalKill: typeof process.kill;

	beforeEach(() => {
		originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
		originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		originalKoffi = require.cache[koffiPath];
		originalKill = process.kill;

		Object.defineProperty(process, "stdin", { value: makeFakeStdin(), configurable: true });
		Object.defineProperty(process, "stdout", { value: makeFakeStdout(), configurable: true });
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		process.kill = (() => true) as typeof process.kill;
	});

	afterEach(() => {
		if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
		if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		if (originalKoffi) require.cache[koffiPath] = originalKoffi;
		else delete require.cache[koffiPath];
		process.kill = originalKill;
	});

	it("reads and sets the console mode with ENABLE_VIRTUAL_TERMINAL_INPUT", () => {
		const setModeCalls: Array<{ handle: unknown; mode: number }> = [];
		// Fake koffi: load() returns an object whose func() returns callable stubs.
		const fakeKoffi = {
			load: (_dll: string) => ({
				func: (signature: string) => {
					if (signature.includes("GetStdHandle")) {
						return (_id: number) => ({ __handle: true });
					}
					if (signature.includes("GetConsoleMode")) {
						return (_handle: unknown, modeOut: Uint32Array) => {
							modeOut[0] = 0x0001; // pretend some existing flags
							return true;
						};
					}
					if (signature.includes("SetConsoleMode")) {
						return (handle: unknown, mode: number) => {
							setModeCalls.push({ handle, mode });
							return true;
						};
					}
					throw new Error(`unexpected koffi func: ${signature}`);
				},
			}),
		};
		require.cache[koffiPath] = {
			id: koffiPath,
			filename: koffiPath,
			loaded: true,
			exports: fakeKoffi,
		} as unknown as NodeModule;

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);

		assert.strictEqual(setModeCalls.length, 1);
		// 0x0001 (existing) | 0x0200 (ENABLE_VIRTUAL_TERMINAL_INPUT) = 0x0201
		assert.strictEqual(setModeCalls[0].mode, 0x0201);

		terminal.stop();
	});

	it("swallows errors when koffi cannot be loaded", () => {
		require.cache[koffiPath] = {
			id: koffiPath,
			filename: koffiPath,
			loaded: true,
			exports: {
				load: () => {
					throw new Error("kernel32.dll not available");
				},
			},
		} as unknown as NodeModule;

		const terminal = new ProcessTerminal();
		assert.doesNotThrow(() =>
			terminal.start(
				() => {},
				() => {},
			),
		);
		terminal.stop();
	});
});
