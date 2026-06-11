/**
 * Tracer bullet for the Effect-shaped `Write` tool (ADR-0010 slice 3).
 *
 * Proves:
 *
 * - `writeHandler` runs against a stubbed `WriteOperations` Layer, calling
 *   `mkdirRecursive(parentDir)` before `writeTextFile(path, content)`.
 * - Result reports the resolved absolute path and the byte count of the
 *   UTF-8-encoded content.
 * - Relative paths resolve against the bound cwd.
 * - `mkdir` failures propagate as `WriteError({ reason: "mkdir-failed" })`.
 * - `writeTextFile` failures propagate as `WriteError({ reason: "write-failed" })`.
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer, Ref } from "effect";
import { describe, expect } from "vitest";

import { FsError } from "../../../effect/tools/fs-effect.js";
import { WriteError, WriteOperations, writeHandler } from "../../../effect/tools/write.js";

const CWD = nodePath.resolve("/test-fs/work");
const FILE = nodePath.join(CWD, "out.txt");
const NESTED = nodePath.join(CWD, "nested", "deep", "file.txt");

interface RecordedWrite {
	readonly path: string;
	readonly content: string;
}

interface StubState {
	readonly mkdirs: ReadonlyArray<string>;
	readonly writes: ReadonlyArray<RecordedWrite>;
}

interface StubOptions {
	readonly mkdirFailures?: ReadonlyArray<string>;
	readonly writeFailures?: ReadonlyArray<string>;
}

const stubWriteOperations = (stateRef: Ref.Ref<StubState>, options: StubOptions = {}): Layer.Layer<WriteOperations> => {
	const mkdirFailures = new Set(options.mkdirFailures ?? []);
	const writeFailures = new Set(options.writeFailures ?? []);
	return Layer.succeed(
		WriteOperations,
		WriteOperations.of({
			mkdirRecursive: (dir) =>
				mkdirFailures.has(dir)
					? Effect.fail(new FsError({ message: "synthetic mkdir failure", code: "EACCES" }))
					: Ref.update(stateRef, (s) => ({ ...s, mkdirs: [...s.mkdirs, dir] })),
			writeTextFile: (p, content) =>
				writeFailures.has(p)
					? Effect.fail(new FsError({ message: "synthetic write failure", code: "EIO" }))
					: Ref.update(stateRef, (s) => ({ ...s, writes: [...s.writes, { path: p, content }] })),
		}),
	);
};

const fresh = (): Effect.Effect<Ref.Ref<StubState>> => Ref.make<StubState>({ mkdirs: [], writes: [] });

describe("Write -- Effect-shaped tool", () => {
	it.effect("writes a file and reports the absolute path + byte count", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			const result = yield* writeHandler(CWD)({ path: FILE, content: "hello" }).pipe(
				Effect.provide(stubWriteOperations(state)),
			);

			expect(result.path).toBe(FILE);
			expect(result.bytesWritten).toBe(5);

			const snapshot = yield* Ref.get(state);
			expect(snapshot.writes).toHaveLength(1);
			expect(snapshot.writes[0]).toEqual({ path: FILE, content: "hello" });
		}),
	);

	it.effect("counts bytes by UTF-8 length, not character count", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			// "héllo" — é is 2 bytes in UTF-8, so 6 bytes total.
			const result = yield* writeHandler(CWD)({ path: FILE, content: "héllo" }).pipe(
				Effect.provide(stubWriteOperations(state)),
			);

			expect(result.bytesWritten).toBe(6);
		}),
	);

	it.effect("creates the parent directory before writing the file", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			yield* writeHandler(CWD)({ path: NESTED, content: "deep" }).pipe(Effect.provide(stubWriteOperations(state)));

			const snapshot = yield* Ref.get(state);
			expect(snapshot.mkdirs).toEqual([nodePath.dirname(NESTED)]);
			expect(snapshot.writes[0]?.path).toBe(NESTED);
		}),
	);

	it.effect("resolves relative paths against the bound cwd", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			const result = yield* writeHandler(CWD)({ path: "out.txt", content: "hi" }).pipe(
				Effect.provide(stubWriteOperations(state)),
			);

			expect(result.path).toBe(FILE);
		}),
	);

	it.effect("fails with WriteError(mkdir-failed) when mkdir rejects, without attempting the write", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			const exit = yield* Effect.exit(
				writeHandler(CWD)({ path: NESTED, content: "x" }).pipe(
					Effect.provide(stubWriteOperations(state, { mkdirFailures: [nodePath.dirname(NESTED)] })),
				),
			);

			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(WriteError);
			expect((error as WriteError).reason).toBe("mkdir-failed");

			const snapshot = yield* Ref.get(state);
			expect(snapshot.writes).toHaveLength(0);
		}),
	);

	it.effect("fails with WriteError(write-failed) when writeTextFile rejects", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			const exit = yield* Effect.exit(
				writeHandler(CWD)({ path: FILE, content: "x" }).pipe(
					Effect.provide(stubWriteOperations(state, { writeFailures: [FILE] })),
				),
			);

			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(WriteError);
			expect((error as WriteError).reason).toBe("write-failed");

			const snapshot = yield* Ref.get(state);
			expect(snapshot.mkdirs).toEqual([CWD]);
		}),
	);
});
