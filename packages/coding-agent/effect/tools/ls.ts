/**
 * The `ls` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports, no UI rendering. The
 * Effect handler accepts `LsOperations` from the runtime context so the
 * default Layer can read the local filesystem while alternative Layers
 * (SSH, in-memory, sandboxed) swap in for tests or remote execution
 * (ADR-0010's pluggable-backend-as-Service pattern).
 *
 * Result shape is a typed structured value (`entries`, `truncated`,
 * `entryLimitReached`) — consumers render in `pi-coding-agent`'s
 * `modes/interactive/tool-renderers/ls.ts` (not yet shipped); the
 * LLM-facing serialization comes from `Schema.encodeSync` against
 * `LsResult`, producing JSON the model sees.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { existsSync, readdirSync, statSync } from "node:fs";

import { FsError, tryFs } from "./fs-effect.js";
import { resolvePath } from "./path-resolution.js";

const DEFAULT_LIMIT = 500;

/**
 * Service for the IO operations `ls` needs. Default `Live` implementation
 * reads the local filesystem; tests provide a stub `Layer` with
 * deterministic responses.
 */
export class LsOperations extends Context.Service<
	LsOperations,
	{
		readonly exists: (absolutePath: string) => Effect.Effect<boolean>;
		readonly isDirectory: (absolutePath: string) => Effect.Effect<boolean, FsError>;
		readonly readdir: (absolutePath: string) => Effect.Effect<ReadonlyArray<string>, FsError>;
	}
>()("pi-coding-agent/LsOperations") {}

/** Default `LsOperations` Layer reading the local Node filesystem. */
export const LsOperationsLive: Layer.Layer<LsOperations> = Layer.succeed(
	LsOperations,
	LsOperations.of({
		exists: (p) => Effect.sync(() => existsSync(p)),
		isDirectory: (p) => tryFs(() => statSync(p).isDirectory()),
		readdir: (p) => tryFs(() => readdirSync(p)),
	}),
);

const LsParameters = Schema.Struct({
	path: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});

const LsResult = Schema.Struct({
	/** Absolute path that was listed. */
	path: Schema.String,
	/** Directory entries returned (subject to `limit`). Sorted lexicographically. */
	entries: Schema.Array(Schema.String),
	/** True when the directory had more entries than `limit` allowed. */
	truncated: Schema.Boolean,
	/** The applied limit, included verbatim so consumers don't have to re-derive defaults. */
	entryLimitApplied: Schema.Number,
});

export class LsError extends Schema.TaggedErrorClass<LsError>()("LsError", {
	path: Schema.String,
	reason: Schema.Literals(["not-found", "not-a-directory", "read-failed"]),
	description: Schema.String,
}) {}

export const Ls = Tool.make("Ls", {
	description:
		"List the entries (files and directories) under a directory. Returns a sorted array of names, paginated by `limit`.",
	parameters: LsParameters,
	success: LsResult,
	failure: LsError,
	// The handler reads its IO Service from context; declaring it here threads
	// `LsOperations` into the toolkit handler's allowed requirements (ADR-0010).
	dependencies: [LsOperations],
});

export const LsToolkit = Toolkit.make(Ls);

/**
 * Build the `Ls` handler bound to a specific `cwd`. The handler reads via
 * `LsOperations` from context, so test Layers can stub the filesystem.
 */
export const lsHandler = (cwd: string) =>
	Effect.fn("ls")(function* (params: typeof LsParameters.Type) {
		const ops = yield* LsOperations;
		const limit = params.limit ?? DEFAULT_LIMIT;
		const target = resolvePath(cwd, params.path);

		const exists = yield* ops.exists(target);
		if (!exists) {
			return yield* new LsError({
				path: target,
				reason: "not-found",
				description: `Path does not exist: ${target}`,
			});
		}

		const isDir = yield* ops.isDirectory(target).pipe(
			Effect.mapError(
				(e) => new LsError({ path: target, reason: "read-failed", description: `Failed to stat ${target}: ${e.message}` }),
			),
		);
		if (!isDir) {
			return yield* new LsError({
				path: target,
				reason: "not-a-directory",
				description: `Path is not a directory: ${target}`,
			});
		}

		const allEntries = yield* ops.readdir(target).pipe(
			Effect.mapError(
				(e) =>
					new LsError({
						path: target,
						reason: "read-failed",
						description: `Failed to read directory ${target}: ${e.message}`,
					}),
			),
		);
		const sorted = [...allEntries].sort();
		const truncated = sorted.length > limit;
		return {
			path: target,
			entries: truncated ? sorted.slice(0, limit) : sorted,
			truncated,
			entryLimitApplied: limit,
		} satisfies typeof LsResult.Type;
	});

