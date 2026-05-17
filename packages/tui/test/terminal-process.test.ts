// Coverage for ProcessTerminal — the real terminal implementation.
// ProcessTerminal touches process.stdin/stdout, so each test stubs those
// streams with controllable fakes and restores them afterwards.
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { setKittyProtocolActive } from "../src/keys.js";
import { ProcessTerminal } from "../src/terminal.js";

interface FakeStdin extends EventEmitter {
	isRaw: boolean;
	setRawMode?: (mode: boolean) => void;
	setEncoding: (enc: string) => void;
	resume: () => void;
	pause: () => void;
	rawModeCalls: boolean[];
	resumed: boolean;
	paused: boolean;
}

interface FakeStdout extends EventEmitter {
	columns?: number;
	rows?: number;
	write: (data: string) => boolean;
	writes: string[];
}

function makeFakeStdin(opts: { withRawMode?: boolean } = {}): FakeStdin {
	const emitter = new EventEmitter() as FakeStdin;
	emitter.isRaw = false;
	emitter.rawModeCalls = [];
	emitter.resumed = false;
	emitter.paused = false;
	if (opts.withRawMode !== false) {
		emitter.setRawMode = (mode: boolean) => {
			emitter.rawModeCalls.push(mode);
			emitter.isRaw = mode;
		};
	}
	emitter.setEncoding = () => {};
	emitter.resume = () => {
		emitter.resumed = true;
	};
	emitter.pause = () => {
		emitter.paused = true;
	};
	return emitter;
}

function makeFakeStdout(): FakeStdout {
	const emitter = new EventEmitter() as FakeStdout;
	emitter.columns = 80;
	emitter.rows = 24;
	emitter.writes = [];
	emitter.write = (data: string) => {
		emitter.writes.push(data);
		return true;
	};
	return emitter;
}

describe("ProcessTerminal", () => {
	let originalStdin: PropertyDescriptor | undefined;
	let originalStdout: PropertyDescriptor | undefined;
	let originalKill: typeof process.kill;
	let killCalls: Array<{ pid: number; signal?: string | number }>;
	let fakeStdin: FakeStdin;
	let fakeStdout: FakeStdout;

	beforeEach(() => {
		originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
		originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
		originalKill = process.kill;
		killCalls = [];
		fakeStdin = makeFakeStdin();
		fakeStdout = makeFakeStdout();
		Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
		Object.defineProperty(process, "stdout", { value: fakeStdout, configurable: true });
		process.kill = ((pid: number, signal?: string | number) => {
			killCalls.push({ pid, signal });
			return true;
		}) as typeof process.kill;
	});

	afterEach(() => {
		if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
		if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
		process.kill = originalKill;
		setKittyProtocolActive(false);
		vi.useRealTimers();
	});

	it("reports columns and rows from stdout, with env and default fallbacks", () => {
		const terminal = new ProcessTerminal();
		assert.strictEqual(terminal.columns, 80);
		assert.strictEqual(terminal.rows, 24);

		fakeStdout.columns = undefined;
		fakeStdout.rows = undefined;
		const prevCols = process.env.COLUMNS;
		const prevLines = process.env.LINES;
		process.env.COLUMNS = "120";
		process.env.LINES = "40";
		assert.strictEqual(terminal.columns, 120);
		assert.strictEqual(terminal.rows, 40);

		delete process.env.COLUMNS;
		delete process.env.LINES;
		assert.strictEqual(terminal.columns, 80);
		assert.strictEqual(terminal.rows, 24);

		if (prevCols === undefined) delete process.env.COLUMNS;
		else process.env.COLUMNS = prevCols;
		if (prevLines === undefined) delete process.env.LINES;
		else process.env.LINES = prevLines;
	});

	it("start() enables raw mode, bracketed paste, resize handler, and queries Kitty protocol", () => {
		vi.useFakeTimers();
		const terminal = new ProcessTerminal();
		const inputs: string[] = [];
		let resizeCount = 0;
		terminal.start(
			(data) => inputs.push(data),
			() => {
				resizeCount++;
			},
		);

		// Raw mode saved (false) then enabled (true)
		assert.deepStrictEqual(fakeStdin.rawModeCalls, [true]);
		assert.strictEqual(fakeStdin.resumed, true);
		// Bracketed paste enabled + Kitty query written
		assert.ok(fakeStdout.writes.includes("\x1b[?2004h"));
		assert.ok(fakeStdout.writes.includes("\x1b[?u"));
		// SIGWINCH refresh on non-win32
		if (process.platform !== "win32") {
			assert.ok(killCalls.some((c) => c.signal === "SIGWINCH"));
		}

		// resize handler is wired to stdout 'resize'
		fakeStdout.emit("resize");
		assert.strictEqual(resizeCount, 1);

		// Kitty protocol not detected within 150ms -> falls back to modifyOtherKeys
		vi.advanceTimersByTime(200);
		assert.ok(fakeStdout.writes.includes("\x1b[>4;2m"));

		terminal.stop();
	});

	it("detects Kitty protocol response, enables it, and does not forward the response", () => {
		const terminal = new ProcessTerminal();
		const inputs: string[] = [];
		terminal.start(
			(data) => inputs.push(data),
			() => {},
		);
		assert.strictEqual(terminal.kittyProtocolActive, false);

		// Feed the Kitty protocol response through stdin
		fakeStdin.emit("data", "\x1b[?1u");
		assert.strictEqual(terminal.kittyProtocolActive, true);
		// Push-flags sequence written, response NOT forwarded to handler
		assert.ok(fakeStdout.writes.includes("\x1b[>7u"));
		assert.deepStrictEqual(inputs, []);

		// Subsequent normal input IS forwarded
		fakeStdin.emit("data", "a");
		assert.deepStrictEqual(inputs, ["a"]);

		terminal.stop();
	});

	it("forwards pasted content re-wrapped with bracketed paste markers", () => {
		const terminal = new ProcessTerminal();
		const inputs: string[] = [];
		terminal.start(
			(data) => inputs.push(data),
			() => {},
		);

		fakeStdin.emit("data", "\x1b[200~hello world\x1b[201~");
		assert.deepStrictEqual(inputs, ["\x1b[200~hello world\x1b[201~"]);

		terminal.stop();
	});

	it("does not write modifyOtherKeys fallback if Kitty protocol was detected first", () => {
		vi.useFakeTimers();
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		fakeStdin.emit("data", "\x1b[?1u");
		vi.advanceTimersByTime(200);
		assert.ok(!fakeStdout.writes.includes("\x1b[>4;2m"));
		terminal.stop();
	});

	it("stop() disables protocols, restores raw mode, pauses stdin, removes handlers", () => {
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		// Activate Kitty so stop() has to disable it
		fakeStdin.emit("data", "\x1b[?1u");
		assert.strictEqual(terminal.kittyProtocolActive, true);

		fakeStdout.writes.length = 0;
		terminal.stop();

		assert.ok(fakeStdout.writes.includes("\x1b[?2004l"), "bracketed paste disabled");
		assert.ok(fakeStdout.writes.includes("\x1b[<u"), "kitty protocol popped");
		assert.strictEqual(terminal.kittyProtocolActive, false);
		assert.strictEqual(fakeStdin.paused, true);
		// raw mode restored to the saved value (false)
		assert.strictEqual(fakeStdin.rawModeCalls[fakeStdin.rawModeCalls.length - 1], false);
		assert.strictEqual(fakeStdin.listenerCount("data"), 0);
		assert.strictEqual(fakeStdout.listenerCount("resize"), 0);
	});

	it("stop() after modifyOtherKeys fallback disables modifyOtherKeys mode", () => {
		vi.useFakeTimers();
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		vi.advanceTimersByTime(200); // trigger fallback
		fakeStdout.writes.length = 0;
		terminal.stop();
		assert.ok(fakeStdout.writes.includes("\x1b[>4;0m"));
	});

	it("drainInput resolves immediately when idle and disables Kitty protocol", async () => {
		vi.useRealTimers();
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		fakeStdin.emit("data", "\x1b[?1u"); // activate kitty
		fakeStdout.writes.length = 0;

		await terminal.drainInput(100, 5);
		assert.ok(fakeStdout.writes.includes("\x1b[<u"), "kitty disabled before drain");
		assert.strictEqual(terminal.kittyProtocolActive, false);

		terminal.stop();
	});

	it("drainInput exits after maxMs even when input keeps arriving", async () => {
		vi.useRealTimers();
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		const interval = setInterval(() => fakeStdin.emit("data", "x"), 2);
		const start = Date.now();
		await terminal.drainInput(40, 1000);
		clearInterval(interval);
		assert.ok(Date.now() - start >= 30, "should have waited close to maxMs");
		terminal.stop();
	});

	it("drainInput disables modifyOtherKeys mode when active", async () => {
		vi.useFakeTimers();
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		vi.advanceTimersByTime(200); // activate modifyOtherKeys fallback
		vi.useRealTimers();
		fakeStdout.writes.length = 0;
		await terminal.drainInput(20, 5);
		assert.ok(fakeStdout.writes.includes("\x1b[>4;0m"));
		terminal.stop();
	});

	it("write() forwards to stdout", () => {
		const terminal = new ProcessTerminal();
		terminal.write("hello");
		assert.ok(fakeStdout.writes.includes("hello"));
	});

	it("moveBy writes down/up sequences and nothing for zero", () => {
		const terminal = new ProcessTerminal();
		terminal.moveBy(3);
		terminal.moveBy(-2);
		terminal.moveBy(0);
		assert.deepStrictEqual(fakeStdout.writes, ["\x1b[3B", "\x1b[2A"]);
	});

	it("cursor and clear helpers write the expected escape sequences", () => {
		const terminal = new ProcessTerminal();
		terminal.hideCursor();
		terminal.showCursor();
		terminal.clearLine();
		terminal.clearFromCursor();
		terminal.clearScreen();
		terminal.setTitle("My Title");
		assert.deepStrictEqual(fakeStdout.writes, [
			"\x1b[?25l",
			"\x1b[?25h",
			"\x1b[K",
			"\x1b[J",
			"\x1b[2J\x1b[H",
			"\x1b]0;My Title\x07",
		]);
	});

	it("setProgress(true) writes the active sequence and keeps it alive on an interval", () => {
		vi.useFakeTimers();
		const terminal = new ProcessTerminal();
		terminal.setProgress(true);
		assert.deepStrictEqual(fakeStdout.writes, ["\x1b]9;4;3\x07"]);

		// Keepalive interval re-emits the active sequence
		vi.advanceTimersByTime(1000);
		assert.strictEqual(fakeStdout.writes.filter((w) => w === "\x1b]9;4;3\x07").length, 2);

		// Second call while already active does not create a second interval
		terminal.setProgress(true);
		vi.advanceTimersByTime(1000);
		assert.strictEqual(fakeStdout.writes.filter((w) => w === "\x1b]9;4;3\x07").length, 4);

		// setProgress(false) clears the interval and writes the clear sequence
		fakeStdout.writes.length = 0;
		terminal.setProgress(false);
		assert.deepStrictEqual(fakeStdout.writes, ["\x1b]9;4;0;\x07"]);
		vi.advanceTimersByTime(2000);
		assert.strictEqual(fakeStdout.writes.length, 1);
	});

	it("setProgress(false) without an active interval still writes the clear sequence", () => {
		const terminal = new ProcessTerminal();
		terminal.setProgress(false);
		assert.deepStrictEqual(fakeStdout.writes, ["\x1b]9;4;0;\x07"]);
	});

	it("stop() emits the progress clear sequence when a progress interval was active", () => {
		vi.useFakeTimers();
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		terminal.setProgress(true);
		fakeStdout.writes.length = 0;
		terminal.stop();
		assert.ok(fakeStdout.writes.includes("\x1b]9;4;0;\x07"));
	});

	it("start() tolerates a stdin without setRawMode", () => {
		const noRawStdin = makeFakeStdin({ withRawMode: false });
		Object.defineProperty(process, "stdin", { value: noRawStdin, configurable: true });
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		// No throw; bracketed paste still enabled
		assert.ok(fakeStdout.writes.includes("\x1b[?2004h"));
		terminal.stop();
	});

	it("logs writes to PI_TUI_WRITE_LOG when set to a file path", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const logFile = path.join(os.tmpdir(), `pi-tui-write-log-${process.pid}-${Date.now()}.log`);
		const prev = process.env.PI_TUI_WRITE_LOG;
		process.env.PI_TUI_WRITE_LOG = logFile;
		try {
			const terminal = new ProcessTerminal();
			terminal.write("logged-output");
			const contents = fs.readFileSync(logFile, "utf8");
			assert.ok(contents.includes("logged-output"));
		} finally {
			if (prev === undefined) delete process.env.PI_TUI_WRITE_LOG;
			else process.env.PI_TUI_WRITE_LOG = prev;
			try {
				fs.rmSync(logFile, { force: true });
			} catch {
				// ignore
			}
		}
	});

	it("treats PI_TUI_WRITE_LOG pointing at a directory as a timestamped log directory", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tui-write-logdir-"));
		const prev = process.env.PI_TUI_WRITE_LOG;
		process.env.PI_TUI_WRITE_LOG = logDir;
		try {
			const terminal = new ProcessTerminal();
			terminal.write("dir-logged");
			const files = fs.readdirSync(logDir);
			assert.strictEqual(files.length, 1);
			assert.ok(files[0].startsWith("tui-"));
			assert.ok(fs.readFileSync(path.join(logDir, files[0]), "utf8").includes("dir-logged"));
		} finally {
			if (prev === undefined) delete process.env.PI_TUI_WRITE_LOG;
			else process.env.PI_TUI_WRITE_LOG = prev;
			fs.rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("write() swallows logging errors when the log path is not writable", async () => {
		const os = await import("node:os");
		const path = await import("node:path");
		const prev = process.env.PI_TUI_WRITE_LOG;
		// A path whose parent directory does not exist -> appendFileSync throws, must be swallowed
		process.env.PI_TUI_WRITE_LOG = path.join(os.tmpdir(), "pi-tui-missing-dir-xyz", "nope.log");
		try {
			const terminal = new ProcessTerminal();
			assert.doesNotThrow(() => terminal.write("still-works"));
			assert.ok(fakeStdout.writes.includes("still-works"));
		} finally {
			if (prev === undefined) delete process.env.PI_TUI_WRITE_LOG;
			else process.env.PI_TUI_WRITE_LOG = prev;
		}
	});

	it("uses PI_TUI_WRITE_LOG verbatim when it is neither an existing dir nor statable", async () => {
		const os = await import("node:os");
		const path = await import("node:path");
		const fs = await import("node:fs");
		const prev = process.env.PI_TUI_WRITE_LOG;
		// statSync throws (path does not exist) -> caught -> used as-is
		const logFile = path.join(os.tmpdir(), `pi-tui-verbatim-${process.pid}-${Date.now()}.log`);
		process.env.PI_TUI_WRITE_LOG = logFile;
		try {
			const terminal = new ProcessTerminal();
			terminal.write("verbatim-output");
			assert.ok(fs.readFileSync(logFile, "utf8").includes("verbatim-output"));
		} finally {
			if (prev === undefined) delete process.env.PI_TUI_WRITE_LOG;
			else process.env.PI_TUI_WRITE_LOG = prev;
			try {
				fs.rmSync(logFile, { force: true });
			} catch {
				// ignore
			}
		}
	});
});
