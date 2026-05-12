# Agent loop public surface: Stream-as-loop with a pi-defined AgentEvent union

`pi-agent-core` exposes the agent loop as a `Stream`-returning entry point on a `Session` service:

```ts
Session.send(input: Input): Stream<AgentEvent, AgentError, R>
type Input = NewPrompt | Continue | Retry
```

Each element of the stream is one `AgentEvent`; stream completion = the loop is finished. A trailing `FinishEvent` carries the final messages, usage, and cost. `Session.state: SubscriptionRef<SessionState>` is exposed alongside the stream for components that want snapshot reads or to observe slices without consuming the event log; `SessionState` is a single `Schema`-defined record. Internally the loop delegates provider streaming and single-turn tool-call resolution to `effect/unstable/ai`'s `LanguageModel.streamText({ toolkit, ... })`; pi owns the higher-level multi-turn agent loop and wraps the provider stream with compaction triggers, retry on transient errors, skill-block parsing, hooks, and telemetry spans.

The event union is pi-defined with a `_tag` discriminator and nests `Response.AnyPart` rather than exposing it directly, so pi orchestration events (skills, compaction, retries, session metadata) are first-class peers of the LLM parts instead of side-channels:

```ts
type AgentEvent =
  | { _tag: "LlmPart"; part: Response.AnyPart }
  | { _tag: "ToolDispatched"; ... }
  | { _tag: "ToolCompleted"; ... }
  | { _tag: "SkillInvoked"; ... }
  | { _tag: "CompactionApplied"; ... }
  | { _tag: "RetryRequested"; ... }
  | { _tag: "SessionMeta"; ... }
  | { _tag: "Finish"; messages; usage; cost }
```

Sub-decisions, all locked together with this ADR:

- **Cancellation is `Fiber.interrupt(currentActionFiber)`**, not `AbortSignal`. The host (per ADR-0008) holds `Ref<Option<Fiber>>` and interrupts on Ctrl+C.
- **Tool execution defaults to sequential.** A future opt-in `concurrency: 'unbounded' | N` parameter on `Session.send` lets callers request parallelism per turn. Sequential preserves today's semantics because pi's built-in tools (`bash`, `write`, `edit`) have real side effects on the working tree.
- **Retry and continue are inputs**, not separate entry points. The Stream branches internally based on `Input`'s tag.
- **Errors are tagged classes** in the error channel: `AgentError = ToolError | LlmError | AuthError | SchemaError | CancellationError | CompactionError | ...` via `Schema.TaggedError`. Untyped throws are not allowed inside the loop.
- **Telemetry happens via `Effect.withSpan`** on every internal Effect; no separate event-emission path for tracing.

Rejected alternatives: 11A "Effect with side-channel events" (callers had to coordinate two streams), 11C "Service-shaped message-passing verbs" (more idiomatic for RPC but loses Stream-as-loop ergonomics for the dominant interactive use case — 11C → 11B is mechanical if we change our minds).

## Status

accepted
