// E2E behavior tests for RuntimeMessageRouter.
//
// These tests drive the REAL implementation with REAL postMessage round-trips.
// We feed genuine MessageEvents into window (exactly as a sandbox iframe would
// via window.parent.postMessage) to drive the router's single global listener,
// and we install a real "sandbox endpoint" object as iframe.contentWindow so
// that the router's respond() actually posts back across that boundary and the
// "sandbox side" observes the responses. The only things stubbed are true
// external boundaries: the iframe contentWindow target and the chrome
// extension API.
//
// Focus the existing unit test does NOT cover: request/response correlation
// across many concurrent in-flight requests, FIFO ordering of a burst,
// round-trip latency, duplicate/unknown/malformed message handling, streaming
// (multi-respond) correlation, and error propagation through the
// provider/consumer fan-out (blast radius of a throwing handler).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type MessageConsumer, RuntimeMessageRouter } from "../src/components/sandbox/RuntimeMessageRouter.js";
import type { SandboxRuntimeProvider } from "../src/components/sandbox/SandboxRuntimeProvider.js";

// --- helpers ---------------------------------------------------------------

const makeProvider = (
	handleMessage?: (m: any, respond: (r: any) => void) => Promise<void>,
): SandboxRuntimeProvider => ({
	getData: () => ({}),
	getRuntime: () => () => {},
	getDescription: () => "",
	handleMessage,
});

const makeConsumer = (received: any[], onEach?: (m: any) => void): MessageConsumer => ({
	handleMessage: async (m) => {
		received.push(m);
		onEach?.(m);
	},
});

/**
 * A real "sandbox endpoint". The router posts responses to whatever object is
 * installed as iframe.contentWindow; here that object records every response
 * the router sends and resolves promises keyed by the correlating messageId.
 * Delivery is synchronous on the receiving side (mirroring the structured
 * cross-realm postMessage hop) so tests stay deterministic without depending on
 * happy-dom's MessagePort timing — the round-trip through the router's real
 * respond() is exercised end to end either way.
 */
function makeSandboxEndpoint() {
	const received: any[] = [];
	const waiters = new Map<string, ((msg: any) => void)[]>();

	const contentWindow = {
		postMessage: (msg: any) => {
			received.push(msg);
			const key = msg?.messageId != null ? String(msg.messageId) : undefined;
			if (key && waiters.has(key)) {
				const queue = waiters.get(key)!;
				const next = queue.shift();
				if (queue.length === 0) waiters.delete(key);
				next?.(msg);
			}
		},
	};

	return {
		contentWindow,
		received,
		/** Resolve once a response with the given messageId arrives. */
		waitFor(messageId: string, timeoutMs = 1000): Promise<any> {
			return new Promise((resolve, reject) => {
				const key = String(messageId);
				const t = setTimeout(() => reject(new Error(`timeout waiting for ${messageId}`)), timeoutMs);
				const cb = (m: any) => {
					clearTimeout(t);
					resolve(m);
				};
				const queue = waiters.get(key) ?? [];
				queue.push(cb);
				waiters.set(key, queue);
			});
		},
	};
}

/** Build an iframe whose contentWindow is our endpoint. */
function attachEndpoint(endpoint: { contentWindow: any }): HTMLIFrameElement {
	const iframe = document.createElement("iframe");
	Object.defineProperty(iframe, "contentWindow", {
		value: endpoint.contentWindow,
		configurable: true,
	});
	return iframe;
}

/** Dispatch a message into the router exactly as a sandbox iframe would. */
function postFromSandbox(data: unknown): void {
	window.dispatchEvent(new MessageEvent("message", { data }));
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * Invoke the router's REAL message listener directly with a synthetic event and
 * await it, returning any rejection it produced (or undefined).
 *
 * `router.messageListener` is the exact async function that window dispatches
 * "message" events to. The router invokes it fire-and-forget. It now wraps each
 * individual provider AND consumer call in try/catch, so a throwing handler is
 * logged and skipped without aborting the fan-out and the listener promise
 * resolves cleanly (dispatchAwaiting returns undefined). Calling the listener
 * directly lets us observe that resolution deterministically — no timing window,
 * no global-handler juggling — and isolates this router from the other routers
 * that share window's "message" listener across the suite. Falls back to a window
 * dispatch if the listener has not been wired yet (it is, after registerSandbox).
 */
async function dispatchAwaiting(router: RuntimeMessageRouter, data: unknown): Promise<unknown> {
	const listener = (router as unknown as { messageListener: ((e: { data: unknown }) => unknown) | null })
		.messageListener;
	if (!listener) {
		postFromSandbox(data);
		await tick(5);
		return undefined;
	}
	let caught: unknown;
	await Promise.resolve(listener({ data })).catch((e) => {
		caught = e;
	});
	return caught;
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).chrome;
});

// ---------------------------------------------------------------------------

describe("RuntimeMessageRouter — real request/response round-trips", () => {
	it("round-trips a single request through the real respond() path and correlates by messageId", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const provider = makeProvider(async (msg, respond) => {
			if (msg.type === "compute") respond({ ok: true, result: msg.a + msg.b });
		});

		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		const pending = endpoint.waitFor("req-1");
		postFromSandbox({ sandboxId: "sb", messageId: "req-1", type: "compute", a: 2, b: 3 });

		const response = await pending;
		expect(response).toMatchObject({
			type: "runtime-response",
			messageId: "req-1",
			sandboxId: "sb",
			ok: true,
			result: 5,
		});

		router.unregisterSandbox("sb");
	});

	it("correlates many concurrent in-flight requests — each response carries ITS OWN messageId even when resolved out of order", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		// Per-message variable delay that INVERTS latency vs request order, so
		// responses return out of the order they were requested. Correlation
		// must therefore be by messageId, not arrival order.
		const provider = makeProvider(async (msg, respond) => {
			if (msg.type !== "compute") return;
			const delay = (10 - msg.n) * 2;
			await tick(delay);
			respond({ result: msg.n * 10 });
		});

		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		const ids = ["a", "b", "c", "d", "e"];
		const waits = ids.map((id) => endpoint.waitFor(id));
		ids.forEach((id, i) => {
			postFromSandbox({ sandboxId: "sb", messageId: id, type: "compute", n: i });
		});

		const responses = await Promise.all(waits);
		responses.forEach((resp, i) => {
			expect(resp.messageId).toBe(ids[i]);
			expect(resp.result).toBe(i * 10);
		});

		router.unregisterSandbox("sb");
	});

	it("delivers a no-op provider response within the first microtask drain (no macrotask deferral)", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const provider = makeProvider(async (_msg, respond) => respond({ pong: true }));
		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		const start = performance.now();
		const pending = endpoint.waitFor("ping-1");
		postFromSandbox({ sandboxId: "sb", messageId: "ping-1", type: "ping" });

		// Race the round-trip against a macrotask. A correct router resolves the
		// async listener entirely on the microtask queue (await of an already-
		// settled promise), so the response MUST win the race against setTimeout(0).
		// This catches a mutation that defers respond() onto a macrotask/timer,
		// which the old wall-clock "< 100ms" bound could never detect.
		const macrotask = tick(0).then(() => "macrotask" as const);
		const winner = await Promise.race([pending.then(() => "response" as const), macrotask]);
		expect(winner).toBe("response");

		const resp = await pending;
		const elapsed = performance.now() - start;
		expect(resp).toMatchObject({ messageId: "ping-1", pong: true });
		// Sanity ceiling for the test env; the race above is the real assertion.
		expect(elapsed).toBeLessThan(100);

		router.unregisterSandbox("sb");
	});

	it("preserves FIFO ordering: a burst of messages reaches the consumer in send order", async () => {
		const router = new RuntimeMessageRouter();
		const order: number[] = [];
		const consumer = makeConsumer([], (m) => order.push(m.seq));

		router.registerSandbox("sb", [], [consumer]);

		const N = 25;
		for (let i = 0; i < N; i++) postFromSandbox({ sandboxId: "sb", type: "tick", seq: i });

		await tick(0);

		expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
		router.unregisterSandbox("sb");
	});

	it("interleaved responses for a burst remain correctly correlated under load", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const provider = makeProvider(async (msg, respond) => {
			await tick((msg.seq % 3) * 3); // force interleaving across the burst
			respond({ seq: msg.seq });
		});
		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		const N = 12;
		const waits: Promise<any>[] = [];
		for (let i = 0; i < N; i++) {
			waits.push(endpoint.waitFor(`m${i}`));
			postFromSandbox({ sandboxId: "sb", messageId: `m${i}`, type: "compute", seq: i });
		}
		const responses = await Promise.all(waits);
		responses.forEach((resp, i) => {
			expect(resp.messageId).toBe(`m${i}`);
			expect(resp.seq).toBe(i); // payload matches the request that produced it
		});

		router.unregisterSandbox("sb");
	});
});

describe("RuntimeMessageRouter — fan-out across providers and consumers", () => {
	it("all providers receive the message and each respond() posts back independently with the same messageId", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const p1 = makeProvider(async (msg, respond) => {
			if (msg.type === "q") respond({ from: "p1" });
		});
		const p2 = makeProvider(async (msg, respond) => {
			if (msg.type === "q") respond({ from: "p2" });
		});

		router.registerSandbox("sb", [p1, p2], []);
		router.setSandboxIframe("sb", iframe);

		postFromSandbox({ sandboxId: "sb", messageId: "multi", type: "q" });
		await tick(5);

		const froms = endpoint.received.map((m) => m.from).sort();
		expect(froms).toEqual(["p1", "p2"]);
		expect(endpoint.received.every((m) => m.messageId === "multi")).toBe(true);

		router.unregisterSandbox("sb");
	});

	it("consumers see the message AFTER providers (provider-first ordering within one dispatch)", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const order: string[] = [];
		const provider = makeProvider(async (_msg, respond) => {
			order.push("provider");
			respond({ ok: true });
		});
		const consumer = makeConsumer([], () => order.push("consumer"));

		router.registerSandbox("sb", [provider], [consumer]);
		router.setSandboxIframe("sb", iframe);

		postFromSandbox({ sandboxId: "sb", messageId: "x", type: "q" });
		await tick(5);

		expect(order).toEqual(["provider", "consumer"]);
		router.unregisterSandbox("sb");
	});

	it("isolates sandboxes: the single global listener routes only to the matching sandbox", async () => {
		const router = new RuntimeMessageRouter();
		const epA = makeSandboxEndpoint();
		const epB = makeSandboxEndpoint();
		const logA: any[] = [];
		const logB: any[] = [];

		const pA = makeProvider(async (_m, respond) => respond({ who: "A" }));
		const pB = makeProvider(async (_m, respond) => respond({ who: "B" }));

		router.registerSandbox("A", [pA], [makeConsumer(logA)]);
		router.registerSandbox("B", [pB], [makeConsumer(logB)]);
		router.setSandboxIframe("A", attachEndpoint(epA));
		router.setSandboxIframe("B", attachEndpoint(epB));

		postFromSandbox({ sandboxId: "A", messageId: "ma", type: "q" });
		await tick(5);

		expect(logA.length).toBe(1);
		expect(logB.length).toBe(0);
		expect(epA.received.map((m) => m.who)).toEqual(["A"]);
		expect(epB.received).toEqual([]);

		router.unregisterSandbox("A");
		router.unregisterSandbox("B");
	});
});

describe("RuntimeMessageRouter — duplicate / unknown / malformed messages", () => {
	it("duplicate messageId: router echoes a response for EACH arrival (no dedup)", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		let calls = 0;
		const provider = makeProvider(async (_msg, respond) => {
			calls++;
			respond({ n: calls });
		});
		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		postFromSandbox({ sandboxId: "sb", messageId: "dup", type: "q" });
		postFromSandbox({ sandboxId: "sb", messageId: "dup", type: "q" });
		await tick(5);

		// Same messageId twice => two independent responses; the router does not
		// deduplicate. A correlation map on the sandbox side keyed by messageId
		// would clobber the first response — this documents that risk.
		const dupResponses = endpoint.received.filter((m) => m.messageId === "dup");
		expect(dupResponses.length).toBe(2);
		expect(dupResponses.map((m) => m.n).sort()).toEqual([1, 2]);

		router.unregisterSandbox("sb");
	});

	it("unknown sandboxId after unregister: previously-valid id is dropped (no response, no consumer hit)", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);
		const log: any[] = [];
		const provider = makeProvider(async (_m, respond) => respond({ late: true }));

		router.registerSandbox("sb", [provider], [makeConsumer(log)]);
		router.setSandboxIframe("sb", iframe);
		router.unregisterSandbox("sb"); // now unknown

		postFromSandbox({ sandboxId: "sb", messageId: "after-unreg", type: "q" });
		await tick(5);

		expect(log).toEqual([]);
		expect(endpoint.received).toEqual([]);
	});

	it("message missing messageId still reaches providers; respond() echoes an undefined messageId", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);
		const seen: any[] = [];
		const provider = makeProvider(async (msg, respond) => {
			seen.push(msg);
			respond({ ack: true });
		});
		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		postFromSandbox({ sandboxId: "sb", type: "fire-and-forget" });
		await tick(5);

		expect(seen.length).toBe(1);
		// respond() forwarded a response, but messageId is undefined — the
		// sandbox cannot correlate it. Documents the protocol contract.
		expect(endpoint.received.length).toBe(1);
		expect(endpoint.received[0].messageId).toBeUndefined();
		expect(endpoint.received[0]).toMatchObject({ type: "runtime-response", ack: true });

		router.unregisterSandbox("sb");
	});

	it("non-object / primitive message data does not crash the global listener", async () => {
		const router = new RuntimeMessageRouter();
		const log: any[] = [];
		router.registerSandbox("sb", [], [makeConsumer(log)]);

		expect(() => postFromSandbox("hello")).not.toThrow();
		expect(() => postFromSandbox(123)).not.toThrow();
		await tick(0);
		expect(log).toEqual([]);

		router.unregisterSandbox("sb");
	});

	it("foreign window message (no sandboxId, unrelated shape) is ignored without side effects", async () => {
		const router = new RuntimeMessageRouter();
		const log: any[] = [];
		router.registerSandbox("sb", [], [makeConsumer(log)]);

		// Noise from a third-party script / browser extension.
		postFromSandbox({ source: "react-devtools-bridge", payload: { hello: "world" } });
		await tick(0);
		expect(log).toEqual([]);

		router.unregisterSandbox("sb");
	});
});

describe("RuntimeMessageRouter — error propagation through the fan-out", () => {
	it("a throwing provider handler is isolated: later providers AND all consumers still run for that message", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const order: string[] = [];
		const failing = makeProvider(async () => {
			order.push("failing-provider");
			throw new Error("boom");
		});
		const laterProvider = makeProvider(async (_m, respond) => {
			order.push("later-provider");
			respond({ reached: true });
		});
		const consumerLog: any[] = [];
		const consumer = makeConsumer(consumerLog, () => order.push("consumer"));

		router.registerSandbox("sb", [failing, laterProvider], [consumer]);
		router.setSandboxIframe("sb", iframe);

		// The router wraps each provider/consumer call in try/catch, so a throwing
		// handler is logged and skipped without aborting the fan-out: every later
		// provider and consumer still runs, and the listener does NOT reject.
		const rejection = await dispatchAwaiting(router, { sandboxId: "sb", messageId: "err", type: "q" });

		expect(order).toEqual(["failing-provider", "later-provider", "consumer"]);
		expect(consumerLog.length).toBe(1); // consumer still received the message
		expect(endpoint.received).toEqual([
			{ type: "runtime-response", messageId: "err", sandboxId: "sb", reached: true },
		]);
		// No uncaught rejection escapes the listener.
		expect(rejection).toBeUndefined();

		router.unregisterSandbox("sb");
	});

	it("one bad message does not permanently break the router — a later good message still routes", async () => {
		const router = new RuntimeMessageRouter();
		const order: string[] = [];
		let failOnce = true;
		const provider = makeProvider(async (msg) => {
			if (msg.type === "bad" && failOnce) {
				failOnce = false;
				throw new Error("transient");
			}
			order.push(`ok:${msg.type}`);
		});
		const log: any[] = [];
		router.registerSandbox("sb", [provider], [makeConsumer(log)]);

		// The provider throws on the "bad" dispatch, but the per-handler try/catch
		// isolates it: the listener does NOT reject, and the consumer still runs.
		const rejection = await dispatchAwaiting(router, { sandboxId: "sb", messageId: "1", type: "bad" });
		expect(rejection).toBeUndefined();

		await dispatchAwaiting(router, { sandboxId: "sb", messageId: "2", type: "good" });

		// The "good" dispatch routes normally; the "bad" one's provider threw before
		// pushing to order, but its consumer still received the message.
		expect(order).toEqual(["ok:good"]);
		expect(log.map((m) => m.type)).toEqual(["bad", "good"]); // both consumers ran

		router.unregisterSandbox("sb");
	});

	it("a throwing consumer is isolated: consumers registered after it still receive the same message", async () => {
		const router = new RuntimeMessageRouter();
		const order: string[] = [];
		const c1 = makeConsumer([], () => {
			order.push("c1");
			throw new Error("consumer boom");
		});
		const c2log: any[] = [];
		const c2 = makeConsumer(c2log, () => order.push("c2"));

		router.registerSandbox("sb", [], [c1, c2]);
		const rejection = await dispatchAwaiting(router, { sandboxId: "sb", type: "q" });

		// c1 threw; the per-consumer try/catch logs and skips it, so c2 still runs
		// and the listener does NOT reject.
		expect(order).toEqual(["c1", "c2"]);
		expect(c2log.length).toBe(1);
		expect(rejection).toBeUndefined();

		router.unregisterSandbox("sb");
	});

	it("provider may respond multiple times for one request (streaming-style) — all chunks correlate", async () => {
		const router = new RuntimeMessageRouter();
		const endpoint = makeSandboxEndpoint();
		const iframe = attachEndpoint(endpoint);

		const provider = makeProvider(async (msg, respond) => {
			if (msg.type !== "stream") return;
			for (let i = 0; i < 3; i++) respond({ chunk: i, done: i === 2 });
		});
		router.registerSandbox("sb", [provider], []);
		router.setSandboxIframe("sb", iframe);

		postFromSandbox({ sandboxId: "sb", messageId: "stream-1", type: "stream" });
		await tick(10);

		const chunks = endpoint.received.filter((m) => m.messageId === "stream-1");
		expect(chunks.map((c) => c.chunk)).toEqual([0, 1, 2]);
		expect(chunks[2].done).toBe(true);

		router.unregisterSandbox("sb");
	});
});

describe("RuntimeMessageRouter — chrome user-script async respond round-trip", () => {
	it("routes a user-script message and the async sendResponse carries the sandboxId back", async () => {
		let listener: ((m: any, s: any, sr: (r: any) => void) => boolean) | undefined;
		(globalThis as Record<string, unknown>).chrome = {
			runtime: {
				onUserScriptMessage: {
					addListener: (l: typeof listener) => {
						listener = l!;
					},
					removeListener: () => {},
				},
			},
		};

		const router = new RuntimeMessageRouter();
		const provider = makeProvider(async (msg, respond) => {
			await tick(5); // async work before responding
			respond({ ok: true, doubled: msg.value * 2 });
		});
		const consumerLog: any[] = [];
		router.registerSandbox("us", [provider], [makeConsumer(consumerLog)]);

		const sendResponse = await new Promise<any>((resolve) => {
			const ret = listener!({ sandboxId: "us", type: "calc", value: 21 }, null, (r) => resolve(r));
			// Must return true to keep the message channel open for async response.
			expect(ret).toBe(true);
		});

		expect(sendResponse).toMatchObject({ ok: true, doubled: 42, sandboxId: "us" });
		await tick(5);
		expect(consumerLog.length).toBe(1);

		router.unregisterSandbox("us");
	});

	it("a throwing provider in the user-script path is isolated: later provider and consumer still run", async () => {
		let listener: ((m: any, s: any, sr: (r: any) => void) => boolean) | undefined;
		(globalThis as Record<string, unknown>).chrome = {
			runtime: {
				onUserScriptMessage: {
					addListener: (l: typeof listener) => {
						listener = l!;
					},
					removeListener: () => {},
				},
			},
		};

		const router = new RuntimeMessageRouter();
		const order: string[] = [];
		const failing = makeProvider(async () => {
			order.push("failing-provider");
			throw new Error("us boom");
		});
		const responded: any[] = [];
		const laterProvider = makeProvider(async (_m, respond) => {
			order.push("later-provider");
			respond({ reached: true });
		});
		const consumerLog: any[] = [];
		router.registerSandbox("us", [failing, laterProvider], [makeConsumer(consumerLog, () => order.push("consumer"))]);

		const ret = listener!({ sandboxId: "us", type: "q" }, null, (r) => responded.push(r));
		expect(ret).toBe(true);
		await tick(5);

		// The failing provider is logged and skipped; the later provider and the
		// consumer still run, and respond() still posts the later provider's result.
		expect(order).toEqual(["failing-provider", "later-provider", "consumer"]);
		expect(consumerLog.length).toBe(1);
		expect(responded).toEqual([{ reached: true, sandboxId: "us" }]);

		router.unregisterSandbox("us");
	});

	it("a throwing consumer in the user-script path is isolated: later consumers still run", async () => {
		let listener: ((m: any, s: any, sr: (r: any) => void) => boolean) | undefined;
		(globalThis as Record<string, unknown>).chrome = {
			runtime: {
				onUserScriptMessage: {
					addListener: (l: typeof listener) => {
						listener = l!;
					},
					removeListener: () => {},
				},
			},
		};

		const router = new RuntimeMessageRouter();
		const order: string[] = [];
		const c1 = makeConsumer([], () => {
			order.push("c1");
			throw new Error("us consumer boom");
		});
		const c2log: any[] = [];
		const c2 = makeConsumer(c2log, () => order.push("c2"));
		router.registerSandbox("us", [], [c1, c2]);

		const ret = listener!({ sandboxId: "us", type: "q" }, null, () => {});
		expect(ret).toBe(true);
		await tick(5);

		// c1 threw; the per-consumer try/catch logs and skips it, so c2 still runs.
		expect(order).toEqual(["c1", "c2"]);
		expect(c2log.length).toBe(1);

		router.unregisterSandbox("us");
	});
});
