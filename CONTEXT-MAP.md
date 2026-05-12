# Context Map

`pi-mono` is a multi-context monorepo. Each package under `packages/` is its own context. System-wide decisions live under `docs/adr/`; per-context decisions live under `packages/<pkg>/docs/adr/`.

## Contexts (post-rewrite shape)

- [pi-tui](./packages/tui/CONTEXT.md) — generic terminal renderer with differential output. **Not touched by the Effect rewrite** (ADR-0002).
- [pi-models](./packages/models/CONTEXT.md) — **new**: pure model-registry data and synchronous utilities (cost, context window, capabilities). No Effect dep. Browser-safe. (ADR-0005)
- [pi-agent-core](./packages/agent/CONTEXT.md) — agent runtime: loop, tool calling, state, cancellation. **Effect rewrite.** Owns OAuth, env-credential detection, session-resource scopes, and the in-repo OpenAI Codex Responses provider. (ADR-0001, ADR-0002, ADR-0005)
- [pi-coding-agent](./packages/coding-agent/CONTEXT.md) — the `pi` CLI: tools, modes, dialogs, storage. **Effect rewrite.** (ADR-0001, ADR-0002)
- [pi-web-ui](./packages/web-ui/CONTEXT.md) — Lit-based web components for AI chat. **Effect rewrite** (browser-targeted). Consumes `@effect/ai-*` and `pi-models` directly. (ADR-0002, ADR-0005)

**Deleted**: `@earendil-works/pi-ai` is retired (ADR-0003, ADR-0005). It stays on npm at `0.74.x` with a `deprecated` field but is not republished.

## Relationships

- **pi-agent-core → @effect/ai-openai, @effect/ai-openrouter, effect** — the loop talks to `LanguageModel` from `effect/unstable/ai` via the provider Layers.
- **pi-agent-core → pi-models** — registry lookup (`getModel`, `getProviders`, `calculateCost`).
- **pi-coding-agent → pi-agent-core, pi-tui, pi-models** — the CLI composes them.
- **pi-web-ui → @effect/ai-openai, @effect/ai-openrouter, effect, pi-models** — browser app uses Effect directly; pi-models for registry; Lit for components.
- **pi-tui is a sink**: nobody Effect-side imports from pi-tui's API in an Effect-typed way; integration happens at boundaries with `Effect.runPromise` / `Stream`-to-event-bridge adapters.

## Open decisions

All macro-architecture decisions are recorded in `docs/adr/0001–0016`. Remaining concerns are implementation-detail tier, not design-tree forks:

- Print mode (`pi --print` / `pi json`) — port to Effects (no structural change expected; subcommand under ADR-0011).
- OAuth flow internals — move into `pi-agent-core` per ADR-0005 (no structural break expected).
- Autocomplete / slash commands — Effect-shaped Services consumed by interactive mode.
- Compaction + branch-summarization — Effects within the agent loop; observable via `AgentEvent` per ADR-0009.
- System prompt building — pure module, no runtime concerns.
- Skills system (`parseSkillBlock`) — Effect-shaped parser; emits `SkillInvoked` events per ADR-0009.
- HTML session export — Effect against `FileSystem`.
- Telemetry / observability concrete exporters — `@effect/opentelemetry` integration, see ADR-0004's risk note about beta surface.
- TS compiler reconciliation: pi-mono uses `@typescript/native-preview` (tsgo); effect-smol uses `tspc` patched compiler. Both target TS 7.0+; verify they coexist for type-checking (pending small spike).
- **(Optional, not blocking)** add MCP support via `effect/unstable/ai`'s `McpServer` — pi-coding-agent has no MCP today, so this is a new feature, not a port.
