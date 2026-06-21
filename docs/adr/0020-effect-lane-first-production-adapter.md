# First production adapter for the Effect lane: flagged print mode with a versioned event schema

The Effect lane (`packages/agent/effect/`, `packages/coding-agent/effect/`) has zero production adapters: every importer lives under `test/` or `test-support/`, and there are zero `runPromise` / `runFork` / `ManagedRuntime` calls in either `src/` tree. The live CLI still runs the legacy Promise stack, so five subsystems exist as divergent twins and fixes don't propagate (the 882-line legacy compaction module was actively edited while its 228-line Effect twin sat untouched). The lane fails the deletion test as shipped.

This ADR records the decision tree for crossing that gap: stand up the ADR-0008 `ManagedRuntime` host in the `pi` process and route **print mode** (`pi -p` / `--mode json`) through the Effect lane as the first production adapter. Print mode is the smallest of the four production `AgentEvent` consumers (interactive 2632, web-ui 153, rpc 357, print 103 — `session.subscribe` call sites), is already on CONTEXT-MAP's open-ports list, and exercises the full loop (tools, compaction, retry, persistence) without a terminal.

## Decisions

1. **Rollout: opt-in flag, legacy default.** An experimental flag (working name `--effect`; exact spelling is implementation-tier) routes print mode through the `ManagedRuntime` host. Legacy print mode stays the default until parity. This makes the mode seam real — two adapters (legacy Promise stack, Effect host) behind one print-mode interface — and lets characterization tests pin the legacy behaviour before any cutover.

2. **Event schema: both shapes, behind `--events v1|v2`.** The Effect lane natively emits the ADR-0009 `AgentEvent` union (`LlmPart | ToolDispatched | ToolCompleted | CompactionApplied | Finish`); legacy `--mode json` emits the `AgentSessionEvent` union. Under the flag, `--events v1` (default) maps Effect events onto the legacy JSON shape; `--events v2` emits the new union as-is. The v1 mapper is not throwaway: it is the parity harness — the same characterization suite runs against legacy and flag+v1, and it becomes the compatibility bridge other modes can reuse at cutover.

3. **v1 fidelity contract: documented-gaps parity.** Core flow is bit-compatible and pinned by characterization tests: message streaming, tool execution, finish, error surfaces, exit codes. Documented gaps, accepted rather than distorting the loop for observability it no longer has:
   - `auto_retry_start` / `auto_retry_end` are absent — retry is internal to `Stream.retry`; attempts are telemetry spans (`pi.Session.send.attempt`), not events.
   - `compaction_start` timing is approximated — the Effect loop emits a single post-hoc `CompactionApplied`; the mapper synthesizes the start/end pair late.
   - `queue_update` / `session_info_changed` / `thinking_level_changed` map only where the single-shot flow produces them (mostly never).

4. **Session becomes a scoped `Context.Service`; the registry is deferred.** A `Session` service tag whose Layer builds one durable session per process scope (`Layer.scoped(Session, Session.durable(id))` or ephemeral for tests) resolves the consolidation backlog's P0: ADR-0008's host can resolve Session from the runtime, and tests can provide a fake Session Layer. Multi-session semantics (`newSession` / `fork` / `switchSession` — today's `AgentSessionRuntime` surface) are interactive-mode territory and get their own design when interactive mode crosses the seam. No speculative registry now.

5. **Provider gap: typed error, Codex port is its own slice.** `Session.send` requires a `LanguageModel` and only `@effect/ai-openai` is wired. Flag-on with an unsupported model fails with a clear typed error naming the supported set. The in-repo OpenAI Codex Responses provider is ported to `effect/unstable/ai` as its own tracer bullet, not as a rider on this slice.

6. **Extensions: skip + warn under the flag.** Flagged print mode does not load extensions; a stderr warning names the limitation. Extension support arrives with ADR-0014's `Extension.make` work, not as a side quest here.

7. **Persistence: `SessionStore`, parallel namespace.** Flagged runs persist through the schema-versioned `SessionStore` (`SessionRecordV1` over `KeyValueStore`), written beside — not into — the legacy JSONL store. This exercises the persist-before-compaction correctness path (the PR #10 grafts) in production, which is the point of a real adapter. Flagged sessions are not resumable from the legacy picker; documented. No dual-write of the legacy format ADR-0007 already sentenced to a clean break.

## Step-2 staging notes (added after the slice-2 adversarial review)

- **`--events` is explicit-only while the v1 mapper is missing.** Decision 2's v1 default takes effect at step 3. Until then, `--effect --mode json` *requires* `--events v2` — a silent v2-today default would flip every script's output schema when the v1 default lands. `--events v1` errors with a pointer to step 3.
- **The parallel namespace derives from the RESOLVED session dir** (`--session-dir` / `PI_CODING_AGENT_SESSION_DIR` / settings), as its sibling `effect-sessions` directory — so sandboxes built on session-dir overrides contain flagged runs too. Default resolves to `~/.pi/agent/effect-sessions`.
- **The supported-model gate is a positive allowlist** — provider `openai` with api `openai-responses` (what `@effect/ai-openai` actually speaks) — not a provider-only exclusion.
- **`Session.send` persists the completed turn.** The slice-2 review found durable records contained only the accepted user turn (persistence ran at post-input and post-compaction only); the loop now persists the final snapshot — assistant turn and token totals — on successful stream exit, before the shutdown hook, mirroring the ADR-0018 persist-before-hooks discipline. Failure/interrupt exits keep the accepted-turn snapshot untouched.
- **Built-in tools are not wired yet**: the coding-agent effect lane (`effect/tools`) is not packaged for `src/` imports; the toolkit lands as its own slice after the lane gets the same build/export treatment pi-agent-core received here. The experimental stderr warning names the limitation.
- Session-selection flags (`--continue`/`--resume`/`--session`/`--fork`/`--no-session`) are ignored under the flag (warned on stderr); `--help`/`--list-models` keep their legacy handling and win over `--effect`.

## Verification loop

Per the deepening discipline — the interface is the test surface:

1. Characterise current print-mode behaviour with tests at its interface (stdout JSON lines, text output, exit codes, signal handling) → green on today's code. (The existing `test/print-mode.test.ts` covers only `session_shutdown` + exit codes; the suite needs building out first.)
2. Stand up the host + Session service + flag + `--events v2` path → characterization tests stay green (legacy default untouched); new v2 tests green at the Session interface.
3. Implement the v1 mapper → the same characterization suite passes against flag+v1, minus the documented gaps (encoded as explicit test exclusions, not silent omissions).
4. Cutover (separate, later decision): flip the default, delete the legacy print path and its superseded tests.

## Rejected alternatives

- **Replace print mode outright** — breaks `--mode json` consumers immediately and forces the provider-coverage question up front.
- **Land as ADR-0011's `pi json` subcommand** — the cleanest end-state home, but couples this candidate to the unstarted `effect/unstable/cli` rewrite; the flag adapter migrates into the subcommand when ADR-0011 executes.
- **v2-only event output** — no consumer breaks behind an opt-in flag, but it forfeits the parity harness; the mapping work would resurface at cutover with less leverage.
- **Strict v1 bit-compatibility** — requires adding retry/compaction observer hooks to the Effect Session whose only consumer is the mapper; distorts the loop for legacy observability.
- **Core-only minimal v1 (silent drops)** — silent truncation makes parity tests lie about coverage.
- **Sessions registry service now** — designs interactive-mode swap semantics before any interactive consumer exists; a hypothetical seam.
- **Silent fallback to legacy on unsupported models** — the flag's meaning becomes ambiguous; routing bugs hide.
- **Ephemeral-only (no persistence)** — leaves the durable path, where the grafted correctness fixes live, production-untested.
- **Dual-write legacy JSONL** — new code writing a format already sentenced to a clean break (ADR-0007).

## Status

accepted
