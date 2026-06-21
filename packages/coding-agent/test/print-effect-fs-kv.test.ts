/**
 * File-backed KeyValueStore for the Effect print-mode host (ADR-0020
 * decision 7) — behaviour at the KeyValueStore interface over a temp dir,
 * including the SessionStore round trip through the parallel namespace.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerKeyValueStore, SessionState, SessionStore } from "@earendil-works/pi-agent-core/effect";
import { Effect, Layer, Option } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { layerFileSystemKeyValueStore } from "../src/modes/print-effect/fs-key-value-store.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-effect-kv-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const withKv = <A>(target: string, use: (kv: KeyValueStore.KeyValueStore) => Effect.Effect<A, unknown>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const kv = yield* KeyValueStore.KeyValueStore;
			return yield* use(kv);
		}).pipe(Effect.provide(layerFileSystemKeyValueStore(target))) as Effect.Effect<A>,
	);

describe("layerFileSystemKeyValueStore", () => {
	it("round-trips values, URI-encoding keys", async () => {
		const value = await withKv(dir, (kv) =>
			Effect.gen(function* () {
				yield* kv.set("sessions/abc", '{"v":1}');
				return yield* kv.get("sessions/abc");
			}),
		);
		expect(value).toBe('{"v":1}');
	});

	it("returns undefined for a missing key", async () => {
		const value = await withKv(dir, (kv) => kv.get("missing"));
		expect(value).toBeUndefined();
	});

	it("overwrites atomically and removes idempotently", async () => {
		const value = await withKv(dir, (kv) =>
			Effect.gen(function* () {
				yield* kv.set("k", "one");
				yield* kv.set("k", "two");
				const after = yield* kv.get("k");
				yield* kv.remove("k");
				yield* kv.remove("k");
				const gone = yield* kv.get("k");
				return { after, gone };
			}),
		);
		const result = value as { after: string | undefined; gone: string | undefined };
		expect(result.after).toBe("two");
		expect(result.gone).toBeUndefined();
	});

	it("reports size 0 for a missing directory and counts entries after writes", async () => {
		const sizes = await withKv(join(dir, "never-created"), (kv) => kv.size);
		expect(sizes).toBe(0);

		const after = await withKv(dir, (kv) =>
			Effect.gen(function* () {
				yield* kv.set("a", "1");
				yield* kv.set("b", "2");
				return yield* kv.size;
			}),
		);
		expect(after).toBe(2);
	});

	it("escapes dots: '..' is a regular key, not a path traversal", async () => {
		const value = await withKv(dir, (kv) =>
			Effect.gen(function* () {
				yield* kv.set("..", "dotdot");
				return yield* kv.get("..");
			}),
		);
		expect(value).toBe("dotdot");
		// The write landed inside the namespace, not in the parent directory.
		expect(await withKv(dir, (kv) => kv.size)).toBe(1);
	});

	it("excludes stray temp files from size", async () => {
		await writeFile(join(dir, "%tmp-99999-1"), "leftover", "utf8");
		const size = await withKv(dir, (kv) =>
			Effect.gen(function* () {
				yield* kv.set("real", "1");
				return yield* kv.size;
			}),
		);
		expect(size).toBe(1);
	});

	it("clear removes the namespace", async () => {
		const size = await withKv(dir, (kv) =>
			Effect.gen(function* () {
				yield* kv.set("a", "1");
				yield* kv.clear;
				return yield* kv.size;
			}),
		);
		expect(size).toBe(0);
	});

	it("maps fs failures to KeyValueStoreError", async () => {
		const fileAsDir = join(dir, "not-a-dir");
		await writeFile(fileAsDir, "occupied", "utf8");

		// set: parent path is a file -> mkdir fails
		const setError = await Effect.runPromise(
			Effect.gen(function* () {
				const kv = yield* KeyValueStore.KeyValueStore;
				return yield* Effect.flip(kv.set("k", "v"));
			}).pipe(Effect.provide(layerFileSystemKeyValueStore(join(fileAsDir, "nested")))),
		);
		expect((setError as { _tag: string })._tag).toBe("KeyValueStoreError");

		// get: key resolves to a directory -> EISDIR
		await mkdir(join(dir, "imadir"));
		const getError = await Effect.runPromise(
			Effect.gen(function* () {
				const kv = yield* KeyValueStore.KeyValueStore;
				return yield* Effect.flip(kv.get("imadir"));
			}).pipe(Effect.provide(layerFileSystemKeyValueStore(dir))),
		);
		expect((getError as { _tag: string })._tag).toBe("KeyValueStoreError");

		// size: directory path is a file -> ENOTDIR
		const sizeError = await Effect.runPromise(
			Effect.gen(function* () {
				const kv = yield* KeyValueStore.KeyValueStore;
				return yield* Effect.flip(kv.size);
			}).pipe(Effect.provide(layerFileSystemKeyValueStore(join(fileAsDir, "x")))),
		);
		expect((sizeError as { _tag: string })._tag).toBe("KeyValueStoreError");

		// remove: key resolves to a directory -> not ENOENT -> error
		const removeError = await Effect.runPromise(
			Effect.gen(function* () {
				const kv = yield* KeyValueStore.KeyValueStore;
				return yield* Effect.flip(kv.remove("imadir"));
			}).pipe(Effect.provide(layerFileSystemKeyValueStore(dir))),
		);
		expect((removeError as { _tag: string })._tag).toBe("KeyValueStoreError");
	});

	it("backs the SessionStore in the parallel namespace (ADR-0020 decision 7)", async () => {
		const program = Effect.gen(function* () {
			const store = yield* SessionStore;
			yield* store.save("effect-session-1", SessionState.empty);
			const loaded = yield* store.load("effect-session-1");
			const ids = yield* store.list;
			return { loaded, ids };
		}).pipe(
			Effect.provide(layerKeyValueStore.pipe(Layer.provide(layerFileSystemKeyValueStore(join(dir, "effect-sessions"))))),
		);

		const { loaded, ids } = await Effect.runPromise(program as Effect.Effect<never>) as unknown as {
			loaded: Option.Option<SessionState>;
			ids: ReadonlyArray<string>;
		};
		expect(Option.isSome(loaded)).toBe(true);
		expect(Option.getOrThrow(loaded).turnCount).toBe(0);
		expect(ids).toContain("effect-session-1");
	});
});
