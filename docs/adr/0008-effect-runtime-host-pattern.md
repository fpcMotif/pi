# Effect host pattern: one `ManagedRuntime` per `pi` process

The interactive mode (and the print and RPC modes) host the Effect runtime via a single `ManagedRuntime` instance built at process startup from the app `Layer` (provider clients, settings, theme, auth, telemetry, session storage, etc.). Imperative `pi-tui` keystroke handlers and component callbacks invoke `runtime.runFork(effect)` for fire-and-forget actions and `runtime.runPromise(effect)` when they need a value back; the long-lived `AgentSession` event subscription runs as one `runFork` on a `Stream.runForEach` consumer that pushes UI state into `pi-tui` via plain function calls. The runtime is disposed on `SIGINT`/`SIGTERM` and on graceful exit, triggering Scope finalization for telemetry flushes, OAuth socket close, and session-resource cleanup. Cancellation of in-flight actions is implemented as `runtime.runFork(Fiber.interrupt(currentActionFiber))`; the current action fiber is held in a `Ref<Option<Fiber>>` inside the runtime.

Rejected alternatives: per-action `Effect.runPromise` (loses shared layer, telemetry, and structured cancellation; rebuilds Runtime guarantees by hand); making the entire interactive mode one long-lived Effect with `pi-tui` event handlers pushing into an `Effect.Queue` (would force `pi-tui` to be Effect-aware, contradicting ADR-0002).

## Status

accepted
