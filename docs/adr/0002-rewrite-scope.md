# Rewrite scope: delete pi-ai, rewrite pi-agent-core / pi-coding-agent / pi-web-ui, leave pi-tui

`pi-ai` is **deleted** as a package — its provider abstraction is superseded by `@effect/ai-openai` and `@effect/ai-openrouter` (ADR-0003), and there is no facade survival. `pi-agent-core`, `pi-coding-agent`, and **`pi-web-ui`** are all rewritten on Effect v4. `pi-tui` is the only package kept as plain TypeScript — it is a generic, independently-published terminal renderer with external consumers and per-frame synchronous concerns that Effect does not improve. The model registry (`models.generated.ts` + `models.ts`) — which `@effect/ai` does not replicate — moves to a new shared package consumed by `pi-agent-core`, `pi-coding-agent`, and `pi-web-ui` (see ADR-0005).

## Revision history

- Originally: `pi-ai`, `pi-agent-core`, `pi-coding-agent` rewritten; `pi-tui`, `pi-web-ui` untouched.
- Revised after Q5 resolved to delete `pi-ai` entirely (rather than survive as a facade), which forced `pi-web-ui` to either be rewritten or be pinned to legacy. Q6 resolved to rewrite `pi-web-ui` (option 6α).
