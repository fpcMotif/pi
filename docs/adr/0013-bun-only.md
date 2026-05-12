# Bun-only distribution for the `pi` CLI

The `pi` CLI ships only as a single-file Bun-compiled binary (via `bun build --compile`). The Node-shaped entry (`dist/cli.js` via `npm install -g @earendil-works/pi-coding-agent`) is removed. The Effect platform Layer wired in at startup is `@effect/platform-bun` (`BunFileSystem`, `BunPath`, `BunHttpClient`, `BunChildProcessSpawner`, `BunRuntime`, `BunStdio`, etc.) — `@effect/platform-node` is not a dependency. `pi-coding-agent` remains publishable to npm as a **library** (its `exports` for `.` and `./hooks` continue) so the agent can still be embedded programmatically and extensions can still be authored as npm packages, but the package no longer carries a `bin` entry. Distribution of the `pi` binary itself moves to GitHub Releases.

## Consequences

- The npm-ecosystem install flow (`npm install -g`, `npx`) is dropped for `pi`. Users on locked-down Node environments who can't run a single-file binary lose a path. Documented as a 1.0 breaking change.
- The Bun-only `restore-sandbox-env.ts` workaround stays in place. The Bedrock-specific Bun init (`register-bedrock.ts`) is deleted with the provider narrowing (ADR-0003).
- Cross-process locking for Stores (ADR-0012) is implemented against Bun's primitives (flock-equivalent or native lock APIs) rather than `proper-lockfile` (a Node-shape lib). `proper-lockfile` and `undici` are removed from `pi-coding-agent` dependencies.
- Bun-incompatible deps need vetting: `koffi` (Node-API FFI — Bun's Node-API support has historically been incomplete; verify or replace), `@silvia-odwyer/photon-node` (Rust WASM — usually fine), `proper-lockfile` (replaced), `cli-highlight`/`marked`/`yaml`/etc. (pure JS — fine).
- Test matrix simplifies to Bun-only. `vitest` runs under Bun's Node-compat. The dual-test scripts (`pi-test.sh` / `pi-test.ps1`) keep the Bun path; the Node-path is removed.
- HTTP fetch goes through `BunHttpClient` (which wraps Bun's native fetch) instead of `undici`. `undici`'s `bodyTimeout: 0 / headersTimeout: 0` workaround in `cli.ts` gets translated to the equivalent `BunHttpClient` config.
- The `@earendil-works/pi-coding-agent` npm package, sans `bin`, is purely an SDK install (`npm install @earendil-works/pi-coding-agent` gets you the embedding API; the CLI comes from a separate release artifact).

## Status

accepted
