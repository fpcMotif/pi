/**
 * Effect-lane print mode (ADR-0020 step 2): tests at the runner interface.
 * Where behaviour is part of legacy print mode's TRANSFERABLE contract
 * (stdout shapes, exit codes, signal exit codes, flush-last), assertions
 * mirror test/print-mode.test.ts. The v2 event schema and typed-error
 * exit-1-in-json-mode are deliberate, documented contract differences.
 */
import {
	type AgentError,
	CancellationError,
	CompactionError,
	CurrentSession,
	Finish,
	layerEphemeral,
	LlmError,
	SchemaError,
	SessionState,
	StoreError,
	ToolError,
} from "@earendil-works/pi-agent-core/effect";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { LanguageModel, type Prompt } from "effect/unstable/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	describeAgentError,
	effectModelSupport,
	finalAssistantTextParts,
	runEffectPrintMode,
} from "../src/modes/print-effect/runner.js";

/** Stream-only stub LanguageModel (mirrors agent test-support's stubLanguageModelStream). */
const stubLm = (parts: ReadonlyArray<unknown>) =>
	Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: (() => Effect.die("stubLm: generateText unused")) as never,
			generateObject: (() => Effect.die("stubLm: generateObject unused")) as never,
			streamText: (() => Stream.fromIterable(parts)) as never,
		}),
	);

/** Fake CurrentSession layer: scripted events or a typed failure per send. */
const fakeSessionLayer = (options: {
	readonly events?: ReadonlyArray<unknown>;
	readonly fail?: AgentError;
	readonly onSend?: (input: unknown) => void;
	readonly hang?: boolean;
}) =>
	Layer.effect(
		CurrentSession,
		Effect.gen(function* () {
			const state = yield* SubscriptionRef.make(SessionState.empty);
			return CurrentSession.of({
				state,
				send: (input) => {
					options.onSend?.(input);
					if (options.hang) return Stream.fromEffect(Effect.never) as never;
					if (options.fail) return Stream.fail(options.fail) as never;
					return Stream.fromIterable((options.events ?? [new Finish({})]) as never[]) as never;
				},
			});
		}),
	);

const realSessionLayer = (text: string) =>
	Layer.mergeAll(layerEphemeral(), stubLm([{ type: "text-delta", id: "msg_1", delta: text }]));

let stdoutChunks: string[] = [];
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

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const outputLines = (): string[] => stdoutChunks.filter((c) => c !== "");
/** stderr minus the leading experimental warning every run emits. */
const stderrAfterWarning = (): string[] => stderrMessages.slice(1);

describe("runEffectPrintMode", () => {
	it("always emits the experimental warning on stderr", async () => {
		const exitCode = await runEffectPrintMode(realSessionLayer("hi"), { mode: "text" });
		expect(exitCode).toBe(0);
		expect(stderrMessages[0]).toContain("[--effect] experimental");
		expect(stderrMessages[0]).toContain("extensions are not loaded");
	});

	describe("json mode (--events v2)", () => {
		it("emits each AgentEvent as a JSON line ending with Finish, and flushes last", async () => {
			const exitCode = await runEffectPrintMode(realSessionLayer("hi"), {
				mode: "json",
				initialMessage: "go",
			});

			expect(exitCode).toBe(0);
			const lines = outputLines();
			expect(lines.length).toBeGreaterThan(0);
			const parsed = lines.map((line) => JSON.parse(line) as { _tag: string });
			expect(parsed[0]._tag).toBe("LlmPart");
			expect(parsed[parsed.length - 1]._tag).toBe("Finish");
			// Transferable pin from legacy print mode: the empty flush sentinel
			// is the final raw chunk.
			expect(stdoutChunks[stdoutChunks.length - 1]).toBe("");
		});

		it("does not print final assistant text", async () => {
			await runEffectPrintMode(realSessionLayer("hi"), { mode: "json", initialMessage: "go" });
			expect(outputLines().every((line) => line.endsWith("}\n"))).toBe(true);
		});

		it("CONTRAST with legacy v1: a typed stream failure exits 1", async () => {
			// Legacy json mode folds errors into assistant messages and exits 0
			// (test/print-mode.test.ts PIN). The v2 contract surfaces the typed
			// AgentError on stderr and fails the run.
			const sends: unknown[] = [];
			const layer = Layer.mergeAll(
				fakeSessionLayer({ fail: new LlmError({ aiError: "rate limited" }), onSend: (i) => sends.push(i) }),
				stubLm([]),
			);
			const exitCode = await runEffectPrintMode(layer, {
				mode: "json",
				initialMessage: "a",
				messages: ["b"],
			});

			expect(exitCode).toBe(1);
			expect(stderrAfterWarning()).toEqual(["LLM request failed: rate limited"]);
			expect(sends).toEqual(["a"]);
		});
	});

	describe("text mode", () => {
		it("prints the final assistant text parts and exits 0", async () => {
			const exitCode = await runEffectPrintMode(realSessionLayer("answer"), {
				mode: "text",
				initialMessage: "go",
			});

			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual(["answer\n"]);
		});

		it("prints nothing when no prompts were sent", async () => {
			const exitCode = await runEffectPrintMode(realSessionLayer("unused"), { mode: "text" });
			expect(exitCode).toBe(0);
			expect(outputLines()).toEqual([]);
		});
	});

	describe("prompt sequencing", () => {
		it("sends initialMessage first, then messages in order", async () => {
			const sends: unknown[] = [];
			const layer = Layer.mergeAll(fakeSessionLayer({ onSend: (i) => sends.push(i) }), stubLm([]));

			const exitCode = await runEffectPrintMode(layer, {
				mode: "json",
				initialMessage: "first",
				messages: ["second", "third"],
			});

			expect(exitCode).toBe(0);
			expect(sends).toEqual(["first", "second", "third"]);
		});
	});

	describe("failure handling", () => {
		it("reports a layer build failure on stderr and exits 1", async () => {
			const broken = Layer.mergeAll(
				Layer.effect(CurrentSession, Effect.fail(new Error("auth exploded")) as never),
				stubLm([]),
			) as never;

			const exitCode = await runEffectPrintMode(broken, { mode: "text", initialMessage: "go" });

			expect(exitCode).toBe(1);
			expect(stderrAfterWarning().join("\n")).toContain("auth exploded");
		});
	});

	describe("signal handling (transferable contract: 143 / 129, dispose before exit)", () => {
		it("exits 143 on SIGTERM after disposing the runtime", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
			const layer = Layer.mergeAll(fakeSessionLayer({ hang: true }), stubLm([]));
			const before = process.listeners("SIGTERM");

			const run = runEffectPrintMode(layer, { mode: "text", initialMessage: "go" });
			await vi.waitFor(() => {
				expect(process.listeners("SIGTERM").length).toBe(before.length + 1);
			});
			const added = process.listeners("SIGTERM").filter((l) => !before.includes(l));
			added[0]("SIGTERM");

			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
			await run;
			expect(process.listeners("SIGTERM")).toEqual(before);
			// Shutdown interruption is not a failure: nothing beyond the
			// experimental warning reaches stderr on the signal path.
			expect(stderrAfterWarning()).toEqual([]);
		});

		it("exits 129 on SIGHUP (non-win32)", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
			const layer = Layer.mergeAll(fakeSessionLayer({ hang: true }), stubLm([]));
			const before = process.listeners("SIGHUP");

			const run = runEffectPrintMode(layer, { mode: "text", initialMessage: "go" });
			await vi.waitFor(() => {
				expect(process.listeners("SIGHUP").length).toBe(before.length + 1);
			});
			const added = process.listeners("SIGHUP").filter((l) => !before.includes(l));
			added[0]("SIGHUP");

			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(129));
			await run;
			expect(process.listeners("SIGHUP")).toEqual(before);
		});

		it("removes signal handlers after a normal run", async () => {
			const beforeTerm = process.listeners("SIGTERM");
			const beforeHup = process.listeners("SIGHUP");

			await runEffectPrintMode(realSessionLayer("hi"), { mode: "text", initialMessage: "go" });

			expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
			expect(process.listeners("SIGHUP")).toEqual(beforeHup);
		});
	});
});

describe("describeAgentError", () => {
	it("covers every AgentError variant", () => {
		expect(describeAgentError(new LlmError({ aiError: "x" }))).toContain("LLM request failed");
		expect(describeAgentError(new ToolError({ toolName: "Bash", toolCallId: "c1", cause: "boom" }))).toContain(
			'Tool "Bash" (c1) failed',
		);
		expect(describeAgentError(new SchemaError({ description: "bad shape" }))).toContain("bad shape");
		expect(
			describeAgentError(new StoreError({ store: "SessionStore", operation: "save", message: "disk full", cause: "e" })),
		).toBe("SessionStore save failed: disk full");
		expect(describeAgentError(new CancellationError())).toBe("Cancelled.");
		expect(describeAgentError(new CompactionError({ cause: "llm down" }))).toContain("Compaction failed");
	});
});

describe("effectModelSupport", () => {
	it("accepts openai non-codex models", () => {
		expect(effectModelSupport({ provider: "openai", id: "gpt-4o-mini", api: "openai-responses" })).toEqual({
			supported: true,
		});
	});

	it("rejects non-openai providers with a typed reason", () => {
		const result = effectModelSupport({ provider: "openrouter", id: "x", api: "openai-completions" });
		expect(result.supported).toBe(false);
		if (!result.supported) {
			expect(result.reason).toContain("UnsupportedModelError");
			expect(result.reason).toContain("openrouter/x");
		}
	});

	it("rejects the codex responses api", () => {
		const result = effectModelSupport({ provider: "openai", id: "codex", api: "openai-codex-responses" });
		expect(result.supported).toBe(false);
	});

	it("rejects openai completions-api models (wrong protocol for @effect/ai-openai)", () => {
		const result = effectModelSupport({ provider: "openai", id: "legacy", api: "openai-completions" });
		expect(result.supported).toBe(false);
	});
});

describe("finalAssistantTextParts", () => {
	const asPrompt = (content: ReadonlyArray<unknown>): Prompt.Prompt => ({ content }) as unknown as Prompt.Prompt;

	it("returns [] for empty history", () => {
		expect(finalAssistantTextParts(asPrompt([]))).toEqual([]);
	});

	it("returns [] when the last message is not from the assistant", () => {
		expect(finalAssistantTextParts(asPrompt([{ role: "user", content: "hi" }]))).toEqual([]);
	});

	it("returns only text parts of the trailing assistant message, in order", () => {
		const history = asPrompt([
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "one" },
					{ type: "tool-call", id: "c" },
					{ type: "text", text: "two" },
				],
			},
		]);
		expect(finalAssistantTextParts(history)).toEqual(["one", "two"]);
	});
});
