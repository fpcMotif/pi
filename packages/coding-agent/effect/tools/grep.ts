/**
 * The `grep` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports. The Effect handler does
 * its IO through `GrepOperations` from context: `isDirectory` (search-root
 * classification), `readFile` (context-line assembly), and `search` (the
 * ripgrep subprocess itself). Putting the subprocess behind the Service is the
 * ADR-0010 pluggable-backend pattern — `GrepOperationsLive` shells out to a
 * local `rg`, while SSH / in-memory / sandbox backends swap a different Layer.
 *
 * Everything the handler does once it has raw matches — relativising paths,
 * assembling before/after context blocks, truncating long lines and oversized
 * output, building the truncation/limit notices — is pure and exercised by the
 * tracer-bullet tests against stub Layers, no real `rg` binary required.
 *
 * Deferred (follow-on slices, mirroring how `read` deferred image handling):
 * downloading `rg` on demand when it is absent from `PATH` (the legacy
 * `ensureTool("rg", true)` behaviour) — `GrepOperationsLive` currently fails
 * with `GrepError(ripgrep-unavailable)` instead.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { createInterface } from "node:readline";

import { Tool, Toolkit } from "effect/unstable/ai";

import { resolvePath } from "./path-resolution.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.js";

const DEFAULT_LIMIT = 100;

/** A single ripgrep hit, as surfaced by `GrepOperations.search`. */
export interface RawGrepMatch {
	/** Absolute path of the file the match was found in. */
	readonly filePath: string;
	/** 1-indexed line number of the match. */
	readonly lineNumber: number;
	/** The raw matched line text (may carry a trailing newline); `undefined` if ripgrep omitted it. */
	readonly lineText: string | undefined;
}

/** Resolved request handed to `GrepOperations.search` — all defaults already applied. */
export interface GrepSearchRequest {
	readonly pattern: string;
	readonly searchPath: string;
	readonly glob: string | undefined;
	readonly ignoreCase: boolean;
	readonly literal: boolean;
	/** Hard cap on returned matches; the Service stops ripgrep once it is hit. */
	readonly limit: number;
}

/** Result of a `GrepOperations.search` — matches plus whether the `limit` cap was hit. */
export interface GrepSearchOutcome {
	readonly matches: ReadonlyArray<RawGrepMatch>;
	readonly limitReached: boolean;
}

/**
 * Every way grep can fail, as a closed `reason` union:
 * - `path-not-found` — the search path could not be stat-ed.
 * - `ripgrep-unavailable` — no `rg` binary on `PATH`.
 * - `ripgrep-failed` — ripgrep spawned but exited abnormally.
 */
export class GrepError extends Schema.TaggedErrorClass<GrepError>()("GrepError", {
	reason: Schema.Literals(["path-not-found", "ripgrep-unavailable", "ripgrep-failed"]),
	description: Schema.String,
}) {}

/**
 * Service for the IO operations `grep` needs. The default `Live` Layer reads
 * the local filesystem and shells out to `rg`; tests provide a stub Layer with
 * canned matches and deterministic file contents.
 */
export class GrepOperations extends Context.Service<
	GrepOperations,
	{
		readonly isDirectory: (absolutePath: string) => Effect.Effect<boolean, NodeJS.ErrnoException>;
		readonly readFile: (absolutePath: string) => Effect.Effect<string, NodeJS.ErrnoException>;
		readonly search: (request: GrepSearchRequest) => Effect.Effect<GrepSearchOutcome, GrepError>;
	}
>()("pi-coding-agent/GrepOperations") {}

/** ripgrep `--json` "match" event shape, decoded defensively from each stdout line. */
const RgMatchEvent = Schema.Struct({
	type: Schema.Literal("match"),
	data: Schema.Struct({
		path: Schema.Struct({ text: Schema.String }),
		line_number: Schema.Number,
		lines: Schema.optional(Schema.Struct({ text: Schema.String })),
	}),
});
const decodeRgMatch = Schema.decodeUnknownOption(RgMatchEvent);

/** Run the local `rg` binary and collect up to `request.limit` matches. */
const runRipgrep = (request: GrepSearchRequest): Effect.Effect<GrepSearchOutcome, GrepError> =>
	Effect.callback<GrepSearchOutcome, GrepError>((resume) => {
		const args = ["--json", "--line-number", "--color=never", "--hidden"];
		if (request.ignoreCase) args.push("--ignore-case");
		if (request.literal) args.push("--fixed-strings");
		if (request.glob !== undefined) args.push("--glob", request.glob);
		args.push("--", request.pattern, request.searchPath);

		const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const matches: Array<RawGrepMatch> = [];
		let stderr = "";
		let limitReached = false;
		let killedDueToLimit = false;

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			if (line.trim() === "" || matches.length >= request.limit) return;
			const decoded = decodeRgMatch(JSON.parse(line));
			if (decoded._tag === "None") return;
			const { data } = decoded.value;
			matches.push({
				filePath: data.path.text,
				lineNumber: data.line_number,
				lineText: data.lines?.text,
			});
			if (matches.length >= request.limit) {
				limitReached = true;
				killedDueToLimit = true;
				if (!child.killed) child.kill();
			}
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			rl.close();
			resume(
				Effect.fail(
					new GrepError({
						reason: error.code === "ENOENT" ? "ripgrep-unavailable" : "ripgrep-failed",
						description: `Failed to run ripgrep: ${error.message}`,
					}),
				),
			);
		});

		child.on("close", (code) => {
			rl.close();
			if (!killedDueToLimit && code !== 0 && code !== 1) {
				resume(
					Effect.fail(
						new GrepError({
							reason: "ripgrep-failed",
							description: stderr.trim() === "" ? `ripgrep exited with code ${code}` : stderr.trim(),
						}),
					),
				);
				return;
			}
			resume(Effect.succeed({ matches, limitReached }));
		});

		return Effect.sync(() => {
			if (!child.killed) child.kill();
		});
	});

/** Default `GrepOperations` Layer: local Node filesystem + the `rg` binary on `PATH`. */
export const GrepOperationsLive: Layer.Layer<GrepOperations> = Layer.succeed(
	GrepOperations,
	GrepOperations.of({
		isDirectory: (p) =>
			Effect.try({
				try: () => statSync(p).isDirectory(),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
		readFile: (p) =>
			Effect.try({
				try: () => readFileSync(p, "utf-8"),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
		search: runRipgrep,
	}),
);

const GrepParameters = Schema.Struct({
	pattern: Schema.String,
	path: Schema.optional(Schema.String),
	glob: Schema.optional(Schema.String),
	ignoreCase: Schema.optional(Schema.Boolean),
	literal: Schema.optional(Schema.Boolean),
	context: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
});

const GrepResult = Schema.Struct({
	/** Number of matches returned (subject to `limit`). 0 means no matches. */
	matchCount: Schema.Number,
	/** Formatted match output: `relpath:line: text` rows, plus context rows and a trailing notice block. */
	output: Schema.String,
	/** The applied match limit, set only when ripgrep was stopped because it was hit. */
	matchLimitReached: Schema.optional(Schema.Number),
	/** True when the formatted output exceeded the byte budget and was head-truncated. */
	bytesTruncated: Schema.Boolean,
	/** True when at least one match/context line was longer than `GREP_MAX_LINE_LENGTH` and was clipped. */
	linesTruncated: Schema.Boolean,
});

export const Grep = Tool.make("Grep", {
	description:
		`Search file contents for a pattern. Returns matching lines with file paths and line numbers. ` +
		`Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB ` +
		`(whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
	parameters: GrepParameters,
	success: GrepResult,
	failure: GrepError,
	// The handler reads its IO Service from context; declaring it here threads
	// `GrepOperations` into the toolkit handler's allowed requirements (ADR-0010).
	dependencies: [GrepOperations],
});

export const GrepToolkit = Toolkit.make(Grep);

/** Relativise a hit's path against the search root (dir search) or fall back to its basename (file search). */
const formatPath = (isDirectory: boolean, searchPath: string, filePath: string): string => {
	if (isDirectory) {
		const relative = nodePath.relative(searchPath, filePath);
		if (relative !== "" && !relative.startsWith("..")) {
			return relative.split(nodePath.sep).join("/");
		}
	}
	return nodePath.basename(filePath);
};

/** Split file content into LF-normalised lines for context-block rendering. */
const toLines = (content: string): ReadonlyArray<string> =>
	content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

/**
 * Build the `Grep` handler bound to a specific `cwd`. The handler resolves the
 * search path, classifies it via `GrepOperations.isDirectory`, runs the search,
 * then formats + truncates the matches purely.
 */
export const grepHandler = (cwd: string) =>
	Effect.fn("grep")(function* (params: typeof GrepParameters.Type) {
		const searchPath = resolvePath(cwd, params.path);
		const ops = yield* GrepOperations;

		const isDirectory = yield* ops
			.isDirectory(searchPath)
			.pipe(
				Effect.mapError(
					() => new GrepError({ reason: "path-not-found", description: `Path not found: ${searchPath}` }),
				),
			);

		const contextValue = params.context !== undefined && params.context > 0 ? params.context : 0;
		const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_LIMIT);

		const { matches, limitReached } = yield* ops.search({
			pattern: params.pattern,
			searchPath,
			glob: params.glob,
			ignoreCase: params.ignoreCase ?? false,
			literal: params.literal ?? false,
			limit: effectiveLimit,
		});

		if (matches.length === 0) {
			return {
				matchCount: 0,
				output: "No matches found",
				matchLimitReached: limitReached ? effectiveLimit : undefined,
				bytesTruncated: false,
				linesTruncated: false,
			} satisfies typeof GrepResult.Type;
		}

		// A match needs the file read when we want context lines, or when ripgrep
		// did not hand us the matched line text inline.
		const filesToRead = new Set<string>();
		for (const match of matches) {
			if (contextValue > 0 || match.lineText === undefined) filesToRead.add(match.filePath);
		}
		const fileCache = new Map<string, ReadonlyArray<string>>();
		yield* Effect.forEach(filesToRead, (filePath) =>
			ops.readFile(filePath).pipe(
				Effect.map((content) => {
					fileCache.set(filePath, toLines(content));
				}),
				// Unreadable files degrade to an empty cache entry, mirroring the legacy
				// tool's "(unable to read file)" fallback rather than failing the search.
				Effect.catch(() =>
					Effect.sync(() => {
						fileCache.set(filePath, []);
					}),
				),
			),
		);

		let linesTruncated = false;
		const clip = (text: string): string => {
			const { text: clipped, wasTruncated } = truncateLine(text);
			if (wasTruncated) linesTruncated = true;
			return clipped;
		};

		const outputLines: Array<string> = [];
		for (const match of matches) {
			const relativePath = formatPath(isDirectory, searchPath, match.filePath);
			if (contextValue === 0 && match.lineText !== undefined) {
				const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
				outputLines.push(`${relativePath}:${match.lineNumber}: ${clip(sanitized)}`);
				continue;
			}
			const lines = fileCache.get(match.filePath) ?? [];
			if (lines.length === 0) {
				outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
				continue;
			}
			const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
			const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
			for (let current = start; current <= end; current++) {
				const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
				const clipped = clip(sanitized);
				outputLines.push(
					current === match.lineNumber
						? `${relativePath}:${current}: ${clipped}`
						: `${relativePath}-${current}- ${clipped}`,
				);
			}
		}

		const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		const notices: Array<string> = [];
		if (limitReached) {
			notices.push(
				`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
			);
		}
		if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		if (linesTruncated) {
			notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		}
		const output = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;

		return {
			matchCount: matches.length,
			output,
			matchLimitReached: limitReached ? effectiveLimit : undefined,
			bytesTruncated: truncation.truncated,
			linesTruncated,
		} satisfies typeof GrepResult.Type;
	});
