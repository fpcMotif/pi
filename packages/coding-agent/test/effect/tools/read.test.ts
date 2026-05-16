/**
 * Tracer bullet for the Effect-shaped `Read` tool (ADR-0010 slice 2).
 *
 * Proves:
 *
 * - `readHandler` runs against a stubbed `ReadOperations` Layer, returning a
 *   typed `ReadResult` (no `pi-tui` import in the path).
 * - Full-file read returns the whole content with `truncated: false`.
 * - `offset` + `limit` slice the file by 1-indexed line range.
 * - Out-of-range offsets clamp to the file end.
 * - Failures (`not-found`, `not-a-file`, `read-failed`) propagate through
 *   the typed error channel via `Effect.exit` + `Cause.findErrorOption`.
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { ReadError, ReadOperations, readHandler } from "../../../effect/tools/read.js";

const CWD = nodePath.resolve("/test-fs/work");
const FILE = nodePath.join(CWD, "sample.txt");
const MISSING = nodePath.join(CWD, "missing.txt");
const DIR = nodePath.join(CWD, "subdir");

interface StubFs {
	readonly files?: Record<string, string>;
	readonly directories?: ReadonlyArray<string>;
	/** Paths that should fail readTextFile with a synthetic error. */
	readonly readFailures?: ReadonlyArray<string>;
}

const stubReadOperations = (fs: StubFs): Layer.Layer<ReadOperations> => {
	const files = fs.files ?? {};
	const directories = new Set(fs.directories ?? []);
	const readFailures = new Set(fs.readFailures ?? []);
	return Layer.succeed(
		ReadOperations,
		ReadOperations.of({
			exists: (p) => Effect.sync(() => p in files || directories.has(p) || readFailures.has(p)),
			isFile: (p) => Effect.sync(() => p in files || readFailures.has(p)),
			readTextFile: (p) =>
				readFailures.has(p)
					? Effect.fail(Object.assign(new Error("synthetic"), { code: "EIO" }) as NodeJS.ErrnoException)
					: Effect.sync(() => files[p] ?? ""),
		}),
	);
};

const sampleLines = (count: number): string =>
	Array.from({ length: count }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`).join("\n");

describe("Read -- Effect-shaped tool", () => {
	it.effect("reads the full file when offset and limit are omitted", () =>
		Effect.gen(function* () {
			const result = yield* readHandler(CWD)({ path: FILE });

			expect(result.path).toBe(FILE);
			expect(result.content).toBe(sampleLines(5));
			expect(result.totalLines).toBe(5);
			expect(result.truncated).toBe(false);
			expect(result.offsetApplied).toBe(1);
		}).pipe(Effect.provide(stubReadOperations({ files: { [FILE]: sampleLines(5) } }))),
	);

	it.effect("resolves relative paths against the bound cwd", () =>
		Effect.gen(function* () {
			const result = yield* readHandler(CWD)({ path: "sample.txt" });

			expect(result.path).toBe(FILE);
			expect(result.content).toBe("hello");
		}).pipe(Effect.provide(stubReadOperations({ files: { [FILE]: "hello" } }))),
	);

	it.effect("slices by 1-indexed offset and limit; marks truncated true when slice < full file", () =>
		Effect.gen(function* () {
			const result = yield* readHandler(CWD)({ path: FILE, offset: 3, limit: 2 });

			expect(result.content).toBe("line-003\nline-004");
			expect(result.totalLines).toBe(10);
			expect(result.truncated).toBe(true);
			expect(result.offsetApplied).toBe(3);
			expect(result.limitApplied).toBe(2);
		}).pipe(Effect.provide(stubReadOperations({ files: { [FILE]: sampleLines(10) } }))),
	);

	it.effect("clamps offsets past EOF to an empty slice (no error)", () =>
		Effect.gen(function* () {
			const result = yield* readHandler(CWD)({ path: FILE, offset: 99, limit: 5 });

			expect(result.content).toBe("");
			expect(result.totalLines).toBe(3);
			expect(result.truncated).toBe(true);
		}).pipe(Effect.provide(stubReadOperations({ files: { [FILE]: sampleLines(3) } }))),
	);

	it.effect("fails with ReadError(not-found) when the path does not exist", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(readHandler(CWD)({ path: MISSING }));
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;

			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(ReadError);
			expect((error as ReadError).reason).toBe("not-found");
			expect((error as ReadError).path).toBe(MISSING);
		}).pipe(Effect.provide(stubReadOperations({ files: {} }))),
	);

	it.effect("fails with ReadError(not-a-file) when the path is a directory", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(readHandler(CWD)({ path: DIR }));
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;

			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(ReadError);
			expect((error as ReadError).reason).toBe("not-a-file");
		}).pipe(Effect.provide(stubReadOperations({ directories: [DIR] }))),
	);

	it.effect("fails with ReadError(read-failed) when readTextFile rejects", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(readHandler(CWD)({ path: FILE }));
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;

			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(ReadError);
			expect((error as ReadError).reason).toBe("read-failed");
		}).pipe(Effect.provide(stubReadOperations({ readFailures: [FILE] }))),
	);
});
