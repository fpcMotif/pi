import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { Prompt } from "effect/unstable/ai";
import { KeyValueStore } from "effect/unstable/persistence";
import { describe, expect } from "vitest";

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

const makeSharedKeyValueStoreLayer = (): Layer.Layer<KeyValueStore.KeyValueStore> => {
	const values = new Map<string, string | Uint8Array>();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	const kv = KeyValueStore.make({
		get: (key) =>
			Effect.sync(() => {
				const value = values.get(key);
				if (value === undefined) return undefined;
				return typeof value === "string" ? value : decoder.decode(value);
			}),
		getUint8Array: (key) =>
			Effect.sync(() => {
				const value = values.get(key);
				if (value === undefined) return undefined;
				return typeof value === "string" ? encoder.encode(value) : value;
			}),
		set: (key, value) =>
			Effect.sync(() => {
				values.set(key, value);
			}),
		remove: (key) =>
			Effect.sync(() => {
				values.delete(key);
			}),
		clear: Effect.sync(() => {
			values.clear();
		}),
		size: Effect.sync(() => values.size),
	});

	return Layer.succeed(KeyValueStore.KeyValueStore)(kv);
};

/**
 * Slice 18 (b) -- `layerKeyValueStore` production path. The KV-backed Layer
 * uses `SessionIndexV1` stored under the `indexes/` prefix to support `list`
 * on top of a pure key-value abstraction. These tests prove the index logic
 * stays consistent across save / remove and survives across a fresh resolution
 * of the SessionStore Layer (i.e. data is durable inside the shared
 * KeyValueStore).
 *
 * The "data survives" test supplies a single shared KeyValueStore instance to
 * two fresh `SessionStore` resolutions. That proves durability is delegated to
 * the KV boundary rather than held inside SessionStore's closure scope.
 */
describe("SessionStore (KV-backed layer with index)", () => {
	it.effect("save / load / list reflect the SessionIndexV1 side-key", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;

			yield* store.save("s1", makeSessionState({ turnCount: 1 }));
			yield* store.save("s2", makeSessionState({ turnCount: 2 }));

			const ids = yield* store.list;
			expect(new Set(ids)).toEqual(new Set(["s1", "s2"]));

			const loaded = yield* store.load("s1");
			expect(Option.getOrThrow(loaded).turnCount).toBe(1);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)))),
	);

	it.effect("remove updates the SessionIndexV1 side-key", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;

			yield* store.save("s1", makeSessionState({ turnCount: 1 }));
			yield* store.save("s2", makeSessionState({ turnCount: 2 }));
			yield* store.remove("s1");

			const ids = yield* store.list;
			expect(ids).toEqual(["s2"]);

			const removed = yield* store.load("s1");
			expect(Option.isNone(removed)).toBe(true);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)))),
	);

	it.effect("saving the same id twice does NOT duplicate the index entry", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;

			yield* store.save("s1", makeSessionState({ turnCount: 1 }));
			yield* store.save("s1", makeSessionState({ turnCount: 2 }));
			yield* store.save("s1", makeSessionState({ turnCount: 3 }));

			const ids = yield* store.list;
			expect(ids).toEqual(["s1"]);

			const loaded = yield* store.load("s1");
			expect(Option.getOrThrow(loaded).turnCount).toBe(3);
		}).pipe(Effect.provide(layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)))),
	);

	it.effect("data survives across a fresh SessionStore resolution sharing the same KV", () =>
		Effect.gen(function* () {
			const sessionLayer = layerKeyValueStore.pipe(Layer.provide(makeSharedKeyValueStoreLayer()));

			yield* Effect.gen(function* () {
				const s = yield* SessionStore;
				yield* s.save("durable-1", makeSessionState({ turnCount: 5 }));
			}).pipe(Effect.provide(sessionLayer));

			const turnCount = yield* Effect.gen(function* () {
				const s = yield* SessionStore;
				const loaded = yield* s.load("durable-1");
				return Option.isSome(loaded) ? loaded.value.turnCount : -1;
			}).pipe(Effect.provide(sessionLayer));

			expect(turnCount).toBe(5);
		}),
	);
});
