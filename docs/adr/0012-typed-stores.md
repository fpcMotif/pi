# Storage layer: typed Stores as Effect Services on top of `FileSystem`

All persistent state in `pi-coding-agent` moves behind typed `Context.Service`s — one per storage concern — built on top of the Effect platform `FileSystem` service. ADR-0013 later narrows the CLI host to Bun-only, so `@effect/platform-bun` is the implementation target; the earlier Node platform option is historical context, not the current plan. The stores: `SessionStore`, `SettingsStore`, `AuthStore`, `KeybindingsStore`, `ThemeStore`, `ModelRegistryStore`, `SkillsStore`, `PromptTemplatesStore`, and `ExtensionStateStore` (the public extension persistence API). Each Store exposes typed methods returning Effects — `save`, `load`, `list`, and where useful `subscribe()` returning a `Stream` of changes. Schema validation happens at the Store boundary via `effect/Schema`, so values stored are typed and deserialization fails with a typed `Schema.ParseError` rather than a runtime panic.

Lock acquisition is internal to each Store: in-process serialization via `Effect.Semaphore`, cross-process locking via a Bun-compatible platform helper (see ADR-0013). All lock acquire/release is scoped via `Effect.acquireRelease`, so dropped fibers don't leave stale locks.

Atomic writes (`write` + `rename`) standardize via a shared helper. Schema versioning per Store: each persisted shape carries a `version: number` field, and stores use `Schema.Union` of versioned shapes plus `Schema.transform` to migrate older shapes forward at read time. The previous `migrations.ts` module becomes a `Migrations` Service whose `run` method composes per-Store migrations declared by each Store's Layer.

Default Layers (for example `SessionStore.BunLayer` in the ADR-0013 host) live next to the Store definition; test Layers backed by in-memory state live under test support and let the test suite run without touching the filesystem.

`models.generated.ts` (cost / context-window data) is not a Store — it is compiled-in pure data living in `pi-models` (ADR-0005), unaffected by this ADR.

Rejected alternatives: wrapping each `node:fs` call in `Effect.try` at the use site (no DI, no test isolation), and using `FileSystem` directly without per-concern Stores (24 modules each invent their own JSON shape, locking, and migration plan — the kind of duplication this rewrite is supposed to eliminate).

## Status

accepted
