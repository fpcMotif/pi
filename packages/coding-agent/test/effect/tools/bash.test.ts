/**
 * Tracer bullet for the Effect-shaped `Bash` tool (ADR-0010 slice 7).
 *
 * `bash` runs a shell command; that subprocess lives behind the
 * `BashOperations.exec` Service method (ADR-0010 explicitly calls out
 * `BashOperations` as a pluggable backend that becomes a `Context.Service`),
 * so the handler's *pure* work — command-prefix assembly, tail truncation,
 * exit-code/timeout status classification — is testable without spawning a
 * real shell.
 *
 * Proves:
 *
 * - A clean run returns the captured output, `exitCode: 0`, and `status: "ok"`.
 * - A non-zero exit surfaces as a *success* result with `status: "nonzero-exit"`
 *   and the exit code preserved — the command ran and produced output the
 *   model needs, so it is not an error-channel failure (a deliberate
 *   improvement over the legacy tool, which threw).
 * - A timed-out run surfaces as `status: "timed-out"` with `exitCode: null`.
 * - Output longer than `DEFAULT_MAX_LINES` is *tail*-truncated (keep the end)
 *   and flags `truncated` / `truncatedBy: "lines"`.
 * - Output past the byte budget flags `truncatedBy: "bytes"`.
 * - `commandPrefix` is prepended to the command handed to the Service.
 * - A genuine inability to run the command (cwd missing) propagates through
 *   the typed error channel as `BashError`.
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { describe, expect } from "vitest";

import { BashError, type BashExecRequest, bashHandler } from "../../../effect/tools/bash.js";
import { stubBashOperations } from "../../../test-support/stub-bash-operations.js";

const CWD = nodePath.resolve("/test-fs/work");

describe("Bash -- Effect-shaped tool", () => {
	it.effect("returns captured output, exitCode 0, and status 'ok' on a clean run", () =>
		Effect.gen(function* () {
			const result = yield* bashHandler(CWD)({ command: "echo hi" }).pipe(
				Effect.provide(stubBashOperations({ output: "hi\n", exitCode: 0 })),
			);

			expect(result.command).toBe("echo hi");
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("hi\n");
			expect(result.status).toBe("ok");
			expect(result.truncated).toBe(false);
		}),
	);

	it.effect("surfaces a non-zero exit as a success result with status 'nonzero-exit'", () =>
		Effect.gen(function* () {
			const result = yield* bashHandler(CWD)({ command: "false" }).pipe(
				Effect.provide(stubBashOperations({ output: "boom\n", exitCode: 1 })),
			);

			expect(result.status).toBe("nonzero-exit");
			expect(result.exitCode).toBe(1);
			expect(result.output).toBe("boom\n");
		}),
	);

	it.effect("surfaces a timed-out run as status 'timed-out' with exitCode null", () =>
		Effect.gen(function* () {
			const result = yield* bashHandler(CWD)({ command: "sleep 100", timeout: 1 }).pipe(
				Effect.provide(stubBashOperations({ output: "partial\n", exitCode: null, timedOut: true })),
			);

			expect(result.status).toBe("timed-out");
			expect(result.exitCode).toBeNull();
			expect(result.output).toBe("partial\n");
		}),
	);

	it.effect("tail-truncates output longer than DEFAULT_MAX_LINES (keeps the end)", () =>
		Effect.gen(function* () {
			const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`).join("\n");
			const result = yield* bashHandler(CWD)({ command: "seq" }).pipe(
				Effect.provide(stubBashOperations({ output: lines, exitCode: 0 })),
			);

			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("lines");
			expect(result.totalLines).toBe(2500);
			// Tail truncation keeps the *end* of the stream.
			expect(result.output.endsWith("line-2500")).toBe(true);
			expect(result.output.startsWith("line-1\n")).toBe(false);
		}),
	);

	it.effect("byte-truncates output past the byte budget with truncatedBy 'bytes'", () =>
		Effect.gen(function* () {
			// A single 80KB line — over the 50KB byte budget, under the line budget.
			const huge = "x".repeat(80 * 1024);
			const result = yield* bashHandler(CWD)({ command: "cat big" }).pipe(
				Effect.provide(stubBashOperations({ output: huge, exitCode: 0 })),
			);

			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
		}),
	);

	it.effect("prepends commandPrefix to the command handed to the Service", () =>
		Effect.gen(function* () {
			let seen: BashExecRequest | undefined;
			const result = yield* bashHandler(CWD, { commandPrefix: "set -e" })({ command: "npm test" }).pipe(
				Effect.provide(
					stubBashOperations({
						output: "",
						exitCode: 0,
						capture: (request) => {
							seen = request;
						},
					}),
				),
			);

			expect(seen?.command).toBe("set -e\nnpm test");
			// The result reports the resolved command actually run.
			expect(result.command).toBe("set -e\nnpm test");
		}),
	);

	it.effect("propagates BashError(cwd-not-found) when the Service cannot run the command", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				bashHandler(CWD)({ command: "echo hi" }).pipe(
					Effect.provide(
						stubBashOperations({
							execError: new BashError({
								reason: "cwd-not-found",
								description: `Working directory does not exist: ${CWD}`,
							}),
						}),
					),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(BashError);
			expect((error as BashError).reason).toBe("cwd-not-found");
		}),
	);
});
