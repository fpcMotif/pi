/**
 * End-to-end tracer bullet: the `Bash` tool flows through `BuiltinToolkit.handle("Bash", …)`
 * (ADR-0010, the toolkit-handler wiring).
 *
 * Slice index.test.ts proves the same for `Ls` against the real local filesystem;
 * this test does the same for `Bash` against the deterministic
 * `stubBashOperations` Layer (no real shell), so the toolkit's handler
 * resolution + the `dependencies: [BashOperations]` declaration + the stub
 * Layer compose cleanly through to a typed `HandlerResult` carrying the
 * expected `output` / `exitCode` / `status` fields.
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";

import { BuiltinToolkit, builtinToolkitLayer } from "../../../effect/tools/index.js";
import { stubBashOperations } from "../../../test-support/stub-bash-operations.js";

const CWD = nodePath.resolve("/unused/test-cwd");

describe("BuiltinToolkit.handle('Bash', …) — end-to-end", () => {
	it.effect("clean run: handler returns the captured output, exitCode 0, status 'ok'", () =>
		Effect.gen(function* () {
			const toolkit = yield* BuiltinToolkit;
			const stream = yield* toolkit.handle("Bash", { command: "echo hi" });
			const results = yield* Stream.runCollect(stream);

			const last = results[results.length - 1];
			expect(last.isFailure).toBe(false);
			if (last.isFailure || "_tag" in last.result) {
				throw new Error("expected Bash to succeed under the stub");
			}
			expect(last.result.command).toBe("echo hi");
			expect(last.result.exitCode).toBe(0);
			expect(last.result.output).toBe("hi\n");
			expect(last.result.status).toBe("ok");
		}).pipe(
			Effect.provide(Layer.mergeAll(builtinToolkitLayer(CWD), stubBashOperations({ output: "hi\n", exitCode: 0 }))),
		),
	);

	it.effect("non-zero exit: handler returns status 'nonzero-exit' with the exit code preserved", () =>
		Effect.gen(function* () {
			const toolkit = yield* BuiltinToolkit;
			const stream = yield* toolkit.handle("Bash", { command: "false" });
			const results = yield* Stream.runCollect(stream);

			const last = results[results.length - 1];
			expect(last.isFailure).toBe(false);
			if (last.isFailure || "_tag" in last.result) {
				throw new Error("expected Bash to surface non-zero as a success result, not an error");
			}
			expect(last.result.exitCode).toBe(1);
			expect(last.result.status).toBe("nonzero-exit");
			expect(last.result.output).toBe("boom\n");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(builtinToolkitLayer(CWD), stubBashOperations({ output: "boom\n", exitCode: 1 })),
			),
		),
	);
});
