# CLI framework: migrate to `effect/unstable/cli`

`pi-coding-agent`'s ~15 KB hand-written `cli/args.ts` is replaced by `effect/unstable/cli`. Modes (`text`/`json`/`rpc`) become subcommands (`pi`, `pi json`, `pi rpc`), with the legacy `--mode <name>` flag preserved as a hidden alias for one release after `1.0.0` to ease migration. Shell completions become a first-class subcommand: `pi completions bash | zsh | fish | pwsh`. Parse-time diagnostics (warnings/errors collected during parsing today) become typed `CliWarning` / `CliError` outputs through `CliOutput`. The two pi-specific behaviors verified during a small upfront spike: **unknown-flag passthrough to extensions** (kept via a post-parse residue shim if `Command` can't express it directly), and **the existing flag vocabulary** including repeatable lists (`--extensions`, `--tools`, `--skills`, `--themes`) — both map cleanly onto `Flag.repeated` in v4.

The rejected alternatives were: keeping the custom parser (leaves the most user-visible code as imperative Promise-land — contradicts ADR-0001's "idiomatic Effect throughout"), and a hybrid (two parsing systems sitting next to each other, ongoing tax).

Risk acknowledged: `effect/unstable/cli` carries no semver guarantee between v4 beta bumps. Mitigated by pinning to exact beta versions and budgeting half a day per bump (already accepted globally in ADR-0004).

## Status

accepted
