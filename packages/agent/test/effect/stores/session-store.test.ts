import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";

import { SessionState } from "../../../effect/session-state.js";
import { MemoryLayer, SessionStore } from "../../../effect/stores/session-store.js";

/**
 * Slice 18 — first durable-state Service per ADR-0012 (`SessionStore`).
 *
 * The contract under test:
 *
 *   - `save(id, state)` durably associates `id` with `state` inside the
 *     resolved Layer's scope.
 *   - `load(id)` returns `Some(state)` after a save, `None` for missing ids.
 *   - `list` returns every id that has been saved, in insertion order is not
 *     guaranteed -- only set-equality is.
 *   - Calls cross Effect.gen boundaries: the Service is held by `Layer`-scoped
 *     state (a Ref<HashMap>), not by closure capture, so successive yields
 *     see prior writes.
 *
 * The Layer under test is `MemoryLayer` (the `TestStores` fixture per
 * ADR-0015). The on-disk Layer's tests reuse this same describe block once
 * it lands.
 */
describe("SessionStore (memory layer)", () => {
	it.effect("save then load round-trips the SessionState by id", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const state = new SessionState({ turnCount: 7 });

			yield* store.save("session-a", state);
			const loaded = yield* store.load("session-a");

			expect(Option.isSome(loaded)).toBe(true);
			const value = Option.getOrThrow(loaded);
			expect(value.turnCount).toBe(7);
		}).pipe(Effect.provide(MemoryLayer)),
	);

	it.effect("load on an unknown id returns None", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			const loaded = yield* store.load("never-saved");
			expect(Option.isNone(loaded)).toBe(true);
		}).pipe(Effect.provide(MemoryLayer)),
	);

	it.effect("list returns every saved id (set-equality)", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.save("s1", new SessionState({ turnCount: 1 }));
			yield* store.save("s2", new SessionState({ turnCount: 2 }));
			yield* store.save("s3", new SessionState({ turnCount: 3 }));

			const ids = yield* store.list;
			expect(new Set(ids)).toEqual(new Set(["s1", "s2", "s3"]));
		}).pipe(Effect.provide(MemoryLayer)),
	);

	it.effect("save overwrites the prior value for the same id", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.save("s1", new SessionState({ turnCount: 1 }));
			yield* store.save("s1", new SessionState({ turnCount: 42 }));

			const loaded = yield* store.load("s1");
			expect(Option.getOrThrow(loaded).turnCount).toBe(42);
		}).pipe(Effect.provide(MemoryLayer)),
	);

	it.effect("remove deletes the saved state and removes the id from list", () =>
		Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.save("s1", new SessionState({ turnCount: 1 }));
			yield* store.remove("s1");

			const loaded = yield* store.load("s1");
			const ids = yield* store.list;
			expect(Option.isNone(loaded)).toBe(true);
			expect(ids).toEqual([]);
		}).pipe(Effect.provide(MemoryLayer)),
	);

	it.effect("two separate resolutions of MemoryLayer do NOT share state", () =>
		Effect.gen(function* () {
			// Two sub-programs run with independent Layer resolutions; the
			// second must NOT see the first's writes. This proves per-test
			// isolation is automatic (no global state, no shared map).
			const firstIds = yield* Effect.gen(function* () {
				const s = yield* SessionStore;
				yield* s.save("a", new SessionState({ turnCount: 1 }));
				return yield* s.list;
			}).pipe(Effect.provide(MemoryLayer));

			const secondIds = yield* Effect.gen(function* () {
				const s = yield* SessionStore;
				return yield* s.list;
			}).pipe(Effect.provide(MemoryLayer));

			expect(firstIds).toEqual(["a"]);
			expect(secondIds).toEqual([]);
		}),
	);
});
