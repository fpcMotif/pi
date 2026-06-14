/**
 * Characterization tests for print mode (ADR-0020 verification loop, step 1).
 *
 * These tests pin the CURRENT behaviour of `runPrintMode` at its interface —
 * stdout writes, exit codes, prompt sequencing, extension-action delegation,
 * rebind semantics, disposal idempotence, and signal handling — so the
 * Effect-lane adapter (`--effect` flag, ADR-0020) can be verified against the
 * same surface. Deliberate pins of today's quirks are marked `PIN:`.
 *
 * Transferability taxonomy (for the ADR-0020 step-3 parity run):
 * - TRANSFERABLE contract: stdout shapes (text parts, header line, event
 *   lines and their ordering), exit codes (incl. signal exit codes 143/129),
 *   prompt sequencing, error-to-stderr + exit-1 on thrown failures.
 * - LEGACY-ONLY pins (excluded from the parity run, see the tagged describe
 *   blocks): the AgentSessionRuntime collaborator shapes, extension binding /
 *   commandContextActions, setRebindSession mechanics, session_shutdown
 *   plumbing, and the signal-handling *mechanism* (listener counts,
 *   killTrackedDetachedChildren).
 * - stderr is observed via a console.error spy because that is today's
 *   mechanism; the step-3 shared driver reframes these to fd-2 bytes.
 */
import type { AssistantMessage, ImageContent, Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.js";
import { killTrackedDetachedChildren } from "../src/utils/shell.js";
import { runPrintMode } from "../src/modes/print-mode.js";

vi.mock("../src/utils/shell.js", () => ({
	killTrackedDetachedChildren: vi.fn(),
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: ReturnType<typeof vi.fn> };
	state: { messages: Message[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	navigateTree: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	content?: AssistantMessage["content"];
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.content ?? (options?.text ? [{ type: "text", text: options.text }] : []),
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createFakeSession(options?: { messages?: Message[]; header?: object }): FakeSession {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};
	return {
		sessionManager: { getHeader: () => options?.header },
		agent: { waitForIdle: vi.fn(async () => {}) },
		state: { messages: options?.messages ?? [] },
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
	};
}

function createRuntimeHost(
	assistantMessage?: AssistantMessage,
	options?: { messages?: Message[]; header?: object },
): FakeRuntimeHost {
	const session = createFakeSession({
		messages: options?.messages ?? (assistantMessage ? [assistantMessage] : []),
		header: options?.header,
	});

	const host: FakeRuntimeHost = {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
	return host;
}

function asHost(host: FakeRuntimeHost): Parameters<typeof runPrintMode>[0] {
	return host as unknown as Parameters<typeof runPrintMode>[0];
}

/** All process.stdout.write chunks for the current test; flush-callbacks are invoked so flushRawStdout resolves. */
let stdoutChunks: string[] = [];
/** One entry per console.error call (args joined) — print mode's stderr surface today. */
let stderrMessages: string[] = [];

beforeEach(() => {
	stdoutChunks = [];
	stderrMessages = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderrMessages.push(args.map(String).join(" "));
	});
	vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		stdoutChunks.push(String(chunk));
		const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		cb?.(null);
		return true;
	}) as typeof process.stdout.write);
});

/** Non-empty stdout chunks ("" writes are flushRawStdout's flush mechanism, not output). */
function outputLines(chunks: string[] = stdoutChunks): string[] {
	return chunks.filter((c) => c !== "");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("runPrintMode", () => {
	describe("text mode", () => {
		it("prints each text part of the final assistant message and exits 0", async () => {
			const host = createRuntimeHost(
				createAssistantMessage({
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				}),
			);

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual(["first\n", "second\n"]);
		});

		it("skips non-text content parts", async () => {
			const host = createRuntimeHost(
				createAssistantMessage({
					content: [
						{ type: "thinking", thinking: "hmm", thinkingSignature: undefined } as AssistantMessage["content"][number],
						{ type: "text", text: "answer" },
					],
				}),
			);

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual(["answer\n"]);
		});

		it("prints errorMessage to stderr and exits 1 on stopReason error", async () => {
			const host = createRuntimeHost(createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }));

			const exitCode = await runPrintMode(asHost(host), { mode: "text" });

			expect(exitCode).toBe(1);
			expect(stderrMessages).toEqual(["provider failure"]);
			expect(outputLines()).toEqual([]);
		});

		it("falls back to 'Request <stopReason>' when errorMessage is absent", async () => {
			const host = createRuntimeHost(createAssistantMessage({ stopReason: "aborted" }));

			const exitCode = await runPrintMode(asHost(host), { mode: "text" });

			expect(exitCode).toBe(1);
			expect(stderrMessages).toEqual(["Request aborted"]);
		});

		it("PIN: continues past an error-stopped turn; exit code reflects only the final message", async () => {
			// The prompt loop has no inter-prompt state inspection: an error-stopped
			// turn mid-run produces no stderr and does not short-circuit later
			// prompts. `pi -p a -m b` scripts depend on all prompts being sent.
			const host = createRuntimeHost(undefined, { messages: [] });
			host.session.prompt.mockImplementation(async () => {
				host.session.state.messages.push(
					host.session.prompt.mock.calls.length === 1
						? createAssistantMessage({ stopReason: "error", errorMessage: "mid-run failure" })
						: createAssistantMessage({ text: "recovered" }),
				);
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "text", messages: ["one", "two"] });

			expect(exitCode).toBe(0);
			expect(host.session.prompt.mock.calls).toEqual([["one"], ["two"]]);
			expect(outputLines()).toEqual(["recovered\n"]);
			expect(stderrMessages).toEqual([]);
		});

		it("prints nothing and exits 0 when the final message is not from the assistant", async () => {
			const userMessage = { role: "user", content: "hi", timestamp: Date.now() } as unknown as Message;
			const host = createRuntimeHost(undefined, { messages: [userMessage] });

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([]);
		});

		it("prints nothing and exits 0 when history is empty", async () => {
			const host = createRuntimeHost(undefined, { messages: [] });

			const exitCode = await runPrintMode(asHost(host), { mode: "text" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([]);
		});

		it("writes no header and no event lines even when a header exists and events fire", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }), { header: { id: "s1" } });
			let listener: ((event: unknown) => void) | undefined;
			host.session.subscribe.mockImplementation((l: (event: unknown) => void) => {
				listener = l;
				return () => {};
			});
			host.session.prompt.mockImplementation(async () => {
				listener?.({ type: "message_update" });
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual(["done\n"]);
		});
	});

	describe("json mode", () => {
		it("writes the session header as the first JSON line when present", async () => {
			const header = { id: "session-1", model: "gpt-4o-mini" };
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }), { header });

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()[0]).toBe(`${JSON.stringify(header)}\n`);
		});

		it("writes no header line when getHeader returns undefined", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([]);
		});

		it("writes each subscribed event as a JSON line, after the header", async () => {
			const header = { id: "session-1" };
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }), { header });
			let listener: ((event: unknown) => void) | undefined;
			host.session.subscribe.mockImplementation((l: (event: unknown) => void) => {
				listener = l;
				return () => {};
			});
			const eventA = { type: "message_start", role: "assistant" };
			const eventB = { type: "message_end" };
			host.session.prompt.mockImplementation(async () => {
				listener?.(eventA);
				listener?.(eventB);
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([
				`${JSON.stringify(header)}\n`,
				`${JSON.stringify(eventA)}\n`,
				`${JSON.stringify(eventB)}\n`,
			]);
			// flushRawStdout runs after all output: the final raw chunk is the
			// empty flush sentinel. Deleting the flush truncates piped stdout.
			expect(stdoutChunks[stdoutChunks.length - 1]).toBe("");
		});

		it("does not write events that fire while extensions bind (subscription attaches after binding)", async () => {
			const header = { id: "s1" };
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }), { header });
			let listener: ((event: unknown) => void) | undefined;
			host.session.subscribe.mockImplementation((l: (event: unknown) => void) => {
				listener = l;
				return () => {};
			});
			host.session.bindExtensions.mockImplementation(async () => {
				// Today no listener is attached yet; a subscribe-before-bind
				// refactor would deliver this and add a stdout line.
				listener?.({ type: "during_bind" });
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([`${JSON.stringify(header)}\n`]);
		});

		it("keeps emitted lines on stdout, sends a thrown error to stderr, and exits 1", async () => {
			const header = { id: "s1" };
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }), { header });
			let listener: ((event: unknown) => void) | undefined;
			host.session.subscribe.mockImplementation((l: (event: unknown) => void) => {
				listener = l;
				return () => {};
			});
			const partial = { type: "message_start" };
			host.session.prompt.mockImplementation(async () => {
				listener?.(partial);
				throw new Error("mid-stream crash");
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(1);
			expect(outputLines()).toEqual([`${JSON.stringify(header)}\n`, `${JSON.stringify(partial)}\n`]);
			expect(stderrMessages).toEqual(["mid-stream crash"]);
		});

		it("does not print final assistant text", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));

			await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(outputLines()).toEqual([]);
		});

		it("PIN: exits 0 even when the final assistant message has stopReason error", async () => {
			// The stopReason -> exit-code mapping lives inside the `mode === "text"`
			// branch only. A json-mode consumer must inspect the event stream to
			// detect failure. The Effect-lane adapter must preserve this.
			// (The empty-stderr pin is legacy-exact: flag+v1 adds the documented
			// extensions-skip warning, ADR-0020 decision 6.)
			const host = createRuntimeHost(createAssistantMessage({ stopReason: "error", errorMessage: "boom" }));

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(stderrMessages).toEqual([]);
		});
	});

	describe("prompt sequencing", () => {
		it("sends initialMessage with images first, then messages in order", async () => {
			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));

			await runPrintMode(asHost(host), {
				mode: "text",
				initialMessage: "first",
				initialImages: images,
				messages: ["second", "third"],
			});

			expect(host.session.prompt.mock.calls).toEqual([["first", { images }], ["second"], ["third"]]);
		});

		it("sends only messages when initialMessage is absent", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));

			await runPrintMode(asHost(host), { mode: "text", messages: ["only"] });

			expect(host.session.prompt.mock.calls).toEqual([["only"]]);
		});

		it("sends no prompts when neither initialMessage nor messages are given", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));

			const exitCode = await runPrintMode(asHost(host), { mode: "text" });

			expect(exitCode).toBe(0);
			expect(host.session.prompt).not.toHaveBeenCalled();
		});
	});

	// LEGACY-ONLY: ADR-0020 decisions 4 and 6 exclude extension binding and the
	// rebind mechanism from the flag+v1 path. These pins characterize today's
	// stack and are excluded from the step-3 parity run.
	describe("extension binding", () => {
		async function bindAndCapture(host: FakeRuntimeHost) {
			await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });
			expect(host.session.bindExtensions).toHaveBeenCalledTimes(1);
			return host.session.bindExtensions.mock.calls[0][0] as {
				commandContextActions: {
					waitForIdle: () => Promise<void>;
					newSession: (o?: unknown) => Promise<unknown>;
					fork: (entryId: string, o?: unknown) => Promise<{ cancelled: boolean }>;
					navigateTree: (targetId: string, o?: Record<string, unknown>) => Promise<{ cancelled: boolean }>;
					switchSession: (path: string, o?: unknown) => Promise<unknown>;
					reload: () => Promise<void>;
				};
				onError: (err: { extensionPath: string; error: unknown }) => void;
			};
		}

		it("delegates commandContextActions to the runtime host and session", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			host.fork.mockResolvedValue({ cancelled: true, selectedText: "ignored" });
			host.session.navigateTree.mockResolvedValue({ cancelled: true, extra: "ignored" });
			const bound = await bindAndCapture(host);

			await bound.commandContextActions.waitForIdle();
			expect(host.session.agent.waitForIdle).toHaveBeenCalledTimes(1);

			await bound.commandContextActions.newSession({ parentSession: "p" });
			expect(host.newSession).toHaveBeenCalledWith({ parentSession: "p" });

			// PIN: fork and navigateTree results are narrowed to `{ cancelled }` —
			// other fields from the host result are dropped at this seam.
			await expect(bound.commandContextActions.fork("entry-1", { label: "l" })).resolves.toEqual({
				cancelled: true,
			});
			expect(host.fork).toHaveBeenCalledWith("entry-1", { label: "l" });

			await expect(
				bound.commandContextActions.navigateTree("target-1", { summarize: true, label: "x" }),
			).resolves.toEqual({ cancelled: true });
			expect(host.session.navigateTree).toHaveBeenCalledWith("target-1", {
				summarize: true,
				customInstructions: undefined,
				replaceInstructions: undefined,
				label: "x",
			});

			await bound.commandContextActions.switchSession("/path/to/session", { resume: true });
			expect(host.switchSession).toHaveBeenCalledWith("/path/to/session", { resume: true });

			await bound.commandContextActions.reload();
			expect(host.session.reload).toHaveBeenCalledTimes(1);
		});

		it("reports extension errors on stderr", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			const bound = await bindAndCapture(host);

			bound.onError({ extensionPath: "/ext/foo.ts", error: "exploded" });

			expect(stderrMessages).toEqual(["Extension error (/ext/foo.ts): exploded"]);
		});

		it("rebinds to the current host session, keeping the old subscription live until the new bind completes", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			const unsubscribeFirst = vi.fn();
			let firstListener: ((event: unknown) => void) | undefined;
			host.session.subscribe.mockImplementation((l: (event: unknown) => void) => {
				firstListener = l;
				return unsubscribeFirst;
			});

			const secondSession = createFakeSession({ messages: [createAssistantMessage({ text: "done" })] });
			let secondListener: ((event: unknown) => void) | undefined;
			secondSession.subscribe.mockImplementation((l: (event: unknown) => void) => {
				secondListener = l;
				return () => {};
			});
			secondSession.bindExtensions.mockImplementation(async () => {
				// PIN: during a mid-run rebind, the OLD session's subscription is
				// still live while the NEW session binds extensions — events in
				// that window are written. An unsubscribe-first refactor would
				// silently drop them.
				firstListener?.({ type: "during_rebind_window" });
			});

			host.session.prompt.mockImplementation(async () => {
				// Simulate a session swap mid-run (e.g. /new via extension action):
				// the host exposes a new session, then invokes the registered rebind.
				host.session = secondSession;
				const rebind = host.setRebindSession.mock.calls[0][0] as () => Promise<void>;
				await rebind();
				secondListener?.({ type: "after_rebind" });
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(unsubscribeFirst).toHaveBeenCalled();
			expect(secondSession.bindExtensions).toHaveBeenCalledTimes(1);
			expect(outputLines()).toEqual([
				`${JSON.stringify({ type: "during_rebind_window" })}\n`,
				`${JSON.stringify({ type: "after_rebind" })}\n`,
			]);
		});

		it("routes follow-up prompts and the final output through the new session after a mid-run rebind", async () => {
			const firstSession = createFakeSession({ messages: [createAssistantMessage({ text: "old session text" })] });
			const secondSession = createFakeSession({ messages: [createAssistantMessage({ text: "new session text" })] });
			const host = createRuntimeHost();
			host.session = firstSession;
			firstSession.prompt.mockImplementation(async () => {
				host.session = secondSession;
				const rebind = host.setRebindSession.mock.calls[0][0] as () => Promise<void>;
				await rebind();
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "text", messages: ["one", "two"] });

			// Prompt "one" went to the first session; after the rebind, prompt
			// "two" and the final text-mode read come from the second session.
			expect(exitCode).toBe(0);
			expect(firstSession.prompt.mock.calls).toEqual([["one"]]);
			expect(secondSession.prompt.mock.calls).toEqual([["two"]]);
			expect(outputLines()).toEqual(["new session text\n"]);
		});
	});

	describe("failure handling", () => {
		it("prints the error message to stderr, exits 1, and still disposes when prompt rejects", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			host.session.prompt.mockRejectedValue(new Error("network down"));

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(1);
			expect(stderrMessages).toEqual(["network down"]);
			expect(host.dispose).toHaveBeenCalledTimes(1);
		});

		it("stringifies non-Error rejections", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			host.session.prompt.mockRejectedValue("string failure");

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(1);
			expect(stderrMessages).toEqual(["string failure"]);
		});

		it("exits 1 when bindExtensions rejects", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			host.session.bindExtensions.mockRejectedValue(new Error("bad extension"));

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(1);
			expect(stderrMessages).toEqual(["bad extension"]);
			expect(host.dispose).toHaveBeenCalledTimes(1);
		});
	});

	describe("lifecycle", () => {
		it("disposes the runtime exactly once and unsubscribes on normal completion", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			const unsubscribe = vi.fn();
			host.session.subscribe.mockImplementation(() => unsubscribe);

			const exitCode = await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(host.dispose).toHaveBeenCalledTimes(1);
			expect(unsubscribe).toHaveBeenCalledTimes(1);
		});

		it("unsubscribes before disposing: shutdown-era events produce no stdout lines", async () => {
			// A json consumer must see no event lines after the final prompt
			// event. The fake delivers events only while subscribed, so a
			// dispose-before-unsubscribe reorder would append a trailing line.
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			let listener: ((event: unknown) => void) | undefined;
			let subscribed = false;
			host.session.subscribe.mockImplementation((l: (event: unknown) => void) => {
				listener = l;
				subscribed = true;
				return () => {
					subscribed = false;
				};
			});
			host.dispose.mockImplementation(async () => {
				if (subscribed) listener?.({ type: "shutdown_era" });
			});

			const exitCode = await runPrintMode(asHost(host), { mode: "json", initialMessage: "go" });

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([]);
		});
	});

	// Exit codes (143/129) and dispose-before-exit are TRANSFERABLE contract;
	// the mechanism pins (listener counting, killTrackedDetachedChildren, the
	// mock host) are LEGACY-ONLY.
	describe("signal handling", () => {
		async function runWithPendingPrompt(host: FakeRuntimeHost) {
			let resolvePrompt!: () => void;
			host.session.prompt.mockImplementation(() => new Promise<void>((resolve) => (resolvePrompt = resolve)));
			const run = runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });
			await vi.waitFor(() => expect(host.session.prompt).toHaveBeenCalled());
			return { run, finishPrompt: () => resolvePrompt() };
		}

		it("kills tracked children, then disposes, and exits 143 only after dispose settles (SIGTERM)", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			let releaseDispose!: () => void;
			host.dispose.mockImplementation(() => new Promise<void>((resolve) => (releaseDispose = resolve)));
			const before = process.listeners("SIGTERM");

			const { run, finishPrompt } = await runWithPendingPrompt(host);
			const added = process.listeners("SIGTERM").filter((l) => !before.includes(l));
			expect(added).toHaveLength(1);

			added[0]("SIGTERM");
			await vi.waitFor(() => expect(host.dispose).toHaveBeenCalledTimes(1));

			// Children are reaped synchronously, BEFORE dispose starts; the exit
			// fires only after dispose settles, so shutdown work is not truncated.
			expect(vi.mocked(killTrackedDetachedChildren)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(killTrackedDetachedChildren).mock.invocationCallOrder[0]).toBeLessThan(
				host.dispose.mock.invocationCallOrder[0],
			);
			expect(exitSpy).not.toHaveBeenCalled();

			releaseDispose();
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));

			finishPrompt();
			const exitCode = await run;

			// The disposed-guard means the finally block does not dispose again,
			// and the handler is removed once the run completes.
			expect(exitCode).toBe(0);
			expect(host.dispose).toHaveBeenCalledTimes(1);
			expect(process.listeners("SIGTERM")).toEqual(before);
		});

		it("exits 129 on SIGHUP (non-win32)", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			const before = process.listeners("SIGHUP");

			const { run, finishPrompt } = await runWithPendingPrompt(host);
			const added = process.listeners("SIGHUP").filter((l) => !before.includes(l));
			expect(added).toHaveLength(1);

			added[0]("SIGHUP");
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(129));
			expect(host.dispose).toHaveBeenCalledTimes(1);

			finishPrompt();
			await run;
			expect(process.listeners("SIGHUP")).toEqual(before);
		});

		it("removes signal handlers after a normal run", async () => {
			const host = createRuntimeHost(createAssistantMessage({ text: "done" }));
			const beforeTerm = process.listeners("SIGTERM");
			const beforeHup = process.listeners("SIGHUP");

			await runPrintMode(asHost(host), { mode: "text", initialMessage: "go" });

			expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
			expect(process.listeners("SIGHUP")).toEqual(beforeHup);
		});
	});
});
