# composeHooks: defect-isolation for lifecycle observers

Slice 39 introduces `composeHooks(...hooks: ReadonlyArray<Hooks>): Hooks` in `packages/agent/effect/hooks.ts` — the lifecycle-hooks composition adapter ADR-0014 named ("host-lifecycle composition") but did not specify a semantic for. ADR-0014 says lifecycle hooks return Effects; it does not pin how multiple hosts' hooks should compose when several are provided simultaneously. This ADR fills that gap and records how the decision evolved during slice-38/39 grill + codex adversarial review.

The accepted semantic is **defect-isolation**. Each underlying hook's invocation is wrapped in `Effect.suspend(() => h.onX(arg))` and then in `Effect.catchDefect(defect => Effect.logWarning(...))` before being run through `Effect.forEach(..., { discard: true })`. Hooks have the typed signature `Effect<void, never, never>` so typed failures are impossible by construction; defects (unchecked throws, `Effect.die`, etc.) inside an underlying hook are absorbed at the boundary and logged at warning level. The `Effect.suspend` thunk is load-bearing: it defers the hook method's invocation into the Effect runtime so that a *synchronous* `throw` while constructing the hook's Effect lands as a defect inside the runtime and is caught by `Effect.catchDefect` identically to an `Effect.die`. Without `suspend`, the synchronous throw would propagate as an uncaught exception and bypass the isolation. Subsequent hooks for that event still run; the composed hook's caller (`Session.send`) is never affected.

This protects durable session state from observer bugs. `Session.send` advances durable state — writes the user input, runs compaction, snapshots the new history — BEFORE it opens the upstream stream that emits AgentEvents through `Stream.tap(Hooks.onAgentEvent)`. A defect in an observer hook at that point — without isolation — fails the stream after the user turn is persisted but before the assistant response is, leaving a user-visible partial turn in the durable session file. Isolation closes that blast radius without changing the public contract.

## Decision evolution

The composition semantic evolved during slice-38/39 review:

1. **Initial choice (rejected): sequential fail-fast on defects.** Argued by "loud failures during dev > silent observer drops" and an intent to match `Tracer.Tracer` (slice 25) semantics. Slice 39's tracer-bullet test #4 originally encoded this — a hook doing `Effect.die` on `onAgentEvent` produced a `Failure` exit, second hook saw zero events.
2. **Codex adversarial review** surfaced the durable-partial-turn blast radius: `Session.send` mutates durable state BEFORE the observer hooks run, so a defect in `composeHooks` fail-fast leaves a persisted user turn without the assistant response. Extension-provided observers are the most likely defect source, and they are exactly the surface area users see — exactly the wrong place to be loud.
3. **Correction (accepted): defect-isolation by default, with warning-level logging.** Wrap each hook's Effect in `Effect.catchDefect(defect => Effect.logWarning(...))`. The loop continues; observer bugs surface as warning-level log entries rather than breaking durable state. Tracer-bullet test #4 rewritten to assert defect-isolation (second hook still observes; loop exit is `Success`).
4. **Follow-up codex review** caught that the initial isolation patch wrapped only the Effect *returned* by `h.onX(arg)`. A hook method that `throw`s synchronously while constructing its Effect would bypass `Effect.catchDefect` because the throw fires before the wrapper runs — exactly the partial-turn risk the correction was meant to close. Synchronous throws are especially plausible for extension-provided observers (a plain JS `throw` in a callback satisfies the `Effect<void, never, never>` return type via `never`).
5. **Patch (accepted): `Effect.suspend` thunk around every hook invocation.** Replace `isolate(h.onX(arg))` with `isolate(() => h.onX(arg))`, implemented as `Effect.suspend(make).pipe(Effect.catchDefect(...))`. Synchronous throws now land as defects inside the Effect runtime and are absorbed identically to `Effect.die`. Tracer-bullet test #5 added to lock the synchronous-throw protection.

The reversal weakens the "matches `Tracer.Tracer` semantics" argument from the initial choice; we accept the inconsistency. Hooks run AFTER durable mutation; tracer spans are observation-only and do not gate state. The blast radii differ. If `Tracer.Tracer`'s defect handling becomes load-bearing later, it can be revisited independently.

Rejected alternatives:

- **Sequential + fail-fast on defects** (the initial choice) — covered above. The "loud failure" argument is real for local-loop in-development hooks but does not survive the extension-provided hook case where partial durable state is user-visible.
- **Parallel fan-out (`Effect.forEach` with `concurrency: "unbounded"`)** — would lose the pass-order contract that test #3 in `hooks-compose.test.ts` asserts, and host code depending on logging-before-UI ordering would silently break. The composition primitive should not have surprising concurrency semantics; if a host wants parallel observers it can wrap each hook in `Effect.fork` inside its own hook impl.
- **Opt-in fail-fast (`composeHooksStrict` alongside `composeHooks`)** — more API surface for marginal gain. If a host knows its observers are safe to fail loud, it can compose them with a custom combinator at its own boundary.
- **Silent absorption (no warning log)** — would hide observer bugs entirely. The warning log gives operators a thread to pull when a hook misbehaves without poisoning the loop.

## Status

accepted (decision evolved during slice-38/39 review)
