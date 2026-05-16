/**
 * The `edit` tool, ported to Effect v4 + `effect/unstable/ai` per ADR-0010.
 *
 * Pure schema-only `Tool.make` — no `pi-tui` imports. The Effect handler reads
 * and writes via `EditOperations` from context so the default Layer can touch
 * the local filesystem and tests / SSH / sandbox backends swap a different
 * Layer (the ADR-0010 pluggable-backends-as-Services pattern, mirroring
 * `ReadOperations` / `WriteOperations`).
 *
 * Edit semantics — exact-text replacement with fuzzy fallback, multi-edit
 * application, BOM + line-ending preservation, unified-diff rendering — live
 * in the pure `./edit-diff.ts` helpers. The handler is the IO + error-mapping
 * shell around them: every failure surfaces as a typed `EditError`, never an
 * untyped throw (ADR-0001).
 *
 * Result shape is a typed structured value (`path`, `editsApplied`, `diff`,
 * `firstChangedLine`) — interactive mode renders the diff in its own tool
 * renderer; the LLM-facing serialization comes from `Schema` encoding.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	EditApplyError,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";

/**
 * Service for the IO operations `edit` needs. Default `Live` implementation
 * reads/writes the local filesystem; tests provide a stub `Layer` with
 * deterministic responses and invocation recording.
 *
 * `readTextFile` returns the full file contents as a UTF-8 string (no BOM
 * stripping — the handler does that, so the round-trip can re-attach the BOM).
 */
export class EditOperations extends Context.Service<
	EditOperations,
	{
		readonly exists: (absolutePath: string) => Effect.Effect<boolean>;
		readonly readTextFile: (absolutePath: string) => Effect.Effect<string, NodeJS.ErrnoException>;
		readonly writeTextFile: (absolutePath: string, content: string) => Effect.Effect<void, NodeJS.ErrnoException>;
	}
>()("pi-coding-agent/EditOperations") {}

/** Default `EditOperations` Layer reading/writing the local Node filesystem. */
export const EditOperationsLive: Layer.Layer<EditOperations> = Layer.succeed(
	EditOperations,
	EditOperations.of({
		exists: (p) => Effect.sync(() => existsSync(p)),
		readTextFile: (p) =>
			Effect.try({
				try: () => readFileSync(p, "utf-8"),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
		writeTextFile: (p, content) =>
			Effect.try({
				try: () => writeFileSync(p, content, "utf-8"),
				catch: (e) => e as NodeJS.ErrnoException,
			}),
	}),
);

const EditReplacement = Schema.Struct({
	oldText: Schema.String,
	newText: Schema.String,
});

const EditParameters = Schema.Struct({
	path: Schema.String,
	edits: Schema.Array(EditReplacement),
});

const EditResult = Schema.Struct({
	/** Absolute path that was edited. */
	path: Schema.String,
	/** Number of replacement blocks applied (equals `edits.length` on success). */
	editsApplied: Schema.Number,
	/** Unified diff (with line numbers + context) of the change. */
	diff: Schema.String,
	/** 1-indexed line of the first change in the new file, for editor navigation. */
	firstChangedLine: Schema.optional(Schema.Number),
});

/**
 * Every way an edit can fail, as a closed `reason` union:
 * - `invalid-input` — the `edits` array was empty.
 * - `not-found` — the target path does not exist.
 * - `read-failed` / `write-failed` — the underlying IO rejected.
 * - `empty-old-text` / `no-match` / `ambiguous-match` / `overlapping-edits` /
 *   `no-change` — the replacement could not be applied as specified (from
 *   `EditApplyError`).
 * - `edit-failed` — an unexpected error while applying edits (defensive
 *   catch-all so an apply-step throw never escapes as an untyped defect).
 */
export class EditError extends Schema.TaggedErrorClass<EditError>()("EditError", {
	path: Schema.String,
	reason: Schema.Literals([
		"invalid-input",
		"not-found",
		"read-failed",
		"write-failed",
		"empty-old-text",
		"no-match",
		"ambiguous-match",
		"overlapping-edits",
		"no-change",
		"edit-failed",
	]),
	description: Schema.String,
}) {}

export const Edit = Tool.make("Edit", {
	description:
		"Edit a single file using exact-text replacement. Every edits[].oldText must match a unique, non-overlapping region of the file. Merge nearby changes into one edit rather than emitting overlapping edits.",
	parameters: EditParameters,
	success: EditResult,
	failure: EditError,
	// The handler reads its IO Service from context; declaring it here threads
	// `EditOperations` into the toolkit handler's allowed requirements (ADR-0010).
	dependencies: [EditOperations],
});

export const EditToolkit = Toolkit.make(Edit);

const resolvePath = (cwd: string, input: string): string =>
	nodePath.isAbsolute(input) ? input : nodePath.resolve(cwd, input);

/**
 * Build the `Edit` handler bound to a specific `cwd`. The handler reads and
 * writes via `EditOperations` from context, so test Layers can stub the
 * filesystem and record invocations.
 */
export const editHandler = (cwd: string) =>
	Effect.fn("edit")(function* (params: typeof EditParameters.Type) {
		const target = resolvePath(cwd, params.path);

		if (params.edits.length === 0) {
			return yield* new EditError({
				path: target,
				reason: "invalid-input",
				description: "Edit tool input is invalid: edits must contain at least one replacement.",
			});
		}

		const ops = yield* EditOperations;

		const exists = yield* ops.exists(target);
		if (!exists) {
			return yield* new EditError({
				path: target,
				reason: "not-found",
				description: `Path does not exist: ${target}`,
			});
		}

		const raw = yield* ops.readTextFile(target).pipe(
			Effect.mapError(
				(e) =>
					new EditError({
						path: target,
						reason: "read-failed",
						description: `Failed to read file ${target}: ${e.message ?? "unknown"}`,
					}),
			),
		);

		// BOM + line-ending handling: strip the BOM before matching (the model
		// never includes an invisible BOM in oldText), normalize to LF for the
		// match/apply pass, then re-attach the original ending + BOM on write.
		const { bom, text } = stripBom(raw);
		const originalEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		const applied = yield* Effect.try({
			try: () => applyEditsToNormalizedContent(normalized, params.edits, target),
			catch: (e) =>
				e instanceof EditApplyError
					? new EditError({ path: target, reason: e.reason, description: e.message })
					: new EditError({
							path: target,
							reason: "edit-failed",
							description: `Failed to apply edits to ${target}: ${e instanceof Error ? e.message : String(e)}`,
						}),
		});

		const finalContent = bom + restoreLineEndings(applied.newContent, originalEnding);

		yield* ops.writeTextFile(target, finalContent).pipe(
			Effect.mapError(
				(e) =>
					new EditError({
						path: target,
						reason: "write-failed",
						description: `Failed to write file ${target}: ${e.message ?? "unknown"}`,
					}),
			),
		);

		const { diff, firstChangedLine } = generateDiffString(applied.baseContent, applied.newContent);
		return {
			path: target,
			editsApplied: params.edits.length,
			diff,
			firstChangedLine,
		} satisfies typeof EditResult.Type;
	});
