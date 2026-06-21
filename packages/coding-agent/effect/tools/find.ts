/**
 * The `find` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports. The Effect handler does
 * its IO through `FindOperations` from context: `exists` (search-root preflight)
 * and `search` (the `fd` subprocess itself). Putting the subprocess behind the
 * Service is the ADR-0010 pluggable-backend pattern — `FindOperationsLive`
 * shells out to a local `fd`, while SSH / in-memory / sandbox backends swap a
 * different Layer (e.g. a glob-based backend for environments without `fd`).
 *
 * Once the handler has the raw paths, everything it does — relativising each
 * path against the search root, preserving directory trailing slashes,
 * POSIX-slashing, byte truncation, building the limit/truncation notices — is
 * pure and exercised by the tracer-bullet tests against stub Layers.
 *
 * Behaviour note vs. the legacy tool: the default `fd` path now does an
 * explicit `exists` preflight (the legacy tool only preflighted on the custom-
 * glob path and let `fd` fail implicitly otherwise) — a small consistency win,
 * surfacing a typed `FindError(path-not-found)` instead of an `fd` exit code.
 *
 * Deferred (follow-on slice): downloading `fd` on demand when it is absent from
 * `PATH` (the legacy `ensureTool("fd", true)` behaviour) — `FindOperationsLive`
 * currently fails with `FindError(fd-unavailable)` instead.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { existsSync } from "node:fs";
import nodePath from "node:path";

import { resolvePath } from "./path-resolution.js";
import { spawnCollect } from "./spawn-collect.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const DEFAULT_LIMIT = 1000;

/** Resolved request handed to `FindOperations.search` — defaults already applied. */
export interface FindSearchRequest {
	/** The raw glob pattern as the model supplied it (the Service applies any `fd` pattern fixups). */
	readonly pattern: string;
	readonly searchPath: string;
	/** Hard cap on returned paths; the Service passes it to `fd --max-results`. */
	readonly limit: number;
}

/** Result of a `FindOperations.search` — clean absolute paths plus whether the `limit` cap was hit. */
export interface FindSearchOutcome {
	/** Matched paths, trimmed and non-empty; directory results keep their trailing slash. */
	readonly paths: ReadonlyArray<string>;
	readonly limitReached: boolean;
}

/**
 * Every way find can fail, as a closed `reason` union:
 * - `path-not-found` — the search path does not exist.
 * - `fd-unavailable` — no `fd` binary on `PATH`.
 * - `fd-failed` — `fd` spawned but exited abnormally with no output.
 */
export class FindError extends Schema.TaggedErrorClass<FindError>()("FindError", {
	reason: Schema.Literals(["path-not-found", "fd-unavailable", "fd-failed"]),
	description: Schema.String,
}) {}

/**
 * Service for the IO operations `find` needs. The default `Live` Layer reads
 * the local filesystem and shells out to `fd`; tests provide a stub Layer with
 * canned paths.
 */
export class FindOperations extends Context.Service<
	FindOperations,
	{
		readonly exists: (absolutePath: string) => Effect.Effect<boolean>;
		readonly search: (request: FindSearchRequest) => Effect.Effect<FindSearchOutcome, FindError>;
	}
>()("pi-coding-agent/FindOperations") {}

/** Run the local `fd` binary and collect up to `request.limit` matching paths. */
const runFd = (request: FindSearchRequest): Effect.Effect<FindSearchOutcome, FindError> =>
	Effect.suspend(() => {
		const args = [
			"--glob",
			"--color=never",
			"--hidden",
			// --no-require-git makes fd apply hierarchical .gitignore semantics whether
			// or not the search path is inside a git repo.
			"--no-require-git",
			"--max-results",
			String(request.limit),
		];

		// fd --glob matches the basename unless --full-path is set; in --full-path
		// mode a path-containing pattern like 'src/**/*.spec.ts' needs a leading
		// '**/' to match anything.
		let effectivePattern = request.pattern;
		if (request.pattern.includes("/")) {
			args.push("--full-path");
			if (!request.pattern.startsWith("/") && !request.pattern.startsWith("**/") && request.pattern !== "**") {
				effectivePattern = `**/${request.pattern}`;
			}
		}
		args.push("--", effectivePattern, request.searchPath);

		const rawLines: Array<string> = [];
		return spawnCollect({
			command: "fd",
			args,
			mapSpawnError: (error, unavailable) =>
				new FindError({
					reason: unavailable ? "fd-unavailable" : "fd-failed",
					description: `Failed to run fd: ${error.message}`,
				}),
			onLine: (line) => {
				rawLines.push(line);
			},
		}).pipe(
			Effect.flatMap((outcome) => {
				const paths = rawLines.map((line) => line.replace(/\r$/, "").trim()).filter((line) => line !== "");
				// fd can exit non-zero on partial failures (e.g. permission denied) yet
				// still have found files — only treat a non-zero exit *with no output* as
				// a hard failure, matching the legacy tool.
				if (outcome.exitCode !== 0 && paths.length === 0) {
					return Effect.fail(
						new FindError({
							reason: "fd-failed",
							description:
								outcome.stderr.trim() === "" ? `fd exited with code ${outcome.exitCode}` : outcome.stderr.trim(),
						}),
					);
				}
				return Effect.succeed({ paths, limitReached: paths.length >= request.limit });
			}),
		);
	});

/** Default `FindOperations` Layer: local Node filesystem + the `fd` binary on `PATH`. */
export const FindOperationsLive: Layer.Layer<FindOperations> = Layer.succeed(
	FindOperations,
	FindOperations.of({
		exists: (p) => Effect.sync(() => existsSync(p)),
		search: runFd,
	}),
);

const FindParameters = Schema.Struct({
	pattern: Schema.String,
	path: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});

const FindResult = Schema.Struct({
	/** Number of paths returned (subject to `limit`). 0 means no matches. */
	resultCount: Schema.Number,
	/** Newline-joined relative paths, plus a trailing notice block when limits were hit. */
	output: Schema.String,
	/** The applied result limit, set only when `fd` hit `--max-results`. */
	resultLimitReached: Schema.optional(Schema.Number),
	/** True when the formatted output exceeded the byte budget and was head-truncated. */
	bytesTruncated: Schema.Boolean,
});

export const Find = Tool.make("Find", {
	description:
		`Search for files by glob pattern. Returns matching file paths relative to the search directory. ` +
		`Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB ` +
		`(whichever is hit first).`,
	parameters: FindParameters,
	success: FindResult,
	failure: FindError,
	// The handler reads its IO Service from context; declaring it here threads
	// `FindOperations` into the toolkit handler's allowed requirements (ADR-0010).
	dependencies: [FindOperations],
});

export const FindToolkit = Toolkit.make(Find);

const toPosixPath = (value: string): string => value.split(nodePath.sep).join("/");

/**
 * Relativise an absolute `fd` path against the search root. A path that does
 * not sit under the root falls back to `path.relative`. Directory results keep
 * their trailing slash.
 */
const relativizeAgainst = (searchPath: string, line: string): string => {
	const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
	let relative = line.startsWith(searchPath) ? line.slice(searchPath.length + 1) : nodePath.relative(searchPath, line);
	if (hadTrailingSlash && !relative.endsWith("/")) relative += "/";
	return toPosixPath(relative);
};

/**
 * Build the `Find` handler bound to a specific `cwd`. The handler resolves the
 * search path, preflights it via `FindOperations.exists`, runs the search, then
 * relativises + truncates the results purely.
 */
export const findHandler = (cwd: string) =>
	Effect.fn("find")(function* (params: typeof FindParameters.Type) {
		const searchPath = resolvePath(cwd, params.path);
		const ops = yield* FindOperations;

		const exists = yield* ops.exists(searchPath);
		if (!exists) {
			return yield* new FindError({ reason: "path-not-found", description: `Path not found: ${searchPath}` });
		}

		const effectiveLimit = params.limit ?? DEFAULT_LIMIT;
		const { paths, limitReached } = yield* ops.search({
			pattern: params.pattern,
			searchPath,
			limit: effectiveLimit,
		});

		if (paths.length === 0) {
			return {
				resultCount: 0,
				output: "No files found matching pattern",
				resultLimitReached: undefined,
				bytesTruncated: false,
			} satisfies typeof FindResult.Type;
		}

		const relativized = paths.map((line) => relativizeAgainst(searchPath, line));
		const truncation = truncateHead(relativized.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });

		const notices: Array<string> = [];
		if (limitReached) {
			notices.push(
				`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
			);
		}
		if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		const output = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;

		return {
			resultCount: relativized.length,
			output,
			resultLimitReached: limitReached ? effectiveLimit : undefined,
			bytesTruncated: truncation.truncated,
		} satisfies typeof FindResult.Type;
	});
