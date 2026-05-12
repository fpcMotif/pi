# pi-tui

`@earendil-works/pi-tui` is the terminal rendering context: a plain TypeScript component system for interactive terminal applications. It is intentionally outside the Effect rewrite because its core work is synchronous rendering, input dispatch, and terminal control.

## What's where

- **`src/components/`** - renderable UI building blocks such as text, editor, markdown, selector, overlays, loader, image, and containers.
- **`ProcessTerminal` / terminal implementations** - adapt stdin/stdout or test terminals to the shared terminal interface.
- **`README.md`** - public component and terminal API reference.

## Architecture stance

- **No Effect dependency** (ADR-0002). Effect-typed packages cross into `pi-tui` at host boundaries with `ManagedRuntime.runFork` / `runPromise`, but `pi-tui` stays renderer-focused.
- **Differential rendering is the package identity.** Components return line arrays; the TUI decides whether to write a first render, full re-render, or minimal changed-line update.
- **Key handling must be configurable.** Use the shared key helpers and configurable binding maps rather than hardcoded ad hoc string checks.

## Glossary

- **Component** - A renderable terminal UI object that returns lines for a given width and may handle focused input.
- **Terminal** - The output/input adapter that exposes dimensions, writes bytes, and controls cursor/screen operations.
- **Differential render** - The update strategy that writes only the terminal lines that changed since the previous frame.
- **Overlay** - A temporarily layered component with its own position, focus, and visibility rules.
- **Focusable** - A component that can expose cursor placement for keyboard input and IME candidate windows.
- **Theme** - A package-specific set of styling callbacks passed into components, not an application settings store.

## Relationships

- **pi-coding-agent -> pi-tui**: the interactive CLI composes `pi-tui` components and renderers.
- **pi-agent-core -> pi-tui**: no direct Effect-typed dependency; communication happens through host adapters in `pi-coding-agent`.
- **Extensions -> pi-tui**: extensions can register UI renderers through `pi-coding-agent`, not by changing `pi-tui` core contracts.

## Example dialogue

> **Dev:** "Should the agent loop return a `pi-tui` component for each tool result?"
> **Domain expert:** "No. The loop emits typed events; `pi-coding-agent` chooses a renderer. `pi-tui` only renders components."

## Flagged ambiguities

- "UI" can mean browser UI or terminal UI. In this context, use **terminal UI** or **pi-tui component**.
- "Renderer" can mean terminal diff renderer or tool-result renderer. In this context, use **differential render** for terminal output and **tool renderer** for `pi-coding-agent` adapters.
