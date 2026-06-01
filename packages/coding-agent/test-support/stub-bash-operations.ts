/**
 * Reusable test fixture for the Effect-shaped `Bash` tool (ADR-0010, ADR-0015).
 *
 * `BashOperations` is the pluggable execution backend the `Bash` tool reads
 * from context. This stub Layer returns a canned outcome (output / exit code /
 * timedOut flag) — or an arbitrary `BashError` — without spawning a real
 * shell, so handler logic, toolkit-handler wiring, and end-to-end integration
 * tests stay deterministic and shell-free.
 *
 * Mirrors the agent's `test-support/stub-*` pattern (e.g. `stubLanguageModel`):
 * one small builder, options as a plain shape, no recording side-channel
 * beyond the optional `capture` callback callers can hook in.
 */
import { Effect, Layer } from "effect";

import { type BashExecRequest, BashError, BashOperations } from "../effect/tools/bash.js";

export interface StubBashOptions {
	/** Combined stdout+stderr the stub returns. Defaults to `""`. */
	readonly output?: string;
	/**
	 * Process exit code. Set to `null` to simulate a signal-killed process. When
	 * the key is **omitted entirely**, defaults to `0` (clean exit); an explicit
	 * `null` is preserved (the no-coalesce path).
	 */
	readonly exitCode?: number | null;
	/** Whether the stub claims the run was killed by `request.timeout`. Defaults to `false`. */
	readonly timedOut?: boolean;
	/** When set, `exec` rejects with this `BashError` instead of returning an outcome. */
	readonly execError?: BashError;
	/** Receives every request handed to `exec`, for call-shape assertions. */
	readonly capture?: (request: BashExecRequest) => void;
}

/**
 * Build a `BashOperations` Layer that resolves every `exec` to the canned
 * `options`. Use under `Effect.provide(...)` in tests that need to exercise the
 * `Bash` tool, the `BuiltinToolkit` flow, or any handler that consumes the
 * `BashOperations` Service — no shell required.
 */
export const stubBashOperations = (options: StubBashOptions): Layer.Layer<BashOperations> =>
	Layer.succeed(
		BashOperations,
		BashOperations.of({
			exec: (request) => {
				options.capture?.(request);
				return options.execError !== undefined
					? Effect.fail(options.execError)
					: Effect.succeed({
							// `exitCode` defaults to 0 only when the key is absent — an explicit
							// `null` (signal-killed) must survive, so `?? 0` would be wrong here.
							exitCode: "exitCode" in options ? (options.exitCode ?? null) : 0,
							output: options.output ?? "",
							timedOut: options.timedOut ?? false,
						});
			},
		}),
	);
