# pi-coding-agent

`@earendil-works/pi-coding-agent` is the `pi` CLI context. It owns user-facing modes, tools, dialogs, settings, sessions, extension loading, and the bridge between the Effect runtime and the terminal renderer.

## What's where

- **`src/cli/`** - command-line parsing and process entry behavior.
- **`src/core/`** - tools, sessions, settings, auth/model selection, storage, hooks, exports, and extension plumbing.
- **`src/modes/`** - interactive, print/json, and RPC user workflows.
- **`src/bun/`** - Bun binary entry path for the post-rewrite CLI distribution.
- **`docs/` and `examples/`** - public user and extension documentation.

## Architecture stance

- **Effect rewrite target** (ADR-0001, ADR-0002). The target 1.0 shape uses Effect services, streams, typed stores, and `effect/unstable/cli`.
- **Host owns the runtime** (ADR-0008). One process-level `ManagedRuntime` hosts app layers; terminal callbacks bridge into it.
- **Tools are pure, renderers are separate** (ADR-0010). Core tools produce typed results; interactive mode chooses terminal renderers.
- **Bun-only CLI binary** (ADR-0013). The npm package survives as an SDK/library install, while CLI distribution moves to a compiled Bun binary.

## Glossary

- **CLI mode** - A top-level execution workflow: interactive, print/json, or RPC.
- **Session** - Persisted conversation state with branchable history and metadata.
- **Tool** - A model-callable capability such as read, write, edit, bash, grep, find, or ls.
- **Tool renderer** - An interactive-mode adapter that turns a typed tool result into a `pi-tui` component.
- **Extension** - A user package that contributes tools, slash commands, keybindings, UI, hooks, or state.
- **Skill** - A markdown capability loaded into the agent prompt, distinct from executable extension code.
- **Prompt template** - A reusable prompt expansion file.
- **Theme** - Terminal styling configuration consumed by interactive components.
- **Pi package** - A distributable bundle of extensions, skills, prompt templates, and themes.

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
