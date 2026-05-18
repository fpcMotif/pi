/**
 * Tracer bullet for the Effect-shaped `Find` tool (ADR-0010 slice 6).
 *
 * The `find` tool spawns `fd`; that subprocess lives behind the
 * `FindOperations.search` Service method so the handler's *pure* work —
 * relativising paths against the search root, trailing-slash preservation,
 * byte truncation, notice building — is testable without a real `fd` binary.
 *
 * Proves:
 *
 * - Found paths are relativised against the search root and POSIX-slashed.
 * - A trailing slash on a directory result is preserved.
 * - Zero results return `resultCount: 0` and `"No files found matching pattern"`.
 * - `limitReached` from the Service surfaces as `resultLimitReached`.
 * - Output exceeding the byte budget is head-truncated and flags `bytesTruncated`.
 * - Failures propagate through the typed error channel as `FindError`:
 *   `path-not-found` (exists is false), `fd-failed` (search rejects).
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { FindError, FindOperations, findHandler } from "../../../effect/tools/find.js";

const CWD = nodePath.resolve("/test-fs/work");
const SRC = nodePath.join(CWD, "src");

interface StubFind {
	readonly exists?: boolean;
	readonly paths?: ReadonlyArray<string>;
	readonly limitReached?: boolean;
	/** When set, `search` rejects (drives `fd-failed`). */
	readonly searchFails?: boolean;
}

const stubFindOperations = (stub: StubFind): Layer.Layer<FindOperations> =>
	Layer.succeed(
		FindOperations,
		FindOperations.of({
			exists: () => Effect.succeed(stub.exists ?? true),
			search: () =>
				stub.searchFails
					? Effect.fail(new FindError({ reason: "fd-failed", description: "synthetic fd failure" }))
					: Effect.succeed({ paths: stub.paths ?? [], limitReached: stub.limitReached ?? false }),
		}),
	);

describe("Find -- Effect-shaped tool", () => {
	it.effect("relativises found paths against the search root", () =>
		Effect.gen(function* () {
			const result = yield* findHandler(CWD)({ pattern: "*.ts", path: "src" }).pipe(
				Effect.provide(
					stubFindOperations({
						paths: [nodePath.join(SRC, "a.ts"), nodePath.join(SRC, "nested", "b.ts")],
					}),
				),
			);

			expect(result.resultCount).toBe(2);
			expect(result.output).toBe("a.ts\nnested/b.ts");
			expect(result.bytesTruncated).toBe(false);
			expect(result.resultLimitReached).toBeUndefined();
		}),
	);

	it.effect("preserves a trailing slash on directory results", () =>
		Effect.gen(function* () {
			const result = yield* findHandler(CWD)({ pattern: "*", path: "src" }).pipe(
				Effect.provide(stubFindOperations({ paths: [`${nodePath.join(SRC, "nested")}/`] })),
			);

			expect(result.output).toBe("nested/");
		}),
	);

	it.effect("returns resultCount 0 and the empty-search message", () =>
		Effect.gen(function* () {
			const result = yield* findHandler(CWD)({ pattern: "*.nope", path: "src" }).pipe(
				Effect.provide(stubFindOperations({ paths: [] })),
			);

			expect(result.resultCount).toBe(0);
			expect(result.output).toBe("No files found matching pattern");
		}),
	);

	it.effect("surfaces resultLimitReached when the Service reports limitReached", () =>
		Effect.gen(function* () {
			const result = yield* findHandler(CWD)({ pattern: "*.ts", path: "src", limit: 1 }).pipe(
				Effect.provide(stubFindOperations({ paths: [nodePath.join(SRC, "a.ts")], limitReached: true })),
			);

			expect(result.resultLimitReached).toBe(1);
			expect(result.output).toContain("results limit reached");
		}),
	);

	it.effect("head-truncates oversized output and flags bytesTruncated", () =>
		Effect.gen(function* () {
			// 60KB of distinct paths blows past the 50KB byte budget.
			const manyPaths = Array.from({ length: 1200 }, (_, i) => nodePath.join(SRC, `${"d".repeat(40)}-${i}.ts`));
			const result = yield* findHandler(CWD)({ pattern: "*.ts", path: "src" }).pipe(
				Effect.provide(stubFindOperations({ paths: manyPaths })),
			);

			expect(result.bytesTruncated).toBe(true);
			expect(result.output).toContain("limit reached");
		}),
	);

	it.effect("fails with FindError(path-not-found) when the search path does not exist", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				findHandler(CWD)({ pattern: "*.ts", path: "ghost" }).pipe(
					Effect.provide(stubFindOperations({ exists: false })),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(FindError);
			expect((error as FindError).reason).toBe("path-not-found");
		}),
	);

	it.effect("propagates FindError(fd-failed) when the Service search rejects", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				findHandler(CWD)({ pattern: "*.ts", path: "src" }).pipe(
					Effect.provide(stubFindOperations({ searchFails: true })),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(FindError);
			expect((error as FindError).reason).toBe("fd-failed");
		}),
	);
});
