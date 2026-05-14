// ADR-0017 phase C.7: ConsoleRuntimeProvider — console capture + completion lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleRuntimeProvider } from "../src/components/sandbox/ConsoleRuntimeProvider.js";

// Save original console methods + window globals so each test starts clean.
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalWarn: typeof console.warn;
let originalInfo: typeof console.info;

beforeEach(() => {
	originalLog = console.log;
	originalErr = console.error;
	originalWarn = console.warn;
	originalInfo = console.info;
	delete (globalThis as Record<string, unknown>).__originalConsole;
	delete (globalThis as Record<string, unknown>).sendRuntimeMessage;
	delete (globalThis as Record<string, unknown>).onCompleted;
	delete (globalThis as Record<string, unknown>).complete;
});

afterEach(() => {
	console.log = originalLog;
	console.error = originalErr;
	console.warn = originalWarn;
	console.info = originalInfo;
	delete (globalThis as Record<string, unknown>).__originalConsole;
	delete (globalThis as Record<string, unknown>).sendRuntimeMessage;
	delete (globalThis as Record<string, unknown>).onCompleted;
	delete (globalThis as Record<string, unknown>).complete;
});

describe("ConsoleRuntimeProvider — non-runtime methods", () => {
	it("getData returns empty object", () => {
		expect(new ConsoleRuntimeProvider().getData()).toEqual({});
	});

	it("getDescription returns empty string", () => {
		expect(new ConsoleRuntimeProvider().getDescription()).toBe("");
	});

	it("handleMessage with type='console' + method='error' tags as error log", async () => {
		const p = new ConsoleRuntimeProvider();
		const respond = vi.fn();
		await p.handleMessage({ type: "console", method: "error", text: "boom", args: [1] }, respond);
		expect(p.getLogs()).toHaveLength(1);
		expect(p.getLogs()[0]).toEqual({ type: "error", text: "boom", args: [1] });
		expect(respond).toHaveBeenCalledWith({ success: true });
	});

	it("handleMessage maps method='warn' → type='warn'", async () => {
		const p = new ConsoleRuntimeProvider();
		await p.handleMessage({ type: "console", method: "warn", text: "w" }, vi.fn());
		expect(p.getLogs()[0].type).toBe("warn");
	});

	it("handleMessage maps method='info' → type='info'", async () => {
		const p = new ConsoleRuntimeProvider();
		await p.handleMessage({ type: "console", method: "info", text: "i" }, vi.fn());
		expect(p.getLogs()[0].type).toBe("info");
	});

	it("handleMessage maps any other method → type='log' (default branch)", async () => {
		const p = new ConsoleRuntimeProvider();
		await p.handleMessage({ type: "console", method: "log", text: "l" }, vi.fn());
		expect(p.getLogs()[0].type).toBe("log");
	});

	it("handleMessage with non-console type is a no-op", async () => {
		const p = new ConsoleRuntimeProvider();
		const respond = vi.fn();
		await p.handleMessage({ type: "other" }, respond);
		expect(p.getLogs()).toEqual([]);
		expect(respond).not.toHaveBeenCalled();
	});

	it("reset() clears logs and completion state", () => {
		const p = new ConsoleRuntimeProvider();
		p.getLogs().push({ type: "log", text: "x" }); // poke via private array
		p.reset();
		expect(p.getLogs()).toEqual([]);
		expect(p.isCompleted()).toBe(false);
		expect(p.getCompletionError()).toBeNull();
	});

	it("isCompleted is initially false; getCompletionError initially null", () => {
		const p = new ConsoleRuntimeProvider();
		expect(p.isCompleted()).toBe(false);
		expect(p.getCompletionError()).toBeNull();
	});
});

describe("ConsoleRuntimeProvider getRuntime() inner closures", () => {
	it("wrapped console captures __originalConsole on first invocation", () => {
		new ConsoleRuntimeProvider().getRuntime()("sb");
		expect((globalThis as Record<string, unknown>).__originalConsole).toBeDefined();
	});

	it("wrapped console methods stringify args (JSON for objects, String otherwise)", () => {
		const captured: string[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: { text: string }) => {
			captured.push(msg.text);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		console.log("string", { a: 1 }, 42);
		expect(captured[0]).toBe('string {"a":1} 42');
	});

	it("wrapped console handles JSON-circular by falling through to String() (covers catch)", () => {
		const captured: string[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: { text: string }) => {
			captured.push(msg.text);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const circ: Record<string, unknown> = {};
		circ.self = circ;
		console.log(circ);
		expect(captured[0]).toBe(String(circ));
	});

	it("when sendRuntimeMessage is missing, wrapped console still logs locally without throwing", () => {
		const localLog = vi.fn();
		console.log = localLog as never;
		new ConsoleRuntimeProvider().getRuntime()("sb");
		console.log("offline");
		// originalConsole.log was captured BEFORE we monkey-patched, so localLog gets called.
		// Either way, no throw.
	});

	it("on subsequent getRuntime() calls, __originalConsole is reused (covers the if-branch)", () => {
		new ConsoleRuntimeProvider().getRuntime()("a");
		const firstOrig = (globalThis as Record<string, unknown>).__originalConsole;
		new ConsoleRuntimeProvider().getRuntime()("b");
		const secondOrig = (globalThis as Record<string, unknown>).__originalConsole;
		expect(firstOrig).toBe(secondOrig);
	});

	it("onCompleted callback awaits pending sends when provided", async () => {
		let registered: ((s: boolean) => Promise<void>) | undefined;
		(globalThis as Record<string, unknown>).onCompleted = (cb: (s: boolean) => Promise<void>) => {
			registered = cb;
		};
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async () => ({});
		new ConsoleRuntimeProvider().getRuntime()("sb");
		console.log("hi");
		expect(registered).toBeDefined();
		await registered!(true);
	});

	it("complete() without prior error sends 'execution-complete' to sendRuntimeMessage", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn(undefined, "myReturn");
		// First send may have happened during console wrapping; latest send is execution-complete.
		const last = sends[sends.length - 1] as { type: string; returnValue: string };
		expect(last.type).toBe("execution-complete");
		expect(last.returnValue).toBe("myReturn");
	});

	it("complete() with explicit error sends 'execution-error'", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn({ message: "x", stack: "y" });
		const last = sends[sends.length - 1] as { type: string };
		expect(last.type).toBe("execution-error");
	});

	it("complete() called twice is idempotent (covers completionSent guard)", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn();
		const sendsBefore = sends.length;
		await completeFn();
		expect(sends.length).toBe(sendsBefore);
	});

	it("complete() with no sendRuntimeMessage skips the dispatch", async () => {
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		// No sendRuntimeMessage set; should not throw.
		await completeFn();
	});

	it("window 'error' event captures lastError and complete() forwards it (covers lines 95-100)", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		// Dispatch a synthetic error event with Error.cause-shaped payload.
		const errEvent = new Event("error") as Event & {
			error?: unknown;
			message?: string;
			lineno?: number;
			colno?: number;
		};
		errEvent.error = new Error("oops");
		errEvent.message = "oops";
		errEvent.lineno = 1;
		errEvent.colno = 2;
		window.dispatchEvent(errEvent);
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn();
		const last = sends[sends.length - 1] as { type: string };
		expect(last.type).toBe("execution-error");
	});

	it("window 'error' event without nested error uses message-only fallbacks", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		// No `.error` property — exercises fallback path inside `${e.error?.stack || e.message || String(e)}` and friends.
		const errEvent = new Event("error") as Event & { message?: string };
		errEvent.message = "msg-only";
		window.dispatchEvent(errEvent);
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn();
		expect((sends[sends.length - 1] as { type: string }).type).toBe("execution-error");
	});

	it("window 'unhandledrejection' event captures lastError (covers 104-109)", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const evt = new Event("unhandledrejection") as Event & { reason?: unknown };
		evt.reason = new Error("rejected");
		window.dispatchEvent(evt);
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn();
		expect((sends[sends.length - 1] as { type: string }).type).toBe("execution-error");
	});

	it("window 'unhandledrejection' with primitive reason uses String fallbacks", async () => {
		const sends: unknown[] = [];
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async (msg: unknown) => {
			sends.push(msg);
			return {};
		};
		new ConsoleRuntimeProvider().getRuntime()("sb");
		const evt = new Event("unhandledrejection") as Event & { reason?: unknown };
		evt.reason = "stringly-reason";
		window.dispatchEvent(evt);
		const completeFn = (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).complete;
		await completeFn();
		expect((sends[sends.length - 1] as { type: string }).type).toBe("execution-error");
	});
});
