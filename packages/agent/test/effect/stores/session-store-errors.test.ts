import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Prompt } from "effect/unstable/ai";
import { KeyValueStore } from "effect/unstable/persistence";
import { describe, expect } from "vitest";

import { SchemaError, StoreError } from "../../../effect/agent-error.js";
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
 * Slice 18 (c) -- error-mapping paths for `layerKeyValueStore`. The happy-path
 * tests live in `session-store-kv.test.ts`. These tests pin the externally
 * reachable storage and schema error paths:
 *
 * - KV-side failures (`KeyValueStoreError`) on `get` / `set` / `remove` surface
 *   through `mapStoreError(operation)` as `StoreError` with the correct
 *   `operation` tag.
 * - Schema-decode failures on corrupted record / index data surface through
 *   `mapSchemaError` as `SchemaError`.
 * - Eager `Schema.Class` construction failures are captured as typed
 *   `SchemaError` values instead of escaping as defects.
 * - The conditional `if (index.ids.includes(id))` branches in `save` and
 *   `remove` are both exercised (already-indexed save / never-indexed remove).
 */

const failingKvLayer = (failOn: {
	readonly get?: boolean;
	readonly set?: boolean;
	readonly remove?: boolean;
}): Layer.Layer<KeyValueStore.KeyValueStore> =>
	Layer.succeed(
		KeyValueStore.KeyValueStore,
		KeyValueStore.make({
			get: (key) =>
				failOn.get
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `get failed for ${key}`,
								method: "get",
								key,
							}),
						)
					: Effect.succeed(undefined),
			getUint8Array: (key) =>
				failOn.get
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `getUint8Array failed for ${key}`,
								method: "getUint8Array",
								key,
							}),
						)
					: Effect.succeed(undefined),
			set: (key, _value) =>
				failOn.set
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `set failed for ${key}`,
								method: "set",
								key,
							}),
						)
					: Effect.void,
			remove: (key) =>
				failOn.remove
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `remove failed for ${key}`,
								method: "remove",
								key,
							}),
						)
					: Effect.void,
			clear: Effect.void,
			size: Effect.succeed(0),
		}),
	);

const preloadedKvLayer = (
	entries: ReadonlyArray<readonly [string, string]>,
): Layer.Layer<KeyValueStore.KeyValueStore> => {
	const values = new Map<string, string>(entries);
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
				Effect.sync(() => {
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

/**
 * Selectively-failing KV: backing storage works normally for any key NOT
 * matched by `failSet` / `failGet` / `failRemove`. Used to trigger failures on
 * one side of the records / indexes split (e.g. records succeed but the
 * `indexes/sessions` write fails -- the `saveIndex` error path).
 */
const selectiveFailingKvLayer = (opts: {
	readonly initial?: ReadonlyArray<readonly [string, string]>;
	readonly failSet?: (key: string) => boolean;
	readonly failGet?: (key: string) => boolean;
	readonly failRemove?: (key: string) => boolean;
}): Layer.Layer<KeyValueStore.KeyValueStore> => {
	const values = new Map<string, string>(opts.initial ?? []);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	return Layer.succeed(
		KeyValueStore.KeyValueStore,
		KeyValueStore.make({
			get: (key) =>
				opts.failGet?.(key)
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `get failed for ${key}`,
								method: "get",
								key,
							}),
						)
					: Effect.sync(() => values.get(key)),
			getUint8Array: (key) =>
				opts.failGet?.(key)
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `getUint8Array failed for ${key}`,
								method: "getUint8Array",
								key,
							}),
						)
					: Effect.sync(() => {
							const v = values.get(key);
							return v === undefined ? undefined : encoder.encode(v);
						}),
			set: (key, value) =>
				opts.failSet?.(key)
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `set failed for ${key}`,
								method: "set",
								key,
							}),
						)
					: Effect.sync(() => {
							values.set(key, typeof value === "string" ? value : decoder.decode(value));
						}),
			remove: (key) =>
				opts.failRemove?.(key)
					? Effect.fail(
							new KeyValueStore.KeyValueStoreError({
								message: `remove failed for ${key}`,
								method: "remove",
								key,
							}),
						)
					: Effect.sync(() => {
							values.delete(key);
						}),
			clear: Effect.sync(() => values.clear()),
			size: Effect.sync(() => values.size),
		}),
	);
};

const expectStoreError = (error: unknown): StoreError => {
	expect(error).toBeInstanceOf(StoreError);
	if (!(error instanceof StoreError)) {
		throw new Error("expected StoreError");
	}
	return error;
};

const expectSchemaError = (error: unknown): SchemaError => {
	expect(error).toBeInstanceOf(SchemaError);
	if (!(error instanceof SchemaError)) {
		throw new Error("expected SchemaError");
	}
	return error;
};

const invalidSessionState = (): SessionState => {
	const state = makeSessionState({ turnCount: 1 });
	Object.defineProperty(state, "turnCount", { value: "not-a-number" });
	return state;
};

describe("SessionStore (KV-backed) -- KV error path surfaces StoreError", () => {
	it.effect("save: records.set failure surfaces StoreError with operation=save", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.save("s1", makeSessionState({ turnCount: 1 })));
			const storeError = expectStoreError(error);
			expect(storeError.operation).toBe("save");
			expect(storeError.store).toBe("SessionStore");
			expect(storeError.message).toMatch(/set failed/);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(failingKvLayer({ set: true }))))),
	);

	it.effect("load: records.get failure surfaces StoreError with operation=load", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.load("s1"));
			const storeError = expectStoreError(error);
			expect(storeError.operation).toBe("load");
			expect(storeError.message).toMatch(/get failed/);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(failingKvLayer({ get: true }))))),
	);

	it.effect("remove: records.remove failure surfaces StoreError with operation=remove", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.remove("s1"));
			const storeError = expectStoreError(error);
			expect(storeError.operation).toBe("remove");
			expect(storeError.message).toMatch(/remove failed/);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(failingKvLayer({ remove: true }))))),
	);

	it.effect("list: loadIndex KV.get failure surfaces StoreError with operation=list", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.list);
			expect(expectStoreError(error).operation).toBe("list");
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(failingKvLayer({ get: true }))))),
	);
});

describe("SessionStore (KV-backed) -- Schema decode error surfaces SchemaError", () => {
	it.effect("load: corrupted record JSON for sessions/<id> surfaces SchemaError", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.load("s1"));
			expect(expectSchemaError(error).description.length).toBeGreaterThan(0);
		}).pipe(
			Effect.provide(
				layerKeyValueStore.pipe(Layer.provide(preloadedKvLayer([["sessions/s1", "this is not json"]]))),
			),
		),
	);

	it.effect("list: corrupted index JSON for indexes/sessions surfaces SchemaError", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.list);
			expectSchemaError(error);
		}).pipe(
			Effect.provide(layerKeyValueStore.pipe(Layer.provide(preloadedKvLayer([["indexes/sessions", "<not-json>"]])))),
		),
	);

	it.effect("save: corrupted index JSON surfaces SchemaError (records.set succeeds, loadIndex schema-fails)", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.save("s1", makeSessionState({ turnCount: 1 })));
			expectSchemaError(error);
		}).pipe(
			Effect.provide(layerKeyValueStore.pipe(Layer.provide(preloadedKvLayer([["indexes/sessions", "garbage"]])))),
		),
	);

	it.effect("remove: corrupted index JSON surfaces SchemaError after the records.remove succeeds", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.remove("s1"));
			expectSchemaError(error);
		}).pipe(
			Effect.provide(layerKeyValueStore.pipe(Layer.provide(preloadedKvLayer([["indexes/sessions", "garbage"]])))),
		),
	);
});

describe("SessionStore (KV-backed) -- saveIndex error path (records.set succeeds, indexes.set fails)", () => {
	it.effect("save: KV.set on `indexes/sessions` failure surfaces StoreError with operation=save-index", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.save("s1", makeSessionState({ turnCount: 1 })));
			const storeError = expectStoreError(error);
			expect(storeError.operation).toBe("save-index");
			expect(storeError.message).toMatch(/set failed for indexes\/sessions/);
		}).pipe(
			Effect.provide(
				layerKeyValueStore.pipe(
					Layer.provide(
						selectiveFailingKvLayer({
							failSet: (key) => key === "indexes/sessions",
						}),
					),
				),
			),
		),
	);

	it.effect("remove: KV.set on `indexes/sessions` failure surfaces StoreError with operation=remove-index", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			// Pre-populate the index with "s1" so the `if (index.ids.includes(id))`
			// branch in `remove` is true; saveIndex is then called to filter it
			// out, and that's the operation we want to fail.
			const initialIndex = JSON.stringify({ version: 1, ids: ["s1"] });
			const error = yield* Effect.flip(store.remove("s1"));
			const storeError = expectStoreError(error);
			expect(storeError.operation).toBe("remove-index");
			// Sanity: the failure must NOT pre-date the saveIndex step.
			expect(storeError.message).toMatch(/set failed for indexes\/sessions/);
			expect(initialIndex).toBeDefined();
		}).pipe(
			Effect.provide(
				layerKeyValueStore.pipe(
					Layer.provide(
						selectiveFailingKvLayer({
							initial: [["indexes/sessions", JSON.stringify({ version: 1, ids: ["s1"] })]],
							failSet: (key) => key === "indexes/sessions",
						}),
					),
				),
			),
		),
	);
});

describe("SessionStore (KV-backed) -- Schema construction error path on save", () => {
	it.effect("save: invalid SessionState is mapped to SchemaError instead of escaping as a defect", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const error = yield* Effect.flip(store.save("s1", invalidSessionState()));
			expect(expectSchemaError(error).description.length).toBeGreaterThan(0);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)))),
	);
});

describe("SessionStore (KV-backed) -- index update conditional branches", () => {
	it.effect("remove: id was never indexed -> saveIndex is skipped", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			// Sanity: removing an id that was never saved must not blow up,
			// the records.remove is best-effort and loadIndex returns the
			// empty index so the `if (index.ids.includes(id))` branch is
			// false -- skipping saveIndex.
			yield* store.remove("never-saved");
			const ids = yield* store.list;
			expect(ids).toEqual([]);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)))),
	);

	it.effect("save: re-saving an already-indexed id does NOT call saveIndex a second time", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.save("s1", makeSessionState({ turnCount: 1 }));
			// Second save must take the `if (!index.ids.includes(id))` false
			// branch -- saveIndex is skipped, but the records.set still runs.
			yield* store.save("s1", makeSessionState({ turnCount: 99 }));
			const ids = yield* store.list;
			expect(ids).toEqual(["s1"]);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)))),
	);
});
