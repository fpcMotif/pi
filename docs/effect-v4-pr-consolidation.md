# Effect-v4 PR consolidation — how six refactor PRs became one

**Status:** the `claude/effect-v4-consolidated` branch supersedes PRs #1, #5, #6, #7, #9, #10.
**TL;DR:** PR **#9** (`claude/refactor-effectful-module-bakKb`) is the integration base — the only confirmed-**green** branch and a strict descendant of the shared #1 foundation. We grafted **6 unique correctness/feature commits from #10**, re-targeted onto #9's module layout, plus **~13 file-level cleanups from #5/#6/#7**. Everything else was subsumed or skipped. `react-doctor` was inapplicable (zero React — `web-ui` is Lit, `tui` is a bespoke renderer); a Lit/TUI anti-pattern audit was run instead and its P0 bugs were fixed.

This document exists so that future work (and future agents) can see *why* each decision was made without re-deriving the branch topology.

---

## 1. Lineage map

All three "big" branches were opened ~2–3 weeks before this consolidation and share the **#1 foundation** (`effect-rewrite/phase-1-thru-4-tdd`, 19 commits ending at `90a345b9`; fork point `b2b47fa0`; the true merge-base of the small PRs is `103d4626`). `main` had already advanced to contain the Effect-v4 phase-4 work (slices 12g/12h, durable `SessionStore`), so **every PR branch is a strict descendant of current `main`** — none is "behind".

```
main (9cb86b75, slices 12g/12h)
└─ #1  effect-rewrite/phase-1-thru-4-tdd        main +19   (CI ❌ stale lockfile)
   ├─ #9  refactor-effectful-module-bakKb        main +42   (CI ✅  ← INTEGRATION BASE)
   ├─ #10 effect-v4-session-tools-refactor-clean main +33   (CI ❌ stale lockfile)
   ├─ #5  simplify-codebase-raoCa   (1 commit on the #1/b2b47fa0 base)
   ├─ #6  simplify-codebase-tjE4x   (1 commit)
   └─ #7  simplify-test-stubs-tjE4x (1 commit)
```

**#9 and #10 diverged on session decomposition strategy** — both split the original monolithic `effect/session.ts`, into *different* files:

| | #9 (base) | #10 |
|---|---|---|
| session helpers | `compaction.ts`, `compaction-step.ts`, `attempt-stream.ts`, `history-accumulator.ts`, `lift-part.ts`, `retry.ts`, `token-capture.ts`, `type-guards.ts`, `agent-input.ts` | `session-compaction.ts`, `session-parts.ts`, `session-retry.ts` |
| test-support | `script-runner.ts`, `openai-stub-helpers.ts` | `scripted-cursor.ts`, `_not-implemented.ts` |

Same goal, incompatible layouts. The two refactors **cannot both be merged** — one must be the base and the other's *unique value* grafted on top.

### Why #10 was RED (and why it doesn't matter)
`#1` and `#10` fail CI on `bun install --frozen-lockfile` — a **stale `bun.lock`**, not broken code. #9 carries the fix (`cfe7cce3 chore: refresh bun.lock`). **Never pull #10's lockfile over #9's** or you reintroduce the red state.

---

## 2. Why #9 is the base, not #10

- The **only branch with green CI**.
- The **deeper, cleaner decomposition**: `session.ts` went 752 → 399 LOC, orchestration-only, over 7 single-responsibility modules.
- A **strict descendant of the #1 foundation** shared by #5/#6/#7/#10, so their unique cleanups graft onto it.
- Carries the scoped-but-honest 100% coverage gate (see §6 watch-item).

#10's *refactor* commits are redundant with — and conflict against — #9's own (divergent) extraction. Only #10's *correctness* commits have unique value.

---

## 3. The 6 grafted #10 commits (ordered, with the bug each closes)

Each was adversarially verified (is it real? is it absent from #9?) and re-targeted onto #9's files (the raw commit diffs are against #10's layout and do not apply cleanly). Order is dependency-correct.

1. **`a89f4000` — Semaphore-guard the KV session-store index.** `layerKeyValueStore.save/remove` did read-modify-write on the `SessionIndexV1` with no mutual exclusion → two concurrent `save()` calls could lose an id (lost-update). Adds a per-`KeyValueStore` `Semaphore.makeUnsafe(1)` via a `WeakMap`, wrapping `save/remove/list` in `withPermit`. *Grafted clean* — #9 left `stores/` untouched. Brings the concurrent-save regression test.
2. **`c3cba209` — compaction token estimate covers all Prompt part types.** `messageChars` counted only text/tool-call/tool-result, so reasoning blocks, file payloads, and tool-approval parts contributed **zero** chars — a reasoning- or file-heavy session could slip past `COMPACTION_THRESHOLD` and blow the context window. Now an exhaustive `switch` + `jsonChars`/`fileDataChars`. Adopted #10's typed `compaction.test.ts` (also removes `as never` casts, +3 part-coverage tests).
3. **`bb17ffe9` — preserve load-bearing facts in the compaction summary prompt.** *Surgical graft:* only the preservation preamble ("Preserve exact file paths… the prefix being summarised will be DISCARDED…") + the `## Critical Context` section into #9's `compaction-step.ts`, plus **ADR-0019**. The bundled cosmetic churn (absorbPart/captureUsage/retry) was dropped — it already lives in #9's modules.
4. **`d453a642` — `composeHooks` lifecycle adapter** into `hooks.ts`, plus **ADR-0018** + `hooks-compose.test.ts`. ⚠️ **Subtle:** adversarial review correctly found this is *dead code as a standalone* on #9 (zero callers), **BUT** commit #5 below imports `composeHooks` without defining it — so this is a hard **compile prerequisite**. Bundle them; do not "optimise away".
5. **`393b515c` — session resilience.** Two fixes: (a) **persist the accepted user turn BEFORE compaction** opens its summary call, re-persisting post-compaction only when `compactionEvent !== undefined` — a compaction-summary failure on a durable session no longer loses the turn; (b) wrap `yield* Hooks` in `composeHooks(...)` so a defect in a single user hook is absorbed (the n=1 path now matches n≥2). Re-targeted onto #9's `runCompactionStep` call site and `yield* Hooks` read.
6. **`1c234ca9` — Schema-validate `AcceptedPromptEnvelope` before mutating history.** `promptFromAcceptedEnvelope` is now an `Effect` that decodes `injectedMessages` + the final user message; a malformed envelope fails with `SchemaError` and leaves `turnCount` at 0. The call site was **hoisted out of the synchronous `SubscriptionRef.update`** (it is now an Effect). Bundled with #5 — both touch the same pre-update region of `session.ts`.

---

## 4. The #10 SKIP list (and why)

| commit | reason |
|---|---|
| `b4571a22`, `ec96a815`, `f2c160ae`, `ded9b398`, `a552d1de` | refactors redundant with #9's own (divergent) extractions; would conflict for zero behavior gain |
| `88eaf019` | ~40-file branch-baseline green-up already satisfied by #9's green CI (ModelThinkingLevel rename, DOM lib, lint churn) — **never re-run, never pull its lockfile** |
| `86f170e1` | test-only; the behavior it asserts already holds in #9 |
| `c8dd9bbe` | CONTEXT.md prose describing #10's file layout — fresh entries were written for the grafted features instead |

---

## 5. The #5/#6/#7 cleanups

All three are single-commit cleanups on the #1/`b2b47fa0` base. Their large diff-stats against `effect-rewrite/phase-1-thru-4-tdd` are an artifact of diffing the wrong base. Each was **re-implemented by hand** (raw cherry-pick conflicts on stale bases):

- **#5 (`d7ee8530`)** — `agent-session-metrics.ts` single-pass switch + inline compaction-index scan + **narrowed `getAgentSessionStats`/`getAgentSessionContextUsage` signature** (`{model:{contextWindow?}}` → primitive `contextWindow`); the `agent-session.ts` call site is a **mandatory pair** with that signature change. Plus `tui-overlay.ts` `parsePercent` + `measureOverlay`/`positionOverlay` split, the `KITTY_PREFIX` dedup across `terminal-image.ts`/`tui-render-helpers.ts`, and `getLastAssistantText`'s backwards loop. **Dropped** #5's `effect/session.ts` comment-trim (subsumed — #9 rewrote and reordered compaction-vs-history; #5's trimmed comments describe the stale pre-reorder ordering). The signature change required updating `agent-session-metrics.test.ts`.
- **#6 (`8f0b35e6`)** — removed the inline `directStubLanguageModelStream` duplicate in `session-liftpart-primitives.test.ts`, swapping all 6 call sites to the shared `stubLanguageModelStream` (byte-identical helper) and dropping the now-unused `Layer`/`LanguageModel` imports.
- **#7 (`676b29ac`)** — `dieUnimplemented(stubName, method)` factory for the LanguageModel stubs' loud-die thunks, plus the `session-cancellation.test.ts` simplification. Preserved #9's independent `summaryCalls`/`summaryError`/`summaryLatch`/`advanceScript` additions on those stub files. Note the deliberate two-idiom split: `dieUnimplemented` (factory) for LanguageModel stubs vs #9's `notImplemented*` constants for OpenAiClient stubs (disjoint method sets).

---

## 6. Carried-forward debt & watch-items

- **Type escapes from #9** (documented; revisit on an `@effect/ai` bump per ADR-0004): `attempt-stream.ts` `as never` on the `streamText` overload + `Prompt.make` append; the unknown-payload type-guards duplicated across `lift-part`/`history-accumulator`/`token-capture`; the retry-predicate double-cast in `retry.ts`.
- **Coverage-exclusion watch-item:** #9's scoped gate excludes a large real surface (coding-agent CLI/TUI/RPC/print modes, native bindings, provider SDK wrapping, the in-progress `effect/tools` ports). 100% is honest for the *included* surface — keep integration suites / `pi-test.sh` running in CI so the exclusions don't become a blind spot as the rewrite lands remaining slices.

---

## 7. Post-consolidation quality backlog (from the Lit/TUI + architecture audit)

`react-doctor` was requested but is **inapplicable**: the repo has **zero** React/JSX/TSX. `web-ui` uses **Lit**; `tui` is a bespoke synchronous renderer (its manual `invalidate()`/`setText()` is by design, not a bug). A Lit-lifecycle audit was run instead.

**Fixed in this branch (P0):**
- `web-ui/.../tools/artifacts/HtmlArtifact.ts` — `updated()` re-executed the sandbox (teardown + new iframe) on *every* reactive update for any artifact that never logs (the `logs.length === 0` guard was always true). Now keyed on content identity via `_executedContent`.
- `web-ui/.../components/SandboxedIframe.ts` — the `open-external-url` window `message` listener was added on every `loadContent` and never removed (only `readyHandler`/`errorHandler` were), leaking a permanent global listener per reload. Now stored on the instance and removed before each load and in `disconnectedCallback()`.

**Open backlog (prioritised):**
- **P0 — promote `Session` to a `Context.Service`.** It is the lone major boundary that is *not* a service (`SessionStore`/`Hooks`/`LanguageModel`/`Tracer` all are), so ADR-0008's host pattern can't resolve it from the `ManagedRuntime` and tests can't provide a fake `Session` Layer. Highest-leverage architecture deepening.
- **P1 — reconcile `Session.send`'s declared error channel.** Typed `Stream<…, AgentError, …>` advertises `ToolError|CancellationError|StoreError` but the loop only constructs `LlmError`/`CompactionError`. Either narrow the type or actually map tool-boundary failures + surface interruption as the typed `CancellationError` (the ADR-0008 graceful-stop contract).
- **P1 — per-`Session` serialization** for the read-snapshot-through-commit critical section of `send` (mirrors ADR-0012 store locking; dovetails with the grafted `a89f4000`).
- **P1 — `MessageList` keyed `repeat()`** by stable message identity, not running index (index keys defeat keyed reconciliation when messages are inserted/filtered).
- **P2 —** `effect/index.ts` public-surface barrel; eliminate the retry-predicate double-cast (compute `isRetryable` once at `LlmError` construction); replace `StreamingMessageContainer`'s per-frame `JSON.parse(JSON.stringify(...))` deep-clone; route `MemoryLayer.save` through the same `makeSessionRecord` guard as the production layer.

---

## 8. How this was produced

A multi-agent review workflow (14 agents) mapped all six PRs read-only, adversarially verified each candidate graft against #9 (is it real? already present?), and synthesised the ordered graft plan above. Grafts were applied and tested one at a time (`packages/agent` effect suite: 191 tests green throughout); the small-PR cleanups and Lit fixes followed. See the branch commit history for the per-graft commits, each crediting its origin commit.
