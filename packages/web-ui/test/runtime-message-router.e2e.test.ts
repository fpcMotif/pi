// ADR-0017: RuntimeMessageRouter — centralized sandbox message routing.
//
// These end-to-end tests drive the router through both transports it
// supports: window.postMessage (sandbox iframes) and
// chrome.runtime.onUserScriptMessage (extension user scripts).
//
// They also pin the *fix* for the handler-isolation bug: each provider /
// consumer handler call is wrapped in try/catch so a single throwing or
// rejecting handler cannot starve the handlers that come after it, and the
// fire-and-forget listener never rejects with an uncaught promise rejection.
import { afterEach, describe, expect, it, vi } from "vitest";

import { type MessageConsumer, RuntimeMessageRouter } from "../src/components/sandbox/RuntimeMessageRouter.js";
import type { SandboxRuntimeProvider } from "../src/components/sandbox/SandboxRuntimeProvider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush the microtask + macrotask queues so fire-and-forget async work settles. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type IframeListener = (e: MessageEvent) => Promise<void>;
type UserScriptListener = (message: any, sender: any, sendResponse: (response: any) => void) => boolean;

interface RouterInternals {
	messageListener: IframeListener | null;
	userScriptMessageListener: UserScriptListener | null;
	sandboxes: Map<string, unknown>;
}

const internals = (router: RuntimeMessageRouter) => router as unknown as RouterInternals;
const iframeListener = (router: RuntimeMessageRouter) => internals(router).messageListener as IframeListener;
const userScriptListener = (router: RuntimeMessageRouter) =>
	internals(router).userScriptMessageListener as UserScriptListener;

/** Build a provider; pass `handleMessage` to opt into bidirectional comm. */
function makeProvider(handleMessage?: SandboxRuntimeProvider["handleMessage"]): SandboxRuntimeProvider {
	const provider: SandboxRuntimeProvider = {
		getData: () => ({}),
		getRuntime: () => () => {},
		getDescription: () => "",
	};
	if (handleMessage) provider.handleMessage = handleMessage;
	return provider;
}

const makeConsumer = (handleMessage: MessageConsumer["handleMessage"]): MessageConsumer => ({ handleMessage });

/** A fake iframe whose contentWindow.postMessage is observable. */
function fakeIframe(postMessage = vi.fn()): { iframe: HTMLIFrameElement; postMessage: ReturnType<typeof vi.fn> } {
	return { iframe: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement, postMessage };
}

/** Install a fake `chrome.runtime.onUserScriptMessage` and capture (un)registrations. */
function installChrome() {
	const added: UserScriptListener[] = [];
	const removed: UserScriptListener[] = [];
	(globalThis as any).chrome = {
		runtime: {
			onUserScriptMessage: {
				addListener: (fn: UserScriptListener) => added.push(fn),
				removeListener: (fn: UserScriptListener) => removed.push(fn),
			},
		},
	};
	return { added, removed };
}

// Track routers so we can tear down their global window/chrome listeners.
const liveRouters: RuntimeMessageRouter[] = [];
function newRouter(): RuntimeMessageRouter {
	const router = new RuntimeMessageRouter();
	liveRouters.push(router);
	return router;
}

afterEach(() => {
	for (const router of liveRouters) {
		for (const id of [...internals(router).sandboxes.keys()]) router.unregisterSandbox(id);
	}
	liveRouters.length = 0;
	delete (globalThis as any).chrome;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Iframe / window.postMessage transport
// ---------------------------------------------------------------------------

describe("RuntimeMessageRouter — iframe (window.postMessage) transport", () => {
	it("routes a message to every provider (with handleMessage) then every consumer, and posts responses back to the iframe", async () => {
		const router = newRouter();
		const order: string[] = [];
		const p1 = makeProvider(async (msg, respond) => {
			order.push("p1");
			respond({ from: "p1", echo: msg.value });
		});
		const noHandler = makeProvider(); // exercises the `if (provider.handleMessage)` false branch
		const p2 = makeProvider(async () => {
			order.push("p2");
		});
		const c1 = makeConsumer(async () => {
			order.push("c1");
		});
		const c2 = makeConsumer(async () => {
			order.push("c2");
		});

		router.registerSandbox("sb", [p1, noHandler, p2], [c1, c2]);
		const { iframe, postMessage } = fakeIframe();
		router.setSandboxIframe("sb", iframe);

		await iframeListener(router)(
			new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1", value: 42 } }),
		);

		expect(order).toEqual(["p1", "p2", "c1", "c2"]);
		expect(postMessage).toHaveBeenCalledWith(
			{ type: "runtime-response", messageId: "m1", sandboxId: "sb", from: "p1", echo: 42 },
			"*",
		);
	});

	it("integrates with a real window 'message' event dispatch", async () => {
		const router = newRouter();
		const seen: unknown[] = [];
		router.registerSandbox("sb", [], [makeConsumer(async (m) => void seen.push(m))]);

		window.dispatchEvent(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "mx", hello: 1 } }));
		await flush();

		expect(seen).toEqual([{ sandboxId: "sb", messageId: "mx", hello: 1 }]);
	});

	it("ignores messages without a sandboxId", async () => {
		const router = newRouter();
		const consumer = makeConsumer(vi.fn());
		router.registerSandbox("sb", [], [consumer]);

		await iframeListener(router)(new MessageEvent("message", { data: { messageId: "m1" } }));

		expect(consumer.handleMessage).not.toHaveBeenCalled();
	});

	it("ignores messages for an unregistered sandbox", async () => {
		const router = newRouter();
		const consumer = makeConsumer(vi.fn());
		router.registerSandbox("sb", [], [consumer]);

		await iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "other", messageId: "m1" } }));

		expect(consumer.handleMessage).not.toHaveBeenCalled();
	});

	it("respond() is a no-op when no iframe has been set", async () => {
		const router = newRouter();
		let threw = false;
		const provider = makeProvider(async (_msg, respond) => {
			try {
				respond({ ok: true });
			} catch {
				threw = true;
			}
		});
		router.registerSandbox("sb", [provider], []);

		await iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1" } }));

		expect(threw).toBe(false);
	});

	it("respond() is a no-op when the iframe has no contentWindow", async () => {
		const router = newRouter();
		let threw = false;
		const provider = makeProvider(async (_msg, respond) => {
			try {
				respond({ ok: true });
			} catch {
				threw = true;
			}
		});
		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", { contentWindow: null } as unknown as HTMLIFrameElement);

		await iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1" } }));

		expect(threw).toBe(false);
	});

	it("addConsumer / removeConsumer add and drop consumers on a live sandbox", async () => {
		const router = newRouter();
		router.registerSandbox("sb", [], []);
		const consumer = makeConsumer(vi.fn());

		router.addConsumer("sb", consumer);
		await iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1" } }));
		expect(consumer.handleMessage).toHaveBeenCalledTimes(1);

		router.removeConsumer("sb", consumer);
		await iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m2" } }));
		expect(consumer.handleMessage).toHaveBeenCalledTimes(1);
	});

	it("setSandboxIframe / addConsumer / removeConsumer are no-ops for an unknown sandbox", () => {
		const router = newRouter();
		const consumer = makeConsumer(vi.fn());
		expect(() => {
			router.setSandboxIframe("nope", fakeIframe().iframe);
			router.addConsumer("nope", consumer);
			router.removeConsumer("nope", consumer);
		}).not.toThrow();
	});

	// ----- handler isolation (the bug fix) --------------------------------

	it("a rejecting provider does NOT starve later providers + consumers, and the listener does not reject", async () => {
		const router = newRouter();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const order: string[] = [];
		const bad = makeProvider(async () => {
			order.push("bad");
			throw new Error("provider boom");
		});
		const good = makeProvider(async (_msg, respond) => {
			order.push("good");
			respond({ ok: true });
		});
		const consumer = makeConsumer(async () => {
			order.push("consumer");
		});
		router.registerSandbox("sb", [bad, good], [consumer]);
		const { postMessage } = (() => {
			const f = fakeIframe();
			router.setSandboxIframe("sb", f.iframe);
			return f;
		})();

		// The fire-and-forget listener must settle without rejecting.
		await expect(
			iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1" } })),
		).resolves.toBeUndefined();

		expect(order).toEqual(["bad", "good", "consumer"]);
		expect(postMessage).toHaveBeenCalledWith(
			{ type: "runtime-response", messageId: "m1", sandboxId: "sb", ok: true },
			"*",
		);
		expect(consoleError).toHaveBeenCalled();
	});

	it("a throwing consumer does NOT starve later consumers, and the listener does not reject", async () => {
		const router = newRouter();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const order: string[] = [];
		const bad = makeConsumer(() => {
			order.push("bad");
			throw new Error("consumer boom"); // synchronous throw inside an async signature
		});
		const good = makeConsumer(async () => {
			order.push("good");
		});
		router.registerSandbox("sb", [], [bad, good]);

		await expect(
			iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1" } })),
		).resolves.toBeUndefined();

		expect(order).toEqual(["bad", "good"]);
		expect(consoleError).toHaveBeenCalled();
	});

	it("one bad message does not permanently break the router", async () => {
		const router = newRouter();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls: string[] = [];
		const provider = makeProvider(async (msg) => {
			if (msg.boom) throw new Error("boom");
			calls.push(`p:${msg.messageId}`);
		});
		const consumer = makeConsumer(async (msg) => {
			calls.push(`c:${msg.messageId}`);
		});
		router.registerSandbox("sb", [provider], [consumer]);

		// First message: the provider throws.
		await iframeListener(router)(
			new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m1", boom: true } }),
		);
		// The consumer still ran for the bad message...
		expect(calls).toEqual(["c:m1"]);

		// ...and a subsequent good message is fully processed.
		await iframeListener(router)(new MessageEvent("message", { data: { sandboxId: "sb", messageId: "m2" } }));
		expect(calls).toEqual(["c:m1", "p:m2", "c:m2"]);
	});
});

// ---------------------------------------------------------------------------
// Chrome user-script (chrome.runtime.onUserScriptMessage) transport
// ---------------------------------------------------------------------------

describe("RuntimeMessageRouter — chrome user-script transport", () => {
	it("routes a user-script message to providers then consumers and responds with the sandboxId merged in", async () => {
		const router = newRouter();
		installChrome();
		const order: string[] = [];
		const p1 = makeProvider(async (msg, respond) => {
			order.push("p1");
			respond({ from: "p1", echo: msg.value });
		});
		const noHandler = makeProvider();
		const p2 = makeProvider(async () => void order.push("p2"));
		const c1 = makeConsumer(async () => void order.push("c1"));
		router.registerSandbox("sb", [p1, noHandler, p2], [c1]);

		const sendResponse = vi.fn();
		const result = userScriptListener(router)({ sandboxId: "sb", value: 7 }, {}, sendResponse);
		expect(result).toBe(true); // signals an async response
		await flush();

		expect(order).toEqual(["p1", "p2", "c1"]);
		expect(sendResponse).toHaveBeenCalledWith({ from: "p1", echo: 7, sandboxId: "sb" });
	});

	it("returns false for a message without a sandboxId", () => {
		const router = newRouter();
		installChrome();
		const consumer = makeConsumer(vi.fn());
		router.registerSandbox("sb", [], [consumer]);

		expect(userScriptListener(router)({ value: 1 }, {}, vi.fn())).toBe(false);
		expect(consumer.handleMessage).not.toHaveBeenCalled();
	});

	it("returns false for an unregistered sandbox", () => {
		const router = newRouter();
		installChrome();
		const consumer = makeConsumer(vi.fn());
		router.registerSandbox("sb", [], [consumer]);

		expect(userScriptListener(router)({ sandboxId: "other" }, {}, vi.fn())).toBe(false);
		expect(consumer.handleMessage).not.toHaveBeenCalled();
	});

	it("a rejecting provider does NOT starve later providers + consumers, with no unhandled rejection", async () => {
		const router = newRouter();
		installChrome();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const order: string[] = [];
			const bad = makeProvider(async () => {
				order.push("bad");
				throw new Error("provider boom");
			});
			const good = makeProvider(async (_msg, respond) => {
				order.push("good");
				respond({ ok: true });
			});
			const consumer = makeConsumer(async () => void order.push("consumer"));
			router.registerSandbox("sb", [bad, good], [consumer]);

			const sendResponse = vi.fn();
			userScriptListener(router)({ sandboxId: "sb" }, {}, sendResponse);
			await flush();
			await flush();

			expect(order).toEqual(["bad", "good", "consumer"]);
			expect(sendResponse).toHaveBeenCalledWith({ ok: true, sandboxId: "sb" });
			expect(consoleError).toHaveBeenCalled();
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("a throwing consumer does NOT starve later consumers, with no unhandled rejection", async () => {
		const router = newRouter();
		installChrome();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const order: string[] = [];
			const bad = makeConsumer(() => {
				order.push("bad");
				throw new Error("consumer boom");
			});
			const good = makeConsumer(async () => void order.push("good"));
			router.registerSandbox("sb", [], [bad, good]);

			userScriptListener(router)({ sandboxId: "sb" }, {}, vi.fn());
			await flush();
			await flush();

			expect(order).toEqual(["bad", "good"]);
			expect(consoleError).toHaveBeenCalled();
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("one bad user-script message does not permanently break the router", async () => {
		const router = newRouter();
		installChrome();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls: string[] = [];
		const provider = makeProvider(async (msg) => {
			if (msg.boom) throw new Error("boom");
			calls.push("p");
		});
		const consumer = makeConsumer(async () => void calls.push("c"));
		router.registerSandbox("sb", [provider], [consumer]);

		userScriptListener(router)({ sandboxId: "sb", boom: true }, {}, vi.fn());
		await flush();
		expect(calls).toEqual(["c"]);

		userScriptListener(router)({ sandboxId: "sb" }, {}, vi.fn());
		await flush();
		expect(calls).toEqual(["c", "p", "c"]);
	});
});

// ---------------------------------------------------------------------------
// Listener lifecycle (setup idempotency + teardown)
// ---------------------------------------------------------------------------

describe("RuntimeMessageRouter — listener lifecycle", () => {
	it("sets up each global listener exactly once across multiple registrations", () => {
		installChrome();
		const addSpy = vi.spyOn(window, "addEventListener");
		const router = newRouter();

		router.registerSandbox("a", [], []);
		router.registerSandbox("b", [], []);

		const messageAdds = addSpy.mock.calls.filter(([type]) => type === "message");
		expect(messageAdds).toHaveLength(1);
		// chrome listener registered exactly once too.
		expect((globalThis as any).chrome.runtime.onUserScriptMessage).toBeDefined();
		expect(typeof internals(router).userScriptMessageListener).toBe("function");
	});

	it("removes both global listeners when the final sandbox is unregistered (extension context)", () => {
		const { removed } = installChrome();
		const removeSpy = vi.spyOn(window, "removeEventListener");
		const router = newRouter();
		router.registerSandbox("sb", [], []);

		router.unregisterSandbox("sb");

		expect(removeSpy.mock.calls.some(([type]) => type === "message")).toBe(true);
		expect(internals(router).messageListener).toBeNull();
		expect(removed).toHaveLength(1);
		expect(internals(router).userScriptMessageListener).toBeNull();
	});

	it("keeps the global listeners while other sandboxes remain", () => {
		const { removed } = installChrome();
		const router = newRouter();
		router.registerSandbox("a", [], []);
		router.registerSandbox("b", [], []);

		router.unregisterSandbox("a");

		expect(typeof internals(router).messageListener).toBe("function");
		expect(typeof internals(router).userScriptMessageListener).toBe("function");
		expect(removed).toHaveLength(0);
	});

	it("non-extension context: only the window listener is set up and torn down", () => {
		// No chrome global at all.
		const router = newRouter();
		router.registerSandbox("sb", [], []);
		expect(internals(router).userScriptMessageListener).toBeNull();

		router.unregisterSandbox("sb");
		expect(internals(router).messageListener).toBeNull();
	});

	it("skips the user-script listener when chrome lacks onUserScriptMessage", () => {
		(globalThis as any).chrome = {}; // chrome defined, but no runtime/onUserScriptMessage
		const router = newRouter();
		router.registerSandbox("sb", [], []);

		expect(internals(router).userScriptMessageListener).toBeNull();
		expect(typeof internals(router).messageListener).toBe("function");
	});

	it("teardown skips chrome.removeListener when chrome has disappeared since setup", () => {
		const { removed } = installChrome();
		const router = newRouter();
		router.registerSandbox("sb", [], []);
		expect(typeof internals(router).userScriptMessageListener).toBe("function");

		delete (globalThis as any).chrome; // chrome vanished

		router.unregisterSandbox("sb");

		expect(internals(router).messageListener).toBeNull();
		expect(removed).toHaveLength(0);
	});

	it("teardown skips chrome.removeListener when onUserScriptMessage has disappeared since setup", () => {
		const { removed } = installChrome();
		const router = newRouter();
		router.registerSandbox("sb", [], []);

		(globalThis as any).chrome.runtime.onUserScriptMessage = undefined; // runtime present, API gone

		router.unregisterSandbox("sb");

		expect(internals(router).messageListener).toBeNull();
		expect(removed).toHaveLength(0);
	});

	it("teardown skips chrome.removeListener when chrome.runtime has disappeared since setup", () => {
		const { removed } = installChrome();
		const router = newRouter();
		router.registerSandbox("sb", [], []);

		(globalThis as any).chrome.runtime = undefined; // optional chaining short-circuits

		router.unregisterSandbox("sb");

		expect(internals(router).messageListener).toBeNull();
		expect(removed).toHaveLength(0);
	});
});
