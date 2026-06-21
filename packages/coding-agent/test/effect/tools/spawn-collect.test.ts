// Focused tests for the shared subprocess helper behind the Live `bash`,
// `find`, and `grep` backends (ADR-0010). POSIX-only: the suite spawns `sh`
// and relies on process-group semantics that do not exist on win32.

import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { describe, expect } from "vitest";

import { SPAWN_OUTPUT_CAP_BYTES, spawnCollect } from "../../../effect/tools/spawn-collect.js";

interface TestSpawnError {
	readonly unavailable: boolean;
	readonly message: string;
}

const sh = (script: string, options?: { timeoutMs?: number; onLine?: (line: string) => void | "kill" }) =>
	spawnCollect<TestSpawnError>({
		command: "sh",
		args: ["-c", script],
		timeoutMs: options?.timeoutMs,
		onLine: options?.onLine,
		mapSpawnError: (error, unavailable) => ({ unavailable, message: error.message }),
	});

describe.skipIf(process.platform === "win32")("spawnCollect", () => {
	it.effect("collects combined stdout+stderr plus a separate stderr tail, and the exit code", () =>
		Effect.gen(function* () {
			const outcome = yield* sh("printf out; printf err 1>&2; exit 3");
			expect(outcome.exitCode).toBe(3);
			expect(outcome.output).toContain("out");
			expect(outcome.output).toContain("err");
			expect(outcome.stderr).toBe("err");
			expect(outcome.timedOut).toBe(false);
			expect(outcome.killedByCaller).toBe(false);
			expect(outcome.outputHeadTruncated).toBe(false);
		}),
	);

	it.effect("keeps only the rolling tail of oversized output and flags the head loss", () =>
		Effect.gen(function* () {
			const outcome = yield* sh(
				`head -c ${SPAWN_OUTPUT_CAP_BYTES + 4096} /dev/zero | tr "\\000" a; printf END`,
			);
			expect(outcome.exitCode).toBe(0);
			expect(outcome.outputHeadTruncated).toBe(true);
			expect(outcome.output.length).toBe(SPAWN_OUTPUT_CAP_BYTES);
			expect(outcome.output.endsWith("END")).toBe(true);
		}),
	);

	it.effect("classifies a missing binary as unavailable via the spawn-error hook", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				spawnCollect<TestSpawnError>({
					command: "pi-no-such-binary-spawn-collect",
					args: [],
					mapSpawnError: (error, unavailable) => ({ unavailable, message: error.message }),
				}),
			);
			expect(exit._tag).toBe("Failure");
			const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(error?._tag).toBe("Some");
			expect(error?._tag === "Some" ? error.value.unavailable : false).toBe(true);
		}),
	);

	it.effect("timeout kills the whole process group and flags timedOut", () =>
		Effect.gen(function* () {
			// The backgrounded sleeps inherit the stdio pipes, so `close` only
			// fires promptly when the group kill reaches them too — a kill of the
			// direct child alone would leave this test hanging until its timeout.
			const outcome = yield* sh("sleep 30 & sleep 30 & wait", { timeoutMs: 200 });
			expect(outcome.timedOut).toBe(true);
			expect(outcome.exitCode).toBeNull();
		}),
	);

	it.effect('onLine streams stdout lines and "kill" stops both delivery and the child', () =>
		Effect.gen(function* () {
			const lines: Array<string> = [];
			const outcome = yield* sh('printf "a\\nb\\nc\\n"; sleep 30', {
				onLine: (line) => {
					lines.push(line);
					if (lines.length === 2) return "kill";
				},
			});
			expect(outcome.killedByCaller).toBe(true);
			expect(lines).toEqual(["a", "b"]);
			// Line-streamed stdout is not collected into the rolling output tail.
			expect(outcome.output).toBe("");
		}),
	);

	it.effect("line mode still captures stderr for exit-code diagnostics", () =>
		Effect.gen(function* () {
			const lines: Array<string> = [];
			const outcome = yield* sh('printf "x\\n"; printf boom 1>&2; exit 2', {
				onLine: (line) => {
					lines.push(line);
				},
			});
			expect(outcome.exitCode).toBe(2);
			expect(outcome.stderr).toBe("boom");
			expect(lines).toEqual(["x"]);
			expect(outcome.killedByCaller).toBe(false);
		}),
	);
});
