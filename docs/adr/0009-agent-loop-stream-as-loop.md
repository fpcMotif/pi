# Agent loop public surface: Stream-as-loop with a pi-defined AgentEvent union

`pi-agent-core` exposes the agent loop as a `Stream`-returning entry point on a `Session` service:

```ts
Session.send(input: Input): Stream<AgentEvent, AgentError, R>
type Input = NewPrompt | Continue | Retry
```

Each element of the stream is one `AgentEvent`; stream completion = the loop is finished. A trailing `FinishEvent` carries the final messages, usage, and cost. `Session.state: SubscriptionRef<SessionState>` is exposed alongside the stream for components that want snapshot reads or to observe slices without consuming the event log; `SessionState` is a single `Schema`-defined record. Internally the loop delegates provider streaming and single-turn tool-call resolution to `effect/unstable/ai`'s `LanguageModel.streamText({ toolkit, ... })`; pi owns the higher-level multi-turn agent loop and wraps the provider stream with compaction triggers, retry on transient errors, hooks, and telemetry spans. (Skill loading and skill-block parsing are **not** part of the loop — see the Amendment below.)

The event union is pi-defined with a `_tag` discriminator and nests `Response.AnyPart` rather than exposing it directly, so pi orchestration events (compaction, retries, session metadata) are first-class peers of the LLM parts instead of side-channels:

```ts
type AgentEvent =
  | { _tag: "LlmPart"; part: Response.AnyPart }
  | { _tag: "ToolDispatched"; ... }
  | { _tag: "ToolCompleted"; ... }
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

## Amendment (2026-05-14): skills are a host concern, not a loop concern

The original draft listed "skill-block parsing" among the things the loop wraps the provider stream with, and included a `SkillInvoked` variant in the `AgentEvent` union. **Both are removed.** Skill loading, skill-block parsing, and skill-invocation expansion are responsibilities of the **host** (`pi-coding-agent`), not of `pi-agent-core`'s `Session` loop.

Rationale:

- The host already loads skills (the `--skills` CLI flag, per ADR-0011) and owns the skill file format. The legacy `parseSkillBlock` lives in `pi-coding-agent`, never in the core.
- A `<skill name="..." location="...">…</skill>` block is a **host-defined text format**. Teaching the core `Session` loop to parse it would leak a host concern into `pi-agent-core` and couple the core to a format it does not own — the same separation ADR-0010 draws for renderers.
- The host hands the core an **already-expanded** prompt. The `AcceptedPromptEnvelope` input variant is exactly this contract: "the host has already run skill/prompt-template expansion, extension input transforms, and model/auth preflight." The core consumes expanded prompt content and never sees `<skill>` blocks.

Consequences:

- `SkillInvoked` is **not** an `AgentEvent` variant. If a host wants to surface a skill invocation to its own UI, it does so from host-side state (it parsed/expanded the skill itself), not by observing the core event stream.
- The core loop's "wrapping" responsibilities are: compaction triggers, retry on transient errors, hooks, and telemetry spans.
- This does not affect the `AcceptedPromptEnvelope` variant or any other `Input` — skill expansion simply happens upstream of `Session.send`.

## Status

accepted (amended 2026-05-14)
