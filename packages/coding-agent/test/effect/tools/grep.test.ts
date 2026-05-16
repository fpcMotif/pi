/**
 * Tracer bullet for the Effect-shaped `Grep` tool (ADR-0010 slice 5).
 *
 * The `grep` tool spawns ripgrep; that subprocess lives behind the
 * `GrepOperations.search` Service method so the handler's *pure* work —
 * relative-path formatting, context-line assembly, long-line + byte
 * truncation, notice building — is testable without a real `rg` binary.
 *
 * Proves:
 *
 * - Single-line matches (context=0) format as `relpath:lineNo: text`, with
 *   paths relativised against a directory search root.
 * - A single-file search formats matches under the file basename.
 * - `context > 0` reads each file via `GrepOperations.readFile` and emits a
 *   before/after block (`relpath-N-` context vs `relpath:N:` match line).
 * - Zero matches return `matchCount: 0` and the `"No matches found"` output.
 * - `limitReached` from the Service surfaces as `matchLimitReached`.
 * - Match lines longer than `GREP_MAX_LINE_LENGTH` are truncated and flag
 *   `linesTruncated`.
 * - Failures propagate through the typed error channel as `GrepError`:
 *   `path-not-found` (isDirectory rejects), `ripgrep-failed` (search rejects).
 */

import nodePath from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { GrepError, GrepOperations, grepHandler, type RawGrepMatch } from "../../../effect/tools/grep.js";

const CWD = nodePath.resolve("/test-fs/work");
const SRC = nodePath.join(CWD, "src");
const FILE_A = nodePath.join(SRC, "a.ts");
const FILE_B = nodePath.join(SRC, "nested", "b.ts");

interface StubGrep {
	readonly directories?: ReadonlyArray<string>;
	readonly files?: Record<string, string>;
	readonly matches?: ReadonlyArray<RawGrepMatch>;
	readonly limitReached?: boolean;
	/** When set, `isDirectory` rejects for any path (drives `path-not-found`). */
	readonly isDirectoryFails?: boolean;
	/** When set, `search` rejects (drives `ripgrep-failed`). */
	readonly searchFails?: boolean;
}

const errno = (msg: string): NodeJS.ErrnoException => {
	const e = new Error(msg) as NodeJS.ErrnoException;
	e.code = "ENOENT";
	return e;
};

const stubGrepOperations = (stub: StubGrep): Layer.Layer<GrepOperations> => {
	const directories = new Set(stub.directories ?? []);
	const files = stub.files ?? {};
	return Layer.succeed(
		GrepOperations,
		GrepOperations.of({
			isDirectory: (p) =>
				stub.isDirectoryFails ? Effect.fail(errno(`stat failed: ${p}`)) : Effect.succeed(directories.has(p)),
			readFile: (p) => (p in files ? Effect.succeed(files[p]) : Effect.fail(errno(`read failed: ${p}`))),
			search: () =>
				stub.searchFails
					? Effect.fail(new GrepError({ reason: "ripgrep-failed", description: "synthetic ripgrep failure" }))
					: Effect.succeed({ matches: stub.matches ?? [], limitReached: stub.limitReached ?? false }),
		}),
	);
};

describe("Grep -- Effect-shaped tool", () => {
	it.effect("formats single-line matches with directory-relative paths", () =>
		Effect.gen(function* () {
			const result = yield* grepHandler(CWD)({ pattern: "foo", path: "src" }).pipe(
				Effect.provide(
					stubGrepOperations({
						directories: [SRC],
						matches: [
							{ filePath: FILE_A, lineNumber: 3, lineText: "const foo = 1;\n" },
							{ filePath: FILE_B, lineNumber: 7, lineText: "  return foo();\n" },
						],
					}),
				),
			);

			expect(result.matchCount).toBe(2);
			expect(result.output).toBe("a.ts:3: const foo = 1;\nnested/b.ts:7:   return foo();");
			expect(result.bytesTruncated).toBe(false);
			expect(result.linesTruncated).toBe(false);
			expect(result.matchLimitReached).toBeUndefined();
		}),
	);

	it.effect("formats matches under the basename when searching a single file", () =>
		Effect.gen(function* () {
			const result = yield* grepHandler(CWD)({ pattern: "foo", path: "src/a.ts" }).pipe(
				Effect.provide(
					stubGrepOperations({
						// FILE_A is not in `directories`, so it is treated as a single file.
						matches: [{ filePath: FILE_A, lineNumber: 1, lineText: "foo\n" }],
					}),
				),
			);

			expect(result.output).toBe("a.ts:1: foo");
		}),
	);

	it.effect("emits before/after context blocks when context > 0", () =>
		Effect.gen(function* () {
			const result = yield* grepHandler(CWD)({ pattern: "two", path: "src", context: 1 }).pipe(
				Effect.provide(
					stubGrepOperations({
						directories: [SRC],
						files: { [FILE_A]: "one\ntwo\nthree\n" },
						matches: [{ filePath: FILE_A, lineNumber: 2, lineText: "two\n" }],
					}),
				),
			);

			expect(result.output).toBe("a.ts-1- one\na.ts:2: two\na.ts-3- three");
		}),
	);

	it.effect("returns matchCount 0 and 'No matches found' when the search is empty", () =>
		Effect.gen(function* () {
			const result = yield* grepHandler(CWD)({ pattern: "absent", path: "src" }).pipe(
				Effect.provide(stubGrepOperations({ directories: [SRC], matches: [] })),
			);

			expect(result.matchCount).toBe(0);
			expect(result.output).toBe("No matches found");
		}),
	);

	it.effect("surfaces matchLimitReached when the Service reports limitReached", () =>
		Effect.gen(function* () {
			const result = yield* grepHandler(CWD)({ pattern: "foo", path: "src", limit: 1 }).pipe(
				Effect.provide(
					stubGrepOperations({
						directories: [SRC],
						matches: [{ filePath: FILE_A, lineNumber: 1, lineText: "foo\n" }],
						limitReached: true,
					}),
				),
			);

			expect(result.matchLimitReached).toBe(1);
			expect(result.output).toContain("matches limit reached");
		}),
	);

	it.effect("truncates over-long match lines and flags linesTruncated", () =>
		Effect.gen(function* () {
			const longLine = `${"x".repeat(800)}\n`;
			const result = yield* grepHandler(CWD)({ pattern: "x", path: "src" }).pipe(
				Effect.provide(
					stubGrepOperations({
						directories: [SRC],
						matches: [{ filePath: FILE_A, lineNumber: 1, lineText: longLine }],
					}),
				),
			);

			expect(result.linesTruncated).toBe(true);
			expect(result.output).toContain("... [truncated]");
		}),
	);

	it.effect("fails with GrepError(path-not-found) when isDirectory rejects", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				grepHandler(CWD)({ pattern: "foo", path: "ghost" }).pipe(
					Effect.provide(stubGrepOperations({ isDirectoryFails: true })),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(GrepError);
			expect((error as GrepError).reason).toBe("path-not-found");
		}),
	);

	it.effect("propagates GrepError(ripgrep-failed) when the Service search rejects", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				grepHandler(CWD)({ pattern: "foo", path: "src" }).pipe(
					Effect.provide(stubGrepOperations({ directories: [SRC], searchFails: true })),
				),
			);
			const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
			const error = failure?._tag === "Some" ? failure.value : undefined;
			expect(error).toBeInstanceOf(GrepError);
			expect((error as GrepError).reason).toBe("ripgrep-failed");
		}),
	);
});
