/**
 * `SessionStore` is the first durable-state Service per ADR-0012. All
 * persistent state crosses a typed Effect boundary: callers depend on the
 * `Context.Service`, tests provide an in-memory Layer, and host code can swap
 * in an Effect persistence KeyValueStore Layer without changing call sites.
 */
import { Context, Effect, HashMap, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";

import { SchemaError, StoreError } from "../agent-error.js";
import { SessionState } from "../session-state.js";

export class SessionRecordV1 extends Schema.Class<SessionRecordV1>("SessionRecordV1")({
	version: Schema.Literal(1),
	state: SessionState,
	updatedAt: Schema.String,
}) {
	static readonly schemaVersion = 1 as const;

	static fromState(state: SessionState): SessionRecordV1 {
		return new SessionRecordV1({
			version: SessionRecordV1.schemaVersion,
			state,
			updatedAt: new Date().toISOString(),
		});
	}
}

export const SessionRecord = SessionRecordV1;
export type SessionRecord = SessionRecordV1;

class SessionIndexV1 extends Schema.Class<SessionIndexV1>("SessionIndexV1")({
	version: Schema.Literal(1),
	ids: Schema.Array(Schema.String),
}) {
	static readonly empty = new SessionIndexV1({ version: 1, ids: [] });
}

export class SessionStore extends Context.Service<
	SessionStore,
	{
		readonly save: (id: string, state: SessionState) => Effect.Effect<void, SchemaError | StoreError>;
		readonly load: (id: string) => Effect.Effect<Option.Option<SessionState>, SchemaError | StoreError>;
		readonly remove: (id: string) => Effect.Effect<void, SchemaError | StoreError>;
		readonly list: Effect.Effect<ReadonlyArray<string>, SchemaError | StoreError>;
	}
>()("@earendil-works/pi-agent-core/SessionStore") {}

const mapSchemaError = (error: Schema.SchemaError): SchemaError =>
	new SchemaError({
		description: String(error),
	});

/**
 * Funnel a `Schema.Class` constructor throw (from `Effect.try`) into the
 * pi `SchemaError`. The constructor throws a plain `Error` (not a
 * `Schema.SchemaError`), so we stringify whatever lands in `catch`.
 */
const mapUnknownSchemaError = (error: unknown): SchemaError =>
	new SchemaError({
		description: String(error),
	});

const mapStoreError =
	(operation: string) =>
	(error: KeyValueStore.KeyValueStoreError): StoreError =>
		new StoreError({
			store: "SessionStore",
			operation,
			message: error.message,
			cause: error,
		});

const makeSessionRecord = (state: SessionState): Effect.Effect<SessionRecord, SchemaError> =>
	Effect.try({
		try: () => SessionRecordV1.fromState(state),
		catch: mapUnknownSchemaError,
	});

const makeSessionIndex = (ids: ReadonlyArray<string>): Effect.Effect<SessionIndexV1, SchemaError> =>
	Effect.try({
		try: () => new SessionIndexV1({ version: 1, ids: [...ids] }),
		catch: mapUnknownSchemaError,
	});

const kvIndexLocks = new WeakMap<KeyValueStore.KeyValueStore, Semaphore.Semaphore>();

const indexLockFor = (kv: KeyValueStore.KeyValueStore): Semaphore.Semaphore => {
	const existing = kvIndexLocks.get(kv);
	if (existing !== undefined) return existing;
	const semaphore = Semaphore.makeUnsafe(1);
	kvIndexLocks.set(kv, semaphore);
	return semaphore;
};

export const MemoryLayer: Layer.Layer<SessionStore> = Layer.effect(SessionStore)(
	Effect.gen(function* () {
		const records = yield* Ref.make(HashMap.empty<string, SessionRecord>());
		return SessionStore.of({
			save: (id, state) => Ref.update(records, (m) => HashMap.set(m, id, SessionRecordV1.fromState(state))),
			load: (id) => Ref.get(records).pipe(Effect.map((m) => Option.map(HashMap.get(m, id), (r) => r.state))),
			remove: (id) => Ref.update(records, (m) => HashMap.remove(m, id)),
			list: Ref.get(records).pipe(Effect.map((m) => Array.from(HashMap.keys(m)))),
		});
	}),
);

export const layerKeyValueStore: Layer.Layer<SessionStore, never, KeyValueStore.KeyValueStore> = Layer.effect(
	SessionStore,
	Effect.gen(function* () {
		const kv = yield* KeyValueStore.KeyValueStore;
		const records = KeyValueStore.toSchemaStore(KeyValueStore.prefix(kv, "sessions/"), SessionRecord);
		const indexes = KeyValueStore.toSchemaStore(KeyValueStore.prefix(kv, "indexes/"), SessionIndexV1);
		const indexLock = indexLockFor(kv);

		const loadIndex = indexes.get("sessions").pipe(
			Effect.map(Option.getOrElse(() => SessionIndexV1.empty)),
			Effect.mapError((error) =>
				Schema.isSchemaError(error) ? mapSchemaError(error) : mapStoreError("list")(error),
			),
		);

		const saveIndex = (ids: ReadonlyArray<string>, operation: string) =>
			Effect.gen(function* () {
				const index = yield* makeSessionIndex(ids);
				yield* indexes
					.set("sessions", index)
					.pipe(
						Effect.mapError((error) =>
							Schema.isSchemaError(error) ? mapSchemaError(error) : mapStoreError(operation)(error),
						),
					);
			});

		return SessionStore.of({
			save: (id, state) =>
				indexLock.withPermit(
					Effect.gen(function* () {
						const record = yield* makeSessionRecord(state);
						yield* records
							.set(id, record)
							.pipe(
								Effect.mapError((error) =>
									Schema.isSchemaError(error) ? mapSchemaError(error) : mapStoreError("save")(error),
								),
							);
						const index = yield* loadIndex;
						if (!index.ids.includes(id)) {
							yield* saveIndex([...index.ids, id], "save-index");
						}
					}),
				),
			load: (id) =>
				records.get(id).pipe(
					Effect.map(Option.map((record) => record.state)),
					Effect.mapError((error) =>
						Schema.isSchemaError(error) ? mapSchemaError(error) : mapStoreError("load")(error),
					),
				),
			remove: (id) =>
				indexLock.withPermit(
					Effect.gen(function* () {
						yield* records.remove(id).pipe(Effect.mapError(mapStoreError("remove")));
						const index = yield* loadIndex;
						if (index.ids.includes(id)) {
							yield* saveIndex(
								index.ids.filter((existing) => existing !== id),
								"remove-index",
							);
						}
					}),
				),
			list: indexLock.withPermit(loadIndex.pipe(Effect.map((index) => index.ids))),
		});
	}),
);

export const layerMemory: Layer.Layer<SessionStore> = MemoryLayer;
