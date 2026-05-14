# pi-web-ui

`@earendil-works/pi-web-ui` is the browser UI context for AI chat interfaces. It owns web components, browser storage, attachments, artifacts, browser tools, and provider-key UX for apps embedding pi in the browser.

## What's where

- **`src/ChatPanel.ts`** - high-level embeddable chat component that composes the agent interface and artifacts panel.
- **`src/components/`** - lower-level message, input, attachment, provider-key, sandbox, and rendering components.
- **`src/dialogs/`** - settings, API key, model, and session dialogs.
- **`src/storage/`** - IndexedDB-backed app storage and store abstractions.
- **`src/tools/`** - browser-side tools such as JavaScript REPL, document extraction, and artifacts (`src/tools/artifacts/`).
- **`example/`** - runnable example application.

## Architecture stance

- **Effect rewrite target for browser** (ADR-0002). The target shape uses Effect directly in the browser where it improves typed services, streams, and errors.
- **Consumes `pi-models` directly** (ADR-0005). Browser model metadata must stay free of Node-only imports.
- **Does not keep the legacy `pi-ai` provider facade** (ADR-0003). Provider access moves to `@effect/ai-*`, OpenRouter/OpenAI-compatible flows, or browser-specific custom providers.
- **UI state is browser-local.** Sessions, settings, provider keys, attachments, and artifacts are stored through browser storage abstractions.

## Glossary

- **ChatPanel** - The high-level embeddable chat component with messages, input, and artifact panel.
- **AgentInterface** - The lower-level chat component for custom layouts.
- **Artifact** - A generated or updated browser-viewable asset such as HTML, SVG, Markdown, text, JSON, image, PDF, DOCX, or XLSX.
- **Artifact workspace** - The browser-local Artifact state and command Module that owns create, update, rewrite, get, delete, logs, and reconstruction semantics independently of panel DOM rendering and sandbox execution Adapters.
- **Attachment** - A user-supplied file or URL payload with preview/extracted text metadata.
- **AppStorage** - The composed browser storage facade for settings, provider keys, sessions, and custom providers.
- **Provider key** - Browser-stored credential or token used by a provider integration.
- **CORS proxy** - A configured browser proxy path used only when a provider cannot be called directly from the page.
- **Custom provider** - A user-configured browser provider such as Ollama, LM Studio, vLLM, or OpenAI-compatible endpoint.

## Relationships

- **pi-web-ui -> pi-agent-core**: target post-rewrite relationship; browser chat workflows embed the agent/session surface after the web rewrite slice replaces the legacy `pi-ai` path.
- **pi-web-ui -> pi-models**: target post-rewrite relationship; uses browser-safe model registry data after legacy `pi-ai` registry imports are removed.
- **pi-web-ui -> @effect/ai-openai / @effect/ai-openrouter**: target provider path for the rewrite; legacy browser provider helpers remain historical until the web rewrite slice replaces them.
- **pi-web-ui -> browser storage**: persists app-local state through IndexedDB-backed stores.

## Example dialogue

> **Dev:** "Can the web UI import a Node-only provider helper if the browser app does not call it?"
> **Domain expert:** "No. Browser bundles must stay clean; use `pi-models` for registry data and browser-safe provider paths."

## Flagged ambiguities

- "Storage" can mean browser IndexedDB stores or CLI filesystem stores. In this context, use **browser storage**.
- "Provider" can mean built-in browser provider, OpenRouter/OpenAI route, or user custom endpoint. Name the specific provider path.
