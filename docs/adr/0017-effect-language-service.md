# Editor LSP integration via `@effect/language-service`

The Effect rewrite (ADR-0001) makes the codebase dense in Effect-specific patterns — `Effect.gen`, `yield*`, `Schema.Class`, `Context.Service`, `Layer.effect`, `Stream` pipelines, `Schema.TaggedErrorClass` error unions. Stock `tsserver` understands the types but cannot warn on Effect-shaped anti-patterns: floating effects, missing context channels, `yield` where `yield*` is needed, `Effect.gen` adapter usage, generic services that can't discriminate at runtime, `Schema.Class` self-mismatch, outdated v3 APIs while we are on v4, and several dozen more (see the `@effect/language-service` README diagnostics table). Catching these at edit time — instead of after a long `tsgo` run or via a code review — is high-leverage for a 75K-LOC rewrite. We adopt `@effect/language-service` as the project-wide TypeScript LSP plugin.

The plugin is installed at the workspace root and wired in `tsconfig.json` under `compilerOptions.plugins`. It piggy-backs on the editor's TypeScript language service (`tsserver`); it does **not** run during `tsgo -p ...` builds, so it adds zero cost to CI or the production `bunx tsgo` typecheck path used in package scripts. The plugin's options (per-diagnostic severity, fix preferences) live in the same `plugins` entry under a typed key, with `$schema` pointing at the bundled `schema.json` for IntelliSense on the options.

The local checkout at `language-service-main/` is the upstream source — useful for proposing rules upstream (see `language-service-main/CLAUDE.md`'s "Developing new rules" workflow) but not the install target. The published `@effect/language-service` package on npm is what `node_modules/` resolves and what the LSP loads at editor start. Lockstep with the rest of the Effect v4 toolchain (ADR-0004): the language-service version is pinned to whatever matches `effect@4.0.0-beta.65`'s API surface. As of this ADR, `@effect/language-service@0.85.1` is current and supports both v3 (existing `packages/ai` legacy code) and v4 (`packages/agent/effect/`) via its `EFFECT_HARNESS_VERSION` switch internally; both surfaces light up in the editor without per-package config.

Workflow consequences:

- **Editors must use the workspace TypeScript version**, not the bundled one (otherwise the plugin doesn't load). VSCode: F1 → "TypeScript: Select TypeScript version" → "Use workspace version". JetBrains: dropdown in TS settings. NVim: vtsls plugin config. Documented in the root README's "Editor setup" section.
- **No tsgo coupling**. `tsgo` ignores `compilerOptions.plugins`. Build correctness still rests on `bunx tsgo -p ... --noEmit`. The plugin's value is purely interactive editing.
- **Diagnostics are advisory, not blocking**, except for the `❌`-severity rules that surface as plain TypeScript errors in the editor. CI does not run the plugin; we don't gate PRs on its output. If a rule proves load-bearing later, we promote it to a lint task with `oxlint`-equivalent gating.
- **Per-rule overrides** belong in the root `tsconfig.json`'s plugin entry, not scattered per-package — the rewrite paths and the legacy `packages/ai` paths share the rule baseline. If `packages/ai`'s v3 code triggers too much noise, we suppress per-rule globally rather than per-folder; the legacy package is being deleted (ADR-0003/0005) so cost is bounded.

Rejected alternatives:

- **Use the plugin only inside `packages/agent`** — would miss diagnostics on the future Effect rewrites of `packages/coding-agent` and `packages/web-ui` (ADR-0002, ADR-0005), and split editor experience across packages.
- **Wait until phase 4 cutover (ADR-0006) before adopting** — the rewrite paths under `packages/agent/effect/` are dense in Effect today; the plugin's value compounds with every new tracer bullet. Adopting late means catching anti-patterns after they're committed.
- **Replace with a custom ESLint plugin** — `@effect/language-service` ships with thirty-plus production rules already covering the surface; reinventing them is high-cost low-value. If we need oxlint integration later, we add it as a parallel gate, not a replacement.

## Status

accepted
