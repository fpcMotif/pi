/**
 * The `bash` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports. The shell subprocess
 * lives behind the `BashOperations.exec` Service method: ADR-0010 explicitly
 * names `BashOperations` as a pluggable execution backend that becomes an
 * Effect `Context.Service`, so `BashOperationsLive` runs a local shell while
 * SSH / sandbox / remote backends swap a different Layer.
 *
 * Everything the handler does once it has the captured output — prepending the
 * command prefix, tail-truncating to the last N lines / M bytes, classifying
 * the run as `ok` / `nonzero-exit` / `timed-out` — is pure and exercised by the
 * tracer-bullet tests against a stub Layer, no real shell required.
 *
 * Design note vs. the legacy tool: a non-zero exit code is a *success* result
 * carrying `status: "nonzero-exit"` and the captured output, not an error-
 * channel failure. The command ran and produced output the model needs; only a
 * genuine inability to run it (missing cwd, spawn failure) goes through the
 * typed `BashError` channel. This is the ADR-0010 "typed result" stance — the
 * legacy tool threw on non-zero exit and lost the structured exit code.
 *
 * Process-group teardown (timeout / interrupt) and the rolling in-memory
 * output cap now live in the shared `spawn-collect.ts` helper. Still deferred
 * (follow-on slices, mirroring how `read` deferred image handling): throttled
 * live-output streaming (`onUpdate`), the temp-file spill for output beyond
 * the rolling cap, and the `BashSpawnHook` env/cwd/command transform Service.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { existsSync } from "node:fs";

import { spawnCollect } from "./spawn-collect.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "./truncate.js";

/** Resolved request handed to `BashOperations.exec` — command prefix already applied. */
export interface BashExecRequest {
	/** The full command to run (already includes any `commandPrefix`). */
	readonly command: string;
	/** Working directory the command runs in. */
	readonly cwd: string;
	/** Optional wall-clock timeout in seconds; the Service kills the process when it elapses. */
	readonly timeout: number | undefined;
}

/** Result of a `BashOperations.exec` — combined stdout+stderr, exit code, and whether a timeout fired. */
export interface BashExecOutcome {
	/** Process exit code, or `null` when the process was killed by a signal (timeout / interrupt). */
	readonly exitCode: number | null;
	/** Combined stdout + stderr, in arrival order. */
	readonly output: string;
	/** True when the Service killed the process because `request.timeout` elapsed. */
	readonly timedOut: boolean;
}

/**
 * The genuine ways `bash` cannot run a command at all, as a closed `reason` union:
 * - `cwd-not-found` — the working directory does not exist.
 * - `spawn-failed` — the shell process could not be spawned.
 *
 * A command that *runs* but exits non-zero is NOT a `BashError` — it is a
 * success `BashResult` with `status: "nonzero-exit"`.
 */
export class BashError extends Schema.TaggedErrorClass<BashError>()("BashError", {
	reason: Schema.Literals(["cwd-not-found", "spawn-failed"]),
	description: Schema.String,
}) {}

/**
 * Service for the shell execution `bash` needs. The default `Live` Layer runs a
 * local shell; tests provide a stub Layer with a canned outcome.
 */
export class BashOperations extends Context.Service<
	BashOperations,
	{
		readonly exec: (request: BashExecRequest) => Effect.Effect<BashExecOutcome, BashError>;
	}
>()("pi-coding-agent/BashOperations") {}

/** Pick the shell + invocation args for the current platform. */
const resolveShell = (): { shell: string; args: ReadonlyArray<string> } =>
	process.platform === "win32"
		? { shell: "cmd.exe", args: ["/d", "/s", "/c"] }
		: { shell: process.env.SHELL ?? "/bin/bash", args: ["-c"] };

/** Run `request.command` in a local shell, collecting combined stdout+stderr. */
const runShell = (request: BashExecRequest): Effect.Effect<BashExecOutcome, BashError> =>
	Effect.suspend(() => {
		if (!existsSync(request.cwd)) {
			return Effect.fail(
				new BashError({
					reason: "cwd-not-found",
					description: `Working directory does not exist: ${request.cwd}`,
				}),
			);
		}
		const { shell, args } = resolveShell();
		return spawnCollect({
			command: shell,
			args: [...args, request.command],
			cwd: request.cwd,
			env: process.env,
			timeoutMs: request.timeout !== undefined && request.timeout > 0 ? request.timeout * 1000 : undefined,
			mapSpawnError: (error) =>
				new BashError({ reason: "spawn-failed", description: `Failed to run shell command: ${error.message}` }),
		}).pipe(
			// `outputHeadTruncated` is dropped on purpose: the rolling cap is 10x the
			// display budget, so any output that lost its head already reports
			// `truncated: true` via `truncateTail` — only `totalLines` undercounts.
			Effect.map((outcome) => ({ exitCode: outcome.exitCode, output: outcome.output, timedOut: outcome.timedOut })),
		);
	});

/** Default `BashOperations` Layer: runs a local shell on the current platform. */
export const BashOperationsLive: Layer.Layer<BashOperations> = Layer.succeed(
	BashOperations,
	BashOperations.of({ exec: runShell }),
);

const BashParameters = Schema.Struct({
	command: Schema.String,
	timeout: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});

const BashResult = Schema.Struct({
	/** The resolved command actually run (includes any `commandPrefix`). */
	command: Schema.String,
	/** Process exit code, or `null` when the process was killed by a signal. */
	exitCode: Schema.NullOr(Schema.Number),
	/** Combined stdout + stderr, tail-truncated to the last N lines / M bytes for display. */
	output: Schema.String,
	/** True when the output was tail-truncated. */
	truncated: Schema.Boolean,
	/** Which budget was hit first, or `null` when the output was not truncated. */
	truncatedBy: Schema.NullOr(Schema.Literals(["lines", "bytes"])),
	/** Total line count of the full (pre-truncation) output. */
	totalLines: Schema.Number,
	/** Line count of the (possibly truncated) `output`. */
	outputLines: Schema.Number,
	/**
	 * Run classification:
	 * - `ok` — exit code 0, or killed by signal without a timeout.
	 * - `nonzero-exit` — the command ran and exited with a non-zero code.
	 * - `timed-out` — the Service killed the command because `timeout` elapsed.
	 */
	status: Schema.Literals(["ok", "nonzero-exit", "timed-out"]),
});

export const Bash = Tool.make("Bash", {
	description:
		`Execute a bash command in the working directory. Returns combined stdout and stderr plus the exit code. ` +
		`Output is tail-truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB ` +
		`(whichever is hit first). Optionally provide a timeout in seconds.`,
	parameters: BashParameters,
	success: BashResult,
	failure: BashError,
	// The handler reads its execution Service from context; declaring it here
	// threads `BashOperations` into the toolkit handler's allowed requirements
	// (ADR-0010).
	dependencies: [BashOperations],
});

export const BashToolkit = Toolkit.make(Bash);

/** Classify a finished run from its exit code + timeout flag. */
const classify = (outcome: BashExecOutcome): typeof BashResult.Type.status => {
	if (outcome.timedOut) return "timed-out";
	if (outcome.exitCode !== 0 && outcome.exitCode !== null) return "nonzero-exit";
	return "ok";
};

/**
 * Build the `Bash` handler bound to a specific `cwd`. `options.commandPrefix`,
 * when set, is prepended (on its own line) to every command — the legacy
 * shell-setup-prefix hook. The handler runs the command via `BashOperations`,
 * then tail-truncates + classifies the result purely.
 */
export const bashHandler = (cwd: string, options?: { readonly commandPrefix?: string }) =>
	Effect.fn("bash")(function* (params: typeof BashParameters.Type) {
		const command =
			options?.commandPrefix !== undefined && options.commandPrefix !== ""
				? `${options.commandPrefix}\n${params.command}`
				: params.command;

		const ops = yield* BashOperations;
		const outcome = yield* ops.exec({ command, cwd, timeout: params.timeout });

		const truncation = truncateTail(outcome.output, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		return {
			command,
			exitCode: outcome.exitCode,
			output: truncation.content,
			truncated: truncation.truncated,
			truncatedBy: truncation.truncatedBy,
			totalLines: truncation.totalLines,
			outputLines: truncation.outputLines,
			status: classify(outcome),
		} satisfies typeof BashResult.Type;
	});
