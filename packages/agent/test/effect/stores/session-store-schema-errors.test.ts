import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Prompt } from "effect/unstable/ai";
import { KeyValueStore } from "effect/unstable/persistence";
import { describe, expect } from "vitest";

import { SchemaError } from "../../../effect/agent-error.js";
import { SessionState } from "../../../effect/session-state.js";
import { layerKeyValueStore, SessionStore } from "../../../effect/stores/session-store.js";

/**
 * Build a full `SessionState` from a partial spec. Fills the fields added in
 * later slices (`history`, `inputTokens`, `outputTokens`) with their empty
 * defaults so these store tests keep expressing fixtures as just a `turnCount`.
 */
const makeSessionState = (fields: { readonly turnCount: number }): SessionState =>
	new SessionState({
		turnCount: fields.turnCount,
		history: Prompt.empty,
		inputTokens: 0,
		outputTokens: 0,
		compactionCount: 0,
	});

/**
 * Slice 18 (d) -- defensive `Schema.isSchemaError(error)` true branches of
 * the inline error-mapping ternaries in `effect/stores/session-store.ts`.
 *
 * `records.set` and `indexes.set` are `toSchemaStore` wrappers whose error
 * channel is `KeyValueStoreError | Schema.SchemaError`. In practice the
 * `Schema.SchemaError` half is unreachable because the values we feed in
 * (`SessionRecordV1` / `SessionIndexV1`) are constructed via `Schema.Class`,
 * which validates eagerly. The runtime ternary nonetheless dispatches on the
 * error _tag because the type system retains the wider union.
 *
 * These tests force the dead branch alive by wiring a custom KV whose `set`
 * returns a real `Schema.SchemaError` value (synthesised at module load by
 * intentionally failing a decode). The wider `mapError` ternary then takes
 * the `mapSchemaError(error)` arm instead of `mapStoreError(...)`.
 */
const aRealSchemaError: Schema.SchemaError = Effect.runSync(
	Effect.flip(Schema.decodeUnknownEffect(Schema.Number)("not-a-number")),
);

const schemaErroringKvLayer = (
	failSet: (key: string) => boolean,
	initial: ReadonlyArray<readonly [string, string]> = [],
): Layer.Layer<KeyValueStore.KeyValueStore> => {
	const values = new Map<string, string>(initial);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	return Layer.succeed(
		KeyValueStore.KeyValueStore,
		KeyValueStore.make({
			get: (key) => Effect.sync(() => values.get(key)),
			getUint8Array: (key) =>
				Effect.sync(() => {
					const v = values.get(key);
					return v === undefined ? undefined : encoder.encode(v);
				}),
			set: (key, value) =>
				failSet(key)
					? // Type-cheat: KV.set's error channel is `KeyValueStoreError`,
						// but we return a `Schema.SchemaError`-shaped value so the
						// downstream `Schema.isSchemaError(error)` discriminator picks
						// the true branch.
						(Effect.fail(aRealSchemaError) as unknown as Effect.Effect<void, KeyValueStore.KeyValueStoreError>)
					: Effect.sync(() => {
							values.set(key, typeof value === "string" ? value : decoder.decode(value));
						}),
			remove: (key) =>
				Effect.sync(() => {
					values.delete(key);
				}),
			clear: Effect.sync(() => values.clear()),
			size: Effect.sync(() => values.size),
		}),
	);
};

describe("SessionStore (KV-backed) -- defensive Schema.isSchemaError branch on set", () => {
	it.effect("save: records.set returning Schema.SchemaError is mapped via mapSchemaError", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.save("s1", makeSessionState({ turnCount: 1 })));
			expect(error).toBeInstanceOf(SchemaError);
		}).pipe(
			Effect.provide(layerKeyValueStore.pipe(Layer.provide(schemaErroringKvLayer((k) => k === "sessions/s1")))),
		),
	);

	it.effect("save: indexes.set returning Schema.SchemaError is mapped via mapSchemaError", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.save("s1", makeSessionState({ turnCount: 1 })));
			expect(error).toBeInstanceOf(SchemaError);
		}).pipe(
			Effect.provide(layerKeyValueStore.pipe(Layer.provide(schemaErroringKvLayer((k) => k === "indexes/sessions")))),
		),
	);

	it.effect("remove: indexes.set returning Schema.SchemaError is mapped via mapSchemaError", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.remove("s1"));
			expect(error).toBeInstanceOf(SchemaError);
		}).pipe(
			Effect.provide(
				layerKeyValueStore.pipe(
					Layer.provide(
						schemaErroringKvLayer(
							(k) => k === "indexes/sessions",
							[["indexes/sessions", JSON.stringify({ version: 1, ids: ["s1"] })]],
						),
					),
				),
			),
		),
	);
});
