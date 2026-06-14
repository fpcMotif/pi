/**
 * Effect-lane print mode (ADR-0020): the first production adapter for the
 * Effect rewrite. Behind the experimental `--effect` flag, prompts run
 * through the ADR-0009 `Session` resolved from an ADR-0008 `ManagedRuntime`,
 * and `--mode json` emits the v2 `AgentEvent` schema as JSON lines.
 *
 * Deliberate contract differences from legacy print mode (documented, not
 * accidental): no session-header line (no legacy SessionManager), no
 * extensions (skip + warn, decision 6), no built-in tools yet (the
 * coding-agent effect lane is not packaged for src/ imports — follow-up
 * slice), and a typed-error stream failure exits 1 in json mode where the
 * legacy v1 shape folds errors into assistant messages and exits 0.
 */
import {
	AgentEvent,
	type AgentError,
	CurrentSession,
} from "@earendil-works/pi-agent-core/effect";
import { Effect, type Layer, ManagedRuntime, Schema, Stream, SubscriptionRef } from "effect";
import type { LanguageModel, Prompt } from "effect/unstable/ai";
import { flushRawStdout, writeRawStdout } from "../../core/output-guard.js";

export interface EffectPrintModeOptions {
	/** "text": print the final assistant text. "json": emit v2 AgentEvent JSON lines. */
	readonly mode: "text" | "json";
	readonly initialMessage?: string;
	readonly messages?: readonly string[];
}

export type EffectPrintRequirements = CurrentSession | LanguageModel.LanguageModel;

/** Pre-flight support check for ADR-0020 decision 5 (typed error, Codex later). */
export const effectModelSupport = (model: {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
}): { readonly supported: true } | { readonly supported: false; readonly reason: string } =>
	// Positive allowlist: @effect/ai-openai speaks the Responses API. A
	// provider-only gate would route completions-api or Codex models through
	// the wrong protocol (slice-2 review).
	model.provider === "openai" && model.api === "openai-responses"
		? { supported: true }
		: {
				supported: false,
				reason:
					`UnsupportedModelError: --effect currently supports provider "openai" models with api ` +
					`"openai-responses" via @effect/ai-openai only (got ${model.provider}/${model.id}, api ${model.api}). ` +
					`Completions-api, Codex Responses, and OpenRouter providers land in follow-up slices (ADR-0020 decision 5).`,
			};

export const describeAgentError = (error: AgentError): string => {
	switch (error._tag) {
		case "LlmError":
			return `LLM request failed: ${String(error.aiError)}`;
		case "ToolError":
			return `Tool "${error.toolName}" (${error.toolCallId}) failed: ${String(error.cause)}`;
		case "SchemaError":
			return `Schema validation failed: ${error.description}`;
		case "StoreError":
			return `${error.store} ${error.operation} failed: ${error.message}`;
		case "CancellationError":
			return "Cancelled.";
		case "CompactionError":
			return `Compaction failed: ${String(error.cause)}`;
	}
};

/** Text parts of the trailing assistant message, in order; [] when the last message is not an assistant turn. */
export const finalAssistantTextParts = (history: Prompt.Prompt): readonly string[] => {
	const last = history.content[history.content.length - 1];
	if (last === undefined || last.role !== "assistant") return [];
	return last.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
};

const emitEventLine = Schema.encodeEffect(AgentEvent);

/**
 * The mode program at the Session interface: send each prompt, stream events
 * to stdout (json mode), then print the final assistant text (text mode).
 * Typed `AgentError` failures go to stderr and yield exit code 1.
 */
export const printProgram = (
	options: EffectPrintModeOptions,
): Effect.Effect<number, never, EffectPrintRequirements> =>
	Effect.gen(function* () {
		const session = yield* CurrentSession;
		const prompts = [
			...(options.initialMessage === undefined ? [] : [options.initialMessage]),
			...(options.messages ?? []),
		];

		for (const prompt of prompts) {
			const failed = yield* session.send(prompt).pipe(
				Stream.runForEach((event) =>
					options.mode === "json"
						? emitEventLine(event).pipe(
								Effect.orDie,
								Effect.flatMap((encoded) => Effect.sync(() => writeRawStdout(`${JSON.stringify(encoded)}\n`))),
							)
						: Effect.void,
				),
				Effect.as(false),
				Effect.catch((error: AgentError) =>
					Effect.sync(() => {
						console.error(describeAgentError(error));
						return true;
					}),
				),
			);
			if (failed) return 1;
		}

		if (options.mode === "text") {
			const snapshot = yield* SubscriptionRef.get(session.state);
			for (const text of finalAssistantTextParts(snapshot.history)) {
				yield* Effect.sync(() => writeRawStdout(`${text}\n`));
			}
		}
		return 0;
	});

/**
 * Host entry: builds the ADR-0008 ManagedRuntime from the app layer, runs
 * the program, and mirrors legacy print mode's transferable contract —
 * SIGTERM→143 / SIGHUP→129 after a single dispose, handlers removed after
 * the run, thrown failures to stderr with exit 1, stdout flushed last.
 */
export async function runEffectPrintMode(
	appLayer: Layer.Layer<EffectPrintRequirements, unknown>,
	options: EffectPrintModeOptions,
): Promise<number> {
	console.error(
		"[--effect] experimental Effect-lane print mode: extensions are not loaded, " +
			"built-in tools are not yet wired, and --mode json emits the v2 AgentEvent schema (ADR-0020).",
	);
	const runtime = ManagedRuntime.make(appLayer);

	// Memoize the in-flight dispose so the finally path AWAITS a
	// signal-initiated disposal instead of skipping past it; shutdown errors
	// are swallowed — there is nothing actionable at exit.
	let disposePromise: Promise<void> | undefined;
	const disposeOnce = (): Promise<void> => (disposePromise ??= runtime.dispose().catch(() => {}));

	const signalCleanups: Array<() => void> = [];
	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	for (const signal of signals) {
		const handler = () => {
			void disposeOnce().finally(() => {
				process.exit(signal === "SIGHUP" ? 129 : 143);
			});
		};
		process.on(signal, handler);
		signalCleanups.push(() => process.off(signal, handler));
	}

	try {
		return await runtime.runPromise(printProgram(options));
	} catch (error: unknown) {
		// A signal-initiated dispose interrupts the in-flight program; that
		// interruption is shutdown, not failure — keep stderr quiet for it.
		if (disposePromise === undefined) {
			/* v8 ignore next -- runPromise always rejects with an Error (FiberFailure); the String arm is defensive. */
			console.error(error instanceof Error ? error.message : String(error));
		}
		return 1;
		/* v8 ignore next -- the finally exception-path range is unreachable: the catch above swallows every error and returns. */
	} finally {
		for (const cleanup of signalCleanups) {
			cleanup();
		}
		await disposeOnce();
		await flushRawStdout();
	}
}
