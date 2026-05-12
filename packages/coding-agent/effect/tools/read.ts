/**
 * The `read` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Text-only path lands here. Image handling (base64-encoded ImageContent for
 * known MIME types, auto-resize to 2000x2000) is a follow-on slice — the
 * legacy `src/core/tools/read.ts` retains that behaviour until then.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports. The Effect handler
 * reads via `ReadOperations` from context so the default Layer can read the
 * local filesystem and tests / SSH / sandbox backends can swap a different
 * Layer (the ADR-0010 pluggable-backends-as-Services pattern, mirroring
 * `LsOperations`).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

/**
 * Service for the IO operations `read` needs. Default `Live` implementation
 * reads the local filesystem; tests provide a stub `Layer` with deterministic
 * responses.
 *
 * `readTextFile` returns the full file contents as a UTF-8 string. The
 * handler does its own line-range slicing — keeping the Service surface
 * primitive lets remote / SSH backends implement it in one network round-trip
 * instead of streaming.
 */
export class ReadOperations extends Context.Service<
	ReadOperations,
	{
		readonly exists: (absolutePath: string) => Effect.Effect<boolean>;
		readonly isFile: (absolutePath: string) => Effect.Effect<boolean, NodeJS.ErrnoException>;
		readonly readTextFile: (absolutePath: string) => Effect.Effect<string, NodeJS.ErrnoException>;
	}
>()("pi-coding-agent/ReadOperations") {}

/** Default `ReadOperations` Layer reading the local Node filesystem. */
export const ReadOperationsLive: Layer.Layer<ReadOperations> = Layer.succeed(
	ReadOperations,
	ReadOperations.of({
		exists: (p) => Effect.sync(() => existsSync(p)),
		isFile: (p) =>
			Effect.try({
				try: () => statSync(p).isFile(),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
		readTextFile: (p) =>
			Effect.try({
				try: () => readFileSync(p, "utf-8"),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
	}),
);

const DEFAULT_LIMIT = 2000;

const ReadParameters = Schema.Struct({
	path: Schema.String,
	offset: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
});

const ReadResult = Schema.Struct({
	/** Absolute path that was read. */
	path: Schema.String,
	/** The selected slice of file content. */
	content: Schema.String,
	/** Total line count of the underlying file (before offset/limit). */
	totalLines: Schema.Number,
	/** True when the selected slice does not cover the full file (offset > 1 or limit truncated). */
	truncated: Schema.Boolean,
	/** 1-indexed line at which the slice begins. */
	offsetApplied: Schema.Number,
	/** Maximum number of lines included in the slice. */
	limitApplied: Schema.Number,
});

export class ReadError extends Schema.TaggedErrorClass<ReadError>()("ReadError", {
	path: Schema.String,
	reason: Schema.Literals(["not-found", "not-a-file", "read-failed"]),
	description: Schema.String,
}) {}

export const Read = Tool.make("Read", {
	description: "Read the contents of a text file, optionally as a 1-indexed line range via `offset` and `limit`.",
	parameters: ReadParameters,
	success: ReadResult,
	failure: ReadError,
});

export const ReadToolkit = Toolkit.make(Read);

const resolvePath = (cwd: string, input: string): string =>
	nodePath.isAbsolute(input) ? input : nodePath.resolve(cwd, input);

const sliceLines = (
	content: string,
	rawOffset: number | undefined,
	rawLimit: number | undefined,
): { content: string; totalLines: number; truncated: boolean; offsetApplied: number; limitApplied: number } => {
	const lines = content.split("\n");
	const totalLines = lines.length;
	const offsetApplied = Math.max(1, rawOffset ?? 1);
	const limitApplied = rawLimit ?? DEFAULT_LIMIT;
	const startIdx = Math.min(offsetApplied - 1, totalLines);
	const endIdx = Math.min(startIdx + limitApplied, totalLines);
	const slice = lines.slice(startIdx, endIdx).join("\n");
	const truncated = startIdx > 0 || endIdx < totalLines;
	return { content: slice, totalLines, truncated, offsetApplied, limitApplied };
};

/**
 * Build the `Read` handler bound to a specific `cwd`. The handler reads via
 * `ReadOperations` from context, so test Layers can stub the filesystem.
 */
export const readHandler = (cwd: string) =>
	Effect.fn("read")(function* (params: typeof ReadParameters.Type) {
		const ops = yield* ReadOperations;
		const target = resolvePath(cwd, params.path);

		const exists = yield* ops.exists(target);
		if (!exists) {
			return yield* new ReadError({
				path: target,
				reason: "not-found",
				description: `Path does not exist: ${target}`,
			});
		}

		const isFile = yield* ops.isFile(target).pipe(
			Effect.mapError(
				() =>
					new ReadError({ path: target, reason: "read-failed", description: `Failed to stat: ${target}` }),
			),
		);
		if (!isFile) {
			return yield* new ReadError({
				path: target,
				reason: "not-a-file",
				description: `Path is not a regular file: ${target}`,
			});
		}

		const raw = yield* ops.readTextFile(target).pipe(
			Effect.mapError(
				() =>
					new ReadError({
						path: target,
						reason: "read-failed",
						description: `Failed to read file: ${target}`,
					}),
			),
		);

		const sliced = sliceLines(raw, params.offset, params.limit);
		return {
			path: target,
			...sliced,
		} satisfies typeof ReadResult.Type;
	});
