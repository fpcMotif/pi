# Changelog

## [Unreleased]

### Added

- Initial extraction from `@earendil-works/pi-ai` (ADR-0005, ADR-0006 phase 1). Pure model-registry data + synchronous utilities (`getModel`, `getProviders`, `getModels`, `calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `modelsAreEqual`) for text and image models. No Effect or provider runtime dependencies; browser-safe.

### Changed

- **Narrowed to OpenAI + OpenAI Codex + OpenRouter** (ADR-0003, ADR-0006 phase 2). `KnownApi` collapses to `"openai-completions" | "openai-responses" | "openai-codex-responses"`. `KnownProvider` collapses to `"openai" | "openai-codex" | "openrouter"`. `AnthropicMessagesCompat` and `VercelGatewayRouting` types are removed (and the `vercelGatewayRouting` field on `OpenAICompletionsCompat` with them). `models.generated.ts` shrinks from 17,252 lines to 5,607 — only the openai, openai-codex, and openrouter blocks survive.
