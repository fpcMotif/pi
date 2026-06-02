# Effect Refactor PR Stack Review

Date: 2026-06-01

This note tracks the open Effect rewrite PR stack so future review starts from the right branch instead of re-reading stale overlapping PRs.

## Stack Status

- PR #12 (`claude/effect-v4-consolidated`) is the merged consolidation PR for #1/#5/#6/#7/#9/#10. Future hardening should target `main` or a follow-up branch.
- PR #10 (`effect-v4-session-tools-refactor-clean`) is the older session-helper split branch. Treat it as a source branch already harvested into #12, plus a useful comparison point for missing fixes.
- PR #9 is the green base branch that #12 builds on. Its decomposed helper layout differs from #10 and is the shape #12 chose for the final consolidation.
- PR #6 and PR #7 are smaller cleanup PRs against `effect-rewrite/phase-1-thru-4-tdd`; their intended outcomes are covered by #12's test-support dedupe work.
- PR #5's independent simplifications are included in #12.
- PR #1 is the broad phase-4 base and is superseded by #12.
- After #12 merged, the remaining open superseded PRs (#5, #6, #7, #10) were each commented and closed.

## Review Gate

- `gh pr view 12` reports PR #12 merged, non-draft, and green: `build-check-test-coverage` passed on 2026-06-01.
- `gh pr view` reports the original stack is no longer open: #1 closed, #5/#6/#7/#10 closed as superseded, #9 merged, and #12 merged.
- The final local hardening pass was done in `/private/tmp/pi-pr12` on `codex/bun-only-toolchain-hardening` based on `origin/main`, not the older local #10 lineage.
- The active toolchain is Bun-only for repo scripts, CI, binary-build workflow, Husky, self-update, and pi-managed registry packages. Use `bun install`, `bun install --frozen-lockfile`, `bun run check`, and focused `bunx vitest --run ...` commands.
- The previous `npmCommand` escape hatch is replaced by `bunCommand`; non-Bun command overrides are rejected.
- User-facing update instructions reuse the same Bun ownership/writability check as self-update execution, so unmanaged Bun-shaped installs do not get misleading `bun install -g ...` guidance.
- `package-lock.json` is removed. `bun.lock` is the package-manager truth.
- Manual TypeScript probes and generator scripts use direct `bun`, not legacy TS-runner paths.
- Bun-native `version-workspaces.mjs` and `publish-workspaces.mjs` back the root version/publish scripts.
- `react-doctor@latest` does not apply to this repo right now: version 0.2.15 exits with `NoReactDependencyError` because the web package is Lit-based and there is no React dependency.
- Remaining npm-looking strings are historical changelog entries, package-source protocol labels such as `npm:@scope/pkg`, or generated registry headers that must be changed through their generator path.
- A full local `bun run test` pass required redirected home/session/temp dirs because the suite writes runtime state and opens loopback ports under the coding-agent tests.
- The only full-suite failure found during this pass was a footer reftable watcher race. It is fixed locally by keeping the `watchFile` fallback independent from optional `fs.watch` watchers and priming one refresh after reftable setup.

## Verification

```sh
bun install
bun run check
bunx vitest --run test/config.test.ts test/package-manager.test.ts test/package-command-paths.test.ts test/stdout-cleanliness.test.ts test/git-update.test.ts test/effect/tools/bash.test.ts
HOME=/private/tmp/pi-pr12-home PI_CODING_AGENT_DIR=/private/tmp/pi-pr12-agent-dir PI_CODING_AGENT_SESSION_DIR=/private/tmp/pi-pr12-session-dir TMPDIR=/private/tmp/pi-pr12-bun-tmp bun run test
bun test/codex-websocket-cached-probe.ts --help
bun test/sdk-codex-cache-probe-tool-loop.ts --help
bun test/rpc-example.ts --help
bun test/streaming-render-debug.ts
bun test/test-theme-colors.ts dark
bun scripts/version-workspaces.mjs patch --dry-run
bun scripts/publish-workspaces.mjs --list
bun scripts/publish-workspaces.mjs --dry-run
bun add file:<local-package>
bun remove <local-package-name>
bun install --production
bun info typescript version --json
bunx react-doctor@latest --json --no-score --fail-on none .
git diff --check
gh pr view 12 --json number,title,state,mergeable,isDraft,headRefName,baseRefName,url,statusCheckRollup
gh pr checks 12
```

Results:

- `bun run check` passed end to end.
- Focused self-update regression checks passed: `test/config.test.ts` and `test/package-command-paths.test.ts` (19 passed, 1 Windows-only skip).
- Focused Bun/toolchain regression suite passed: 6 test files, 138 tests passed, 1 Windows-only skip.
- Real Bun CLI command-shape probes passed for project-local package add/remove, git dependency production install, and registry version lookup (`bun info ... version --json` returns a JSON string).
- Full workspace `bun run test` passed: models 38, tui 1128, ai 376 with 6 skipped, agent 496, coding-agent 1379 with 27 skipped, web-ui 835.
- Manual probe/help smoke paths passed with direct `bun`; `rpc-example.ts --help` now avoids accidental agent startup.
- Workspace version/publish helper smoke checks passed: version dry-run would update 6 packages from `0.74.0` to `0.74.1`; publish order lists the 6 non-private packages in dependency order; publish dry-run packs all six packages via `bun pm pack --dry-run` without registry auth.
- `git diff --check` passed with only the expected `pi-test.ps1` LF/CRLF warning.
- PR #12 remote CI is green and the PR is merged.
