/**
 * The `write` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports. The Effect handler
 * writes via `WriteOperations` from context so the default Layer can write
 * to the local filesystem and tests / SSH / sandbox backends can swap a
 * different Layer.
 *
 * Parent directories are created recursively (via `mkdirRecursive`) before
 * the file is written, matching the legacy `write` tool's behaviour. The
 * write itself is atomic at the Effect level (the underlying `writeFile`
 * call is the sole IO step after directory creation).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Service for the IO operations `write` needs. Default `Live` writes to the
 * local Node filesystem; tests provide a stub `Layer` recording invocations.
 */
export class WriteOperations extends Context.Service<
	WriteOperations,
	{
		readonly mkdirRecursive: (absoluteDir: string) => Effect.Effect<void, NodeJS.ErrnoException>;
		readonly writeTextFile: (
			absolutePath: string,
			content: string,
		) => Effect.Effect<void, NodeJS.ErrnoException>;
	}
>()("pi-coding-agent/WriteOperations") {}

export const WriteOperationsLive: Layer.Layer<WriteOperations> = Layer.succeed(
	WriteOperations,
	WriteOperations.of({
		mkdirRecursive: (dir) =>
			Effect.try({
				try: () => {
					mkdirSync(dir, { recursive: true });
				},
				catch: (e) => e as NodeJS.ErrnoException,
			}),
		writeTextFile: (p, content) =>
			Effect.try({
				try: () => writeFileSync(p, content, "utf-8"),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
	}),
);

const WriteParameters = Schema.Struct({
	path: Schema.String,
	content: Schema.String,
});

const WriteResult = Schema.Struct({
	/** Absolute path that was written. */
	path: Schema.String,
	/** Byte count of the UTF-8-encoded content written. */
	bytesWritten: Schema.Number,
});

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("WriteError", {
	path: Schema.String,
	reason: Schema.Literals(["mkdir-failed", "write-failed"]),
	description: Schema.String,
}) {}

export const Write = Tool.make("Write", {
	description:
		"Write text content to a file. Creates parent directories as needed. Overwrites any existing file at the path.",
	parameters: WriteParameters,
	success: WriteResult,
	failure: WriteError,
});

export const WriteToolkit = Toolkit.make(Write);

const resolvePath = (cwd: string, input: string): string =>
	nodePath.isAbsolute(input) ? input : nodePath.resolve(cwd, input);

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, "utf-8");

/**
 * Build the `Write` handler bound to a specific `cwd`. The handler writes
 * via `WriteOperations` from context, so test Layers can capture invocations.
 */
export const writeHandler = (cwd: string) =>
	Effect.fn("write")(function* (params: typeof WriteParameters.Type) {
		const ops = yield* WriteOperations;
		const target = resolvePath(cwd, params.path);
		const parentDir = nodePath.dirname(target);

		yield* ops.mkdirRecursive(parentDir).pipe(
			Effect.mapError(
				(e) =>
					new WriteError({
						path: target,
						reason: "mkdir-failed",
						description: `Failed to create parent directory ${parentDir}: ${e.message ?? "unknown"}`,
					}),
			),
		);

		yield* ops.writeTextFile(target, params.content).pipe(
			Effect.mapError(
				(e) =>
					new WriteError({
						path: target,
						reason: "write-failed",
						description: `Failed to write file ${target}: ${e.message ?? "unknown"}`,
					}),
			),
		);

		return {
			path: target,
			bytesWritten: utf8ByteLength(params.content),
		} satisfies typeof WriteResult.Type;
	});
