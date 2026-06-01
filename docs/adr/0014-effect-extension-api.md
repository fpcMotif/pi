# Extension API: Effect Layers, no back-compat for 0.x extensions

The public extension API is rewritten as Effect-shaped Layers. An extension is a single value exported via `Extension.make({ name, version, layer, toolkit?, slashCommands?, keybindings?, cli?, ... })`. The `layer` is an `Effect.Layer` that provides extension-scoped Services; the `toolkit` is a `Toolkit` from `effect/unstable/ai` whose tools are `Tool.make`-based with `effect/Schema` parameters (ADR-0010, ADR-0007). Lifecycle hooks (`onStart`, `onAgentEvent`, `onShutdown`) return Effects; `Effect.acquireRelease` is the idiomatic pattern for setup/teardown.

UI access for extensions goes through a `UI` Service whose default Layer (`UI.PiTuiLayer`) bridges to `pi-tui` imperatively via the host's `ManagedRuntime` (ADR-0008). Headless modes (print, RPC) provide a no-op or text-only `UI` Layer. CLI flag registration uses `effect/unstable/cli`'s primitives (ADR-0011). Extension state persists via a per-extension scoped view of `ExtensionStateStore` (ADR-0012). Pluggable backends like `BashOperations` (ADR-0010) remain extension-overridable via Layer composition.

**No back-compat wrapper for 0.x extensions** — consistent with the clean-break stance on session files (ADR-0007). Extension authors port to the new shape. The in-tree example extensions (`packages/coding-agent/examples/extensions/`) are rewritten during phase 4 and double as the migration tutorial; `packages/coding-agent/docs/extensions.md` is rewritten alongside. Working assumption: the public third-party extension ecosystem on npm is small enough today (pi is still 0.x) that the rewrite cost is bounded by examples + each author's own work, not by negotiating with an established ecosystem. If that assumption turns out wrong, a thin compatibility shim could be added later — but it isn't built up front.

Rejected alternatives: imperative shape preserved with Effect hidden behind callback wrappers (puts the largest Promise-island in the codebase at the highest-traffic public boundary, contradicts ADR-0001 and ADR-0007); two-tier API with both shapes in parallel (long-term maintenance tax for two SDKs, two doc sets, two example trees — same trap as Q9C).

## Status

accepted
