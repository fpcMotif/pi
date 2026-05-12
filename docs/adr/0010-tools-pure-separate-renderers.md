# Tool definition shape: pure Effect tools, renderers separated into interactive-mode

Built-in tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) and any future built-ins live in `packages/coding-agent/src/core/tools/<name>.ts` as **pure** Effect tools — `Tool.make({ parameters: Schema.Struct(...), execute: Effect.fn(...) })` with typed results. These files have **zero `pi-tui` imports** so they can be consumed by the agent loop, the RPC mode, the print mode, faux test runners, and any future headless caller without dragging a terminal renderer into the import graph. The pi-tui renderer for each tool lives separately under `packages/coding-agent/src/modes/interactive/tool-renderers/<name>.ts`, registered into a `Map<string, (result: unknown) => Component>` lookup that interactive-mode owns. Tools without a custom renderer get a generic default. Extension authors follow the same separation: `Tool.make` for the definition (mandatory), `registerRenderer(toolName, fn)` for the renderer (optional).

Pluggable execution backends — currently the `BashOperations` interface (lets you redirect command execution to SSH or other remote transports) and the `BashSpawnHook` interface (intercepts process spawning) — become Effect `Context.Service`s with Layer-swappable implementations. `BashOperations.LocalLayer` is the default; remote impls supply alternative layers. The pluggability survives the rewrite because both were deliberate extension points with concrete users; dropping them would be reversible-but-painful.

Each tool's execute Effect returns a typed result. The agent event stream's `ToolCompleted` event carries this typed value. The LLM-facing serialization is produced via `Schema.encodeSync` to a string summary — the LLM sees JSON, the UI sees the typed value, both come from one Schema.

The built-in tool list is exported as a single `BuiltinToolkit` from `packages/coding-agent/src/core/tools/index.ts`, paired with a `BuiltinRendererRegistry` published from `modes/interactive/tool-renderers/index.ts`. The CLI assembles the final toolkit by merging built-in + extension-provided tools at startup.

## Status

accepted
