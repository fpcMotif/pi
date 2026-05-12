# Phased migration: product narrowing on 0.x main, then snapshot + Effect rewrite

The rewrite ships through five phases, separating the **product change** (provider narrowing) from the **technology change** (Effect adoption):

1. **`0.75.0`** — carve `pi-models` out of `pi-ai`. `pi-ai` re-exports from `pi-models`. No consumer changes. Ships from main as a normal patch.
2. **`0.76.0`** — narrow supported providers in `pi-ai` from 28 to OpenAI / OpenRouter / OpenAI Codex (ADR-0003). Regenerate `models.generated.ts`. Update `defaultModelPerProvider`, provider display names, docs, CHANGELOGs. Ships from main as a major-y minor.
3. **Cutover** — tag `v0.76.x` on main; branch `legacy` from that tag. `legacy` receives only critical fixes (security, severe regressions) for a bounded **6-month** window after `1.0.0` ships.
4. **Effect rewrite on main** — `pi-agent-core`, `pi-coding-agent`, and `pi-web-ui` are rewritten in Effect v4 over a sequence of large merges. Main is intentionally in-progress; willing users preview via `1.0.0-beta.N` tags published from main. Feature PRs are paused on main during this phase; new requests are triaged onto `legacy`.
5. **`1.0.0`** — lockstep release of all surviving packages (`pi-tui`, `pi-models`, `pi-agent-core`, `pi-coding-agent`, `pi-web-ui`). `@earendil-works/pi-ai` is deprecated on npm; legacy sunset clock starts.

This sequencing front-loads the user-visible breakage (provider removal) onto a continuously-releasing main, isolates the broken-during-rewrite window to a single explicit phase, and keeps a real escape hatch (the `legacy` branch) for users who can't migrate immediately. The rejected alternatives were: long-lived rewrite branch (high abandonment risk, merge conflicts with `models.generated.ts` regeneration), and pure strangler-fig (no facade to hide behind once `pi-ai` is deleted — would carry two complete impls for months).

## Status

accepted
