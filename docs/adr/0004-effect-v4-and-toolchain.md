# Effect v4 (beta) substrate + oxlint/oxfmt + TS 7.0 native

The rewrite targets **Effect v4** (currently in beta; codenamed "smol" in the upstream repo). v3 would force a guaranteed second migration to v4 within the rewrite's own shelf life; starting on the destination pays the migration cost once and aligns with Effect v4's smaller bundle, consolidated package surface, lockstep versioning, rewritten fiber runtime, and built-in `effect/unstable/ai` AI/MCP module that already covers the providers we want (`@effect/ai-openai`, `@effect/ai-openrouter`). Toolchain: **oxlint** for lint and **oxfmt** for format, replacing biome; **`@typescript/native-preview` (tsgo / TS 7.0 beta)** stays as the compiler, which is already used in pi-mono today.

## Consequences

- The `effect/unstable/*` namespace (including `ai`, `schema`, `cli`, `http`, `observability`) explicitly carries no semver guarantee between beta releases. Pin every beta version exactly; budget time per bump for breakage.
- Choice diverges from upstream effect-smol's own format toolchain (they use dprint). oxfmt is newer and less battle-tested; if its TS output diverges from what we want we may have to fall back to dprint or biome-format-only.
- TS 7.0 is still pre-release; some IDE integrations may lag. Mitigated by pinning to a specific dev build, as pi-mono already does.
- Documentation, blog posts, and third-party Effect integrations are still mostly v3-shaped — source code in `effect-smol-main/` and `effect-smol-main/LLMS.md` are the authoritative reference for the rewrite.

## Status

accepted
