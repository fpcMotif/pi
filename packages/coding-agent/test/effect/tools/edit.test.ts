/**
 * Tracer bullet for the Effect-shaped `Edit` tool (ADR-0010 slice 4).
 *
 * Proves:
 *
 * - `editHandler` runs against a stubbed `EditOperations` Layer, returning a
 *   typed `EditResult` (no `pi-tui` import in the path).
 * - A single exact-text replacement rewrites the file and reports a diff +
 *   the resolved absolute path + `editsApplied`.
 * - Multiple disjoint edits in one call all land (matched against the
 *   original file, applied reverse-order so offsets stay stable).
 * - Relative paths resolve against the bound cwd.
 * - CRLF line endings and a leading BOM round-trip through the edit.
 * - Failures propagate through the typed error channel as `EditError`:
 *   `not-found` (file missing), `read-failed` / `write-failed` (IO rejects),
 *   `no-match` (oldText absent), `ambiguous-match` (oldText not unique),
 *   `invalid-input` (empty edits array).
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer, Ref } from "effect";
import { describe, expect } from "vitest";

import { EditError, EditOperations, editHandler } from "../../../effect/tools/edit.js";

const CWD = nodePath.resolve("/test-fs/work");
const FILE = nodePath.join(CWD, "sample.ts");
const MISSING = nodePath.join(CWD, "missing.ts");

interface RecordedWrite {
	readonly path: string;
	readonly content: string;
}

interface StubState {
	readonly files: Record<string, string>;
	readonly writes: ReadonlyArray<RecordedWrite>;
}

interface StubOptions {
	readonly readFailures?: ReadonlyArray<string>;
	readonly writeFailures?: ReadonlyArray<string>;
}

const errnoLike = (msg: string): NodeJS.ErrnoException => {
	const e = new Error(msg) as NodeJS.ErrnoException;
	e.code = "EACCES";
	return e;
};

const stubEditOperations = (stateRef: Ref.Ref<StubState>, options: StubOptions = {}): Layer.Layer<EditOperations> => {
	const readFailures = new Set(options.readFailures ?? []);
	const writeFailures = new Set(options.writeFailures ?? []);
	return Layer.succeed(
		EditOperations,
		EditOperations.of({
			exists: (p) => Effect.map(Ref.get(stateRef), (s) => p in s.files),
			readTextFile: (p) =>
				readFailures.has(p)
					? Effect.fail(errnoLike("synthetic read failure"))
					: Effect.map(Ref.get(stateRef), (s) => s.files[p] ?? ""),
			writeTextFile: (p, content) =>
				writeFailures.has(p)
					? Effect.fail(errnoLike("synthetic write failure"))
					: Ref.update(stateRef, (s) => ({
							files: { ...s.files, [p]: content },
							writes: [...s.writes, { path: p, content }],
						})),
		}),
	);
};

const fresh = (files: Record<string, string> = {}): Effect.Effect<Ref.Ref<StubState>> =>
	Ref.make<StubState>({ files, writes: [] });

describe("Edit -- Effect-shaped tool", () => {
	it.effect("applies a single exact-text replacement and reports the diff + path", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "const a = 1;\nconst b = 2;\n" });
			const result = yield* editHandler(CWD)({
				path: FILE,
				edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }],
			}).pipe(Effect.provide(stubEditOperations(state)));

			expect(result.path).toBe(FILE);
			expect(result.editsApplied).toBe(1);
			expect(result.diff).toContain("const a = 42;");

			const snapshot = yield* Ref.get(state);
			expect(snapshot.files[FILE]).toBe("const a = 42;\nconst b = 2;\n");
		}),
	);

	it.effect("applies multiple disjoint edits in a single call", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "alpha\nbeta\ngamma\n" });
			const result = yield* editHandler(CWD)({
				path: FILE,
				edits: [
					{ oldText: "alpha", newText: "ALPHA" },
					{ oldText: "gamma", newText: "GAMMA" },
				],
			}).pipe(Effect.provide(stubEditOperations(state)));

			expect(result.editsApplied).toBe(2);
			const snapshot = yield* Ref.get(state);
			expect(snapshot.files[FILE]).toBe("ALPHA\nbeta\nGAMMA\n");
		}),
	);

	it.effect("resolves relative paths against the bound cwd", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "x\n" });
			const result = yield* editHandler(CWD)({
				path: "sample.ts",
				edits: [{ oldText: "x", newText: "y" }],
			}).pipe(Effect.provide(stubEditOperations(state)));

			expect(result.path).toBe(FILE);
		}),
	);

	it.effect("preserves CRLF line endings in the written file", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "one\r\ntwo\r\nthree\r\n" });
			yield* editHandler(CWD)({
				path: FILE,
				edits: [{ oldText: "two", newText: "TWO" }],
			}).pipe(Effect.provide(stubEditOperations(state)));

			const snapshot = yield* Ref.get(state);
			expect(snapshot.files[FILE]).toBe("one\r\nTWO\r\nthree\r\n");
		}),
	);

	it.effect("preserves a leading UTF-8 BOM", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "﻿hello world\n" });
			yield* editHandler(CWD)({
				path: FILE,
				edits: [{ oldText: "hello", newText: "goodbye" }],
			}).pipe(Effect.provide(stubEditOperations(state)));

			const snapshot = yield* Ref.get(state);
			expect(snapshot.files[FILE]).toBe("﻿goodbye world\n");
		}),
	);

	it.effect("fails with EditError(not-found) when the path does not exist", () =>
		Effect.gen(function* () {
			const state = yield* fresh();
			const exit = yield* Effect.exit(
				editHandler(CWD)({ path: MISSING, edits: [{ oldText: "a", newText: "b" }] }).pipe(
					Effect.provide(stubEditOperations(state)),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(EditError);
			expect((error as EditError).reason).toBe("not-found");
		}),
	);

	it.effect("fails with EditError(read-failed) when readTextFile rejects", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "content" });
			const exit = yield* Effect.exit(
				editHandler(CWD)({ path: FILE, edits: [{ oldText: "content", newText: "x" }] }).pipe(
					Effect.provide(stubEditOperations(state, { readFailures: [FILE] })),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(EditError);
			expect((error as EditError).reason).toBe("read-failed");
		}),
	);

	it.effect("fails with EditError(write-failed) when writeTextFile rejects", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "content" });
			const exit = yield* Effect.exit(
				editHandler(CWD)({ path: FILE, edits: [{ oldText: "content", newText: "x" }] }).pipe(
					Effect.provide(stubEditOperations(state, { writeFailures: [FILE] })),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(EditError);
			expect((error as EditError).reason).toBe("write-failed");
		}),
	);

	it.effect("fails with EditError(no-match) when oldText is not in the file", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "the quick brown fox" });
			const exit = yield* Effect.exit(
				editHandler(CWD)({ path: FILE, edits: [{ oldText: "lazy dog", newText: "x" }] }).pipe(
					Effect.provide(stubEditOperations(state)),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(EditError);
			expect((error as EditError).reason).toBe("no-match");
			// No write happened.
			const snapshot = yield* Ref.get(state);
			expect(snapshot.writes).toHaveLength(0);
		}),
	);

	it.effect("fails with EditError(ambiguous-match) when oldText matches more than once", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "dup\ndup\n" });
			const exit = yield* Effect.exit(
				editHandler(CWD)({ path: FILE, edits: [{ oldText: "dup", newText: "x" }] }).pipe(
					Effect.provide(stubEditOperations(state)),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(EditError);
			expect((error as EditError).reason).toBe("ambiguous-match");
		}),
	);

	it.effect("fails with EditError(invalid-input) when the edits array is empty", () =>
		Effect.gen(function* () {
			const state = yield* fresh({ [FILE]: "content" });
			const exit = yield* Effect.exit(
				editHandler(CWD)({ path: FILE, edits: [] }).pipe(Effect.provide(stubEditOperations(state))),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(EditError);
			expect((error as EditError).reason).toBe("invalid-input");
		}),
	);
});
