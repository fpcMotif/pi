// End-to-end interaction tests for <agent-interface>.
//
// Unlike agent-interface.test.ts (which pokes individual event branches), this
// file drives realistic *sequences* through a stub Agent that mirrors the real
// Agent surface AgentInterface depends on: subscribe() returning an unsubscribe,
// a mutable `state`, prompt(), abort(), and __emit() to push AgentEvents the way
// a live streaming turn does. We assert observable outcomes — the snapshot the
// streaming container commits, incrementality + per-delta latency, the
// streaming/clear lifecycle, send-guards, abort wiring, and subscription
// teardown/replacement — across full submit -> stream -> end / abort turns.
//
// i18n and app-storage are mocked exactly as the sibling suite does: i18n's
// getCurrentLanguage() reads localStorage at render time and would crash under
// happy-dom (a real source robustness gap noted in the workflow report).

import type * as PiAi from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { streamSimpleMock } = vi.hoisted(() => ({
	streamSimpleMock: vi.fn(async () => ({ result: async () => undefined })),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, streamSimple: streamSimpleMock };
});

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

type StorageState = { providerKeys: Map<string, string | undefined>; settings: Map<string, unknown> };
const storageState = (): StorageState => {
	const key = "__agentInterfaceE2EStorage";
	const root = globalThis as typeof globalThis & { [k: string]: StorageState };
	if (!(key in root)) root[key] = { providerKeys: new Map(), settings: new Map() };
	return root[key];
};

vi.mock("../src/storage/app-storage.js", () => ({
	getAppStorage: () => ({
		providerKeys: {
			get: async (provider: string) => storageState().providerKeys.get(provider) ?? null,
			set: async (provider: string, value: string) => void storageState().providerKeys.set(provider, value),
		},
		settings: {
			get: async <T>(key: string): Promise<T | null> => (storageState().settings.get(key) as T) ?? null,
			set: async () => undefined,
		},
	}),
}));

class ResizeObserverMock {
	observe = vi.fn();
	disconnect = vi.fn();
	unobserve = vi.fn();
}

import "../src/components/AgentInterface.js";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { LitElement } from "lit";
import type { AgentInterface } from "../src/components/AgentInterface.js";

type AssistantSnapshot = { role: "assistant"; content: Array<{ type: "text"; text: string }> };
type StubAgent = Agent & { __emit(ev: AgentEvent): void };

const assistant = (text: string): AssistantSnapshot => ({ role: "assistant", content: [{ type: "text", text }] });

const makeSession = (overrides: Partial<Agent> = {}): StubAgent => {
	const listeners = new Set<(ev: AgentEvent) => void>();
	return {
		state: {
			messages: [] as unknown[],
			tools: [],
			pendingToolCalls: new Set<string>(),
			isStreaming: false,
			model: { id: "gpt-4", provider: "openai", name: "GPT-4" },
			thinkingLevel: "off",
		} as unknown as Agent["state"],
		streamFn: streamSimple,
		getApiKey: undefined as Agent["getApiKey"],
		subscribe(listener: (ev: AgentEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: vi.fn(async () => undefined),
		abort: vi.fn(),
		__emit(ev: AgentEvent) {
			for (const l of [...listeners]) l(ev);
		},
		...overrides,
	} as unknown as StubAgent;
};

const mount = async (session?: StubAgent): Promise<AgentInterface> => {
	const el = document.createElement("agent-interface") as AgentInterface;
	if (session) el.session = session;
	document.body.appendChild(el);
	await (el as unknown as LitElement).updateComplete;
	return el;
};

const streamingContainer = (el: AgentInterface) =>
	el.querySelector("streaming-message-container") as
		| (Element & { isStreaming: boolean; updateComplete?: Promise<unknown> })
		| null;

/** The text snapshot the streaming container is currently committing (its _message). */
const committedStreamText = (el: AgentInterface): string => {
	const c = streamingContainer(el) as unknown as { _message?: AssistantSnapshot | null };
	const msg = c?._message;
	if (!msg || !Array.isArray(msg.content)) return "";
	return msg.content.find((b) => b.type === "text")?.text ?? "";
};

/** Settle the component and its streaming child after a batched (streaming) update. */
const settleStreaming = async (el: AgentInterface) => {
	await (el as unknown as LitElement).updateComplete;
	await new Promise((r) => requestAnimationFrame(() => r(undefined)));
	await streamingContainer(el)?.updateComplete;
};

let originalRO: typeof ResizeObserver | undefined;
let originalRAF: typeof globalThis.requestAnimationFrame;

beforeEach(() => {
	originalRO = globalThis.ResizeObserver;
	originalRAF = globalThis.requestAnimationFrame;
	globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
	storageState().providerKeys.clear();
	storageState().settings.clear();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	if (originalRO) globalThis.ResizeObserver = originalRO;
	globalThis.requestAnimationFrame = originalRAF;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("AgentInterface — end-to-end interaction", () => {
	it("renders an explicit empty state and no transcript when no session is set", async () => {
		const el = await mount();
		expect(el.textContent).toContain("No session set");
		expect(el.querySelector("message-list")).toBeNull();
		expect(el.querySelector("message-editor")).toBeNull();
	});

	it("renders the editor + stable transcript once a session is attached", async () => {
		const session = makeSession();
		session.state.messages = [{ role: "user", content: "Hello" }] as unknown as Agent["state"]["messages"];
		const el = await mount(session);
		expect(el.querySelector("message-editor")).not.toBeNull();
		expect(el.querySelector("message-list")).not.toBeNull();
		expect(el.querySelector("streaming-message-container")).not.toBeNull();
	});

	it("installs default getApiKey/streamFn on subscribe so the session can authenticate", async () => {
		const session = makeSession();
		expect(session.getApiKey).toBeUndefined();
		await mount(session);
		expect(session.getApiKey).toBeDefined();
		expect(session.streamFn).not.toBe(streamSimple); // proxy-aware streamFn was installed
	});

	it("forwards a submitted message to session.prompt and clears the editor", async () => {
		const session = makeSession();
		storageState().providerKeys.set("openai", "sk-test");
		const el = await mount(session);
		const editor = el.querySelector("message-editor") as HTMLElement & { value: string };
		editor.value = "Hi there";
		await el.sendMessage("Hi there");
		expect(session.prompt).toHaveBeenCalledWith("Hi there");
		expect(editor.value).toBe("");
	});

	it("composes a user-with-attachments message when attachments are present", async () => {
		const session = makeSession();
		storageState().providerKeys.set("openai", "sk-test");
		const el = await mount(session);
		const attachment = {
			id: "a1",
			fileName: "n.txt",
			mimeType: "text/plain",
			type: "document",
			size: 4,
			content: "bm90ZQ==",
			extractedText: "note",
		};
		await el.sendMessage("see file", [attachment as never]);
		expect(session.prompt).toHaveBeenCalledTimes(1);
		const arg = (session.prompt as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
			role: string;
			content: string;
			attachments: unknown[];
		};
		expect(arg.role).toBe("user-with-attachments");
		expect(arg.content).toBe("see file");
		expect(arg.attachments).toHaveLength(1);
	});

	it("pins the whitespace guard: empty text + explicit empty attachments is dropped", async () => {
		const session = makeSession();
		storageState().providerKeys.set("openai", "sk-test"); // so only the guard can block
		const el = await mount(session);
		await el.sendMessage("   ", []);
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("drops a second submission while a turn is already streaming", async () => {
		const session = makeSession();
		session.state.isStreaming = true;
		const el = await mount(session);
		await el.sendMessage("blocked while streaming");
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("aborts a send (no prompt) when no API key is configured and there is no key handler", async () => {
		const session = makeSession(); // no providerKeys set, no onApiKeyRequired
		const el = await mount(session);
		await el.sendMessage("needs a key");
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("proceeds with the send once an onApiKeyRequired handler resolves true", async () => {
		const session = makeSession();
		const el = await mount(session);
		el.onApiKeyRequired = vi.fn(async () => true);
		await el.sendMessage("after key prompt");
		expect(el.onApiKeyRequired).toHaveBeenCalledWith("openai");
		expect(session.prompt).toHaveBeenCalledWith("after key prompt");
	});

	it("throws if a send is attempted before a model is configured", async () => {
		const session = makeSession();
		(session.state as unknown as { model: undefined }).model = undefined;
		const el = await mount(session);
		await expect(el.sendMessage("no model")).rejects.toThrow("No model set");
	});

	it("renders streamed deltas incrementally and promptly as message_update events arrive", async () => {
		const session = makeSession();
		session.state.isStreaming = true;
		const el = await mount(session);

		const snapshots = ["Hel", "Hello", "Hello, world"];
		const seen: string[] = [];
		for (const text of snapshots) {
			const start = performance.now();
			session.__emit({ type: "message_update", message: assistant(text) } as unknown as AgentEvent);
			await settleStreaming(el);
			seen.push(committedStreamText(el));
			expect(performance.now() - start).toBeLessThan(250);
		}

		expect(seen[0]).toBe("Hel");
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i].startsWith(seen[i - 1])).toBe(true);
			expect(seen[i].length).toBeGreaterThanOrEqual(seen[i - 1].length);
		}
		expect(seen[seen.length - 1]).toBe("Hello, world");
	});

	it("commits the final snapshot immediately when the session is no longer streaming", async () => {
		const session = makeSession();
		session.state.isStreaming = false; // final update arrives after streaming flips off
		const el = await mount(session);
		session.__emit({ type: "message_update", message: assistant("final answer") } as unknown as AgentEvent);
		await (el as unknown as LitElement).updateComplete;
		await streamingContainer(el)?.updateComplete;
		// immediate=!isStreaming === true: no animation frame needed.
		expect(committedStreamText(el)).toBe("final answer");
	});

	it("clears the streaming container on message_end so the stable list owns the message", async () => {
		const session = makeSession();
		session.state.isStreaming = true;
		const el = await mount(session);
		session.__emit({ type: "message_update", message: assistant("partial") } as unknown as AgentEvent);
		await settleStreaming(el);
		expect(committedStreamText(el)).toBe("partial");

		session.__emit({ type: "message_end" } as AgentEvent);
		await (el as unknown as LitElement).updateComplete;
		await streamingContainer(el)?.updateComplete;
		expect(committedStreamText(el)).toBe(""); // cleared to avoid double-render with message-list
	});

	it("stops streaming and clears the container on agent_end", async () => {
		const session = makeSession();
		session.state.isStreaming = true;
		const el = await mount(session);
		session.__emit({ type: "message_update", message: assistant("mid") } as unknown as AgentEvent);
		await settleStreaming(el);

		session.__emit({ type: "agent_end" } as AgentEvent);
		await (el as unknown as LitElement).updateComplete;
		await streamingContainer(el)?.updateComplete;
		expect(streamingContainer(el)?.isStreaming).toBe(false);
		expect(committedStreamText(el)).toBe("");
	});

	it("end-to-end: submit -> stream three deltas -> message_end yields one stable assistant turn", async () => {
		const session = makeSession();
		storageState().providerKeys.set("openai", "sk-test");
		const el = await mount(session);

		await el.sendMessage("Tell me a joke");
		expect(session.prompt).toHaveBeenCalledWith("Tell me a joke");

		session.state.isStreaming = true;
		for (const t of ["Why", "Why did", "Why did the chicken cross"]) {
			session.__emit({ type: "message_update", message: assistant(t) } as unknown as AgentEvent);
			await settleStreaming(el);
		}
		expect(committedStreamText(el)).toBe("Why did the chicken cross");

		session.state.messages = [
			{ role: "user", content: "Tell me a joke" },
			assistant("Why did the chicken cross"),
		] as unknown as Agent["state"]["messages"];
		session.state.isStreaming = false;
		session.__emit({ type: "message_end" } as AgentEvent);
		await (el as unknown as LitElement).updateComplete;
		await streamingContainer(el)?.updateComplete;
		expect(committedStreamText(el)).toBe("");
		expect(el.querySelector("message-list")).not.toBeNull();
	});

	it("abort wiring: the editor's onAbort calls session.abort()", async () => {
		const session = makeSession();
		const el = await mount(session);
		const editor = el.querySelector("message-editor") as HTMLElement & { onAbort?: () => void };
		expect(typeof editor.onAbort).toBe("function");
		editor.onAbort?.();
		expect(session.abort).toHaveBeenCalledTimes(1);
	});

	it("unsubscribes from the session when the element is removed (no leaked listeners)", async () => {
		const session = makeSession();
		const el = await mount(session);
		el.remove();
		expect(() =>
			session.__emit({ type: "message_update", message: assistant("late") } as unknown as AgentEvent),
		).not.toThrow();
		expect(committedStreamText(el)).toBe("");
	});

	it("re-subscribes when the session property is swapped to a new session", async () => {
		const first = makeSession();
		const el = await mount(first);
		const second = makeSession();
		el.session = second;
		await (el as unknown as LitElement).updateComplete;

		second.state.isStreaming = true;
		second.__emit({ type: "message_update", message: assistant("from second") } as unknown as AgentEvent);
		await settleStreaming(el);
		expect(committedStreamText(el)).toBe("from second");

		// Events from the old session must no longer affect the view.
		first.__emit({ type: "message_update", message: assistant("from first") } as unknown as AgentEvent);
		await (el as unknown as LitElement).updateComplete;
		await streamingContainer(el)?.updateComplete;
		expect(committedStreamText(el)).toBe("from second");
	});
});
