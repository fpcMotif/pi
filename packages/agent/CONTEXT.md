# pi-agent-core

`@earendil-works/pi-agent-core` — the agent runtime. This package is the rewrite target per ADR-0005. During ADR-0006 phases 1-3 it continues to ship the existing TypeBox / Promise-shaped agent loop under `src/`. The Effect v4 rewrite lands under `test-support/` and `test/effect/` first as TDD tracer bullets, then takes over `src/` during phase 4.

## What's where

- **`src/`** — Existing pi-agent-core (TypeBox, async iterators, `@earendil-works/pi-ai` deps). Untouched by the rewrite until phase 4.
- **`test/`** — Existing tests for the existing `src/`. Under the root AGENTS.md rules, run explicit test files through Vitest rather than `npm test`.
- **`effect/`** — _New, Effect-based **production** code._ Schemas (`agent-event.ts`, `agent-error.ts`, `agent-input.ts`), state (`session-state.ts`), and the tracer-bullet `Session` loop (`session.ts`). Folds into `src/` during ADR-0006 phase 4.
- **`test-support/`** — _New, Effect-based._ Reusable Layer fixtures: `stubLanguageModel`, `stubOpenAiClient`, `stubOpenAiClientScripted`, `stubOpenAiClientStreaming`. Will be deep-published as `@earendil-works/pi-agent-core/test-support` per ADR-0015.
- **`test/effect/`** — _New, Effect-based._ Tracer-bullet tests proving the v4 surface works against the stubs above. Run with `npm run test:effect`.

## Temporary code/test knowledge store

This section is a working migration map, not the final architecture contract. Keep it only while ADR-0006 is splitting the legacy Promise-shaped runtime from the Effect-shaped rewrite. Promote durable decisions into ADRs or package docs, and delete stale test-map notes once the implementation moves.

Current verification snapshot for `packages/agent`, captured on 2026-05-13:

```powershell
# from packages/agent/
npx.cmd vitest --run --coverage --no-file-parallelism --maxWorkers=1 --minWorkers=1 --coverage.reportsDirectory=coverage-fresh --coverage.reporter=text --coverage.reporter=lcovonly
```

Result: 53 test files passed, 364 tests passed, with 100% statements, branches, functions, and lines under V8 coverage for `src/**/*.ts` and `effect/**/*.ts`. This is the direct Vitest coverage invocation for this package, not `npm test`.

Current stricter gate: `npm run coverage:agent:100` runs the package's `test:coverage:100` script, which enforces statements, branches, functions, and lines at 100%. The current worktree satisfies this gate for `packages/agent`; the branch-coverage blocker has been closed with behavior tests first and narrow `v8 ignore next` annotations only for proven unreachable defensive branches:

- `agent-loop.ts` EventStream result extraction fallback: the extractor is invoked only for the `agent_end` terminal event.
- `proxy.ts` EventStream error extractor fallback and `parseStreamingJson(...) || {}` fallback: the extractor is terminal-event constrained and `parseStreamingJson` always returns an object.
- `harness/agent-harness.ts` optional stream-options patch guard: callers only invoke the helper after a hook returns `streamOptions`.
- `harness/compaction/branch-summarization.ts` empty-summary fallback: the branch preamble makes generated summaries truthy before return.

Current protected legacy / harness behavior:

- `test/agent*.test.ts` and `test/e2e.test.ts` protect the existing `src/` agent loop: continuation from user or assistant turns, steering / follow-up queues, queue clearing, busy guards, failed-run recording, invalid continuation rejection, tool-call error conversion, tool hooks, and streamed finalization.
- `test/harness/agent-harness*.test.ts` protects turn preparation, resources, before-start hooks, next-turn messages, active-turn mutation flushing, tool-call / tool-result hooks, compaction hooks, cancellation, provider-backed compaction, branch navigation summaries, queued steering, and abort handling.
- `test/harness/compaction.test.ts` and `test/harness/branch-summarization.test.ts` protect compaction thresholds, token accounting, split-turn handling, previous summaries, custom instructions, branch-path summaries, file-operation details, aborted summaries, and errored summaries.
- `test/harness/nodejs-env.test.ts` and `test/harness/shell-output.test.ts` protect symlink handling, command `cwd` / env propagation, shell fallback, stdout / stderr streaming, abort behavior, timeout behavior, and shell-output formatting.
- `test/harness/prompt-templates.test.ts`, `test/harness/skills.test.ts`, `test/harness/system-prompt.test.ts`, `test/harness/resource-formatting.test.ts`, `test/harness/messages.test.ts`, and `test/harness/truncate.test.ts` protect env-backed discovery, symlink source tracking, diagnostics, markdown/template formatting, system prompt assembly, message formatting, and truncation rules.
- `test/harness/session.test.ts`, `test/harness/repo.test.ts`, `test/harness/storage.test.ts`, and `test/proxy.test.ts` protect memory/jsonl session storage, repo metadata operations, proxy request serialization, stream error propagation, HTTP fallback status, protocol mismatch handling, orphan-event handling, unknown-event ignores, and abort cleanup.

Future migration obligation: when ADR-0006 phase 4 moves the runtime into `src/`, these behavior specs need either an Effect-shaped replacement or an explicit deletion note explaining the replacement behavior. Do not treat the Effect tracer bullets alone as covering the full current package behavior; the legacy / harness lane above is still part of the package contract until it is migrated or retired.

## Status — Effect rewrite tracer bullets

Thirty-two tracer bullets, all GREEN, all without an API key:

1. **`stubLanguageModel({ text })`** — Layer that bypasses providers entirely; `LanguageModel.generateText` resolves to canned text. Proves the v4 runtime and `@effect/ai` API surface work.
2. **`stubOpenAiClient({ text })` + `OpenAiLanguageModel.layer({ model })`** — Layer composition that exercises the real provider path (`OpenAiLanguageModel.make` calls `client.createResponse`, parses the OpenAI Responses-API body shape, builds the `GenerateTextResponse`). Proves the OpenAI integration path works without an API key.
3. **Tool calling** — `Tool.make("Name", { parameters: Schema, success: Schema })` + `Toolkit.make(...tools).toLayer({ Name: handler })` + `stubOpenAiClient({ outputs: [{ type: "function_call", name, arguments }] })`. `LanguageModel.generateText({ prompt, toolkit })` parses the function_call output, runs the handler with decoded params, surfaces the handler's return value in `response.toolResults`.
4. **Tool failure (capture mode)** — `Tool.make(name, { ..., failure: FailureSchema, failureMode: "return" })` + handler returning `Effect.fail(value)`. The failure value reaches `response.toolResults[0]` as `{ name, isFailure: true, result: value }` instead of crashing the calling effect.
5. **Tool failure (propagation mode)** — `Tool.make(name, { ..., failure: FailureSchema })` (default `failureMode: "error"`) + handler returning `Effect.fail(value)`. The raw failure value propagates through `generateText`'s error channel. Verified with `Effect.flip`.
6. **HTTP error mapping (`AiError.RateLimitError`)** — `stubOpenAiClient({ error: AiError.make({ ..., reason: new AiError.RateLimitError({ retryAfter }) }) })`. Provider HTTP errors map to `AiError` reasons cleanly — the test can match on `reason._tag` to drive retry / backoff / surfacing logic.
7. **Schema-encode failure → `AiError.ToolResultEncodingError`** — Tool handler returns a value that doesn't satisfy the `success` schema. The framework's `encodeResult` step fails with a `Schema.SchemaError`, which is wrapped as `AiError.ToolResultEncodingError` with `toolName`, `description`, and `isRetryable: false` (treated as a code bug).
8. **Handler-side schema failure → `AiError.InvalidToolResultError`** — Tool handler returns `Effect.fail(SchemaError)` (e.g. an internal `Schema.decodeUnknownEffect` inside the handler fails). `Toolkit.normalizeError` sees `Schema.isSchemaError(error) === true` and wraps as `InvalidToolResultError` with `toolName`, `description` prefixed `"Tool handler returned invalid result: …"`, and `isRetryable: false`. Together with #7, this characterises the full surface of schema-related tool failures.
9. **AiError reason variants — parametrized** (`test/effect/error-reasons.test.ts`, 5 cases via `it.effect.each`): `RateLimitError` / `AuthenticationError` / `ContentPolicyError` / `QuotaExhaustedError` / `InvalidRequestError`. Each round-trips through `stubOpenAiClient({ error })` → `OpenAiLanguageModel.make` → `generateText` error channel with `reason._tag` and `reason.isRetryable` intact. Only `RateLimitError` is retryable; the rest indicate user action / config / billing issues. Adding a new reason variant is now a single new row in the `cases` array.
10.   **Multi-turn with `Chat.empty`** — `yield* Chat.empty` produces a stateful conversation; two successive `chat.generateText({ prompt })` calls accumulate to 4 messages (user+assistant+user+assistant) on the `Ref.Ref<Prompt.Prompt>` exposed at `chat.history`. Verified with a new `stubOpenAiClientScripted([step1, step2, ...])` test helper that uses an internal `Ref<number>` to serve a different canned body per call (and dies loudly on calls past the script length). Proves history is appended-to (not replaced) on each turn — the foundation `Session.send` will build on.
11.   **Multi-turn with a real tool call** — combines #3 + #10. Turn 1 (`chat.generateText({ prompt, toolkit })`) gets a `function_call` body from the scripted stub, the framework runs the `GetWeather` handler, and the tool-result lands in `r1.toolResults` AND in `chat.history`. Turn 2 (`chat.generateText({ prompt: "follow-up" })`) — no toolkit, no tool call from the stub — produces a text answer, and `chat.history` ends with `role === "assistant"`. Proves the tool-call/tool-result interaction round-trips through history cleanly so the next turn can build on it. This is the smallest credible agent-loop iteration without yet needing `Session.send`.
12.   **Streaming** — `stubOpenAiClientStreaming({ text, chunkCount })` Layer with a `createResponseStream` that emits `response.created` → N × `response.output_text.delta` → `response.completed` as an Effect `Stream` of canned SSE events. `LanguageModel.streamText({ prompt })` returns `Stream<Response.StreamPart, AiError, LanguageModel>` directly; the test runs `Stream.runCollect` and reconstructs the text by concatenating `delta` from all `type: "text-delta"` parts. Also asserts a `finish` part lands at the end. Proves the SSE → `StreamPart` translation path in `OpenAiLanguageModel.makeStreamResponse`. **v4 note**: `Stream.runCollect` returns `Effect<Array<A>>` in v4 — _not_ `Effect<Chunk<A>>` like in v3.
13.   **`AgentEvent` + `AgentError` schema scaffolding** (12a — first slice of `Session.send` per ADR-0009). Defines, in `effect/agent-event.ts` and `effect/agent-error.ts`:


    - `AgentEvent` = `LlmPart | ToolDispatched | ToolCompleted | Finish` (closed `Schema.Union` of `Schema.TaggedClass`-derived variants). The pi-defined event union the future `Session.send` stream will emit.
    - `AgentError` = `LlmError | ToolError | SchemaError | CancellationError` (`Schema.TaggedErrorClass`-derived). Yieldable in `Effect.gen`; propagates through the error channel.
    - 6 test cases: tag-discrimination, _tag literals, Schema.encode/decode roundtrip for a `LlmPart`, decode failure on unknown `_tag`, error-channel propagation per AgentError variant.
    Future variants (`RetryRequested`, `SessionMeta`, `AuthError` if it splits from `LlmError`) are deferred until their slices need them. (`CompactionApplied` / `CompactionError` landed in slice 28. There is no `SkillInvoked` variant — skill-block parsing is a host concern, ADR-0009 amendment 2026-05-14.)

14.   **`Session.empty` + `Session.send` wired to `LanguageModel.streamText`** (12b/c — combined). `effect/session.ts` exposes:


    - `Session` interface with `send: (prompt: string) => Stream<AgentEvent, LlmError, LanguageModel>`.
    - `Session.empty: Effect<Session>` builder (stateless for now; mirrors `Chat.empty` so a stateful variant can land later without changing call sites).
    The `send` Stream wraps `LanguageModel.streamText({ prompt })`: `Stream.map` each `Response.AnyPart` to an `LlmPart` event, `Stream.mapError` each upstream `AiError` to our pi-defined `LlmError`, and `Stream.concat` a trailing `Finish` event. 2 tests in `test/effect/session.test.ts`:
    - `Session.empty` resolves to a Session with `send` (smoke test).
    - `send("hello")` against `stubOpenAiClientStreaming({ text, chunkCount })` yields N `LlmPart` events whose unwrapped `text-delta` parts concatenate back to the canned text, followed by exactly one `Finish`.

    **At this slice boundary, deferred to later slices** (each its own tracer bullet): the `Input = NewPrompt | Continue | Retry` discriminated union, multi-turn history inside `Session`, compaction triggers, cancellation via `Fiber.interrupt`. (Input triad, multi-turn history, token/cost accounting, retry, telemetry, and compaction triggers have since landed in later tracer bullets. Skill-block parsing was removed from the loop's scope — host concern, ADR-0009 amendment 2026-05-14.)

15.   **Tool events in `Session.send`** (slice 12d — `ToolDispatched` / `ToolCompleted`). Extended `session.ts` to `Stream.flatMap` each upstream `Response.AnyPart` through a `liftPart(part)` helper:


    - `tool-call` part → `[LlmPart, ToolDispatched({ toolName, toolCallId, params })]`
    - `tool-result` part → `[LlmPart, ToolCompleted({ toolName, toolCallId, isFailure, result })]`
    - every other part → `[LlmPart]`

    Verified by a new `stubLanguageModelStream(parts: ReadonlyArray<unknown>)` test-support helper that satisfies `LanguageModel.LanguageModel` directly (bypassing the OpenAI provider layer) with a caller-supplied canned `Response.StreamPart` sequence. 2 tests in `test/effect/session-tool-events.test.ts`:
    - Canned parts `[text-delta, tool-call, tool-result]` produce the exact sequence `[LlmPart, LlmPart, ToolDispatched, LlmPart, ToolCompleted, Finish]` with all fields preserved.
    - A `tool-result` with `isFailure: true` round-trips that flag into `ToolCompleted.isFailure` along with the failure-shaped `result`.

    The lifted events appear **alongside** the raw `LlmPart` (not replacing it) so consumers can pick the abstraction level they want: raw provider parts via `LlmPart`, or higher-level orchestration via `ToolDispatched` / `ToolCompleted`.

16.   **`Session.state: SubscriptionRef<SessionState>` for snapshot reads** (slice 12e — observable per-session state per ADR-0009). New `effect/session-state.ts` defines:


    - `SessionState` = `Schema.Class<SessionState>("SessionState")({ turnCount: Schema.Number })`. First-slice payload is just `turnCount`; later tracer bullets have since added `history`, `inputTokens`, and `outputTokens`; future slices can add model selection, pending tool calls, and cancellation flags as Schema fields on the same class so consumers see a single coherent snapshot.
    - `SessionState.empty: SessionState = new SessionState({ turnCount: 0 })`.

    `effect/session.ts` updated:

    - `Session` interface gains `state: SubscriptionRef.SubscriptionRef<SessionState>` alongside `send`.
    - `Session.empty` builds the SubscriptionRef via `SubscriptionRef.make(SessionState.empty)`.
    - `send` wraps its provider-stream pipeline in `Stream.unwrap(Effect.gen(function*() { yield* SubscriptionRef.update(state, ...); return streamPipeline }))` so the `turnCount` bump is atomic on the same fiber boundary as the new events arriving.

    2 tests in `test/effect/session-state.test.ts`:

    - `Session.empty` exposes `state` initialised to `SessionState.empty` (`turnCount: 0`). Verified with `SubscriptionRef.get(session.state)` returning a `SessionState` instance.
    - Three back-to-back `Stream.runDrain(session.send(prompt))` calls leave `turnCount` at 3 — increments accumulate across sends; nothing else mutates state in this slice.

    **v4 note**: `SubscriptionRef` is **not** structurally a `Ref` in v4 (internal shape differs — `Ref` stores `ref.current`, `SubscriptionRef` stores `value` + `pubsub`). Use `SubscriptionRef.get(ref)` to read a SubscriptionRef; `Ref.get` on a SubscriptionRef throws `Cannot read properties of undefined (reading 'current')`.

17.   **Toolkit threading through `Session.send`** (slice 12f — real end-to-end agent loop). `Session.send` now takes an optional second `toolkit?: LanguageModel.ToolkitInput<Tools>` argument, generic over `Tools extends Record<string, Tool.Any>` so concrete `Toolkit.make(GetWeather)` infers precisely without widening to a Record-with-index. The toolkit is forwarded to `LanguageModel.streamText({ prompt, toolkit })`; handler resolution services come from the runtime context (via `WeatherHandlers = Weather.toLayer({ GetWeather: handler })` provided alongside the LanguageModel layer).


    `stubOpenAiClientStreaming` extended with `outputs: ReadonlyArray<StreamingOutputItem>` mode supporting `{ type: "function_call", name, arguments }` items — emits the canonical SSE sequence (`response.output_item.added` + N × `response.function_call_arguments.delta` + `response.function_call_arguments.done` + `response.output_item.done`). The `{ text, chunkCount }` shorthand stays for back-compat.

    1 test in `test/effect/session-toolkit.test.ts` proves the full path:

    `stub SSE → OpenAiLanguageModel.makeStreamResponse → framework's outer LanguageModel.make tool dispatch → real GetWeather handler runs → tool-call + tool-result parts in the stream → Session.send.liftPart surfaces them as ToolDispatched + ToolCompleted AgentEvents.`

    **This is the real end-to-end agent loop**: provider events → toolkit dispatch → handler → events for the consumer. Every previous slice composes correctly with this one.

    **TS note**: typing the toolkit slot as `Record<string, Tool.Any>` (a non-generic ToolkitInput) is **too wide** — `Toolkit<{ GetWeather }>` is NOT assignable to `Toolkit<Record<...>>` because Record's index signature requires every string key to map to a `Tool.Any`. Use generic `send<Tools extends Record<string, Tool.Any> = {}>(prompt, toolkit?: LanguageModel.ToolkitInput<Tools>)` so the concrete `Tools` shape is captured at the call site.

18.   **Multi-turn history accumulation inside `SessionState`** (slice 12g — `Session` becomes a stateful conversation). `SessionState` gains a `history: Prompt.Prompt` field (typed via the `Prompt.Prompt` Schema export from `effect/unstable/ai`); `SessionState.empty` initialises it to `Prompt.empty`. `Session.send`:


    - **Before opening the upstream stream**, calls `SubscriptionRef.update(state, s => SessionState.advance(s, Prompt.concat(s.history, prompt)))` — appends a `user` message with the new prompt AND bumps `turnCount` in one atomic update.
    - **Passes the FULL history** (not just the new prompt) as `LanguageModel.streamText({ prompt: snapshot.history })` so the next turn sees prior turns' context. Same code path with toolkit: `streamText({ prompt: snapshot.history, toolkit })`.
    - **Accumulates text-delta deltas** during the stream via `Stream.tap` + a local `Ref<string>` (extracted by a small `textDeltaOf(part)` helper).
    - **After the upstream completes**, appends an `assistant` message with the assembled text via `Stream.concat(Stream.unwrap(...))`. Empty assistant responses (zero text deltas) are not appended.

    2 tests in `test/effect/session-history.test.ts`:

    - `SessionState.empty.history.content` has length 0.
    - Two back-to-back `Stream.runDrain(session.send(prompt))` calls produce a 4-message history with roles `["user", "assistant", "user", "assistant"]`.

    **At this slice boundary, limitation deferred to the next slice**: `tool-call` / `tool-result` parts are emitted as events but not yet persisted in `state.history`. The streamText-with-toolkit path still works because `LanguageModel.streamText` handles the upstream tool dispatch internally. Slice 12h below closes this gap by persisting tool turns in `state.history`.

19.   **Tool turns persisted in `state.history`** (slice 12h — completes the history record). Extends slice #18's text-only accumulator with a richer `AssistantContentAcc { pendingText, parts }` that tracks `tool-call` and `tool-result` parts alongside text deltas in arrival order. The `absorbPart` helper:


    - `text-delta` → appends to `pendingText` (coalesces consecutive deltas into one `TextPart`).
    - `tool-call` → flushes pending text into a `TextPart`, appends a `ToolCallPart` (`{ id, name, params, providerExecuted: false }`).
    - `tool-result` → flushes pending text, appends a `ToolResultPart` (`{ id, name, isFailure, result }`).
    - Other streaming-only parts (`tool-params-start` / `tool-params-delta` / `tool-params-end` / `response-metadata` / `finish`) — **skipped**, they're event-only.

    `finalize` flushes any trailing pending text. After the upstream completes, `Session.send` builds one `AssistantMessage` with the ordered `content` array and appends it to `state.history` via `Prompt.concat`.

    1 test in `test/effect/session-history-tools.test.ts`: a send whose canned stream emits `[text-delta, tool-call, tool-result]` produces a `state.history.content` of `[user, assistant]` where the assistant message's `content` is `[text, tool-call, tool-result]` with all fields preserved (`toolCall.params === { city: "Paris" }`, `toolResult.result === { temperature: 72, condition: "sunny" }`).

    **(slice 26 lands per-text-block segmentation — see below.)**

20.   **State consistency under abnormal termination** (per ADR-0009's cancellation sub-decision). Verifies the global invariant that `state.turnCount` + history user-message append (pre-upstream side effects) land BEFORE the upstream opens, while history assistant-message append (post-upstream side effect) lands ONLY after the upstream completes successfully. When the upstream fails (or is interrupted — same code path), state shows just the pre-upstream effects. 1 test in `test/effect/session-cancellation.test.ts`:


    `Stream.fail(AiError.RateLimitError)` upstream → `Effect.exit(Stream.runDrain(...))` is `Exit.isFailure` → state has `turnCount: 1`, `history.content` has exactly one user message, no assistant message.

    **Note on direct interruption testing**: Effect's runtime guarantees that any well-typed Effect program is interruption-safe; `Session.send` uses only interruption-safe primitives (`SubscriptionRef.update`, `Ref.update`, `Stream.flatMap`/`tap`/`mapError`/`concat`). Attempts to drive interruption via `Effect.timeout` on a blocking upstream (`Stream.never`, `Stream.fromEffect(Effect.callback(...))`) **hung** in the `it.effect` test environment — likely a v4-beta `@effect/vitest` interaction or Stream/Channel quirk worth investigating separately, but the framework's interruption guarantee + the failure-path test above together establish the state-consistency property cancellation depends on. **v4 rename**: `Effect.async` is now `Effect.callback` (the v3 name doesn't exist at the type level in v4).

21.   **`Input = NewPrompt | Continue` discriminated union on `Session.send`** (ADR-0009). New `effect/agent-input.ts` defines:


    - `class NewPrompt extends Schema.TaggedClass<NewPrompt>()("NewPrompt", { prompt: Schema.String }) {}`
    - `class Continue extends Schema.TaggedClass<Continue>()("Continue", {}) {}`
    - `type Input = NewPrompt | Continue` (+ `Input` Schema.Union for wire/persistence use)
    - `normalize(input: string | Input): Input` — lifts a bare string into `new NewPrompt({ prompt })`.

    `Session.send` now takes `(input: string | Input, toolkit?)` and dispatches at the top:

    - `NewPrompt({ prompt })` — appends a `user` message with `prompt` to `state.history` before opening the upstream.
    - `Continue({})` — leaves `state.history` untouched; the upstream sees only the existing conversation and produces a new assistant turn on top.

    Both variants bump `turnCount`. The string form stays backward-compatible (existing tests + simple callers pass strings directly; `normalize` lifts them).

    3 tests in `test/effect/session-input.test.ts`:

    - `send(string)` is normalised to `NewPrompt` → history `[user, assistant]`.
    - `send(new NewPrompt({ prompt: "..." }))` behaves identically.
    - `send("first")` then `send(new Continue({}))` → history `[user, assistant, assistant]` (no second user message; `turnCount === 2`).

    **`Retry` deferred**: needs history rollback (drop the last assistant turn — and any tool turns it contains — before re-sending). Lands in a separate slice.

22.   **`Retry` Input variant — history rollback** (closes out ADR-0009's `Input` triad). New `Retry` `Schema.TaggedClass` + `rollbackToLastUserMessage(history: Prompt.Prompt): Prompt.Prompt` helper in `effect/agent-input.ts`:


    - Walks `history.content` backwards looking for the last `user`-role message.
    - Returns a new `Prompt.make` over the slice up to and including that user message — everything after (the trailing assistant turn, including in-content tool-call / tool-result parts) is dropped.
    - If history has no user messages (empty / system-only), returns it unchanged.

    `Session.send`'s dispatch gained a third branch: when `_tag === "Retry"`, the next history is `rollbackToLastUserMessage(s.history)` (instead of `Prompt.concat(s.history, prompt)` for NewPrompt or `s.history` for Continue). The rest of the pipeline is identical: `turnCount` still bumps, the upstream runs against the (rolled-back) history, and the new assistant message lands on top.

    2 tests in `test/effect/session-retry.test.ts`:

    - `send("hello")` then `send(new Retry({}))` → history is `[user, assistant']` (length 2 — the old assistant was replaced, not appended next to). `turnCount === 2`.
    - `send(new Retry({}))` on an empty session → rollback is a no-op (no user to roll back to). `turnCount === 1`, history is `[assistant]` (the LLM was called with empty prompt — defensible edge case behavior).

    ADR-0009's `Input = NewPrompt | Continue | Retry` triad is now complete. Future slice: tool-turn-aware rollback if we want Retry to also drop tool calls *across* messages (currently they're inside the assistant message's content, so a single-message rollback already does the right thing).

23.   **Token / cost accounting on `Finish` and inside `SessionState`** (slice 23). Closes out the "token accounting on Finish" item deferred from slice 14. `SessionState` gains two fields and `Session.send` gains usage capture:


    - `SessionState`: `inputTokens: Schema.Number`, `outputTokens: Schema.Number` — both default to 0 in `empty`. `SessionState.advance` preserves them (the post-stream update is the one that bumps them, separately from `turnCount` + `history`).
    - `effect/session.ts`: a new `captureUsage(part: unknown): { inputTokens, outputTokens } | null` helper reads `usage.inputTokens.total` / `usage.outputTokens.total` off `type === "finish"` parts (per the upstream `Response.FinishPart` shape — `Usage` has `inputTokens: { uncached, total, cacheRead, cacheWrite }` and `outputTokens: { total, text, reasoning }`, each total is `UndefinedOr<number>` — undefined values fall through as 0).
    - `send` body adds a `usageRef = yield* Ref.make<CapturedUsage | null>(null)` alongside the existing `accRef`. The single `Stream.tap` now both absorbs into the assistant accumulator AND, if `captureUsage(part)` returns non-null, sets `usageRef`.
    - The trailing `Stream.concat(Stream.unwrap(...))` reads both refs at the end. The state update now bumps `inputTokens` / `outputTokens` cumulatively (in addition to appending the assistant message if non-empty). The emitted `Finish` event carries `{ inputTokens, outputTokens }` when `usageRef` is non-null; when the upstream omitted a `finish` part entirely, `Finish({})` keeps both fields undefined and state totals stay put.

    5 tests in `test/effect/session-usage.test.ts`:

    - One send with `usage.{input,output}Tokens.total === { 10, 25 }` → `Finish` event has those values; `state.{input,output}Tokens` equal them.
    - Two back-to-back sends against the same usage-emitting stub → totals accumulate to `{ 20, 50 }`.
    - `usage.{input,output}Tokens.total === undefined` → both Finish fields and state totals are 0 (no NaN propagation).
    - A finish-only stream with usage updates the token totals but does not append an empty assistant message.
    - No `finish` part at all in the upstream → Finish has both token fields `undefined`; state totals stay at 0 (no accidental zero-overwrite).

    **Upstream Usage shape (v4)**: `Response.Usage` lives at `effect/unstable/ai/Response.ts`. `inputTokens` has 4 keys (`uncached`, `total`, `cacheRead`, `cacheWrite`); `outputTokens` has 3 keys (`total`, `text`, `reasoning`). We only track `*.total` at the Session level; provider-specific breakdowns (cache, reasoning, text) stay accessible to consumers who unwrap the raw `LlmPart` of the upstream `finish` part. Cost calculation (tokens × per-model rate) is deferred — it's a `pi-billing` concern, not an agent-loop concern.

24.   **Retry on transient LLM errors** (slice 24). `Session.send` now retries the per-attempt inner stream on retryable `AiError` reasons (`RateLimitError`, `OverloadedError`, `TransportError`, …) up to `MAX_LLM_RETRIES = 3` times before propagating; non-retryable reasons (`AuthenticationError`, `ContentPolicyError`, `InvalidRequestError`, …) propagate immediately without retry. Structural changes in `effect/session.ts`:


    - **Split the per-send pipeline** into a once-per-send setup (history + turn update, in the outer `Stream.unwrap`) and a per-attempt factory (`Ref.make` for `accRef` and `usageRef` + `streamText` open + the absorb/map/concat pipeline, in a nested `Stream.unwrap` so each retry gets fresh refs).
    - **Schedule**: `const retrySchedule = Schedule.recurs(MAX_LLM_RETRIES).pipe(Schedule.while(({ input }) => (input as LlmError).aiError.isRetryable))`. The schedule's `input` is the stream's error type, which after the `Stream.mapError(... LlmError)` inside the attempt pipeline is `LlmError` — so the predicate reads `.aiError.isRetryable` directly. `Stream.mapError` lives **inside** the attempt boundary (so the schedule sees `LlmError`, not raw `AiError`).
    - **`Stream.retry(retrySchedule)`** wraps the attempt stream. On each retryable failure the inner `Effect.gen` re-runs, producing a clean accumulator + a fresh upstream; the consumer sees only the events of the successful attempt.

    New test fixture `stubLanguageModelStreamScripted(script)` (`test-support/stub-language-model-stream-scripted.ts`) — a streaming counterpart to `stubOpenAiClientScripted`. Each step is `{ type: "parts", parts } | { type: "error", error: AiError }`; internal `Ref<number>` advances the script per `streamText` call; calls past the script length die loudly so accidental extra retries are visible in test output.

    3 tests in `test/effect/session-llm-retry.test.ts`:

    - Two `RateLimitError` calls then a successful parts call → consumer sees only the successful attempt's `[LlmPart, LlmPart, Finish]`; `turnCount === 1`; history is `[user, assistant]`; tokens captured from the successful finish part.
    - One `AuthenticationError` call (script length 1) → fails immediately with that error in the error channel; `turnCount === 1`, history is `[user]` (pre-stream effect landed; no assistant message because the upstream never produced events). Script-length-1 proves no retry fired.
    - Four `RateLimitError` calls (initial + 3 retries = 4 total tries) → retry cap exhausted, last error propagates; state still has just the pre-stream effects.

    **History + turnCount semantics under retry**: the pre-stream `SubscriptionRef.update` runs ONCE per `send` (outside the retry boundary), so a 3-retry-then-succeed sequence still bumps `turnCount` by exactly 1 and appends exactly one user message. This is the **once-per-send-vs-once-per-attempt** invariant.

    **Mid-stream retry caveat (documented but not handled)**: `Stream.retry` re-opens the stream on failure. If the upstream emits some events *then* fails, those events have already flowed to the consumer; the retry attempt's events will appear after them. The realistic transient-error pattern is "fail at-open" (the provider's `createResponseStream` rejects before any SSE events), which is what this slice's tests cover. Mid-stream retry coalescing is a future concern.

    **Deferred (within retry)**:
    - Backoff between attempts (currently no delay; production wants exponential / `retryAfter`-respecting).
    - Configurable retry policy on `Session.empty` (currently hardcoded).

25.   **`Effect.withSpan` telemetry on `Session.send`** (slice 25 — the telemetry ADR-0009 "wrapping" item; compaction triggers landed later in slice 28, and skill-block parsing was subsequently removed from the loop's scope per the ADR-0009 amendment of 2026-05-14). `Session.send` now emits two named spans per send, observable via any standard Effect `Tracer.Tracer`:


    - **Outer span**: `pi.Session.send` — wraps the entire send including all retry attempts. Attributes: `pi.input.tag` (`"NewPrompt"` / `"Continue"` / `"Retry"`) and `pi.history.size` (number of messages in `state.history` at send time, *after* the input variant's history mutation lands).
    - **Inner spans**: `pi.Session.send.attempt` — one per retry attempt (so a clean send produces 1, a retry-then-success after 2 transient failures produces 3). Attribute: `pi.attempt.number` (1-indexed).

    Implementation:

    - Both spans use `Stream.withSpan(name, { attributes })`. The outer span is the *last* step in the outer pipe (so it wraps `Stream.retry` and therefore covers all attempts); the inner span is the *last* step in each per-attempt pipe (so it wraps `flatMap + tap + mapError + concat` and ends when the attempt's stream completes).
    - The attempt counter is a `Ref<number>` created in the *outer* `Stream.unwrap` (so all retries share it); the inner `Effect.gen` calls `Ref.updateAndGet(counter, n => n + 1)` on entry to capture this attempt's number into the span attribute. `Ref.updateAndGet` is the v4 atomic increment-and-return helper.
    - Spans END on stream completion (success / failure / interruption); `NativeSpan.end(endTime, exit)` records the exit on `span.status` (transitions `_tag` from `"Started"` to `"Ended"` with `exit` attached).

    New test fixture `recordingTracer()` (`test-support/recording-tracer.ts`) — a minimal in-memory `Tracer.Tracer` whose `span` factory pushes each `NativeSpan` it constructs into a shared `Array<Span>`. Tests provide it via `Effect.provideService(Tracer.Tracer, tracer)` and assert on names / attributes / exit status afterward.

    2 tests in `test/effect/session-telemetry.test.ts`:

    - One clean send → recording-order names are `["pi.Session.send", "pi.Session.send.attempt"]` (parent-first because `Stream.withSpan` start order mirrors pipe nesting). `pi.input.tag === "NewPrompt"`, `pi.history.size === 1`, `pi.attempt.number === 1`. Both spans end with `Success`.
    - Two `RateLimitError`s + 1 success → 3 attempt spans (`pi.attempt.number === 1, 2, 3`) under exactly 1 send span; all spans end; the send span's exit is `Success`.

    **v4 Tracer note**: `Tracer.Tracer` is a `Context.Reference` (not a `Context.Service`), defaulting to `make({ span: (options) => new NativeSpan(options) })` — i.e. spans are built but not exported. Providing a custom Tracer is the entry point for opentelemetry / honeycomb / etc. wiring later; here it's just a recording sink. `NativeSpan` (v4-exported, at `Tracer.NativeSpan`) is the simplest concrete `Span` — keeps a `Map<string, unknown>` of attributes, tracks start/end timestamps, and accepts `attribute(key, value)` / `event(...)` / `addLinks(...)` post-construction.

    **`Stream.withSpan` placement quirk**: putting `Stream.withSpan` at the *start* of `.pipe(...)` wraps only the receiver stream — the rest of the pipe is downstream of it but not under the span. We want the span to cover the WHOLE pipeline (including the trailing `Stream.concat(...)` that emits `Finish`), so `Stream.withSpan` must be the *last* step in the pipe. Same applies to the outer wrapping: `Stream.withSpan` is the last step in the outer `attemptStream.pipe(Stream.retry(...), Stream.withSpan(...))`.

26.   **Per-text-block segmentation in history** (slice 26 — closes out the multi-block-fidelity limitation noted in slice 12h). The `absorbPart` accumulator gains two new branches:


    - `text-start` → `flushText(acc)` (any pendingText from preceding deltas closes as a `TextPart`).
    - `text-end` → `flushText(acc)` (the current block's pendingText closes as a `TextPart`).

    Net effect on `state.history`'s assistant `content` array:

    - Multi-block streams like `[text-start, deltas, text-end, tool-call, tool-result, text-start, deltas, text-end]` now produce 4 distinct content parts (`text → tool-call → tool-result → text`) instead of coalescing both texts into a single TextPart at the same position.
    - Adjacent bookended blocks (`[text-start(a), deltas(a), text-end(a), text-start(b), deltas(b), text-end(b)]`) produce 2 distinct TextParts.
    - **Backward-compat**: streams that emit raw `text-delta`s WITHOUT bookending markers (every prior slice's test) still produce a single TextPart via `finalize` at end-of-stream — `flushText` is a no-op when `pendingText.length === 0`, so the new branches don't create spurious empty TextParts.

    3 tests in `test/effect/session-text-blocks.test.ts`:

    - `text → tool-call → tool-result → text` flow → 4 distinct content parts; first TextPart is `"Looking up... "`, last is `"It's 72 and sunny."`.
    - Two adjacent bookended blocks → 2 distinct TextParts (`"Hello."`, `"Goodbye."`).
    - Raw `text-delta`s without markers → still 1 TextPart with concatenated content (`"hello world"`).

    **v4 StreamPart shape**: `TextStartPart` and `TextEndPart` both carry an `id: string` that ties them to the matching `text-delta`s. We don't currently use the id (a sequence of well-formed start/delta/end is sufficient to identify block boundaries), but it's available on the raw `LlmPart` for consumers that want to correlate.

    **What this does NOT yet do**:
    - Re-emit the text-block boundaries as `AgentEvent`s — they currently flow through as raw `LlmPart`s only (consumers can narrow on `event.part.type === "text-start"` if they need).

27.   **Reasoning blocks persisted in history** (slice 27 — closes out the reasoning gap noted in slice 26). The accumulator now handles `reasoning-start` / `reasoning-delta` / `reasoning-end` parts the same way it handles their text-\* counterparts, in a separate `pendingReasoning: string` field. Flushing emits a `{ type: "reasoning", text }` part into the assistant message's `content`. Key implementation details:


    - **Two pending buffers in `AssistantContentAcc`**: `pendingText` and `pendingReasoning`, plus a `flushReasoning(acc)` helper that mirrors `flushText(acc)`. A `flushAll(acc)` convenience composes them.
    - **Cross-flush in deltas**: each `text-delta` calls `flushReasoning` before appending to `pendingText`; each `reasoning-delta` calls `flushText` before appending to `pendingReasoning`. This invariant — at most one buffer is non-empty between absorb calls — guarantees arrival order is preserved even for streams that interleave deltas without explicit boundary markers.
    - **Cross-flush at boundaries**: `text-start` / `text-end` / `reasoning-start` / `reasoning-end` / `tool-call` / `tool-result` all call `flushAll`. This is defensive — well-formed streams only have one buffer non-empty at a boundary, but ill-formed streams (missing start/end markers) still produce ordered output.
    - **`finalize` calls `flushAll`** to clean up either lingering buffer at end-of-stream.

    3 tests in `test/effect/session-reasoning-blocks.test.ts`:

    - `text → tool → reasoning → text` flow (bookended blocks) → assistant content is `[text, tool-call, tool-result, reasoning, text]` in arrival order, with reasoning text correctly captured.
    - Interleaved `text-delta → reasoning-delta → text-delta` WITHOUT boundary markers → `[text("a"), reasoning("b"), text("c")]`. Without the cross-flush invariant, this would collapse to `[text("ac"), reasoning("b")]` with broken order.
    - Consecutive `reasoning-delta`s inside one bookended block → one `ReasoningPart` with concatenated text (mirrors the slice 26 backward-compat for text).

    **What this does NOT yet do**:
    - Re-emit reasoning-block boundaries as `AgentEvent`s (e.g. `ReasoningStarted` / `ReasoningCompleted`) — consumers see raw `LlmPart`s only.
    - Surface a "thinking" status in `SessionState` for UI hints during long reasoning runs.

28.   **Compaction triggers in `Session.send`** (slice 28 — the big remaining ADR-0009 "wrapping" item). New `effect/compaction.ts` holds pure, runtime-free helpers so the trigger logic is unit-testable in isolation:


    - `estimateTokens(history)` — chars/4 heuristic over message content. `messageChars` counts `text` parts, `tool-call` (`name` + `JSON.stringify(params)`), `tool-result` (`JSON.stringify(result)`), and bare-string `system` content. Mirrors the legacy `estimateTokens` fallback path.
    - `shouldCompact(history, threshold)` — pure predicate; `true` once `estimateTokens` strictly exceeds the threshold.
    - `splitHistory(history, keepRecentTokens)` — walks backwards accumulating the chars/4 estimate; the first message that tips the accumulator at/past `keepRecentTokens` starts `toKeep`, everything older is `toSummarize`. The cut never lands on a `tool` message (a tool-result must stay with its tool-call's assistant message) — it walks back past any leading `tool` messages.
    - `COMPACTION_THRESHOLD = 100_000` / `KEEP_RECENT_TOKENS = 20_000` — hardcoded slice defaults (same disposition as `MAX_LLM_RETRIES`; a configurable policy on `Session.empty` is a follow-on slice).

    New `CompactionApplied` `AgentEvent` variant (`{ tokensBefore, tokensAfter, summarizedMessageCount }`) and `CompactionError` `AgentError` variant (`{ cause }` — wraps the failed summarisation `AiError`, distinct from the per-turn `LlmError`).

    `effect/session.ts` integration — a step-0 block at the top of the `send` `Effect.gen`, BEFORE the input-variant history update:

    - Reads `state.history`; if `shouldCompact` fires, `splitHistory` cuts it, then `LanguageModel.generateText({ prompt: Prompt.concat(toSummarize, SUMMARIZATION_INSTRUCTION) })` produces the summary text.
    - `state.history` is rebuilt as `[summary user message, ...toKeep.content]` via `Prompt.fromMessages` (`turnCount` and token totals preserved — the input-variant update and turn bump happen in the existing step 1 on top of the compacted history).
    - The `CompactionApplied` event is prepended to the final stream via `Stream.concat(Stream.succeed(compactionEvent), mainStream)` so consumers observe it as the FIRST element.
    - A failed `generateText` is `Effect.mapError`-ed to `CompactionError`, widening `send`'s error channel to `LlmError | CompactionError`.

    New test fixture `stubLanguageModelDual` (`test-support/stub-language-model-dual.ts`) — a Layer satisfying `LanguageModel.LanguageModel` for BOTH `generateText` (canned `summaryText`, or a canned `summaryError` `AiError` failure) AND `streamText` (canned part sequence). A compaction `send` calls both methods in one turn, so the single-purpose stubs (`stubLanguageModel`, `stubLanguageModelStream`) — each dies on the other method — don't suffice.

    13 tests across `test/effect/compaction.test.ts` (7 — pure helpers) and `test/effect/session-compaction.test.ts` (3 — integration):

    - `estimateTokens`: chars/4 over text; counts tool-call + tool-result content; counts bare-string `system` content.
    - `shouldCompact`: false at/below threshold, true above.
    - `splitHistory`: cuts at a message boundary keeping ~`keepRecentTokens`; never orphans a tool-result (moves the cut back to the tool-call's assistant message).
    - `Session.send` over-threshold → `CompactionApplied` is the first event, `state.history` shrinks.
    - `Session.send` under-threshold → no `CompactionApplied`, and (via `stubLanguageModelStream`, which dies on `generateText`) the summary call is never reached.
    - Summary `generateText` failure → `CompactionError` in the error channel (asserted via `Effect.flip`).

    **What this does NOT yet do**:
    - Real summarisation prompt structure — `SUMMARIZATION_INSTRUCTION` is a single terse instruction, not the legacy's structured-checkpoint format (`## Goal` / `## Progress` / …). The summary message is plain `user` role.
    - Split-turn handling — the legacy compaction summarises a turn prefix separately when the cut falls mid-turn; this slice cuts only at whole-message boundaries.
    - Iterative summaries — no "previous summary" merge; each compaction summarises `toSummarize` from scratch.
    - Configurable threshold / keep-recent on `Session.empty` (hardcoded constants for now).
    - A `CompactionApplied` / compaction-count field on `SessionState` for snapshot observability.

29.   **Tool-call concurrency control on `Session.send`** (slice 29 — ADR-0009's "tool execution defaults to sequential" sub-decision). `Session.send` gains an optional third positional parameter `concurrency?: Types.Concurrency` (`number | "unbounded" | "inherit"`), forwarded to `LanguageModel.streamText` as the tool-call resolution concurrency.

      **Latent bug this fixes**: the effect framework's `streamText` defaults `concurrency` to `"unbounded"` when the option is omitted (`LanguageModel.ts` `resolveConcurrency`). The prior `Session.send` passed no `concurrency`, so the effect path was silently resolving tool calls unbounded — contradicting ADR-0009 ("sequential preserves today's semantics because pi's built-in `bash` / `write` / `edit` tools have real side effects"). `send` now resolves `concurrency ?? 1` and passes an explicit `1` by default; the toolkit and no-toolkit `streamText` branches both carry it.


    New test fixture `recordingLanguageModelStream` (`test-support/recording-language-model-stream.ts`) — a Layer whose `streamText` yields a canned part sequence AND pushes each options object it was called with into a shared `calls` array. Used when the test asserts on what `Session.send` *passes* to `streamText` rather than the events it emits. (`generateText` / `generateObject` die.)

    3 tests in `test/effect/session-concurrency.test.ts`:

    - `send(input)` with no concurrency arg → `streamText` receives `concurrency: 1` (sequential default).
    - `send(input, undefined, "unbounded")` → `streamText` receives `concurrency: "unbounded"`.
    - `send(input, undefined, 4)` → `streamText` receives `concurrency: 4`.

    **Testing stance**: pi's contract is "set the right default + forward the opt-in" — the actual parallel tool resolution is framework behavior, tested upstream in `effect/unstable/ai`. So these tests assert on the forwarded options, not on observed execution overlap.

    **What this does NOT yet do**:
    - Per-turn `concurrency` on the `Input` variants (it is a `send` argument, not a field on `NewPrompt` / `AcceptedPromptEnvelope`).
    - A configurable default on `Session.empty` (hardcoded `1`, same disposition as `MAX_LLM_RETRIES` / `COMPACTION_THRESHOLD`).

30.   **Observer hooks on `Session.send`** (slice 30 — ADR-0009's final loop-wrapping item after compaction, retry, and telemetry). New `effect/hooks.ts` defines a small `Hooks` service as a `Context.Reference` with a no-op default:


    - `Hooks.onAgentEvent(event)` is invoked once per `AgentEvent` the consumer sees, in stream order.
    - The hook observes the final event stream after orchestration events have been added, so it also sees prepended events such as `CompactionApplied`.
    - Because `Hooks` has a default implementation, `Session.send`'s `R` channel remains unchanged. Hosts or tests opt in with `Effect.provideService(Hooks, customHooks)`.

    New test fixture `recordingHooks` (`test-support/recording-hooks.ts`) returns `{ hooks, events }` so tests can assert that hook-observed events match emitted events.

    3 tests in `test/effect/session-hooks.test.ts`:

    - A provided `Hooks` observes every emitted event, in order.
    - The hook observes a prepended `CompactionApplied` event when compaction fires.
    - With no `Hooks` provided, `send` uses the no-op default and emits normally.

    **Testing stance**: this slice intentionally implements observer-only hooks. Hooks cannot mutate the event, block a tool call, patch a tool result, or change loop control flow.

    **What this does NOT yet do**:
    - Mutating hooks for tool-call approval / result patching.
    - Lifecycle hooks such as `onStart` / `onShutdown`.
    - Host-specific hook adapters in `pi-coding-agent`.

31.   **HTTP-status-driven error mapping** (slice 31 — a `stubHttpClient` test-support fixture + characterization tests). New `test-support/stub-http-client.ts` provides `HttpClient.HttpClient` resolving every request to a canned `Response(body, { status, headers })`.


    Composed UNDER the **real** `OpenAiClient.layer({})` (rather than stubbing `OpenAiClient` directly like `stubOpenAiClient`), a non-2xx status flows through the provider's genuine HTTP-error path: `HttpClient.filterStatusOk` → `StatusCodeError` → `@effect/ai-openai`'s `mapStatusCodeError` / `mapStatusCodeToReason` → `AiError`. One layer deeper than slice 6's `stubOpenAiClient({ error })`, which hands back an `AiError` directly.

    7 tests in `test/effect/http-error-mapping.test.ts`:

    - 429 → `AiError.RateLimitError` through `generateText`.
    - Parametrized matrix (`it.effect.each`): 400 → `InvalidRequestError`, 401 / 403 → `AuthenticationError`, 429 → `RateLimitError`, 500 → `InternalProviderError`.
    - 429 through `Session.send` → surfaces as `LlmError` (wrapping the `AiError`) in the stream error channel — proving the pi loop's `Stream.mapError` wraps an HTTP-originated `AiError`, after exhausting the retryable-error retry path.

    **No-RED slice**: this slice adds no `effect/` production code — the provider's mapping and `Session.send`'s existing `mapError` already work. It is **characterization testing**: it establishes the `stubHttpClient` fixture (which unblocks future deeper integration tests) and locks in the HTTP-status → `AiError` reason matrix that pi's chosen provider stack depends on.

    **What this does NOT yet do**:
    - Body-driven nuance — e.g. a 429 with an `insufficient_quota` JSON body maps to `QuotaExhaustedError` rather than `RateLimitError`; `retry-after` header parsing. The fixture supports `body` / `headers`, but no test exercises those branches yet.
    - A streaming-specific HTTP-error test distinct from the `Session.send` path.

32.   **Configurable + observable compaction** (slice 32 — closes two slice-28 compaction follow-ons). Two changes:


    - **`SessionState.compactionCount: number`** — observable count of how many times the session has compacted, `0` in `empty`, preserved by `advance`, bumped by the compaction update in `Session.send` (its sole writer). Every `new SessionState({...})` site now carries the field.
    - **`Session.make(config?: SessionConfig)`** — `SessionConfig = { compactionThreshold?, keepRecentTokens? }`. Omitted fields fall back to the module defaults (`COMPACTION_THRESHOLD` / `KEEP_RECENT_TOKENS`). `send` reads the session's resolved `compactionThreshold` / `keepRecentTokens` closure values instead of the module constants. `Session.empty` is now `Session.make({})` — both produce a FRESH `Session` (own `state` ref) per run.

    4 tests in `test/effect/session-compaction-config.test.ts`:

    - `SessionState.empty.compactionCount` is `0`.
    - `compactionCount` bumps to 1 each time compaction fires.
    - `Session.make({ compactionThreshold: 50, keepRecentTokens: 40 })` — a ~150-token history (well under the 100_000 default) compacts, and the low `keepRecentTokens` forces a real split (`summarizedMessageCount > 0`, vs `0` under the 20_000 default).
    - `Session.empty` delegates to `make({})` — a fresh session at `SessionState.empty`, independent `state` ref per run.

    **What this does NOT yet do**:
    - Configurable retry policy (`MAX_LLM_RETRIES`) — still a hardcoded module constant; a separate follow-on.
    - Structured-checkpoint summary prompt, split-turn handling, iterative "previous summary" merge — the remaining slice-28 compaction follow-ons.

## Architecture stance (Effect rewrite)

- **Idiomatic Effect throughout** (ADR-0001). No Promise facade beneath Effect. Public surface is `Effect`/`Stream`-shaped.
- **`@effect/ai` is the LLM abstraction** (ADR-0003). Target providers: `@effect/ai-openai`, `@effect/ai-openrouter`, and OpenAI Codex (re-implemented in-repo as a v4 Effect provider). Current tracer bullets exercise only `@effect/ai-openai`; OpenRouter and Codex provider wiring are later slices.
- **Effect v4 beta substrate** (ADR-0004). Pinned exact at `4.0.0-beta.65`. Beta releases carry no semver guarantee; every bump is a manual bump with breakage budgeted.
- **Agent loop is `Stream`-as-loop** (ADR-0009). Current tracer entry is `Session.send(input, toolkit?, concurrency?): Stream<AgentEvent, LlmError | CompactionError, LanguageModel>`. `LanguageModel.streamText({ toolkit, ... })` is wrapped, not exposed directly. `Session.empty`, observable state, history, retry, usage, telemetry, tool-event lifting, compaction triggers, observer hooks, and tool-call concurrency control are already implemented in the Effect path; production wiring remains a future slice. Tool execution defaults to sequential (`concurrency: 1`). **Skill loading / skill-block parsing is NOT a loop concern** — it is a host (`pi-coding-agent`) responsibility; the loop consumes already-expanded prompts (ADR-0009 amendment, 2026-05-14).
- **Tools are pure** (ADR-0010). `Tool.make("Name", { parameters, success, failure })` defines the schema contract; `Toolkit.make(...tools).toLayer({ Name: handler })` wires Effect handlers. Renderers live in `pi-coding-agent`, not here.
- **Tests use `test-support` deep import** (ADR-0015). Effect-shaped Layer fixtures replace the old faux provider pattern.

## Glossary

- **LanguageModel** — `Context.Service` from `effect/unstable/ai`. The provider-agnostic LLM service. Access via `yield* LanguageModel.LanguageModel`; call helpers like `LanguageModel.generateText({ prompt })`.
- **Tool / Toolkit** — `Tool.make("Name", { description, parameters: Schema, success: Schema, failure?: Schema, failureMode? })` defines a tool. `Toolkit.make(...tools).toLayer({ Name: handler })` wires handlers.
- **AiError** — Reason-pattern error type. Reasons include `RateLimitError`, `AuthenticationError`, `ContentPolicyError`, `InvalidRequestError`, `ToolNotFoundError`, etc. Each carries an `isRetryable` getter and optional `retryAfter`.
- **Tool failure / tool result error reasons (two distinct paths)** — easy to confuse:
   - `InvalidToolResultError` — produced when the handler's `Effect.fail` carries a `Schema.SchemaError` (i.e. the handler itself reports a schema-shaped failure). Goes through `Toolkit.ts`'s `normalizeError`.
   - `ToolResultEncodingError` — produced when the handler **succeeds** but the value can't be encoded against the `success` schema (a code bug — `isRetryable: false`). Comes from `encodeResult`, downstream of `normalizeError`.
     Both carry `toolName`. Test the failure path you mean.
- **OpenAiClient** — Low-level Context.Service from `@effect/ai-openai` (exported as a namespace, so the class is `OpenAiClient.OpenAiClient`). `OpenAiLanguageModel.layer({ model })` consumes it and provides `LanguageModel.LanguageModel`.
- **stubLanguageModel** — `test-support/stub-language-model.ts`. Test Layer that satisfies `LanguageModel.LanguageModel` directly with a canned text response.
- **stubOpenAiClient** — `test-support/stub-openai-client.ts`. Test Layer that satisfies `OpenAiClient.OpenAiClient`. Three modes:
   - `{ text }` — single text response (shorthand).
   - `{ outputs }` — full control over the `output` array (mix of text and function_call items).
   - `{ error }` — `createResponse` fails with the given `AiError` (HTTP-error / rate-limit / auth-failure tests).
- **stubOpenAiClientScripted** — `test-support/stub-openai-client-scripted.ts`. Layer that serves a different canned body per call from a `script: ReadonlyArray<StubScriptStep>`. Each step is either `{ type: "body", outputs, ... }` or `{ type: "error", error }`. Internal `Ref<number>` tracks the call index; calls beyond the script length die. Use for multi-turn conversations, retry sequences, or any test where the second call needs to differ from the first.
- **stubOpenAiClientStreaming** — `test-support/stub-openai-client-streaming.ts`. Layer with a streaming `createResponseStream` that emits canned SSE events reconstructing into `options.text`. Splits text across `chunkCount` `response.output_text.delta` events (default 1). `createResponse` and `createEmbedding` die — use with `LanguageModel.streamText`, not `generateText`.
- **stubLanguageModelStream** — `test-support/stub-language-model-stream.ts`. Test Layer that satisfies `LanguageModel.LanguageModel` directly (bypassing the OpenAI provider layer) with a caller-supplied static `ReadonlyArray<unknown>` of `Response.StreamPart`-shaped objects. Use for tests where you need precise control over the part sequence (e.g. tool-call/tool-result lifting, finish-part usage, mixed text/tool flows).
- **stubLanguageModelStreamScripted** — `test-support/stub-language-model-stream-scripted.ts`. Test Layer that satisfies `LanguageModel.LanguageModel` directly and serves a different stream per call from a `script: ReadonlyArray<{ type: "parts", parts } | { type: "error", error: AiError }>`. Internal `Ref<number>` tracks call index; calls past script length die. Use for retry sequences (fail-then-success), cap-exceeded scenarios, or any other test where successive `streamText` calls must differ. Mirrors `stubOpenAiClientScripted` but bypasses the OpenAI provider layer.
- **recordingTracer** — `test-support/recording-tracer.ts`. Returns `{ tracer, spans }` where `tracer` is a minimal `Tracer.Tracer` whose `span` factory constructs a `NativeSpan` and pushes it into the shared `spans` array. Provide via `Effect.provideService(Tracer.Tracer, tracer)`; assert on `spans[i].name` / `.attributes.get(key)` / `.status._tag` (`"Ended"` after run completion) / `.status.exit._tag` (`"Success"` vs `"Failure"`). Used to test `Effect.withSpan` / `Stream.withSpan` wiring without standing up a real opentelemetry pipeline.
- **Hooks** — `effect/hooks.ts`. `Context.Reference` service with a no-op default. `Session.send` taps its final event stream and calls `Hooks.onAgentEvent(event)` once per emitted `AgentEvent`, in stream order. Observer-only in the current slice.
- **recordingHooks** — `test-support/recording-hooks.ts`. Returns `{ hooks, events }`, where `hooks.onAgentEvent` pushes every observed `AgentEvent` into the shared `events` array. Use with `Effect.provideService(Hooks, hooks)` when tests need to assert hook observation order.
- **recordingLanguageModelStream** — `test-support/recording-language-model-stream.ts`. Returns `{ layer, calls }` where `layer` provides `LanguageModel.LanguageModel` with a `streamText` that yields a canned part sequence AND pushes each options object it was called with into the shared `calls` array. Use when the test asserts on what a consumer _passes_ to `streamText` (e.g. the `concurrency` knob) rather than the events produced. `generateText` / `generateObject` die.
- **stubHttpClient** — `test-support/stub-http-client.ts`. Layer providing `HttpClient.HttpClient` that resolves every request to a canned `Response(body, { status, headers })`. Composed UNDER the real `OpenAiClient.layer` it drives the provider's genuine HTTP-error path (`filterStatusOk` → `StatusCodeError` → `mapStatusCodeError` → `AiError`) — one layer deeper than `stubOpenAiClient`, which fakes `OpenAiClient` directly.
- **disableToolCallResolution** — option on `LanguageModel.generateText`. When `true`, tool calls surface as `tool-call` parts but handlers don't run (no `tool-result` parts). Default `false` → auto-execute. `generateText` does NOT auto-loop after tool execution; the final response merges tool-call parts with their resolved tool-result parts in a single round.
- **concurrency** — option on `LanguageModel.generateText` / `streamText` controlling tool-call resolution parallelism (`number | "unbounded" | "inherit"`). The framework defaults it to `"unbounded"` when omitted; `Session.send` resolves an explicit `1` (sequential) unless its `concurrency?` argument opts in (ADR-0009).
- **failureMode** — option on `Tool.make`. `"error"` (default) propagates the handler's `Effect.fail` through the calling Effect's error channel. `"return"` captures the failure as a `tool-result` part with `isFailure: true` so the agent loop can react to it instead of crashing. Inside the toolkit, `Toolkit.ts` `normalizeError` only wraps `Schema.SchemaError` (→ `InvalidToolResultError`) and `AiError.AiErrorReason` values; any other failure propagates as-is.
- **v4 error-channel testing** — `Effect.either` is **removed** in v4. Use `Effect.flip` (swaps success/error — assert on the success of the flipped effect) or `Effect.exit` + `Exit.isFailure`.
- **v4 stream collection** — `Stream.runCollect` returns `Effect<Array<A>, E, R>` (NOT `Effect<Chunk<A>>` as in v3). No `Chunk.toReadonlyArray` shim needed.
- **AgentEvent / AgentError** — `effect/agent-event.ts`, `effect/agent-error.ts`. The pi-defined Schema-tagged unions for the `Session.send` Stream (ADR-0009). Event variants extend `Schema.TaggedClass`; error variants extend `Schema.TaggedErrorClass` (yieldable in `Effect.gen`). Construction: `new LlmPart({ part })`, `yield* new ToolError({ ... })`. Event variants: `LlmPart | ToolDispatched | ToolCompleted | CompactionApplied | Finish`. Error variants: `LlmError | ToolError | SchemaError | CancellationError | CompactionError`.
- **Compaction** — `effect/compaction.ts`. Pure trigger helpers: `estimateTokens(history)` (chars/4 heuristic), `shouldCompact(history, threshold)`, `splitHistory(history, keepRecentTokens)` (cut-point detection that never orphans a tool-result). `Session.send` wires them in at step 0 — over `COMPACTION_THRESHOLD` it summarises the older history slice via `LanguageModel.generateText`, rebuilds `state.history` as `[summary user message, ...recent kept]`, and emits `CompactionApplied` as the stream's first event. A failed summary call → `CompactionError`.
- **stubLanguageModelDual** — `test-support/stub-language-model-dual.ts`. Test Layer satisfying `LanguageModel.LanguageModel` for BOTH `generateText` (canned `summaryText` or canned `summaryError` `AiError`) AND `streamText` (canned part sequence). Needed by compaction tests, where one `send` calls both methods.
- **Transcript operation** — A pure operation over persisted agent messages, such as LLM-facing conversion, compaction text extraction, or replay/reconstruction. Core owns base transcript operations; host packages supply custom role Adapters for host-specific message roles.
- **Accepted prompt envelope** — A host-preflighted prompt input handed to `Session`: skill/prompt-template expansion and extension input transforms have already run, model/auth preflight has passed, and the envelope carries user content plus queue policy and host metadata without terminal UI details.

## Toolchain (for the Effect rewrite paths)

- `effect@4.0.0-beta.65` (exact) — runtime
- `@effect/ai-openai@4.0.0-beta.65` (exact) — OpenAI provider
- `@effect/vitest@4.0.0-beta.65` (exact) — `it.effect` test helper
- `vitest@^3.2.4` — test runner
- `oxlint@1.42.0` — lint (scoped to `test-support` + `test/effect`)
- `oxfmt@^0.49.0` — format (per ADR-0004)
- `tsgo` (`@typescript/native-preview`) — typecheck/build
- `bunx` (Bun) — invoke binaries

The existing `src/` and `test/` (non-effect) keep their pre-Effect toolchain (biome, vitest) until phase 4 absorbs them.

## Style (Effect paths)

Pi-monorepo style — tabs, indent 3, line width 120, semicolons, double quotes, `all` trailing commas (matches Biome 2.x default that the rest of the repo uses, including in function-call args). Configured in `.oxfmtrc.json`.

## Running (Effect paths)

From `packages/agent/`:

```sh
bunx vitest --run test/effect              # run Effect tracer bullets
bunx oxlint test-support test/effect       # lint
bunx oxfmt test-support test/effect CONTEXT.md          # format
bunx oxfmt --check test-support test/effect CONTEXT.md  # format check
# typecheck (from repo root):
# node_modules\.bin\tsgo.cmd -p packages\agent\tsconfig.build.json --noEmit
```

Or via package scripts:

```sh
npm run test:effect
npm run lint:effect
npm run fmt:effect
npm run fmt:effect:check
```

## What's not here yet

- Streaming on the scripted / non-streaming stubs: only `stubOpenAiClientStreaming` implements `createResponseStream`; the others die on call. A future slice can unify (e.g. a per-call stream-or-body switch).
- Remaining `AiError` reasons (`InvalidOutputError`, `StructuredOutputError`, `UnsupportedSchemaError`, `InternalProviderError`, `NetworkError`, `UnknownError`, `InvalidUserInputError`) - add to the `cases` array in `error-reasons.test.ts` when a slice needs them.
- ADR-0009 wrapping follow-ons: the current `Hooks` service is observer-only (`onAgentEvent`). Mutating hooks for tool-call approval / result patching, lifecycle hooks (`onStart` / `onShutdown`), and host-specific hook adapters are still future slices. Skill-block parsing was **removed** from this target — it is a host (`pi-coding-agent`) concern (ADR-0009 amendment, 2026-05-14); the loop consumes already-expanded prompts.
- Compaction follow-ons: structured-checkpoint summary prompt, split-turn handling, and iterative "previous summary" merge. (Configurable threshold / keep-recent via `Session.make` and the `compactionCount` field on `SessionState` landed in slice 32.)
- Retry policy still needs production backoff and `retryAfter` support; the current tests cover no-delay retry of retryable at-open provider failures.
- The other `test-support` fixtures per ADR-0015: `TestUI`, `TestStores`, `TestBashOperations`.

These land as TDD slices, in order - see `docs/agents/domain.md` for how the consumer skills (`/tdd`, `/diagnose`, `/improve-codebase-architecture`) should treat this package.
