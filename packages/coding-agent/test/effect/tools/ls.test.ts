/**
 * Tracer bullet for the Effect-shaped `Ls` tool (ADR-0010).
 *
 * Proves:
 *
 * - `lsHandler` runs against a stubbed `LsOperations` Layer, returning a
 *   typed `LsResult` (no `pi-tui` import in the path).
 * - Result entries are sorted lexicographically.
 * - When the directory has more entries than `limit`, `truncated: true` and
 *   the result is the first `limit` entries.
 * - Missing paths fail with `LsError({ reason: "not-found" })` in the error
 *   channel -- the tool failure propagates rather than throwing.
 * - Paths that exist but are not directories fail with
 *   `LsError({ reason: "not-a-directory" })`.
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { LsError, LsOperations, lsHandler } from "../../../effect/tools/ls.js";

// Platform-portable path roots. nodePath.resolve gives "/test-data" on POSIX,
// "C:\test-data" (or similar) on Windows; downstream paths use nodePath.join
// so the stub keys and the handler's resolved paths agree byte-for-byte.
const WORK = nodePath.resolve("/test-data/work");
const SRC = nodePath.join(WORK, "src");
const BIG = nodePath.resolve("/test-data/big");
const MISSING = nodePath.resolve("/test-data/missing");
const FILE = nodePath.resolve("/test-data/file.txt");

interface StubFs {
	readonly directories: Record<string, ReadonlyArray<string>>;
	readonly files?: ReadonlyArray<string>;
}

const stubLsOperations = (fs: StubFs): Layer.Layer<LsOperations> => {
	const files = new Set(fs.files ?? []);
	return Layer.succeed(
		LsOperations,
		LsOperations.of({
			exists: (p) => Effect.sync(() => p in fs.directories || files.has(p)),
			isDirectory: (p) => Effect.sync(() => p in fs.directories),
			readdir: (p) => Effect.sync(() => fs.directories[p] ?? []),
		}),
	);
};

describe("Ls -- Effect-shaped tool", () => {
	it.effect("returns sorted entries for an existing directory", () =>
		Effect.gen(function* () {
			const result = yield* lsHandler(WORK)({ path: WORK });

			expect(result.path).toBe(WORK);
			expect(result.entries).toEqual(["alpha.txt", "beta.txt", "zeta.txt"]);
			expect(result.truncated).toBe(false);
			expect(result.entryLimitApplied).toBe(500);
		}).pipe(
			Effect.provide(
				stubLsOperations({
					directories: { [WORK]: ["zeta.txt", "alpha.txt", "beta.txt"] },
				}),
			),
		),
	);

	it.effect("defaults to the bound cwd when path is omitted", () =>
		Effect.gen(function* () {
			const result = yield* lsHandler(WORK)({});

			expect(result.path).toBe(WORK);
			expect(result.entries).toEqual(["alpha.txt", "beta.txt"]);
		}).pipe(
			Effect.provide(
				stubLsOperations({
					directories: { [WORK]: ["beta.txt", "alpha.txt"] },
				}),
			),
		),
	);

	it.effect("resolves relative paths against the bound cwd", () =>
		Effect.gen(function* () {
			const result = yield* lsHandler(WORK)({ path: "src" });

			expect(result.path).toBe(SRC);
			expect(result.entries).toEqual(["a.ts", "b.ts"]);
		}).pipe(
			Effect.provide(
				stubLsOperations({
					directories: { [SRC]: ["b.ts", "a.ts"] },
				}),
			),
		),
	);

	it.effect("truncates when entries exceed limit and sets truncated: true", () =>
		Effect.gen(function* () {
			const all = Array.from({ length: 10 }, (_, i) => `file-${String(i).padStart(2, "0")}.txt`);
			const result = yield* lsHandler(WORK)({ path: BIG, limit: 3 });

			expect(result.entries).toEqual(all.slice(0, 3));
			expect(result.truncated).toBe(true);
			expect(result.entryLimitApplied).toBe(3);
		}).pipe(
			Effect.provide(
				stubLsOperations({
					directories: {
						[BIG]: Array.from({ length: 10 }, (_, i) => `file-${String(i).padStart(2, "0")}.txt`),
					},
				}),
			),
		),
	);

	it.effect("fails with LsError(not-found) when the path does not exist", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(lsHandler(WORK)({ path: MISSING }));
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(LsError);
			expect((error as LsError).reason).toBe("not-found");
			expect((error as LsError).path).toBe(MISSING);
		}).pipe(Effect.provide(stubLsOperations({ directories: {} }))),
	);

	it.effect("fails with LsError(not-a-directory) when the path is a file", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(lsHandler(WORK)({ path: FILE }));
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			expect(failure?._tag).toBe("Some");
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(LsError);
			expect((error as LsError).reason).toBe("not-a-directory");
		}).pipe(
			Effect.provide(
				stubLsOperations({
					directories: {},
					files: [FILE],
				}),
			),
		),
	);
});
