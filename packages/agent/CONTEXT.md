# pi-agent-core

`@earendil-works/pi-agent-core` — the agent runtime. This package is the rewrite target per ADR-0005. During ADR-0006 phases 1-3 it continues to ship the existing TypeBox / Promise-shaped agent loop under `src/`. The Effect v4 rewrite lands under `test-support/` and `test/effect/` first as TDD tracer bullets, then takes over `src/` during phase 4.

## What's where

- **`src/`** — Existing pi-agent-core (TypeBox, async iterators, `@earendil-works/pi-ai` deps). Untouched by the rewrite until phase 4.
- **`test/`** — Existing tests for the existing src/. Run with `npm test`.
- **`effect/`** — _New, Effect-based **production** code._ Schemas (`agent-event.ts`, `agent-error.ts`), services (`session.ts` in later slices), and the future agent-loop body. Folds into `src/` during ADR-0006 phase 4.
- **`test-support/`** — _New, Effect-based._ Reusable Layer fixtures: `stubLanguageModel`, `stubOpenAiClient`, `stubOpenAiClientScripted`, `stubOpenAiClientStreaming`. Will be deep-published as `@earendil-works/pi-agent-core/test-support` per ADR-0015.
- **`test/effect/`** — _New, Effect-based._ Tracer-bullet tests proving the v4 surface works against the stubs above. Run with `npm run test:effect`.

## Status — Effect rewrite tracer bullets

Fifteen tracer bullets (26 test cases), all GREEN, all without an API key:

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
    Future variants (`SkillInvoked`, `CompactionApplied`, `RetryRequested`, `SessionMeta`, `CompactionError`, `AuthError` if it splits from `LlmError`) are deferred until their slices need them.

14.   **`Session.empty` + `Session.send` wired to `LanguageModel.streamText`** (12b/c — combined). `effect/session.ts` exposes:


    - `Session` interface with `send: (prompt: string) => Stream<AgentEvent, LlmError, LanguageModel>`.
    - `Session.empty: Effect<Session>` builder (stateless for now; mirrors `Chat.empty` so a stateful variant can land later without changing call sites).
    The `send` Stream wraps `LanguageModel.streamText({ prompt })`: `Stream.map` each `Response.AnyPart` to an `LlmPart` event, `Stream.mapError` each upstream `AiError` to our pi-defined `LlmError`, and `Stream.concat` a trailing `Finish` event. 2 tests in `test/effect/session.test.ts`:
    - `Session.empty` resolves to a Session with `send` (smoke test).
    - `send("hello")` against `stubOpenAiClientStreaming({ text, chunkCount })` yields N `LlmPart` events whose unwrapped `text-delta` parts concatenate back to the canned text, followed by exactly one `Finish`.

    **Deferred to later slices** (each its own tracer bullet): the `Input = NewPrompt | Continue | Retry` discriminated union, multi-turn history inside `Session`, `Session.state: SubscriptionRef<SessionState>` for snapshot reads, token/cost accounting on `Finish`, compaction triggers, retry on transient errors, skill-block parsing, `Effect.withSpan` telemetry, cancellation via `Fiber.interrupt`.

15.   **Tool events in `Session.send`** (slice 12d — `ToolDispatched` / `ToolCompleted`). Extended `session.ts` to `Stream.flatMap` each upstream `Response.AnyPart` through a `liftPart(part)` helper:


    - `tool-call` part → `[LlmPart, ToolDispatched({ toolName, toolCallId, params })]`
    - `tool-result` part → `[LlmPart, ToolCompleted({ toolName, toolCallId, isFailure, result })]`
    - every other part → `[LlmPart]`

    Verified by a new `stubLanguageModelStream(parts: ReadonlyArray<unknown>)` test-support helper that satisfies `LanguageModel.LanguageModel` directly (bypassing the OpenAI provider layer) with a caller-supplied canned `Response.StreamPart` sequence. 2 tests in `test/effect/session-tool-events.test.ts`:
    - Canned parts `[text-delta, tool-call, tool-result]` produce the exact sequence `[LlmPart, LlmPart, ToolDispatched, LlmPart, ToolCompleted, Finish]` with all fields preserved.
    - A `tool-result` with `isFailure: true` round-trips that flag into `ToolCompleted.isFailure` along with the failure-shaped `result`.

    The lifted events appear **alongside** the raw `LlmPart` (not replacing it) so consumers can pick the abstraction level they want: raw provider parts via `LlmPart`, or higher-level orchestration via `ToolDispatched` / `ToolCompleted`.

## Architecture stance (Effect rewrite)

- **Idiomatic Effect throughout** (ADR-0001). No Promise facade beneath Effect. Public surface is `Effect`/`Stream`-shaped.
- **`@effect/ai` is the LLM abstraction** (ADR-0003). Target providers: `@effect/ai-openai`, `@effect/ai-openrouter`, and OpenAI Codex (re-implemented in-repo as a v4 Effect provider). Current tracer bullets exercise only `@effect/ai-openai`; OpenRouter and Codex provider wiring are later slices.
- **Effect v4 beta substrate** (ADR-0004). Pinned exact at `4.0.0-beta.65`. Beta releases carry no semver guarantee; every bump is a manual bump with breakage budgeted.
- **Agent loop is `Stream`-as-loop** (ADR-0009). Public entry is `Session.send(input): Stream<AgentEvent, AgentError, R>`. `LanguageModel.streamText({ toolkit, ... })` is wrapped, not exposed directly. Tracer bullets here drive the building blocks; the `Session` service comes in a later slice.
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
- **disableToolCallResolution** — option on `LanguageModel.generateText`. When `true`, tool calls surface as `tool-call` parts but handlers don't run (no `tool-result` parts). Default `false` → auto-execute. `generateText` does NOT auto-loop after tool execution; the final response merges tool-call parts with their resolved tool-result parts in a single round.
- **failureMode** — option on `Tool.make`. `"error"` (default) propagates the handler's `Effect.fail` through the calling Effect's error channel. `"return"` captures the failure as a `tool-result` part with `isFailure: true` so the agent loop can react to it instead of crashing. Inside the toolkit, `Toolkit.ts` `normalizeError` only wraps `Schema.SchemaError` (→ `InvalidToolResultError`) and `AiError.AiErrorReason` values; any other failure propagates as-is.
- **v4 error-channel testing** — `Effect.either` is **removed** in v4. Use `Effect.flip` (swaps success/error — assert on the success of the flipped effect) or `Effect.exit` + `Exit.isFailure`.
- **v4 stream collection** — `Stream.runCollect` returns `Effect<Array<A>, E, R>` (NOT `Effect<Chunk<A>>` as in v3). No `Chunk.toReadonlyArray` shim needed.
- **AgentEvent / AgentError** — `effect/agent-event.ts`, `effect/agent-error.ts`. The pi-defined Schema-tagged unions for the `Session.send` Stream (ADR-0009). Event variants extend `Schema.TaggedClass`; error variants extend `Schema.TaggedErrorClass` (yieldable in `Effect.gen`). Construction: `new LlmPart({ part })`, `yield* new ToolError({ ... })`.

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
- Streaming with tool calls: would require `response.output_item.added` + `response.function_call_arguments.delta`/`done` events in the canned stream. Same pattern, more events.
- Remaining `AiError` reasons (`InvalidOutputError`, `StructuredOutputError`, `UnsupportedSchemaError`, `InternalProviderError`, `NetworkError`, `UnknownError`, `InvalidUserInputError`) — add to the `cases` array in `error-reasons.test.ts` when a slice needs them.
- Concurrency control on parallel tool calls.
- HTTP-driven error mapping via `AiError.reasonFromHttpStatus({ status, body })` — once a stub `HttpClient` lands.
- **The `Session.send` Stream-as-loop entry point** (ADR-0009) — the big one. Builds on every tracer bullet here.
- The other `test-support` fixtures per ADR-0015: `TestUI`, `TestStores`, `TestBashOperations`.

These land as TDD slices, in order — see `docs/agents/domain.md` for how the consumer skills (`/tdd`, `/diagnose`, `/improve-codebase-architecture`) should treat this package.
