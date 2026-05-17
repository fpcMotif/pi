# Effect Schema everywhere — including the extension SDK

`typebox` is removed across all rewritten packages and replaced with `effect/Schema`. All tool argument definitions (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` and any future built-ins), the public extension SDK (`packages/coding-agent/docs/extensions.md`, the in-tree examples under `packages/coding-agent/examples/extensions/`), persisted state schemas (sessions, settings, custom providers, theme config), and model/config validation at Effect runtime boundaries all migrate to Effect Schema. The pure `pi-models` registry remains Effect-free per ADR-0005. Extension authors who used typebox before now write `Schema.Struct({...})` for tool args and `Effect.fn` (or `Effect.gen`) for handlers; they get access to Effect's full feature set (Layer-injected dependencies, typed errors, structured cancellation) inside extension code. Schema → JSON Schema for outbound tool definitions is automatic via `effect/JsonSchema`, so authors who only care about the LLM-facing tool definition don't pay extra ceremony for that translation. Persisted state on disk stays JSON-encoded via Schema's default encoding; **old `0.x` session files are not loadable under `1.0` — clean break, no migration shim** — users mid-session stay on the `legacy` branch (ADR-0006).

The rejected alternatives were: a typebox/JSON-Schema-shaped extension boundary (extensions become Promise-islands inside an Effect runtime, defeating the rewrite's premise); and a two-tier SDK with both shapes supported in parallel (real ongoing maintenance tax for two docs sets and two example trees — value too low to justify).

## Status

accepted
