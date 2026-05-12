# Post-rewrite package layout

The monorepo restructures to five packages: **`pi-tui`** (untouched), **`pi-models`** (new — pure model-registry data and synchronous utilities, no Effect dep, browser-safe), **`pi-agent-core`** (rewritten in Effect; owns the agent loop, the in-repo OpenAI Codex Responses Effect provider, host-side OAuth flow, env-credential auto-detection, and session-resource handling via `Scope`), **`pi-coding-agent`** (rewritten in Effect; the `pi` CLI), and **`pi-web-ui`** (rewritten in Effect for the browser; consumes `@effect/ai-*` and `pi-models` directly). The previous `@earendil-works/pi-ai` package is deleted; on npm it stays at its last legacy `0.74.x` version with a `deprecated` field pointing users to `@effect/ai-openai` / `@effect/ai-openrouter` (for the provider abstraction) and `@earendil-works/pi-models` (for the model registry). All surviving packages move from the lockstep `0.74.x` line to a new lockstep `1.0.0` line when the rewrite ships.

## Consequences

- `pi-models` becomes a foundational leaf: depended on by `pi-agent-core`, `pi-coding-agent`, and `pi-web-ui`. It must stay free of `effect` and Node-only imports so the browser bundle stays clean.
- The image-model registry (`image-models.generated.ts`, `images.ts`, `images-api-registry.ts`) co-locates with the text registry in `pi-models` — same shape, same generator.
- The Codex Responses provider is in-repo Effect code inside `pi-agent-core`. If `@effect/ai` later ships a Codex package upstream, we can swap our in-repo provider for it at low cost and even consider splitting it out (the 7C option) for upstream contribution.
- The lockstep `1.0.0` understates the scope of breakage but signals "Effect rewrite line" clearly versus continuing the `0.x` line.
- The `@earendil-works/pi-ai` npm name is permanently retired; any future provider-abstraction work goes under `@effect/ai-*` upstream or in `pi-agent-core`.

## Status

accepted
