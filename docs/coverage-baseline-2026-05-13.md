# Coverage baseline — 2026-05-13

Snapshot taken after ADR-0017 phase A (infrastructure unification). Records the starting % per package per metric so phases C and B can target the actual gaps. Delete this file once all packages are at 100% across the board.

## Per-package state

### @earendil-works/pi-agent-core
- **Lines: 100% • Statements: 100% • Functions: 100% • Branches: 91.75%**
- 48 test files, 252 tests, all passing.
- Branch gaps in: `src/harness/agent-harness.ts` (86%), `src/harness/skills.ts` (82.9%), `src/harness/compaction/branch-summarization.ts` (82.35%), `src/harness/session/repo/memory.ts` (78.57%), `src/harness/env/nodejs.ts` (86.32%), `src/harness/utils/shell-output.ts` (90.47%), `src/harness/session/repo/jsonl.ts` (90.32%), `src/harness/compaction/compaction.ts` (92.72%).
- `src/types.ts` reports 0/0/0/0 — pure type-only file with no coverable runtime code; does not drag the aggregate (0/0 contributes weight 0). Confirmed via `All files` row showing 100% Lines/Stmts/Funcs.

### @earendil-works/pi-tui
- **Lines: 74.32% • Statements: 74.32% • Functions: 76.56% • Branches: 81.91%**
- 22 test files, 570 tests passing, 16 skipped, all under vitest (ported from `node --test` in phase A.3).
- 0%-coverage files: `src/editor-component.ts`, `src/components/box.ts`, `src/components/cancellable-loader.ts`, `src/components/loader.ts`, `src/components/settings-list.ts`, `src/components/spacer.ts`, `src/components/text.ts`, `src/index.ts`.
- Partial coverage: `src/autocomplete.ts` (51.2%), `src/terminal.ts` (18.83%), `src/terminal-image.ts` (41.54%).
- Phase B.4 fills these.

### @earendil-works/pi-coding-agent
- **Coverage measurement BLOCKED** — 23 test failures across 11 files prevent the run from completing.
- Failing tests include `test/suite/regressions/3302-find-path-glob.test.ts` (find returns `[]` for path-prefixed glob patterns like `some/parent/child/**`). Pre-existing bug on the branch; tracked separately.

### @earendil-works/pi-models
- **No tests.** Phase A.4 added the vitest config + scripts; phase C.6 writes the tests.

### @earendil-works/pi-web-ui
- **No tests.** Phase A.6 added the vitest config + happy-dom; phase C.7 writes the tests.

### @earendil-works/pi-ai
- Not yet measured. Has an existing test suite (`test/`); needs coverage run. Phase B.3 closes the gaps. Deprecated per ADR-0005 but in coverage scope per ADR-0017.

## Aggregate (rough)

| Metric | Where we are | Target |
|---|---|---|
| Lines | mixed: agent 100, tui 74 | 100 |
| Branches | agent 92, tui 82 | 100 |
| Functions | agent 100, tui 77 | 100 |
| Statements | agent 100, tui 74 | 100 |

## Progress 2026-05-13 (post-grilling session)

After ADR-0017 phase A landed and the first wave of phase C tests:

| Package | Lines | Branches | Functions | Statements | Status |
|---|---|---|---|---|---|
| pi-models | 100 | 100 | 100 | 100 | ✓ phase C.6 done |
| pi-agent-core / effect/ | 100 | 100 | 100 | 100 | ✓ phase C.4 done |
| pi-coding-agent / effect/ (3 tool ports) | 100 | 100 | 100 | 100 | ✓ phase C.5 done |
| pi-agent-core / src/ | 100 | ~95 | 100 | 100 | phase B.1 to close |
| pi-tui | 74 | 82 | 77 | 74 | phase B.4 to close |
| pi-coding-agent / src/ | blocked on 23 test failures | - | - | - | task #20 blocks |
| pi-ai | not measured | - | - | - | phase B.3 |
| pi-web-ui | no tests yet | - | - | - | phase C.7 |

## Realistic e2e scenarios (phase C.3 — landed)

`packages/agent/test/effect/e2e/realistic-conversation-flows.test.ts` — 22 describe blocks (31 `it.effect` cases), each composing ≥3 already-landed slices:

1. Multi-tool turn (Grep→Read→Edit pattern) — streaming + tool lifting + history + usage
2. Retry sequence preserves once-per-send invariants (3 sub-cases: success-after-retries / non-retryable / cap-exhausted)
3. Reasoning + text + tool interleaved preserves arrival order
4. 5-turn conversation usage accumulation
5. NewPrompt→Retry→Retry rollback chain (2 sub-cases)
6. Telemetry under retry — span count matches attempt count (3 sub-cases)
7. Failing tool results land in history with isFailure preserved (2 sub-cases)
8. Parallel sessions don't cross-contaminate state
9. Zero-content stream produces user msg only, no empty assistant
10. Multi-block text segmentation across one turn
11. Zero-output usage (cache-hit) lands cleanly (2 sub-cases)
12. Deltas reconstruct exact source text byte-for-byte
13. Reasoning preserved per-turn across multi-turn arcs
14. Defensive interleaved deltas without markers preserve order
15. Text-only send (no toolkit) completes cleanly
16. Stream laziness — turnCount increments per runDrain
17. pi.history.size attribute is post-mutation (3 sub-cases)
18. Retry on empty session is a no-op (1 sub-case)
19. SubscriptionRef.changes observable for state-driven UIs
20. Pre-upstream history append survives upstream failure
21. Per-send retry counters don't leak across parallel sessions
22. Full lifecycle smoke — 4-turn arc composing every landed slice

All 31 cases pass against stub Layers exercising the real provider Layer code path (`OpenAiLanguageModel.makeStreamResponse` for the SSE-driven cases, direct `LanguageModel.LanguageModel` substitution for the part-sequence-driven cases). No live API keys.

## Phase plan

- **C.1, C.2**: land deferred compaction and skill-block-parsing slices (TDD).
- **C.3**: 20+ realistic e2e scenarios composing already-landed slices.
- **C.4**: close `packages/agent/effect/**` branch gaps (mostly `session.ts:185,253,339` — likely unreachable Effect-machinery branches; verify before adding `/* v8 ignore */`).
- **C.5–C.7**: cover coding-agent/effect, models, web-ui to 100%.
- **B.1–B.4**: characterisation tests for legacy `src/` and deprecated `pi-ai`.
- Separate: fix 23 coding-agent find-tool regressions.
