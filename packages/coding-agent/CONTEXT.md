# pi-coding-agent

`@earendil-works/pi-coding-agent` is the `pi` CLI context. It owns user-facing modes, tools, dialogs, settings, sessions, extension loading, and the bridge between the Effect runtime and the terminal renderer.

## What's where

- **`src/cli/`** - command-line parsing and process entry behavior. _(legacy lane — rewrite-pending)_
- **`src/core/`** - tools, sessions, settings, auth/model selection, storage, hooks, exports, and extension plumbing. _(legacy lane — rewrite-pending)_
- **`src/modes/`** - interactive, print/json, and RPC user workflows. _(legacy lane — rewrite-pending)_
- **`src/bun/`** - Bun binary entry path for the post-rewrite CLI distribution. _(legacy lane — rewrite-pending)_
- **`effect/`** - _New, Effect v4 **production** code._ Folds into `src/` at the ADR-0006 phase-4 cutover. Currently: `effect/tools/` — the seven built-in tools as pure `Tool.make` definitions with pluggable `*Operations` Services (ADR-0010), plus the `BuiltinToolkit` registry.
- **`test/effect/`** - _New, Effect-based._ Tracer-bullet tests for the `effect/` lane, run with `bun run test:effect`.
- **`docs/` and `examples/`** - public user and extension documentation.

## Effect rewrite status (`effect/` lane)

Built-in tools — ADR-0010 slices, each a pure schema-only `Tool.make` with **zero `pi-tui` imports**, a pluggable `*Operations` `Context.Service` (default `*OperationsLive` Layer; tests swap stub Layers), and a typed `*Error` failure channel. All seven ported, all GREEN against stub Layers:

1. **`ls`** — `LsOperations` (`exists` / `isDirectory` / `readdir`); sorted, `limit`-paginated entries.
2. **`read`** — `ReadOperations` (`exists` / `isFile` / `readTextFile`); 1-indexed `offset`/`limit` slicing. _Image handling deferred._
3. **`write`** — `WriteOperations` (`mkdirRecursive` / `writeTextFile`); recursive parent-dir creation, UTF-8 byte count.
4. **`edit`** — `EditOperations` (`exists` / `readTextFile` / `writeTextFile`); exact-text + fuzzy replacement, multi-edit, BOM + line-ending preservation, unified diff. Pure algorithm in `effect/tools/edit-diff.ts`; `applyEditsToNormalizedContent` throws a typed `EditApplyError` mapped onto `EditError` reasons (no message-string matching).
5. **`grep`** — `GrepOperations` (`isDirectory` / `readFile` / `search`); the ripgrep subprocess lives behind `search`, the handler does pure path-relativising, context blocks, long-line + byte truncation.
6. **`find`** — `FindOperations` (`exists` / `search`); the `fd` subprocess lives behind `search`, the handler does pure relativising + byte truncation.
7. **`bash`** — `BashOperations` (`exec`); the shell subprocess lives behind `exec`. A non-zero exit is a **success** result with `status: "nonzero-exit"` (the legacy tool threw and lost the exit code) — only a genuine inability to run (`cwd-not-found` / `spawn-failed`) is a `BashError`.

`effect/tools/index.ts` exports the `BuiltinToolkit` (`Toolkit.make` over all seven), `builtinHandlers(cwd)` / `builtinToolkitLayer(cwd)` (cwd-bound handler wiring), and `BuiltinOperationsLive` (every `*OperationsLive` merged). Tools declare their Service via `Tool.make`'s `dependencies: [...]` so the toolkit handler's allowed requirements include it. Shared pure truncation helpers are copied into `effect/tools/truncate.ts` (rewrite-lane counterpart of `src/core/tools/truncate.ts`).

Deferred across the subprocess tools (follow-on slices): on-demand `rg`/`fd` download when absent from `PATH` (legacy `ensureTool`); for `bash` — throttled live-output streaming, the rolling-buffer + temp-file `OutputAccumulator`, the `BashSpawnHook` Service, full process-tree teardown. Not yet started: tool renderers (`modes/interactive/tool-renderers/` per ADR-0010), typed Stores (ADR-0012), the extension API (ADR-0014), and the CLI/modes rewrite.

## Running (`effect/` lane)

From `packages/coding-agent/`:

```sh
bunx vitest --run test/effect            # run the Effect tracer bullets
# typecheck (from repo root): node_modules/.bin/tsgo -p packages/coding-agent/tsconfig.effect.json --noEmit
```

## Architecture stance

- **Effect rewrite target** (ADR-0001, ADR-0002). The target 1.0 shape uses Effect services, streams, typed stores, and `effect/unstable/cli`.
- **Host owns the runtime** (ADR-0008). One process-level `ManagedRuntime` hosts app layers; terminal callbacks bridge into it.
- **Tools are pure, renderers are separate** (ADR-0010). Core tools produce typed results; interactive mode chooses terminal renderers.
- **Bun-only CLI binary** (ADR-0013). The npm package survives as an SDK/library install, while CLI distribution moves to a compiled Bun binary.

## Glossary

- **CLI mode** - A top-level execution workflow: interactive, print/json, or RPC.
- **Session** - Persisted conversation state with branchable history and metadata.
- **Tool** - A model-callable capability such as read, write, edit, bash, grep, find, or ls.
- **Typed tool result** - The Schema-validated value returned by a tool handler and carried through agent events.
- **LLM-facing serialized summary** - The JSON serialization of a typed tool result sent back to the model.
- **Tool renderer** - An interactive-mode adapter that turns a typed tool result into a `pi-tui` component.
- **Tool renderer host** - The Module that consumes tool execution events and produces renderer updates for a mode-specific Adapter. It owns renderer lifecycle, partial/final result state, fallback behavior, expansion state, and image policy without owning tool execution.
- **Extension** - A user package that contributes tools, slash commands, keybindings, UI, hooks, or state.
- **Extension UI capability** - A focused Extension UI Interface such as dialogs, editor access, status bar, widget host, theme access, or terminal input. Each CLI mode supplies only the capability Adapters it supports.
- **Skill** - A markdown capability loaded into the agent prompt, distinct from executable extension code.
- **Prompt template** - A reusable prompt expansion file.
- **Theme** - Terminal styling configuration consumed by interactive components.
- **Pi package** - A distributable bundle of extensions, skills, prompt templates, and themes.
- **Resource catalog** - The categorized discovery output for extension, skill, prompt template, and theme resources from already-installed packages, local paths, and extension-provided paths. It excludes package install/update/remove behavior.

## Relationships

- **pi-coding-agent -> pi-agent-core**: consumes the agent loop/session runtime and shared test support.
- **pi-coding-agent -> pi-tui**: owns terminal composition and tool-result rendering.
- **pi-coding-agent -> pi-models**: target post-rewrite relationship; uses model registry data for selection, scoped cycling, display, and cost after legacy `pi-ai` registry imports are removed.
- **pi-coding-agent -> extensions**: loads user code at process startup and composes contributed capabilities into the runtime.

## Example dialogue

> **Dev:** "Should a built-in tool import a terminal component so it can render itself?"
> **Domain expert:** "No. The tool returns a typed result. Interactive mode maps that result to a `pi-tui` renderer."

## Flagged ambiguities

- "Command" can mean CLI command, slash command, or shell command. Use **CLI subcommand**, **slash command**, or **bash command**.
- "Tool output" can mean typed tool result, LLM-facing serialized summary, or terminal rendering. Name the layer explicitly.
