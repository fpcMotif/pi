/**
 * Shared typed `Effect.try` boundary for the filesystem-backed `*OperationsLive`
 * Layers (ADR-0010). Every synchronous `node:fs` call goes through `tryFs`,
 * which normalizes whatever was thrown into a typed `FsError` — so the
 * `*Operations` Service contracts carry one schema-backed error instead of
 * leaking `as NodeJS.ErrnoException` casts.
 */
import { Effect, Schema } from "effect";

/**
 * A failed filesystem operation: normalized `message`, the errno `code` when
 * the throw carried one, and the original thrown value as `cause`.
 */
export class FsError extends Schema.TaggedErrorClass<FsError>()("FsError", {
	code: Schema.optional(Schema.String),
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

/** Run a synchronous fs thunk, normalizing any throw into a typed `FsError`. */
export const tryFs = <A>(thunk: () => A): Effect.Effect<A, FsError> =>
	Effect.try({
		try: thunk,
		catch: (e) => {
			const code = (e as NodeJS.ErrnoException).code;
			return new FsError({
				code: typeof code === "string" ? code : undefined,
				message: e instanceof Error ? e.message : String(e),
				cause: e,
			});
		},
	});
