# Monorepo-wide 100% coverage and realistic e2e suite

Every surviving and deprecated package under `packages/` is held to **100% line, branch, function, and statement** coverage, measured via `vitest` + `@vitest/coverage-v8`, with **minimal excludes** (only `*.test.ts`, `*.d.ts`, and built `dist/` artefacts). This applies to: `pi-tui`, `pi-models`, `pi-ai` (deprecated per ADR-0005 but kept in scope as a forcing function while it remains in the worktree), `pi-agent-core` (both `src/` legacy and `effect/` rewrite paths), `pi-coding-agent`, and `pi-web-ui`. `packages/agent/test-support/**` is **excluded** as test infrastructure.

`pi-tui` is ported from `node --test --import tsx` to `vitest` to make this measurable. `pi-models` and `pi-web-ui` gain new vitest configs and `test:coverage` / `test:coverage:100` scripts that mirror `pi-agent-core`'s existing `--coverage.thresholds.lines=100 --coverage.thresholds.statements=100` shape, extended with `--coverage.thresholds.branches=100 --coverage.thresholds.functions=100`. `pi-web-ui` runs under `vitest --environment=happy-dom` for Lit components.

The work is sequenced **A → C → B**:
1. **A — Infrastructure**: root `coverage:all` aggregator, per-package vitest configs, port tui to vitest, GitHub Actions PR gate that fails any workspace below 100%.
2. **C — Effect-rewrite + realistic e2e**: fill coverage gaps in `packages/agent/effect/**` and `packages/coding-agent/effect/**`; land the deferred compaction slice (so the ADR-0009 wrapping target is fully realized before e2e covers it); write **20+ realistic e2e scenarios** that compose multiple slices in long, lifelike conversation arcs (multi-tool turns, retry mid-stream, save/load resume, reasoning + text + tool interleaving, compaction trigger, CLI subprocess driving the full loop, tool round-trips against a tmpdir filesystem). All e2e is **stub-Layer based**, no live API keys; the stub Layers exercise the same `OpenAiLanguageModel.makeStreamResponse` SSE parse path real providers go through. New work follows **strict TDD** (red-green-refactor; failing test describes intended behavior first).
3. **B — Legacy coverage**: write **characterisation tests** for `packages/agent/src/**`, `packages/coding-agent/src/**`, all of `packages/ai/**`, and `packages/tui/**`. These are not TDD — they capture current (possibly buggy) behavior as executable specs. They land as the **migration obligation** noted in `packages/agent/CONTEXT.md` "Temporary code/test knowledge store" — at ADR-0006 phase 4 cutover, each characterisation test must either be ported to an Effect-shaped equivalent against the new code or carry a deletion note explaining the replacement behavior.

CI enforces per-package thresholds via `bun run --workspaces --if-present test:coverage:100` plus a root `coverage:all` aggregator that prints a unified report and exits non-zero if any package falls below 100%. No pre-commit hook (coverage is too slow for pre-commit; ~5-30s per package × six packages).

Rejected alternatives:
- **Effect-rewrite paths only**, excluding legacy `src/` and `pi-ai`: lower waste, faster, contradicts the maximalist directive. Would defer revealing dead code in legacy until phase 4 absorbs it.
- **Lines + Statements only**, matching the existing `coverage:agent:100` script: easier threshold to satisfy, but lets dead exported functions and untested branches sneak through. We pick the strict reading deliberately as a forcing function.
- **Live OpenAI API tests** guarded by `OPENAI_API_KEY`: catches real provider drift but adds CI flakiness and cost. Stub Layers already exercise the real provider Layer code path; provider drift is caught by pinning `@effect/ai-openai@4.0.0-beta.65` exactly (ADR-0004) and surfacing in PR review of the bump.
- **Playwright browser e2e for `pi-web-ui`**: adds a new toolchain and long-lived browser CI dependency. Out of scope for this ADR; revisit when `pi-web-ui` has substantial behavior beyond rendering stub-driven streams.

This ADR supplements **ADR-0015 (test-strategy)** — which defines *how* tests are structured (Effect-shaped Layer fixtures via `test-support` deep import) — by specifying *how much* is required and *how it's enforced*. It does not override ADR-0006's phased migration plan: legacy `src/` is still untouched until phase 4, but the characterisation tests landing in phase B become the executable acceptance criteria that phase 4 absorption must continue to satisfy.

## Status

accepted
