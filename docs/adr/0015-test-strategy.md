# Test strategy: `pi-agent-core/test-support` with Effect-shaped test layers

A test-support module under `packages/agent/test-support/` is published from `pi-agent-core` via a deep import path (`@earendil-works/pi-agent-core/test-support`). It provides Effect-shaped test fixtures: `TestLanguageModel` (a scripted `LanguageModel.Service` implementation), `TestUI` (records dialog/widget calls for assertion), `TestStores` (in-memory implementations of every Store from ADR-0012), `TestBashOperations` (records exec calls and returns scripted output). All tests across the rewritten packages (`pi-agent-core`, `pi-coding-agent`, `pi-web-ui`) import from here.

The previous `pi-ai/src/providers/faux.ts` and the bulk of `packages/ai/test/*` (the provider-specific tests for Anthropic, Bedrock, Google, Mistral, Fireworks, cross-provider handoff, etc.) are deleted with the provider narrowing (ADR-0003). The remaining provider-agnostic tests (OpenAI completions/responses, OpenAI Codex, validation/unicode/tool-call-id-normalization) are rewritten as `pi-agent-core/test/*` against the test layers. The `packages/coding-agent/test/suite/regressions/*` files keep their naming convention (`<issue-number>-<short-slug>.test.ts`) and are ported during phase 4 (ADR-0006).

`@effect/vitest` is added as a dev dependency in the rewritten packages, providing `TestClock` (for retry/timeout determinism), `TestRandom` (deterministic ID generation), and `TestServices` (composable test contexts). `vitest` itself stays as the test runner. Tests that genuinely need real subprocess execution opt into `@earendil-works/pi-agent-core/test-support/integration` rather than relying on environmental state in unit tests.

Rejected alternatives: a separately published `@earendil-works/pi-test-utils` package (overkill — no external authors today need it as a versioned artifact; the deep import covers the same ground without the publish cycle); and per-package fixtures with no shared module (predictable drift — each package's `TestLanguageModel` ends up slightly different, defeating the consistency the rewrite is supposed to bring).

## Status

accepted
