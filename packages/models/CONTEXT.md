# pi-models

`@earendil-works/pi-models` is the pure model-registry context. It owns generated model data and synchronous lookup/cost helpers, with no provider runtime, no Effect dependency, and no Node-only imports.

## What's where

- **`src/models.generated.ts`** - generated text model registry.
- **`src/image-models.generated.ts`** - generated image model registry.
- **`src/models.ts`** - synchronous text model lookup, provider listing, cost calculation, and thinking-level helpers.
- **`src/image-models.ts`** - synchronous image model lookup and provider listing.
- **`src/types.ts`** - registry-side provider, model, usage, cost, capability, and compatibility types.

## Architecture stance

- **Pure leaf package** (ADR-0005). `pi-agent-core`, `pi-coding-agent`, and `pi-web-ui` depend on it; it must not depend back on them.
- **No Effect and no provider clients.** Runtime streaming/auth/provider behavior lives in `@effect/ai-*` or `pi-agent-core`.
- **Generators own generated files.** Do not edit generated registries directly; update the generator scripts in `packages/ai/scripts/`.

## Glossary

- **Model registry** - The compiled data set of provider/model metadata used for lookup and cost calculation.
- **Model** - A text model entry with provider, API kind, capabilities, context window, max tokens, and cost rates.
- **Image model** - An image-capable registry entry with provider, input/output capabilities, and cost rates.
- **Known provider** - A provider name pi supports directly after ADR-0003: `openai`, `openai-codex`, or `openrouter`.
- **API kind** - The wire-protocol family a model uses, such as `openai-completions`, `openai-responses`, or `openai-codex-responses`.
- **Thinking level** - Pi's normalized reasoning-depth setting, clamped per model by `getSupportedThinkingLevels` / `clampThinkingLevel`.
- **Usage cost** - The derived dollar cost for input, output, cache-read, and cache-write token counts.

## Relationships

- **pi-agent-core -> pi-models**: selects models and calculates usage cost without importing provider runtime code.
- **pi-coding-agent -> pi-models**: displays model choices, thinking levels, and cost data in the CLI.
- **pi-web-ui -> pi-models**: uses the browser-safe registry directly.
- **pi-ai -> pi-models**: temporary ADR-0006 phase-1 compatibility path only; `pi-ai` is deleted in the target architecture.

## Example dialogue

> **Dev:** "Can `pi-models` create an OpenAI client for this model?"
> **Domain expert:** "No. `pi-models` says what the model is and what it costs; provider clients live outside this package."

## Flagged ambiguities

- "Provider" can mean a registry provider name or a runtime client. In this context, **provider** means registry identity only.
- "Model support" means registry metadata exists, not that auth, streaming, or every provider feature is implemented.
